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

// --------------------------------------------------------------- the shapes
// "string" | "boolean" | "number" | "<shape>" | "<shape>[]" | "<shape>|null"
export const SHAPES = {
  site: {
    name: "string", shortName: "string", tagline: "string", description: "string",
    baseUrl: "string", domain: "string", author: "string", authorUrl: "string",
    org: "string", orgUrl: "string", locale: "string", language: "string", lang: "string",
    feedUrl: "string", podcastUrl: "string", hasPodcast: "boolean",
    homeUrl: "string", faviconUrl: "string",
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
    isPodcast: "boolean", source: "source|null", audio: "audio|null", seo: "seo",
  },
  page: {
    type: "string", slug: "string", url: "string", absUrl: "string",
    title: "string", dek: "string", bodyHtml: "string",
    updatedDisplay: "string", inNav: "boolean", seo: "seo",
  },
  source: {
    label: "string", title: "string", url: "string",
    publisher: "string", figure: "string", discussionUrl: "string",
  },
  audio: {
    url: "string", absUrl: "string", mimeType: "string",
    byteLength: "number", duration: "string", durationSeconds: "number",
  },
  seo: { title: "string", description: "string", canonical: "string", noindex: "boolean", jsonLd: "string" },
};

// What each layout gets on top of the common roots.
export const COMMON_ROOTS = {
  site: "site", nav: "navItem[]", pages: "page[]", posts: "post[]",
  theme: "theme", build: "build", template: "templateInfo",
  // Per-page metadata. Present in every layout so one `head` partial serves all
  // of them; the renderer fills it from the post, the page, or the site.
  seo: "seo",
};

export const LAYOUT_ROOTS = {
  index: {},
  article: { post: "post" },
  page: { page: "page" },
  "404": {},
  archive: {},
  tag: { tag: "string", posts: "post[]" },
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

  // 1. the innermost {{#each}} item, or the context a partial declared
  const scopeType = forcedScope ?? (scope ? typeOfScope(layout, scope) : null);
  if (scopeType && SHAPES[scopeType] && Object.hasOwn(SHAPES[scopeType], parts[0])) {
    return walkFrom(SHAPES[scopeType][parts[0]], 1);
  }

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
    bodyHtml: sanitizeHtml(record.body ?? ""),
    pullQuote: record.pullQuote ?? "",
    tags: record.tags ?? [],
    isPodcast: record.type === "podcast",
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
      "@type": record.type === "podcast" ? "PodcastEpisode" : "NewsArticle",
      headline: record.title,
      description: record.dek,
      datePublished: record.date,
      ...(site.author ? { author: { "@type": "Person", name: site.author, url: site.authorUrl || undefined } } : {}),
      publisher: { "@type": "Organization", name: site.name },
      mainEntityOfPage: absUrl(site.baseUrl, url),
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
export function buildViewModel({ site, template, theme, posts, pages, nav = [], base = "", now = new Date() }) {
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
      // search.js is prepended by the platform, not declared by the template.
      // A template renders {{#each template.scripts}} and gets search behaviour
      // without shipping any JavaScript of its own -- which matters because the
      // validator forbids templates from carrying <script> at all.
      scripts: [
        linkTo("assets/search.js", base),
        ...(template.manifest.scripts ?? []).map((s) => linkTo(`assets/${s.split("/").pop()}`, base)),
      ],
    },
    theme: nestTokens(theme),
    posts,
    pages,
    nav,
  };
}

export { esc, absUrl };
