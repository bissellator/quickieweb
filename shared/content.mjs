// The stored content model.
//
// One record shape for everything a site publishes. `type` decides which layout
// renders it and which fields matter; the storage, the index, the admin list and
// the publish path do not branch on it at all.
//
//   article   a dated post
//   podcast   a dated post with an audio enclosure
//   gallery   a dated post with an image set
//   page      an undated standing page (About, Contact, Colophon)
//
// Pages are a platform feature rather than a template's choice. A site that
// switches templates must not lose its About page, so every template is required
// to render `page` (see REQUIRED_LAYOUTS in template/manifest.mjs).
//
// Pure: no filesystem, no S3, no network. Both the admin and the CLI normalize
// through here so a record written by one is readable by the other.

export const CONTENT_TYPES = ["article", "podcast", "gallery", "page"];
export const STATUSES = ["draft", "published"];

/** Dated types appear in the index and the feeds. Pages do not. */
export const isDated = (type) => type !== "page";

export const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const str = (v, fallback = "") => (typeof v === "string" ? v : fallback);
const today = () => new Date().toISOString().slice(0, 10);

function normalizeSource(raw) {
  if (!raw || typeof raw !== "object") return null;
  const source = {
    label: str(raw.label, "The story"),
    title: str(raw.title),
    url: str(raw.url),
    publisher: str(raw.publisher),
    figure: str(raw.figure),
    discussionUrl: str(raw.discussionUrl),
  };
  // A source with neither a title nor a URL is an empty card, which reads as a
  // rendering bug rather than as an absent source.
  return source.title || source.url ? source : null;
}

function normalizeAudio(raw) {
  if (!raw || typeof raw !== "object" || !str(raw.url)) return null;
  return {
    url: str(raw.url),
    mimeType: str(raw.mimeType, "audio/mpeg"),
    byteLength: Number(raw.byteLength) || 0,
    durationSeconds: Number(raw.durationSeconds) || 0,
    transcriptNote: str(raw.transcriptNote),
  };
}

function normalizeImages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((i) => (typeof i === "string" ? { url: i } : i))
    .filter((i) => i && typeof i === "object")
    .map((i) => ({
      url: str(i.url),
      alt: str(i.alt),
      caption: str(i.caption),
      // Zero means unknown. Emitting width/height when they ARE known lets a
      // template reserve the box and stops the grid reflowing as images arrive.
      width: Number(i.width) || 0,
      height: Number(i.height) || 0,
      // A smaller rendition for grids and cards. Empty means none; the view
      // model falls back to `url`, so a template can always write thumbUrl.
      thumb: str(i.thumb),
    }))
    .filter((i) => i.url);
}

// The console's upload writes `<base>.webp` and `<base>-thumb.webp` side by side
// (admin/server.mjs, media POST). Recognising that pair here means a gallery
// built from pasted uploads gets its thumbnails without the editor recording them.
const MEDIA_FULL_RE = /^\/?media\/(?!.*-thumb\.webp$).+\.webp$/;
const thumbFor = (url) => (MEDIA_FULL_RE.test(url) ? url.replace(/\.webp$/, "-thumb.webp") : "");

const IMG_RE = /<img\b[^>]*>/gi;
const attr = (tag, name) =>
  (tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i")) ?? [])
    .slice(2).find((v) => v !== undefined) ?? "";

/**
 * Pull <img> tags out of editor HTML into an image list, and return the prose
 * that is left. This is how a gallery is authored: images are pasted into the
 * body like any other post, and the grid is assembled from them.
 *
 * Done once here rather than at render time. The alternative -- regexing user
 * HTML on every render, in one process serving many tenants -- is the shape of
 * thing that eventually goes wrong on somebody else's content.
 */
export function extractImages(html = "") {
  const images = [];
  const body = String(html).replace(IMG_RE, (tag) => {
    const url = attr(tag, "src");
    if (!url) return "";
    images.push({
      url,
      alt: attr(tag, "alt"),
      caption: attr(tag, "title"),
      width: Number(attr(tag, "width")) || 0,
      height: Number(attr(tag, "height")) || 0,
      thumb: attr(tag, "data-thumb") || thumbFor(url),
    });
    return "";
  });
  // An <img> alone in a <p> or <figure> leaves an empty shell behind it.
  const prose = body
    .replace(/<(p|figure|div)\b[^>]*>(?:\s|&nbsp;|<br\s*\/?>)*<\/\1\s*>/gi, "")
    .trim();
  return { images, body: prose };
}

function normalizeNav(raw) {
  if (!raw || typeof raw !== "object" || !str(raw.label)) return null;
  return { label: str(raw.label), order: Number(raw.order) || 0 };
}

/**
 * Coerce anything into a valid record, filling defaults. Accepts `headline` as
 * an alias for `title`: the content model unified on `title` when pages arrived,
 * and records written before that are still readable.
 */
export function normalizeContent(raw = {}, { now = new Date().toISOString() } = {}) {
  const type = CONTENT_TYPES.includes(raw.type)
    ? raw.type
    // Records predating the type field carried templateType, which ohshelly used
    // for exactly this distinction.
    : (["podcast", "gallery"].includes(raw.templateType) ? raw.templateType : "article");

  const title = str(raw.title) || str(raw.headline);
  const slug = str(raw.slug) || (isDated(type)
    ? `${str(raw.date, today())}-${slugify(title)}`
    : slugify(title));

  const record = {
    type,
    slug,
    status: STATUSES.includes(raw.status) ? raw.status : "draft",
    title,
    dek: str(raw.dek),
    body: str(raw.body),
    pullQuote: str(raw.pullQuote),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === "string") : [],
    // Who may read it once published: one of ACCESS_LEVELS in shared/site.mjs,
    // or "" to follow the site's default. The list is repeated rather than
    // imported so this module stays free of the platform model; site.mjs is
    // what decides what a level means, and a test holds the two lists equal.
    access: ["public", "viewer", "editor", "admin"].includes(raw.access) ? raw.access : "",
    seo: {
      description: str(raw.seo?.description),
      noindex: Boolean(raw.seo?.noindex),
    },
    createdBy: str(raw.createdBy),
    createdAt: str(raw.createdAt, now),
    updatedBy: str(raw.updatedBy),
    updatedAt: str(raw.updatedAt, now),
  };

  if (isDated(type)) {
    record.date = DATE_RE.test(str(raw.date)) ? raw.date : today();
    // Uncategorized is a legitimate state: a site can declare no taxonomy, and
    // the template omits the chip when the label is empty.
    record.category = str(raw.category);
    record.categoryLabel = str(raw.categoryLabel);
    record.source = normalizeSource(raw.source);
    record.audio = type === "podcast" ? normalizeAudio(raw.audio) : null;
    if (type === "gallery") {
      // An explicit list always wins; extraction is the fallback that makes a
      // post authored as prose-with-pictures -- or imported from a site that
      // stored it that way -- come out as a gallery without anyone editing it.
      const given = normalizeImages(raw.images);
      if (given.length) {
        record.images = given;
      } else {
        const pulled = extractImages(record.body);
        record.images = normalizeImages(pulled.images);
        record.body = pulled.body;
      }
    } else {
      record.images = [];
    }
  } else {
    record.nav = normalizeNav(raw.nav);
  }

  return record;
}

/** Problems that must stop a publish. Returns [] when the record is publishable. */
export function validateContent(record) {
  const problems = [];

  if (!CONTENT_TYPES.includes(record.type)) {
    problems.push(`type must be one of: ${CONTENT_TYPES.join(", ")}`);
  }
  if (!SLUG_RE.test(record.slug ?? "")) {
    problems.push('slug must be lowercase letters, digits and hyphens');
  }
  if (!record.title?.trim()) problems.push("title is required");

  if (isDated(record.type)) {
    if (!DATE_RE.test(record.date ?? "")) problems.push("date must be YYYY-MM-DD");
    if (record.type === "podcast" && record.status === "published" && !record.audio?.url) {
      problems.push("a published podcast needs an audio file");
    }
    if (record.type === "gallery" && record.status === "published" && !record.images?.length) {
      problems.push("a published gallery needs at least one image");
    }
  }
  // Reserved because the renderer writes these itself; a page claiming one would
  // be silently overwritten at build time.
  if (["index", "404", "feed", "podcast", "articles", "taxonomy", "theme", "archive", "tags"].includes(record.slug)) {
    problems.push(`slug "${record.slug}" is reserved by the renderer`);
  }

  return problems;
}

/**
 * Newest first for dated content, then pages alphabetically.
 *
 * The two groups must not interleave: a page has no date, so comparing one
 * against a post has no meaningful answer, and falling through to a title
 * comparison scatters pages through the post stream.
 */
export function sortContent(records) {
  return [...records].sort((a, b) => {
    const aDated = isDated(a.type);
    const bDated = isDated(b.type);
    if (aDated !== bDated) return aDated ? -1 : 1;
    if (aDated) {
      return a.date < b.date ? 1 : a.date > b.date ? -1 : a.slug < b.slug ? 1 : -1;
    }
    return (a.title ?? "").localeCompare(b.title ?? "");
  });
}

export const publishedOnly = (records) => records.filter((r) => r.status === "published");

/**
 * What the console's content list shows for one record -- drafts included,
 * bodies not. Kept as one manifest beside the records (summary.json) so the
 * list is a single read instead of one per record. Written by whatever already
 * holds every record: a rebuild, a seed.
 */
export const summarizeContent = (a) => ({
  slug: a.slug, type: a.type, status: a.status,
  title: a.title, dek: a.dek, date: a.date ?? "",
  category: a.category, categoryLabel: a.categoryLabel,
  // The editor's tag picker offers every tag in use, gathered from this list.
  tags: a.tags ?? [],
  nav: a.nav ?? null, updatedAt: a.updatedAt,
});

/** The list order: dated content newest first, then undated pages by title. */
export const compareSummaries = (x, y) =>
  (y.date || "0").localeCompare(x.date || "0") || x.title.localeCompare(y.title);
