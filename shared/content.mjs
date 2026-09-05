// The stored content model.
//
// One record shape for everything a site publishes. `type` decides which layout
// renders it and which fields matter; the storage, the index, the admin list and
// the publish path do not branch on it at all.
//
//   article   a dated post
//   podcast   a dated post with an audio enclosure
//   page      an undated standing page (About, Contact, Colophon)
//
// Pages are a platform feature rather than a template's choice. A site that
// switches templates must not lose its About page, so every template is required
// to render `page` (see REQUIRED_LAYOUTS in template/manifest.mjs).
//
// Pure: no filesystem, no S3, no network. Both the admin and the CLI normalize
// through here so a record written by one is readable by the other.

export const CONTENT_TYPES = ["article", "podcast", "page"];
export const STATUSES = ["draft", "published"];

/** Dated types appear in the index and the feeds. Pages do not. */
export const isDated = (type) => type === "article" || type === "podcast";

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
    // Records predating the type field carried templateType with no "page" case.
    : (raw.templateType === "podcast" ? "podcast" : "article");

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
  }
  // Reserved because the renderer writes these itself; a page claiming one would
  // be silently overwritten at build time.
  if (["index", "404", "feed", "podcast", "articles", "taxonomy", "theme"].includes(record.slug)) {
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
