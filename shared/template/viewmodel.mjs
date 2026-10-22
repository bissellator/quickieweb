// The view model: the only data a template can see.
//
// This file is the contract in both directions. At render time buildViewModel()
// produces it; at validate time SHAPES and LAYOUT_ROOTS are walked to decide
// whether `{{post.headlien}}` is a typo. That double duty is the point -- a spec
// kept somewhere other than the code it describes is a spec that drifts, and a
// template author (human or LLM) then finds out at publish time.
//
// docs/TEMPLATE-SPEC.md is generated from these tables.

import { esc, sanitizeHtml, absUrl } from "../html.mjs";
import { extractImages } from "../content.mjs";

// --------------------------------------------------------------- the shapes
// "string" | "boolean" | "number" | "<shape>" | "<shape>[]" | "<shape>|null"
export const SHAPES = {
  site: {
    name: "string", shortName: "string", tagline: "string", description: "string",
    baseUrl: "string", domain: "string", author: "string", authorUrl: "string",
    org: "string", orgUrl: "string", locale: "string", language: "string", lang: "string",
    feedUrl: "string", podcastUrl: "string", hasPodcast: "boolean",
    homeUrl: "string", faviconUrl: "string",
    // True when the site takes comments (its Comments setting is not "off").
    // An article layout then renders <section data-qw-comments
    // data-qw-thread="{{post.slug}}"></section>, and the platform's comments
    // library -- already in template.scripts -- fills it in the browser.
    hasComments: "boolean",
  },
  build: { year: "string", generatedAt: "string", generator: "string" },
  templateInfo: { id: "string", name: "string", version: "string", stylesheets: "string[]", scripts: "string[]" },
  navItem: { label: "string", href: "string", external: "boolean", current: "boolean" },
  post: {
    type: "string", slug: "string", url: "string", absUrl: "string",
    title: "string", dek: "string",
    date: "string", dateDisplay: "string", dateIso: "string",
    category: "string", categorySlug: "string", categoryLabel: "string",
    bodyHtml: "string", pullQuote: "string", tags: "string[]",
    // The same tags, linkable: where the `tag` layout renders each one.
    tagRefs: "tagRef[]",
    isPodcast: "boolean", isGallery: "boolean",
    source: "source|null", audio: "audio|null",
    images: "image[]", cover: "image|null",
    // The <img>s inside bodyHtml, in order -- read out, not removed. For a post
    // whose pictures sit between its paragraphs, which `images` never holds.
    bodyImages: "image[]",
    // The neighbouring posts in index order (newest first). null at either end,
    // and on a post the site's listings leave out.
    newer: "postLink|null", older: "postLink|null",
    seo: "seo",
  },
  postLink: { slug: "string", url: "string", title: "string", dateDisplay: "string" },
  // One tag across the site. `url` is where the `tag` layout renders it, so it
  // is only a live link when the template has one.
  tagInfo: { name: "string", slug: "string", url: "string", count: "number" },
  tagRef: { name: "string", slug: "string", url: "string" },
  page: {
    type: "string", slug: "string", url: "string", absUrl: "string",
    title: "string", dek: "string", bodyHtml: "string",
    updatedDisplay: "string", inNav: "boolean", seo: "seo",
  },
  source: {
    label: "string", title: "string", url: "string",
    publisher: "string", figure: "string", discussionUrl: "string",
  },
  image: {
    url: "string", absUrl: "string", alt: "string", caption: "string",
    // 0 when unknown. A template writing width/height only when they are
    // truthy reserves the box and stops the grid reflowing as images load.
    width: "number", height: "number",
    // A smaller rendition for grids and cards; the full image when there is none.
    thumbUrl: "string",
  },
  audio: {
    url: "string", absUrl: "string", mimeType: "string",
    byteLength: "number", duration: "string", durationSeconds: "number",
  },
  seo: { title: "string", description: "string", canonical: "string", noindex: "boolean", jsonLd: "string" },
};

// What each layout gets on top of the common roots.
export const COMMON_ROOTS = {
  site: "site", nav: "navItem[]", pages: "page[]", posts: "post[]", tags: "tagInfo[]",
  theme: "theme", build: "build", template: "templateInfo",
  // Per-page metadata. Present in every layout so one `head` partial serves all
  // of them; the renderer fills it from the post, the page, or the site.
  seo: "seo",
};

export const LAYOUT_ROOTS = {
  index: {},
  article: { post: "post" },
  gallery: { post: "post" },
  page: { page: "page" },
  "404": {},
  archive: {},
  tag: { tag: "tagInfo", posts: "post[]" },
};

// --------------------------------------------------- static path resolution
const baseType = (t) => String(t).replace(/\[\]$/, "").replace(/\|null$/, "");
const isList = (t) => String(t).endsWith("[]");

/** The type a scope like `posts[]` or `post.source` denotes, or null. */
function typeOfScope(layout, scope) {
  if (!scope) return null;
  const res = resolveViewPath(layout, scope.replace(/\[\]$/, ""), { scope: null });
  return res.ok ? baseType(res.type) : null;
}

// The item type of an {{#each}} scope read from inside a shape -- a partial's
// declared context -- rather than from the layout roots. `bodyImages[]` inside a
// `post` partial is an `image`. Lists along the way are stepped through, since
// each `[]` in the scope is a loop that already did the iterating.
function typeOfScopeIn(shapeName, scope) {
  let type = shapeName;
  for (const key of scope.replace(/\[\]/g, "").split(".")) {
    const shape = SHAPES[baseType(type)];
    if (!shape || !Object.hasOwn(shape, key)) return null;
    type = shape[key];
  }
  return baseType(type);
}

/**
 * Can `path` be read here? Returns { ok, type } or { ok:false, reason, known }.
 *
 * Resolution matches the engine: try the enclosing {{#each}} shape first, then
 * fall back to the layout roots, so `{{site.name}}` works inside a loop.
 */
export function resolveViewPath(layout, path, { scope = null, scopeType: forcedScope = null, tokenKeys = null } = {}) {
  const roots = { ...COMMON_ROOTS, ...(LAYOUT_ROOTS[layout] ?? {}) };
  const parts = String(path).split(".");

  const walkFrom = (shapeName, from) => {
    let type = shapeName;
    for (let i = from; i < parts.length; i++) {
      const key = parts[i];
      const base = baseType(type);

      if (base === "theme") {
        if (!tokenKeys) return { ok: true, type: "string" };
        const rest = parts.slice(i).join(".");
        if (tokenKeys.includes(rest)) return { ok: true, type: "string" };
        if (tokenKeys.some((k) => k.startsWith(`${rest}.`))) return { ok: true, type: "theme" };
        return {
          ok: false,
          reason: `the template declares no token "${rest}"`,
          known: tokenKeys.map((k) => `theme.${k}`),
        };
      }

      const shape = SHAPES[base];
      if (!shape) return { ok: false, reason: `"${parts.slice(0, i).join(".")}" is a ${base}, which has no fields` };
      if (isList(type)) {
        return {
          ok: false,
          reason: `"${parts.slice(0, i).join(".")}" is a list -- iterate it with {{#each}} before reading "${key}"`,
        };
      }
      if (!Object.hasOwn(shape, key)) {
        return { ok: false, reason: `${base} has no field "${key}"`, known: Object.keys(shape).map((k) => `${parts.slice(0, i).join(".")}.${k}`) };
      }
      type = shape[key];
    }
    return { ok: true, type };
  };

  // 1. the innermost {{#each}} item, then the context a partial declared. The
  //    engine resolves through the same stack: a loop inside a `post` partial
  //    reads the item first and falls back to the post.
  const loopType = scope
    ? (forcedScope ? typeOfScopeIn(forcedScope, scope) ?? typeOfScope(layout, scope) : typeOfScope(layout, scope))
    : null;
  for (const t of [loopType, forcedScope]) {
    if (t && SHAPES[t] && Object.hasOwn(SHAPES[t], parts[0])) return walkFrom(SHAPES[t][parts[0]], 1);
  }
  const scopeType = loopType ?? forcedScope;

  // 2. the layout roots
  if (!Object.hasOwn(roots, parts[0])) {
    const inScope = scopeType ? Object.keys(SHAPES[scopeType] ?? {}) : [];
    return {
      ok: false,
      reason: `"${parts[0]}" is not available in the ${layout} layout`,
      known: [...inScope, ...Object.keys(roots)],
    };
  }
  return walkFrom(roots[parts[0]], 1);
}

// ------------------------------------------------------------ the projection
const fmtDate = (iso, locale = "en-US") =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString(locale, {
    year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  });

export const fmtDuration = (sec) => {
  if (!sec || !Number.isFinite(sec)) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
};

/** Flat token keys ("color.ink") become nested objects so templates read
 *  {{theme.color.ink}}. The CSS side keeps the flat key as --color-ink. */
export function nestTokens(theme = {}) {
  const out = {};
  for (const [key, value] of Object.entries(theme)) {
    const parts = key.split(".");
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts.at(-1)] = value;
  }
  return out;
}

// -------------------------------------------------------------- URLs
//
// Every URL a template receives is RELATIVE by default -- `about.html`, not
// `/about.html`. A site is flat (every page sits at the root), so a relative
// reference resolves correctly from any page AND from any base path the whole
// site is served under. That is what makes an authenticated preview possible:
// the same rendered bytes work at https://acme.quickieweb.com/ and at
// https://app.quickieweb.com/api/preview/<token>/ with no rewriting.
//
// Templates never build a path. Everything they need arrives already resolved,
// so `base` is the renderer's business and a template author cannot get it
// wrong.
//
// The one exception is 404.html, which CloudFront serves for ANY path --
// including /deep/missing, where a relative reference would resolve against
// /deep/. That page is rendered with base "/" instead. `<base href>` would have
// been the tidier fix and is a trap: it also re-bases in-page #anchors.
export const pathFor = (record) => `${record.slug}.html`;

/** A site-relative path -> a link for the base this page is rendered at. */
export const linkTo = (path, base = "") => `${base}${String(path).replace(/^\/+/, "")}`;

/** Kept for the file name; the link version is linkTo(pathFor(record), base). */
export const urlFor = (record) => `/${record.slug}.html`;

// Tag pages live one directory down, so a page rendered there is drawn with a
// base of "../" (or the preview prefix) -- see renderSite.
export const tagSlug = (name) =>
  String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tag";
export const tagPathFor = (name) => `tags/${tagSlug(name)}.html`;

/** Every tag on the given posts, most-used first, then alphabetically. */
export function buildTags(posts, base = "") {
  const counts = new Map();
  for (const p of posts) for (const t of new Set(p.tags ?? [])) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, slug: tagSlug(name), url: linkTo(tagPathFor(name), base), count }));
}

/**
 * JSON-LD arrives pre-wrapped in its <script> tag, written by {{{seo.jsonLd}}}.
 * Templates are not allowed literal <script> elements, and structured data is
 * too easy to get subtly wrong to leave to each template anyway.
 */
function jsonLdScript(obj) {
  // </script> inside a JSON string would close the element early; escaping the
  // slash keeps it valid JSON and inert HTML.
  const json = JSON.stringify(obj).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

function projectSeo(record, site, rootPath, jsonLd) {
  return {
    title: `${record.title}${site.shortName ? ` - ${site.shortName}` : ""}`,
    description: record.seo?.description || record.dek || site.description || "",
    canonical: absUrl(site.baseUrl, rootPath),
    noindex: Boolean(record.seo?.noindex),
    jsonLd: jsonLd ? jsonLdScript(jsonLd) : "",
  };
}

/** The seo root for a layout that renders no single record. */
export function siteSeo(site, { title, description, url = "/", noindex = false, jsonLd = null }) {
  return {
    title,
    description: description ?? site.description ?? "",
    canonical: absUrl(site.baseUrl, url),
    noindex,
    jsonLd: jsonLd ? jsonLdScript(jsonLd) : "",
  };
}

export function websiteJsonLd(site) {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: site.name,
    url: site.baseUrl,
    ...(site.description ? { description: site.description } : {}),
    ...(site.author ? { author: { "@type": "Person", name: site.author, url: site.authorUrl || undefined } } : {}),
  };
}

export function projectPost(record, site, base = "") {
  const url = linkTo(pathFor(record), base);
  const projectImage = (i) => ({
    url: linkTo(i.url, base),
    absUrl: absUrl(site.baseUrl, i.url),
    alt: i.alt ?? "",
    caption: i.caption ?? "",
    width: i.width ?? 0,
    height: i.height ?? 0,
    thumbUrl: linkTo(i.thumb || i.url, base),
  });
  const images = (record.images ?? []).map(projectImage);
  const bodyHtml = sanitizeHtml(record.body ?? "");
  // Only site-relative sources are linked against the base; an absolute URL in
  // a body (a hotlinked image) is passed through as written.
  const bodyImages = extractImages(bodyHtml).images.map((i) => /^https?:\/\//i.test(i.url)
    ? { ...projectImage(i), url: i.url, absUrl: i.url, thumbUrl: i.thumb || i.url }
    : projectImage(i));
  return {
    type: record.type,
    slug: record.slug,
    url,
    absUrl: absUrl(site.baseUrl, `/${pathFor(record)}`),
    title: record.title,
    dek: record.dek,
    date: record.date,
    dateDisplay: fmtDate(record.date, site.locale),
    dateIso: record.date,
    category: record.category ?? "",
    // Safe for a CSS class: templates write class="tag tag-{{categorySlug}}".
    categorySlug: String(record.category ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    categoryLabel: record.categoryLabel ?? "",
    // Raw HTML from the editor, sanitized once here so every template that
    // writes {{{post.bodyHtml}}} is safe by construction rather than by care.
    bodyHtml,
    pullQuote: record.pullQuote ?? "",
    tags: record.tags ?? [],
    tagRefs: (record.tags ?? []).map((name) => ({ name, slug: tagSlug(name), url: linkTo(tagPathFor(name), base) })),
    isPodcast: record.type === "podcast",
    isGallery: record.type === "gallery",
    images: images,
    // The first image stands in for the post: a card thumbnail, an og:image.
    cover: images[0] ?? null,
    bodyImages,
    // Filled by renderSite, which is the only place that knows the order.
    newer: null,
    older: null,
    source: record.source ?? null,
    audio: record.audio
      ? {
          url: linkTo(record.audio.url, base),
          absUrl: absUrl(site.baseUrl, record.audio.url),
          mimeType: record.audio.mimeType,
          byteLength: record.audio.byteLength,
          duration: fmtDuration(record.audio.durationSeconds),
          durationSeconds: record.audio.durationSeconds,
        }
      : null,
    seo: projectSeo(record, site, url, {
      "@context": "https://schema.org",
      "@type": record.type === "podcast" ? "PodcastEpisode"
        : record.type === "gallery" ? "ImageGallery"
        : "NewsArticle",
      headline: record.title,
      description: record.dek,
      datePublished: record.date,
      ...(site.author ? { author: { "@type": "Person", name: site.author, url: site.authorUrl || undefined } } : {}),
      publisher: { "@type": "Organization", name: site.name },
      mainEntityOfPage: absUrl(site.baseUrl, url),
      ...(images.length ? { image: images.map((i) => i.absUrl) } : {}),
      ...(record.audio?.url
        ? { associatedMedia: { "@type": "MediaObject", contentUrl: absUrl(site.baseUrl, record.audio.url) } }
        : {}),
    }),
  };
}

export function projectPage(record, site, base = "") {
  const url = linkTo(pathFor(record), base);
  return {
    type: "page",
    slug: record.slug,
    url,
    absUrl: absUrl(site.baseUrl, `/${pathFor(record)}`),
    title: record.title,
    dek: record.dek,
    bodyHtml: sanitizeHtml(record.body ?? ""),
    updatedDisplay: record.updatedAt ? fmtDate(record.updatedAt.slice(0, 10), site.locale) : "",
    inNav: Boolean(record.nav),
    seo: projectSeo(record, site, url, {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: record.title,
      description: record.dek,
      url: absUrl(site.baseUrl, url),
      isPartOf: { "@type": "WebSite", name: site.name, url: site.baseUrl },
    }),
  };
}

/**
 * Masthead navigation: the site's configured links, plus any page that asked to
 * be in the nav, ordered by the page's `nav.order`. A page can put itself in the
 * masthead without anyone editing config.json, which is what makes "add an About
 * page" a one-step operation in the admin.
 */
export function buildNav(site, pageRecords, currentUrl = null, base = "") {
  const configured = (site.nav ?? []).map((n) => {
    const external = Boolean(n.external) || /^https?:\/\//i.test(n.href ?? "");
    // "/" is the home link and has no filename to be relative to, so it becomes
    // the base itself -- "" under a prefix, which a browser reads as "this page's
    // directory". Rendered into href="" that is technically the current URL, so
    // the renderer substitutes homeUrl below instead.
    const href = external ? n.href : linkTo(n.href === "/" ? "index.html" : n.href, base);
    return { label: n.label, href, external, current: n.href === currentUrl };
  });

  const fromPages = pageRecords
    .filter((p) => p.nav?.label)
    .map((p) => ({ url: linkTo(pathFor(p), base), root: urlFor(p), label: p.nav.label, order: p.nav.order ?? 0 }))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
    .map((p) => ({ label: p.label, href: p.url, external: false, current: p.root === currentUrl }));

  return [...configured, ...fromPages];
}

/**
 * Everything common to every layout. Per-layout roots (`post`, `page`) are added
 * by the renderer.
 */
export const COMMENTS_LIB = "/__qw/lib/comments.js";

export function buildViewModel({ site, template, theme, posts, pages, nav = [], base = "", comments = false, now = new Date() }) {
  const hasPodcast = posts.some((p) => p.isPodcast && p.audio?.url);
  return {
    site: {
      name: site.name ?? "",
      shortName: site.shortName ?? site.name ?? "",
      tagline: site.tagline ?? "",
      description: site.description ?? "",
      baseUrl: site.baseUrl ?? "",
      domain: site.domain ?? "",
      author: site.author ?? "",
      authorUrl: site.authorUrl ?? "",
      org: site.org ?? "",
      orgUrl: site.orgUrl ?? "",
      locale: site.locale ?? "en-US",
      language: site.language ?? "en-us",
      // <html lang> wants the bare subtag, not the full locale.
      lang: String(site.locale ?? "en-US").split("-")[0],
      feedUrl: linkTo("feed.xml", base),
      podcastUrl: hasPodcast ? linkTo("podcast.xml", base) : "",
      hasPodcast,
      hasComments: comments,
      // The home link. Named rather than left as "/" so a template never has to
      // hardcode a root path, which is the one thing that would break a preview.
      homeUrl: linkTo("index.html", base),
      faviconUrl: linkTo("assets/favicon.svg", base),
    },
    build: {
      year: String(now.getUTCFullYear()),
      generatedAt: now.toISOString(),
      generator: "quickieweb",
    },
    template: {
      id: template.manifest.id,
      name: template.manifest.name,
      version: template.manifest.version,
      stylesheets: ["assets/theme.css", ...(template.manifest.styles ?? []).map((s) => `assets/${s.split("/").pop()}`)]
        .map((u) => linkTo(u, base)),
      // search.js and gallery.js are prepended by the platform, not declared by
      // the template; the template's own `scripts` follow them. On a site that
      // takes comments the comments library comes first of all: a root path,
      // because the edge serves it at /__qw/lib/ on every site host, never
      // from the site's own files. All of it arrives
      // through {{#each template.scripts}} -- the validator refuses any other
      // <script> -- so the URLs come from here, never from a template's markup.
      // A template with `platformAssets: false` gets only its own.
      scripts: [
        ...(comments ? [COMMENTS_LIB] : []),
        ...[
          ...(template.manifest.platformAssets === false ? [] : ["assets/search.js", "assets/gallery.js"]),
          ...(template.manifest.scripts ?? []).map((s) => `assets/${s.split("/").pop()}`),
        ].map((u) => linkTo(u, base)),
      ],
    },
    theme: nestTokens(theme),
    posts,
    pages,
    nav,
    tags: buildTags(posts, base),
  };
}

export { esc, absUrl };
