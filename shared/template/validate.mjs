// Template validation.
//
// This is the mechanical half of the template contract. docs/TEMPLATE-SPEC.md
// says what a template may do; this decides whether one actually does it, and
// says where it went wrong with a file and a line.
//
// It exists because a spec nobody can check is a spec that gets violated. That
// is true of people and it is emphatically true of an LLM writing a template
// from the spec: `{{post.headlien}}` renders as nothing at all, and the failure
// surfaces as a blank space on a published page rather than as an error. So
// every path a template reads is resolved against the same tables the renderer
// projects, statically, before anything is published.
//
// Pure: the caller reads the files. cli/validate-template.mjs does it from disk;
// the admin does it from an upload.

import { checkManifest, compileTemplate, manifestFiles, ENGINE } from "./manifest.mjs";
import { usedPaths, usedPartials } from "./engine.mjs";
import { resolveViewPath } from "./viewmodel.mjs";
import { renderSite } from "../render.mjs";
import { normalizeContent } from "../content.mjs";

// A template must be self-contained: everything it needs ships inside the
// package. An external stylesheet, font or image is a third-party request on
// every page load, a tracking vector we did not choose, and a dependency that
// can break a customer's site without anyone touching it.
const EXTERNAL_ASSET_RE =
  /<(?:link|img|script|source|video|audio|iframe)\b[^>]*\b(?:href|src)\s*=\s*["']?(https?:)?\/\//gi;
// A <script> element, with whatever sits between its tags.
const SCRIPT_EL_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>|<script\b([^>]*)\/>/gi;
// The ONE permitted shape: a src that is entirely a mustache interpolation, so
// the URL comes from the view model -- template.scripts, which the platform
// fills with its own search client -- and never from a literal path the template
// picked. That keeps "a template ships no JavaScript of its own" true while
// letting the platform deliver behaviour to every template at once.
const SRC_IS_INTERPOLATED = /\ssrc\s*=\s*"\{\{[^"]*\}\}"|\ssrc\s*=\s*'\{\{[^']*\}\}'/i;
const IMPORT_RE = /@import\s+(?:url\()?["']?(https?:)?\/\//gi;

const problem = (file, line, message) => ({ level: "error", file, line, message });
const warning = (file, line, message) => ({ level: "warning", file, line, message });

/**
 * @param sources  { "template.json": "…", "layouts/index.html": "…", … }
 * @returns { ok, manifest, findings } -- findings carry level/file/line/message
 */
export function validateTemplate(sources) {
  const findings = [];

  // ---- 1. the manifest parses
  const rawJson = sources["template.json"];
  if (rawJson === undefined) {
    return { ok: false, manifest: null, findings: [problem("template.json", 1, "No template.json in the package.")] };
  }
  let raw;
  try {
    raw = JSON.parse(rawJson);
  } catch (err) {
    return { ok: false, manifest: null, findings: [problem("template.json", 1, `Not valid JSON: ${err.message}`)] };
  }

  // ---- 2. the manifest is well formed
  const { manifest, problems } = checkManifest(raw);
  for (const p of problems) findings.push(problem("template.json", 1, p));
  if (problems.length) return { ok: false, manifest, findings };

  // ---- 3. every file the manifest names is present
  for (const rel of manifestFiles(manifest)) {
    if (sources[rel] === undefined) {
      findings.push(problem("template.json", 1, `Declares "${rel}", which is not in the package.`));
    }
  }
  if (findings.some((f) => f.level === "error")) return { ok: false, manifest, findings };

  // ---- 4. every layout and partial compiles
  const pkg = compileTemplate(manifest, sources);
  for (const m of pkg.missing) findings.push(problem("template.json", 1, `Missing file for ${m}`));
  for (const e of pkg.errors) {
    const [file, line, ...rest] = String(e).split(":");
    findings.push(problem(file, Number(line) || 1, rest.join(":").trim() || e));
  }
  if (findings.some((f) => f.level === "error")) return { ok: false, manifest, findings };

  // ---- 5. self-containment
  for (const [rel, text] of Object.entries(sources)) {
    if (!/\.(html|css)$/.test(rel)) continue;
    const lineOf = (idx) => text.slice(0, idx).split("\n").length;

    for (const m of text.matchAll(EXTERNAL_ASSET_RE)) {
      findings.push(problem(rel, lineOf(m.index),
        "External asset reference. Templates are self-contained -- ship the file in the package " +
        "and reference it relatively, so a page makes no third-party request."));
    }
    for (const m of text.matchAll(IMPORT_RE)) {
      findings.push(problem(rel, lineOf(m.index), "@import of an external stylesheet. Ship the CSS in the package instead."));
    }
    if (rel.endsWith(".html")) {
      for (const m of text.matchAll(SCRIPT_EL_RE)) {
        const attrs = m[1] ?? m[3] ?? "";
        const body = m[2] ?? "";

        // `<script src="{{...}}"></script>` is how a template renders
        // template.scripts, which is where the platform's search client
        // arrives. Anything else -- an inline body, or a literal src the
        // template chose -- is refused, because reading a page must not depend
        // on JavaScript a template shipped itself.
        if (SRC_IS_INTERPOLATED.test(attrs) && !body.trim()) continue;

        findings.push(problem(rel, lineOf(m.index), body.trim()
          ? "Inline <script> in a template. Reading a page must not require JavaScript. " +
            "Structured data is available as {{{seo.jsonLd}}}."
          : '<script> with a literal src. The only permitted form is ' +
            '<script src="{{.}}"> inside {{#each template.scripts}}, so the URL comes ' +
            "from the view model rather than from the template."));
      }
    }
  }

  // ---- 6. every partial reference is declared
  const declaredPartials = new Set(Object.keys(manifest.partials ?? {}));
  const checkPartials = (nodes, file) => {
    for (const { name, line } of usedPartials(nodes)) {
      if (!declaredPartials.has(name)) {
        findings.push(problem(file, line,
          `{{> ${name}}} is not declared. Add it to "partials" in template.json.`));
      }
    }
  };
  for (const [layout, nodes] of Object.entries(pkg.layouts)) checkPartials(nodes, manifest.layouts[layout]);
  for (const [name, nodes] of Object.entries(pkg.partials)) checkPartials(nodes, manifest.partials[name].path);

  // ---- 7. every path resolves against the view model
  const tokenKeys = Object.keys(manifest.tokens ?? {});

  const checkPaths = (nodes, { file, layout, scopeType = null }) => {
    for (const { path, scope, line } of usedPaths(nodes)) {
      const res = resolveViewPath(layout, path, { scope, scopeType, tokenKeys });
      if (res.ok) continue;
      const hint = res.known?.length
        ? ` Available here: ${[...new Set(res.known)].slice(0, 12).join(", ")}.`
        : "";
      findings.push(problem(file, line, `{{${path}}} -- ${res.reason}.${hint}`));
    }
  };

  for (const [layout, nodes] of Object.entries(pkg.layouts)) {
    checkPaths(nodes, { file: manifest.layouts[layout], layout });
  }
  for (const [name, nodes] of Object.entries(pkg.partials)) {
    const spec = manifest.partials[name];
    // A partial with no declared context is rendered against a layout's own
    // roots, so it may only read what every layout has. One that declares a
    // context may also read that shape's fields bare, the way {{> card}} does
    // inside {{#each posts}}.
    checkPaths(nodes, { file: spec.path, layout: "index", scopeType: spec.context });
  }

  // ---- 8. it survives an actual render
  //
  // Static checks miss what only shows up when the pieces run together: a
  // partial that includes itself, a layout that never opens <html>. Rendering a
  // fixture is cheap and catches all of it.
  if (!findings.some((f) => f.level === "error")) {
    try {
      const { files } = renderSite({ template: pkg, site: FIXTURE_SITE, theme: {}, records: FIXTURE_RECORDS });
      for (const [name, html] of Object.entries(files)) {
        if (!name.endsWith(".html")) continue;
        if (!/<html[\s>]/i.test(html)) {
          findings.push(problem(name, 1, "Rendered output has no <html> element -- is the head partial included?"));
        }
        if (!/<\/body>/i.test(html)) {
          findings.push(problem(name, 1, "Rendered output has no </body> -- is the footer partial included?"));
        }
      }
    } catch (err) {
      findings.push(problem("(render)", 1, `Rendering the fixture failed: ${err.message}`));
    }
  }

  // ---- 9. advisory
  if (!manifest.description) findings.push(warning("template.json", 1, 'No "description" -- the library listing will be blank.'));
  if (!manifest.license) findings.push(warning("template.json", 1, 'No "license".'));
  return { ok: !findings.some((f) => f.level === "error"), manifest, findings };
}

// ------------------------------------------------------------------ fixture
// Deliberately awkward: a post with everything, a post with nothing, a podcast,
// a gallery, and a page. A template that renders all five renders any real site.
export const FIXTURE_SITE = {
  name: "Fixture Site", shortName: "Fixture", tagline: "A tagline",
  description: "A site used to smoke-test templates.",
  domain: "example.com", baseUrl: "https://example.com",
  author: "A. Person", authorUrl: "https://example.com/about",
  org: "Example", orgUrl: "https://example.org",
  locale: "en-US", language: "en-us",
  nav: [{ label: "Archive", href: "/" }],
  podcast: { category: "Technology", explicit: false },
};

export const FIXTURE_RECORDS = [
  normalizeContent({
    type: "article", slug: "2026-01-02-full", date: "2026-01-02", status: "published",
    title: "A post with every field set", dek: "Including a dek.",
    category: "NEWS", categoryLabel: "News",
    body: "<p>Body copy.</p>", pullQuote: "A pull quote.", tags: ["one", "two"],
    source: { title: "Somewhere", url: "https://example.org/x", publisher: "Somewhere", figure: "$1M", discussionUrl: "https://example.org/d" },
  }),
  normalizeContent({
    type: "article", slug: "2026-01-01-bare", date: "2026-01-01", status: "published",
    title: "A post with nothing optional", body: "<p>Bare.</p>",
  }),
  normalizeContent({
    type: "podcast", slug: "2026-01-03-ep", date: "2026-01-03", status: "published",
    title: "An episode", dek: "With audio.", body: "<p>Show notes.</p>",
    audio: { url: "/media/audio/ep.mp3", mimeType: "audio/mpeg", byteLength: 1234, durationSeconds: 3725 },
  }),
  normalizeContent({
    type: "gallery", slug: "2026-01-04-shots", date: "2026-01-04", status: "published",
    title: "A gallery", dek: "With pictures.",
    // Authored the way a gallery is authored: prose and pictures in one body,
    // split apart by normalizeContent. One image carries dimensions and a
    // caption, one carries neither, because a template must handle both.
    body: '<p>Some prose.</p><p><img src="/media/1.jpg" alt="First" title="A caption" width="800" height="600"></p><img src="/media/2.jpg">',
  }),
  normalizeContent({
    type: "page", slug: "about", status: "published",
    title: "About", dek: "Who this is.", body: "<p>Standing page.</p>",
    nav: { label: "About", order: 1 },
  }),
];

export { ENGINE };
