// A MaxMind DB (.mmdb) reader, in about two hundred lines and no dependencies.
//
// Why this exists rather than `npm i geoip-lite`: this repository has no
// node_modules on purpose, and a platform that argues every dependency is a
// decision should not import 150MB of someone else's code to answer "which
// city." The MMDB
// format is a documented binary search tree plus a tagged data section. Reading
// it is a day of work, and then it is ours.
//
// Format reference: https://maxmind.github.io/MaxMind-DB/
//
// Works with any MMDB file. We ship DB-IP's City Lite build (CC BY 4.0), which
// needs no account; a MaxMind GeoLite2-City.mmdb can be dropped in its place
// with no code change, because the container format is identical.
//
// The lookup is a walk down a bit-trie: at most 128 node reads for IPv6, 32 for
// an IPv4 address entered at the v4 start node. No allocation per step, so
// resolving a few thousand distinct addresses in a stats run is not something
// you will notice next to the S3 reads.

const METADATA_MARKER = Buffer.from("\xab\xcd\xefMaxMind.com", "binary");

// Data section type tags. 0 means "extended": the real type is 7 + next byte.
const T = {
  POINTER: 1, UTF8: 2, DOUBLE: 3, BYTES: 4, UINT16: 5, UINT32: 6,
  MAP: 7, INT32: 8, UINT64: 9, UINT128: 10, ARRAY: 11,
  CONTAINER: 12, END_MARKER: 13, BOOLEAN: 14, FLOAT: 15,
};

export class MMDBError extends Error {}

/**
 * Reads a .mmdb buffer. Nothing is copied: every decode is a view over `buf`,
 * so the memory cost is the file itself and not a multiple of it.
 */
export class MMDBReader {
  constructor(buf) {
    if (!Buffer.isBuffer(buf)) throw new MMDBError("MMDBReader needs a Buffer");
    this.buf = buf;
    this.metadata = this.#readMetadata();

    const { node_count, record_size } = this.metadata;
    if (![24, 28, 32].includes(record_size)) {
      throw new MMDBError(`unsupported record_size ${record_size}`);
    }
    this.nodeByteSize = (record_size * 2) / 8;
    this.searchTreeSize = node_count * this.nodeByteSize;
    // The data section begins 16 bytes past the tree; the gap is a documented
    // block of zeroes used as the "no data" separator.
    this.dataSectionStart = this.searchTreeSize + 16;
    this.ipv4StartNode = this.#findIPv4StartNode();
  }

  #readMetadata() {
    // The metadata map follows the LAST occurrence of the marker, so search
    // backwards: the marker's bytes can legitimately appear inside the data
    // section, and taking the first hit reads garbage as a header.
    const idx = this.buf.lastIndexOf(METADATA_MARKER);
    if (idx === -1) throw new MMDBError("not an MMDB file: metadata marker missing");
    const { value } = this.#decode(idx + METADATA_MARKER.length);
    for (const k of ["node_count", "record_size", "ip_version"]) {
      if (value?.[k] === undefined) throw new MMDBError(`metadata is missing ${k}`);
    }
    return value;
  }

  // In an IPv6 database, IPv4 lives under ::/96. Walking those 96 zero bits on
  // every lookup is pure waste, so resolve the entry node once.
  #findIPv4StartNode() {
    if (this.metadata.ip_version !== 6) return 0;
    let node = 0;
    for (let i = 0; i < 96 && node < this.metadata.node_count; i++) {
      node = this.#readRecord(node, 0);
    }
    return node;
  }

  #readRecord(node, bit) {
    const base = node * this.nodeByteSize;
    const b = this.buf;
    switch (this.metadata.record_size) {
      case 24:
        return bit === 0
          ? (b[base] << 16) | (b[base + 1] << 8) | b[base + 2]
          : (b[base + 3] << 16) | (b[base + 4] << 8) | b[base + 5];
      case 28:
        // The middle byte is split: high nibble extends the left record, low
        // nibble extends the right. Getting this backwards yields lookups that
        // work for most addresses and fail for a scattered few, which is a
        // genuinely miserable bug to find.
        return bit === 0
          ? ((b[base + 3] & 0xf0) << 20) | (b[base] << 16) | (b[base + 1] << 8) | b[base + 2]
          : ((b[base + 3] & 0x0f) << 24) | (b[base + 4] << 16) | (b[base + 5] << 8) | b[base + 6];
      default: // 32
        return bit === 0 ? b.readUInt32BE(base) : b.readUInt32BE(base + 4);
    }
  }

  /** @returns {number[]|null} address as bytes, or null if unparseable. */
  static addressBytes(ip) {
    if (typeof ip !== "string" || !ip) return null;
    const s = ip.trim();
    if (!s || s === "-") return null;

    if (s.includes(":")) {
      // ::ffff:1.2.3.4 is an IPv4 address wearing a hat.
      const v4 = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
      if (v4) return MMDBReader.addressBytes(v4[1]);
      return MMDBReader.#ipv6Bytes(s);
    }

    const parts = s.split(".");
    if (parts.length !== 4) return null;
    const out = [];
    for (const p of parts) {
      if (!/^\d{1,3}$/.test(p)) return null;
      const n = Number(p);
      if (n > 255) return null;
      out.push(n);
    }
    return out;
  }

  static #ipv6Bytes(s) {
    const halves = s.split("::");
    if (halves.length > 2) return null;
    const toWords = (part) =>
      part ? part.split(":").filter(Boolean).map((h) => (/^[0-9a-f]{1,4}$/i.test(h) ? parseInt(h, 16) : NaN)) : [];
    const head = toWords(halves[0]);
    const tail = halves.length === 2 ? toWords(halves[1]) : [];
    if ([...head, ...tail].some((w) => !Number.isFinite(w))) return null;
    const fill = 8 - head.length - tail.length;
    if (halves.length === 2 ? fill < 0 : fill !== 0) return null;
    const words = [...head, ...new Array(Math.max(0, fill)).fill(0), ...tail];
    const out = [];
    for (const w of words) out.push((w >> 8) & 0xff, w & 0xff);
    return out;
  }

  /** Raw record for an address, or null when the database has no entry. */
  get(ip) {
    const bytes = MMDBReader.addressBytes(ip);
    if (!bytes) return null;

    const isV4 = bytes.length === 4;
    if (!isV4 && this.metadata.ip_version === 4) return null;

    let node = isV4 ? this.ipv4StartNode : 0;
    const bitCount = bytes.length * 8;
    const { node_count } = this.metadata;

    for (let i = 0; i < bitCount; i++) {
      if (node >= node_count) break;
      const bit = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
      node = this.#readRecord(node, bit);
    }

    // node_count exactly means "no data for this address"; anything greater is
    // an offset into the data section.
    if (node === node_count) return null;
    if (node < node_count) return null; // ran out of bits inside the tree

    // The record value is node_count + 16 + (offset within the data section),
    // and the data section itself starts 16 bytes past the tree. Both 16s are
    // the same separator; subtracting it twice reads plausible-looking garbage
    // a few hundred bytes early, which decodes without throwing and returns the
    // wrong city. Ask how long that took to find.
    const offset = this.dataSectionStart + (node - node_count - 16);
    return this.#decode(offset).value;
  }

  #decode(offset) {
    const b = this.buf;
    const ctrl = b[offset];
    let type = ctrl >> 5;
    let ptr = offset + 1;

    if (type === 0) {
      type = b[ptr] + 7;
      ptr += 1;
    }

    if (type === T.POINTER) {
      const size = (ctrl >> 3) & 0x3;
      const v = ctrl & 0x7;
      let target;
      if (size === 0) {
        target = (v << 8) | b[ptr];
        ptr += 1;
      } else if (size === 1) {
        target = (v << 16) | (b[ptr] << 8) | b[ptr + 1];
        ptr += 2;
        target += 2048;
      } else if (size === 2) {
        target = (v << 24) | (b[ptr] << 16) | (b[ptr + 1] << 8) | b[ptr + 2];
        ptr += 3;
        target += 526336;
      } else {
        target = b.readUInt32BE(ptr);
        ptr += 4;
      }
      // A pointer is resolved against the data section, and does not move the
      // caller's cursor past the pointer itself.
      return { value: this.#decode(this.dataSectionStart + target).value, next: ptr };
    }

    // Payload size: 0-28 inline, then one/two/three extra length bytes.
    let size = ctrl & 0x1f;
    if (size === 29) {
      size = 29 + b[ptr];
      ptr += 1;
    } else if (size === 30) {
      size = 285 + b.readUInt16BE(ptr);
      ptr += 2;
    } else if (size === 31) {
      size = 65821 + (b[ptr] << 16) + (b[ptr + 1] << 8) + b[ptr + 2];
      ptr += 3;
    }

    switch (type) {
      case T.UTF8:
        return { value: b.toString("utf8", ptr, ptr + size), next: ptr + size };
      case T.DOUBLE:
        return { value: b.readDoubleBE(ptr), next: ptr + 8 };
      case T.FLOAT:
        return { value: b.readFloatBE(ptr), next: ptr + 4 };
      case T.BYTES:
        return { value: b.subarray(ptr, ptr + size), next: ptr + size };
      case T.UINT16:
      case T.UINT32:
      case T.UINT64:
      case T.UINT128: {
        // Unsigned ints are variable-length big-endian with leading zero bytes
        // omitted, so a "uint32" field can occupy 0..4 bytes.
        let n = 0;
        for (let i = 0; i < size; i++) n = n * 256 + b[ptr + i];
        return { value: n, next: ptr + size };
      }
      case T.INT32: {
        let n = 0;
        for (let i = 0; i < size; i++) n = (n << 8) | b[ptr + i];
        if (size > 0 && size < 4) {
          const shift = 32 - size * 8;
          n = (n << shift) >> shift;
        }
        return { value: n, next: ptr + size };
      }
      case T.BOOLEAN:
        return { value: size !== 0, next: ptr };
      case T.MAP: {
        const map = {};
        let cur = ptr;
        for (let i = 0; i < size; i++) {
          const k = this.#decode(cur);
          const v = this.#decode(k.next);
          map[k.value] = v.value;
          cur = v.next;
        }
        return { value: map, next: cur };
      }
      case T.ARRAY: {
        const arr = [];
        let cur = ptr;
        for (let i = 0; i < size; i++) {
          const v = this.#decode(cur);
          arr.push(v.value);
          cur = v.next;
        }
        return { value: arr, next: cur };
      }
      case T.CONTAINER:
      case T.END_MARKER:
        return { value: null, next: ptr };
      default:
        throw new MMDBError(`unknown MMDB type ${type} at ${offset}`);
    }
  }
}

const UNKNOWN = Object.freeze({
  country: "", countryName: "", city: "", region: "", lat: null, lng: null,
});

/**
 * Wraps a reader with the shape the stats accumulator wants, and a cache.
 *
 * The cache matters more than it looks: a log run resolves the same handful of
 * scanner addresses thousands of times, and a trie walk per hit would dominate
 * the run. Bounded so a spray from many sources cannot grow it without limit.
 */
export class GeoLookup {
  constructor(reader, { cacheLimit = 20000 } = {}) {
    this.reader = reader;
    this.cache = new Map();
    this.cacheLimit = cacheLimit;
  }

  /** A lookup that always answers, even with no database loaded. */
  static none() {
    return new GeoLookup(null);
  }

  get available() {
    return Boolean(this.reader);
  }

  lookup(ip) {
    if (!this.reader || !ip) return UNKNOWN;
    const hit = this.cache.get(ip);
    if (hit) return hit;

    let out = UNKNOWN;
    try {
      const rec = this.reader.get(ip);
      if (rec) {
        const country = rec.country?.iso_code ?? rec.registered_country?.iso_code ?? "";
        const sub = Array.isArray(rec.subdivisions) ? rec.subdivisions[0] : null;
        out = {
          country,
          countryName: rec.country?.names?.en ?? rec.registered_country?.names?.en ?? "",
          city: rec.city?.names?.en ?? "",
          region: sub?.names?.en ?? sub?.iso_code ?? "",
          lat: typeof rec.location?.latitude === "number" ? rec.location.latitude : null,
          lng: typeof rec.location?.longitude === "number" ? rec.location.longitude : null,
        };
      }
    } catch {
      // A malformed record must not take down a stats run over one address.
      out = UNKNOWN;
    }

    if (this.cache.size >= this.cacheLimit) this.cache.clear();
    this.cache.set(ip, out);
    return out;
  }
}
