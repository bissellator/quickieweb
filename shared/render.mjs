// Rendering: content records + a template package -> the files a site is made of.
//
// Pure. No filesystem, no S3, no network. Both renderers call this -- cli/build.mjs
// from disk and the admin Lambda from the buckets -- so a page built locally and
// one published from the admin are byte-identical. If it lived in only one of
// them the two would drift, and nobody would notice until the diff was enormous.
//
// Templates control HTML. Feeds and machine-readable indexes are generated here
// and are NOT templatable: RSS and the iTunes podcast dialect have strict rules,
// and a template that gets them subtly wrong produces a feed that validates in a
// browser and fails in a podcast client a week later.

import { esc, escCss, absUrl } from "./html.mjs";
import { render } from "./template/engine.mjs";
import { resolveTokens, tokensToCss } from "./template/tokens.mjs";
import {
  buildViewModel, buildNav, projectPost, projectPage, urlFor, siteSeo, websiteJsonLd,
  buildTags, tagPathFor,
} from "./template/viewmodel.mjs";
import { isDated, publishedOnly, sortContent } from "./content.mjs";
import { listedAt } from "./site.mjs";
import { buildSearchIndex, CLIENT_SOURCE } from "./search.mjs";
import { CLIENT_SOURCE as GALLERY_CLIENT } from "./gallery.mjs";

export class RenderError extends Error {
  constructor(message) { super(message); this.name = "RenderError"; }
}

const contentType = (name) =>
  name.endsWith(".xml") ? "application/xml; charset=utf-8"
  : name.endsWith(".json") ? "application/json; charset=utf-8"
  : name.endsWith(".css") ? "text/css; charset=utf-8"
  : name.endsWith(".js") ? "text/javascript; charset=utf-8"
  : name.endsWith(".svg") || name.endsWith(".ico") ? "image/svg+xml"
  : "text/html; charset=utf-8";

/**
 * @param template  a compiled package from compileTemplate()
 * @param site      the `site` block of a site record
 * @param theme     the site's token overrides
 * @param records   content records (normalized). Drafts are dropped here.
 * @param access    the site's default reading level (ACCESS_LEVELS in site.mjs)
 * @returns { files, posts, pages, warnings }
 */
export function renderSite({ template, site, theme = {}, records = [], access = "public", base = "", comments = false, now = new Date() }) {
  const missing = ["index", "article", "page", "404"].filter((l) => !template.layouts[l]);
  if (missing.length) {
    throw new RenderError(
      `Template "${template.manifest.id}" is missing compiled layouts: ${missing.join(", ")}`);
  }

  const live = sortContent(publishedOnly(records));
  // Every published record gets its own page; the edge decides who may open it.
  // But the LISTINGS -- index, nav, feeds, search, articles.json -- are read at
  // the site's default level, so a more restricted record stays out of them.
  // Otherwise its title and summary would be published to people who cannot
  // read it, on the very page that is meant to hide it.
  const listed = (r) => listedAt(r.access, access);
  const allPostRecords = live.filter((r) => isDated(r.type));
  const allPageRecords = live.filter((r) => r.type === "page");
  const postRecords = allPostRecords.filter(listed);
  const pageRecords = allPageRecords.filter(listed);

  // `base` is where this rendering will be SERVED from. Empty means relative,
  // which works at a site's own domain and equally under a preview prefix. Only
  // 404.html differs, and only because CloudFront serves it for arbitrary paths.
  const posts = postRecords.map((r) => projectPost(r, site, base));
  const pages = pageRecords.map((r) => projectPage(r, site, base));

  const { theme: resolved, warnings } = resolveTokens(template.manifest, theme);

  const files = {};
  const draw = (layout, name, extra, currentUrl, pageBase = base) => {
    const model = {
      ...buildViewModel({
        site, template, theme: resolved,
        posts: pageBase === base ? posts : postRecords.map((r) => projectPost(r, site, pageBase)),
        pages: pageBase === base ? pages : pageRecords.map((r) => projectPage(r, site, pageBase)),
        nav: buildNav(site, pageRecords, currentUrl, pageBase), base: pageBase, comments, now,
      }),
      ...extra,
    };
    files[name] = render(template.layouts[layout], model, {
      partials: template.partials,
      template: `${template.manifest.id}/${layout}`,
    });
  };

  // A gallery renders through the `article` layout unless the template offers a
  // dedicated one, which is how `podcast` has always worked: declaring support
  // for a type is a manifest concern, having a separate layout for it is taste.
  // Requiring a `gallery` layout instead would invalidate every template ever
  // written against this engine, to no reader's benefit.
  const layoutFor = (post) => (post.isGallery && template.layouts.gallery ? "gallery" : "article");
  // Neighbours come from the LISTED order, so prev/next never leads a reader to
  // a post the index itself hides from them.
  const listedAtIndex = new Map(postRecords.map((r, i) => [r.slug, i]));
  const linkOf = (p) => (p ? { slug: p.slug, url: p.url, title: p.title, dateDisplay: p.dateDisplay } : null);
  for (const post of allPostRecords.map((r) => projectPost(r, site, base))) {
    const i = listedAtIndex.get(post.slug);
    if (i !== undefined) {
      post.newer = linkOf(posts[i - 1]);
      post.older = linkOf(posts[i + 1]);
    }
    draw(layoutFor(post), `${post.slug}.html`, { post, seo: post.seo }, post.url);
  }
  for (const page of allPageRecords.map((r) => projectPage(r, site, base))) {
    draw("page", `${page.slug}.html`, { page, seo: page.seo }, page.url);
  }

  // ---- optional layouts: rendered only when the template provides them
  if (template.layouts.archive) {
    draw("archive", "archive.html", {
      seo: siteSeo(site, { title: `Archive${site.shortName ? ` - ${site.shortName}` : ""}`, url: "/archive.html" }),
    }, "/archive.html");
  }
  if (template.layouts.tag) {
    // One directory down, so relative links climb back out. A preview's base is
    // already absolute and serves unchanged.
    const tagBase = base || "../";
    const tagPosts = postRecords.map((r) => projectPost(r, site, tagBase));
    for (const tag of buildTags(tagPosts, tagBase)) {
      const file = tagPathFor(tag.name);
      draw("tag", file, {
        tag,
        posts: tagPosts.filter((p) => p.tags.includes(tag.name)),
        seo: siteSeo(site, { title: `${tag.name}${site.shortName ? ` - ${site.shortName}` : ""}`, url: `/${file}` }),
      }, `/${file}`, tagBase);
    }
  }

  draw("index", "index.html", {
    seo: siteSeo(site, {
      title: `${site.name}${site.tagline ? ` - ${site.tagline}` : ""}`,
      url: "/",
      jsonLd: websiteJsonLd(site),
    }),
  }, "/");

  // Deliberately noindex: the 404 body is served for every unmatched path, and
  // an indexable one competes with the real pages for the same site's ranking.
  // Rendered against the site ROOT, not relatively. CloudFront serves this body
  // for any unmatched path -- /deep/missing included -- where a relative
  // stylesheet would resolve to /deep/assets/style.css and the page would arrive
  // unstyled. A preview passes its own prefix so the same reasoning holds there.
  draw("404", "404.html", {
    seo: siteSeo(site, {
      title: `Not found${site.shortName ? ` - ${site.shortName}` : ""}`,
      description: "That page is not here.",
      url: "/404.html",
      noindex: true,
    }),
  }, null, base || "/");

  // ---- generated, not templatable
  files["assets/theme.css"] = tokensToCss(template.manifest, resolved);

  // A template's own stylesheet and scripts are part of the file set, not a
  // separate copying step. They used to be moved server-side from the platform
  // bucket by rebuild(), which meant anything rendering WITHOUT a bucket -- a
  // preview -- produced pages whose stylesheet 404ed. One source of the complete
  // set is the fix; binary assets (webfonts) still need the server-side copy,
  // because they cannot travel as text.
  for (const rel of [...(template.manifest.styles ?? []), ...(template.manifest.scripts ?? [])]) {
    const body = template.sources?.[rel];
    if (typeof body === "string") files[`assets/${rel.split("/").pop()}`] = body;
  }

  // Every template links a favicon, and nothing was producing one: a site
  // created through the console had no assets/favicon.svg at all, so an S3
  // origin behind OAC answered every page load with a 403 for it. Generating a
  // plain default beats shipping one per template or 403ing forever.
  //
  // `platformAssets: false` opts out of this and of the search and gallery
  // clients below: that site supplies its own icon (a static file) and ships
  // nothing that names the platform.
  const platform = template.manifest.platformAssets !== false;
  if (platform) {
    files["assets/favicon.svg"] = defaultFavicon(site, resolved);
    // Browsers ask for /favicon.ico whether or not a page links one, and an S3
    // origin behind OAC answers a miss with 403 -- a red console line on every
    // single page load. The same SVG bytes served at that path silence it; the
    // content type is what browsers honour, not the extension.
    files["favicon.ico"] = files["assets/favicon.svg"];
  }

  // ---- search
  //
  // Emitted for every site, always. It costs nothing until somebody types: the
  // client fetches the index on first interaction with the box and never on page
  // load, so a reader who does not search never downloads it.
  //
  // Whether a box appears at all is the TEMPLATE's decision -- the platform
  // supplies the index and the behaviour, the template supplies the markup and
  // the styling. Exactly the split design tokens use.
  files["search-index.json"] = JSON.stringify(buildSearchIndex([...posts, ...pages]));
  if (platform) files["assets/search.js"] = CLIENT_SOURCE;

  // ---- galleries
  //
  // Emitted unconditionally, for the same reason and on the same terms as
  // search: it does nothing on a page with no [data-qw-gallery] in it, and
  // making the file set depend on what happens to be published means a site
  // gains and loses files as posts come and go.
  if (platform) files["assets/gallery.js"] = GALLERY_CLIENT;
  files["feed.xml"] = feedXml(site, posts);
  const pod = podcastXml(site, posts);
  if (pod) files["podcast.xml"] = pod;
  files["articles.json"] = indexJson(posts, pages);

  return { files, posts, pages, warnings, contentType };
}

/**
 * A default site mark: the first letter of the name on the template's accent.
 * Deliberately dull -- it exists so a new site is not broken on day one, and so
 * that replacing it is obviously worth doing.
 */
function defaultFavicon(site, theme) {
  const accent = theme["color.accent"] ?? theme["color.link"] ?? theme["color.ink"] ?? "#14161a";
  const paper = theme["color.paper"] ?? "#ffffff";
  const letter = [...String(site.name ?? "?").trim()][0]?.toUpperCase() ?? "?";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${esc(site.name ?? "")}">
  <rect width="64" height="64" rx="10" fill="${escCss(accent)}"/>
  <text x="32" y="45" text-anchor="middle" fill="${escCss(paper)}"
        font-family="Georgia, 'Times New Roman', serif" font-size="40" font-weight="700">${esc(letter)}</text>
</svg>
`;
}

// -------------------------------------------------------------------- feeds
function feedXml(site, posts) {
  const items = posts.slice(0, 30).map((p) => `  <item>
    <title>${esc(p.title)}</title>
    <link>${esc(p.absUrl)}</link>
    <guid isPermaLink="true">${esc(p.absUrl)}</guid>
    <pubDate>${new Date(`${p.date}T12:00:00Z`).toUTCString()}</pubDate>
${p.categoryLabel ? `    <category>${esc(p.categoryLabel)}</category>\n` : ""}    <description>${esc(p.dek)}</description>
  </item>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>${esc(site.name)}</title>
  <link>${esc(site.baseUrl)}</link>
  <description>${esc(site.description)}</description>
  <language>${esc(site.language ?? "en-us")}</language>
${items}
</channel></rss>
`;
}

/**
 * Only posts with a real audio enclosure. Returns null when there are none, so
 * the caller can skip writing a feed that would fail validation with zero items.
 *
 * Enclosure URLs are absolute: a podcast client has no page to resolve a
 * site-root path against and fails to fetch the episode without saying why.
 */
function podcastXml(site, posts) {
  const eps = posts.filter((p) => p.isPodcast && p.audio?.url);
  if (!eps.length) return null;
  const pod = site.podcast ?? {};

  const items = eps.slice(0, 100).map((p) => `  <item>
    <title>${esc(p.title)}</title>
    <link>${esc(p.absUrl)}</link>
    <guid isPermaLink="false">${esc(p.slug)}</guid>
    <pubDate>${new Date(`${p.date}T12:00:00Z`).toUTCString()}</pubDate>
    <description>${esc(p.dek)}</description>
    <enclosure url="${esc(p.audio.absUrl)}" type="${esc(p.audio.mimeType)}" length="${Number(p.audio.byteLength) || 0}"/>
    <itunes:duration>${esc(p.audio.duration || "0:00")}</itunes:duration>
    <itunes:summary>${esc(p.dek)}</itunes:summary>
    <itunes:explicit>${pod.explicit ? "true" : "false"}</itunes:explicit>
  </item>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
  <title>${esc(site.name)}</title>
  <link>${esc(site.baseUrl)}</link>
  <description>${esc(site.description)}</description>
  <language>${esc(site.language ?? "en-us")}</language>
${site.author ? `  <itunes:author>${esc(site.author)}</itunes:author>\n` : ""}  <itunes:summary>${esc(site.description)}</itunes:summary>
  <itunes:explicit>${pod.explicit ? "true" : "false"}</itunes:explicit>
  <itunes:category text="${esc(pod.category ?? "Technology")}"/>
${items}
</channel></rss>
`;
}

// The site's machine-readable manifest. A template's own scripts read it to build
// galleries, slideshows and filters in the browser, so it carries what those
// need: every post's images and the site's tags. URLs are relative to the site
// root, the directory this file is served from.
function indexJson(posts, pages) {
  return JSON.stringify({
    posts: posts.map((p) => ({
      slug: p.slug, url: p.url, date: p.date, title: p.title, dek: p.dek,
      category: p.category, categoryLabel: p.categoryLabel, type: p.type, tags: p.tags,
      // A gallery's set, or failing that the pictures inline in the body: a
      // script building a slideshow wants every image a post shows.
      images: (p.images.length ? p.images : p.bodyImages).map((i) => ({
        url: i.url, thumbUrl: i.thumbUrl, width: i.width, height: i.height, alt: i.alt, caption: i.caption,
      })),
    })),
    pages: pages.map((p) => ({ slug: p.slug, url: p.url, title: p.title })),
    tags: buildTags(posts).map(({ name, slug, url, count }) => ({ name, slug, url, count })),
  }, null, 2);
}

export { contentType, urlFor, absUrl };
