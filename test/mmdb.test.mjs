// Tests for the hand-rolled MaxMind DB reader.
//
// Run: node test/mmdb.test.mjs [path/to/city.mmdb]
//
// The address parsing and the decoder are checked without any database, so this
// runs anywhere. If a real .mmdb is passed (or found in the usual scratch
// place) the lookup path is exercised against known addresses too -- which is
// the only thing that would have caught the bug this reader shipped with: the
// data-section offset subtracted the 16-byte separator twice, and every lookup
// quietly returned a plausible wrong city instead of throwing.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { MMDBReader, MMDBError, GeoLookup } from "../admin/lib/mmdb.mjs";

let failures = 0;
const ok = (name) => console.log(`  ${name.padEnd(28)} ok`);
const check = (name, fn) => {
  try { fn(); ok(name); } catch (e) { failures++; console.error(`  ${name.padEnd(28)} FAIL  ${e.message}`); }
};

// ------------------------------------------------------------ address bytes
check("ipv4", () => {
  assert.deepEqual(MMDBReader.addressBytes("8.8.8.8"), [8, 8, 8, 8]);
  assert.deepEqual(MMDBReader.addressBytes("255.0.0.1"), [255, 0, 0, 1]);
});

check("ipv4 rejects", () => {
  for (const bad of ["8.8.8", "8.8.8.8.8", "256.0.0.1", "a.b.c.d", "", "-", null, undefined, 42]) {
    assert.equal(MMDBReader.addressBytes(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

check("ipv6 full", () => {
  const b = MMDBReader.addressBytes("2606:4700:4700:0000:0000:0000:0000:1111");
  assert.equal(b.length, 16);
  assert.deepEqual(b.slice(0, 4), [0x26, 0x06, 0x47, 0x00]);
  assert.equal(b[15], 0x11);
});

check("ipv6 compressed", () => {
  const full = MMDBReader.addressBytes("2606:4700:4700:0000:0000:0000:0000:1111");
  assert.deepEqual(MMDBReader.addressBytes("2606:4700:4700::1111"), full);
  assert.deepEqual(MMDBReader.addressBytes("::1"), [...new Array(15).fill(0), 1]);
  assert.deepEqual(MMDBReader.addressBytes("::"), new Array(16).fill(0));
});

check("ipv6 v4-mapped", () => {
  // Must come back as four bytes so the lookup enters at the v4 start node
  // rather than walking 96 zero bits it already skipped.
  assert.deepEqual(MMDBReader.addressBytes("::ffff:8.8.8.8"), [8, 8, 8, 8]);
});

check("ipv6 rejects", () => {
  for (const bad of ["2606::4700::1111", "gggg::1", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9"]) {
    assert.equal(MMDBReader.addressBytes(bad), null, `should reject ${bad}`);
  }
});

check("not an mmdb", () => {
  assert.throws(() => new MMDBReader(Buffer.from("hello world")), MMDBError);
  assert.throws(() => new MMDBReader("not a buffer"), MMDBError);
});

// ------------------------------------------------------------- GeoLookup
check("GeoLookup.none", () => {
  const g = GeoLookup.none();
  assert.equal(g.available, false);
  const r = g.lookup("8.8.8.8");
  assert.equal(r.country, "");
  assert.equal(r.lat, null);
});

// ------------------------------------------------------------- real database
// The real-database tests need an .mmdb, which is not vendored (it is 60 MB
// and it goes stale). Point at one with an argument or MMDB_PATH; without one
// these tests skip rather than fail.
const candidates = [
  process.argv[2],
  process.env.MMDB_PATH,
  "admin/data/dbip-city-lite.mmdb",
].filter(Boolean);
const dbPath = candidates.find((p) => existsSync(p));

if (!dbPath) {
  console.log("  (no .mmdb found; lookup tests skipped -- pass a path to run them)");
} else {
  const raw = readFileSync(dbPath);
  const buf = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  const reader = new MMDBReader(buf);
  const geo = new GeoLookup(reader);

  check("metadata", () => {
    assert.ok(reader.metadata.node_count > 0);
    assert.ok([24, 28, 32].includes(reader.metadata.record_size));
    assert.ok([4, 6].includes(reader.metadata.ip_version));
  });

  // The regression that matters. A wrong offset still decodes and still yields
  // a country -- just not the right one -- so assert on the actual values.
  check("known addresses", () => {
    const g = geo.lookup("8.8.8.8");
    assert.equal(g.country, "US", "8.8.8.8 must resolve to US");
    assert.equal(g.region, "California");
    assert.ok(g.lat > 30 && g.lat < 45, `8.8.8.8 latitude looks wrong: ${g.lat}`);
    assert.ok(g.lng < -100 && g.lng > -130, `8.8.8.8 longitude looks wrong: ${g.lng}`);

    assert.equal(geo.lookup("78.46.0.1").country, "DE", "Hetzner must resolve to DE");
    assert.equal(geo.lookup("119.93.116.116").country, "PH", "the scanner must resolve to PH");
  });

  check("v4-mapped matches v4", () => {
    assert.deepEqual(geo.lookup("::ffff:8.8.8.8"), geo.lookup("8.8.8.8"));
  });

  check("private and junk", () => {
    for (const ip of ["192.168.1.1", "10.0.0.1", "127.0.0.1", "not-an-ip", "-", ""]) {
      assert.equal(geo.lookup(ip).country, "", `${ip} must not resolve`);
    }
  });

  check("cache returns same object", () => {
    const g = new GeoLookup(reader);
    assert.equal(g.lookup("8.8.8.8"), g.lookup("8.8.8.8"));
  });

  check("throughput", () => {
    const g = new GeoLookup(reader, { cacheLimit: 1 });
    const t0 = Date.now();
    let resolved = 0;
    for (let i = 0; i < 5000; i++) {
      if (g.lookup(`${(i % 223) + 1}.${(i * 7) % 256}.${(i * 13) % 256}.${(i * 29) % 256}`).country) resolved++;
    }
    const ms = Date.now() - t0;
    assert.ok(resolved > 4000, `expected most public addresses to resolve, got ${resolved}`);
    assert.ok(ms < 5000, `5000 uncached lookups took ${ms}ms; the tree walk is not working`);
    console.log(`      (${resolved}/5000 resolved in ${ms}ms)`);
  });
}

if (failures) {
  console.error(`\n${failures} mmdb test(s) failed`);
  process.exit(1);
}
console.log("\nall mmdb tests passed");
