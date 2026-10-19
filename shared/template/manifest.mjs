// The template manifest: what a template package declares about itself.
//
// Everything here is pure. Reading a template package off disk (the CLI) or out
// of the platform bucket (the Lambda) is the caller's job; both hand the same
// { path: text } map to compileTemplate(). Keeping I/O out of shared/ is what
// lets one renderer serve both.

import { compile, TemplateError } from "./engine.mjs";
import { TOKEN_TYPES } from "./tokens.mjs";
import { CONTENT_TYPES } from "../content.mjs";

export const ENGINE = "quickieweb-template@1";

// A template that cannot render one of these cannot render a site. `page` is in
// the list because static pages are a platform feature, not a template's choice:
// a site that switches templates must not lose its About page.
export const REQUIRED_LAYOUTS = ["index", "article", "page", "404"];
export const OPTIONAL_LAYOUTS = ["archive", "tag", "gallery"];

// Re-exported, not redeclared. A second copy of this list lived here and had
// already drifted -- it still said article/podcast/page after `gallery` was a
// content type, so every template declaring support for one failed to validate
// with a message naming a list the platform no longer used.
export { CONTENT_TYPES };

// Shapes a partial may declare itself rendered against. "post" and "page" cover
// the two loops that matter; null means "the layout's own roots".
export const PARTIAL_CONTEXTS = ["post", "page", "navItem"];

const ID_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;
// Paths inside a template package. No absolute paths, no traversal, no
// backslashes -- a template is untrusted input and its manifest names files that
// something will go and read.
const PKG_PATH_RE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._\-/]*$/;

export class ManifestError extends Error {
  constructor(problems) {
    super(`Invalid template manifest:\n  - ${problems.join("\n  - ")}`);
    this.name = "ManifestError";
    this.problems = problems;
  }
}

/**
 * Validate a parsed template.json. Returns { manifest, problems } rather than
 * throwing, so the validator can report everything wrong at once instead of one
 * error per run.
 */
export function checkManifest(raw) {
  const problems = [];
  const m = raw && typeof raw === "object" ? raw : {};

  if (!ID_RE.test(m.id ?? "")) {
    problems.push('"id" must be lowercase letters, digits and hyphens, 3-40 chars');
  }
  if (typeof m.name !== "string" || !m.name.trim()) problems.push('"name" is required');
  if (!SEMVER_RE.test(m.version ?? "")) problems.push('"version" must be semver, e.g. "1.0.0"');
  if (m.engine !== ENGINE) problems.push(`"engine" must be "${ENGINE}"`);

  // ---- layouts
  const layouts = m.layouts ?? {};
  if (typeof layouts !== "object" || Array.isArray(layouts)) {
    problems.push('"layouts" must be an object of name -> path');
  } else {
    for (const req of REQUIRED_LAYOUTS) {
      if (!layouts[req]) problems.push(`"layouts.${req}" is required`);
    }
    for (const [name, p] of Object.entries(layouts)) {
      if (!REQUIRED_LAYOUTS.includes(name) && !OPTIONAL_LAYOUTS.includes(name)) {
        problems.push(`"layouts.${name}" is not a layout this engine renders ` +
          `(known: ${[...REQUIRED_LAYOUTS, ...OPTIONAL_LAYOUTS].join(", ")})`);
      }
      if (!PKG_PATH_RE.test(String(p))) problems.push(`"layouts.${name}" is not a safe package path`);
    }
  }

  // ---- partials
  //
  // A partial may declare the shape it is rendered against ("context"), because
  // partials take no parameters: `{{> card}}` inside `{{#each posts}}` reads
  // bare fields off the post. Without the declaration the validator has no way
  // to know what `{{title}}` inside card.html refers to, and every typo in a
  // partial would slip through to a published page.
  const partials = m.partials ?? {};
  const normalizedPartials = {};
  if (typeof partials !== "object" || Array.isArray(partials)) {
    problems.push('"partials" must be an object of name -> path (or name -> {path, context})');
  } else {
    for (const [name, value] of Object.entries(partials)) {
      if (!/^[a-z][a-z0-9-]*$/.test(name)) {
        problems.push(`partial name "${name}" must be lowercase letters, digits and hyphens`);
      }
      const spec = typeof value === "string" ? { path: value } : (value ?? {});
      if (!PKG_PATH_RE.test(String(spec.path))) {
        problems.push(`"partials.${name}" is not a safe package path`);
      }
      if (spec.context !== undefined && !PARTIAL_CONTEXTS.includes(spec.context)) {
        problems.push(`"partials.${name}.context" must be one of: ${PARTIAL_CONTEXTS.join(", ")}`);
      }
      normalizedPartials[name] = { path: String(spec.path), context: spec.context ?? null };
    }
  }

  // ---- tokens
  const tokens = m.tokens ?? {};
  if (typeof tokens !== "object" || Array.isArray(tokens)) {
    problems.push('"tokens" must be an object of key -> spec');
  } else {
    for (const [key, spec] of Object.entries(tokens)) {
      if (!/^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/.test(key)) {
        problems.push(`token "${key}" must be lowercase, dot- or underscore-separated`);
      }
      if (!spec || typeof spec !== "object") { problems.push(`token "${key}" must be an object`); continue; }
      if (!TOKEN_TYPES.includes(spec.type)) {
        problems.push(`token "${key}" has type "${spec.type}" (known: ${TOKEN_TYPES.join(", ")})`);
      }
      if (spec.default === undefined && !spec.optional) {
        problems.push(`token "${key}" needs a "default" or "optional": true`);
      }
      if (spec.type === "select" && !Array.isArray(spec.options)) {
        problems.push(`token "${key}" is a select and needs "options"`);
      }
    }
    // Token keys nest for templates ({{theme.color.ink}}), so a key that is a
    // prefix of another would have to be both a value and an object.
    const keys = Object.keys(tokens);
    for (const a of keys) {
      for (const b of keys) {
        if (a !== b && b.startsWith(`${a}.`)) {
          problems.push(`token "${a}" is a prefix of "${b}" -- one of them has to be renamed`);
        }
      }
    }
  }

  // ---- supports
  const supports = m.supports ?? ["article", "page"];
  if (!Array.isArray(supports) || supports.some((s) => !CONTENT_TYPES.includes(s))) {
    problems.push(`"supports" must be a subset of: ${CONTENT_TYPES.join(", ")}`);
  } else if (!supports.includes("page")) {
    problems.push('"supports" must include "page" -- static pages are a platform feature');
  }

  // ---- assets and scripts
  for (const f of m.styles ?? []) {
    if (!PKG_PATH_RE.test(String(f))) problems.push(`"styles" entry "${f}" is not a safe package path`);
  }
  for (const f of m.scripts ?? []) {
    if (!PKG_PATH_RE.test(String(f))) problems.push(`"scripts" entry "${f}" is not a safe package path`);
    else if (!String(f).endsWith(".js")) problems.push(`"scripts" entry "${f}" must be a .js file`);
  }
  if (m.platformAssets !== undefined && typeof m.platformAssets !== "boolean") {
    problems.push('"platformAssets" must be true or false');
  }
  for (const f of m.webfonts ?? []) {
    if (!f?.family) problems.push('each "webfonts" entry needs a "family"');
    if (!PKG_PATH_RE.test(String(f?.src ?? ""))) {
      problems.push(`webfont "${f?.family}" needs a "src" inside the package -- ` +
        "webfonts are self-hosted, so a page makes no third-party request");
    }
  }

  return {
    manifest: {
      ...m,
      partials: normalizedPartials,
      layouts: { ...(m.layouts ?? {}) },
      tokens: { ...(m.tokens ?? {}) },
      supports,
      styles: m.styles ?? [],
      scripts: m.scripts ?? [],
      webfonts: m.webfonts ?? [],
      // false: the site ships nothing of the platform's own -- no search or
      // gallery client, no default favicon, no generated-file banners. For a
      // site that must not be traceable to the installation serving it; the
      // template (or static files) supply whatever it needs instead.
      platformAssets: m.platformAssets !== false,
    },
    problems,
  };
}

/** checkManifest, but throwing. Used where a bad manifest is unrecoverable. */
export function parseManifest(raw) {
  const { manifest, problems } = checkManifest(raw);
  if (problems.length) throw new ManifestError(problems);
  return manifest;
}

/**
 * Compile a whole template package.
 *
 * @param manifest  a validated manifest
 * @param sources   { "layouts/index.html": "<!doctype…", … } -- every path the
 *                  manifest names, already read by the caller
 * @returns { manifest, layouts, partials, missing, errors }
 */
export function compileTemplate(manifest, sources) {
  const layouts = {};
  const partials = {};
  const missing = [];
  const errors = [];

  const take = (label, p, into, key) => {
    const src = sources[p];
    if (src === undefined || src === null) { missing.push(`${label} -> ${p}`); return; }
    try {
      into[key] = compile(src, p);
    } catch (err) {
      if (err instanceof TemplateError) errors.push(err.message);
      else throw err;
    }
  };

  for (const [name, spec] of Object.entries(manifest.partials ?? {})) take(`partials.${name}`, spec.path, partials, name);
  for (const [name, p] of Object.entries(manifest.layouts ?? {})) take(`layouts.${name}`, p, layouts, name);

  return { manifest, layouts, partials, missing, errors };
}

/** Every package-relative file a manifest refers to. Callers read exactly these. */
export function manifestFiles(manifest) {
  return [
    ...Object.values(manifest.layouts ?? {}),
    ...Object.values(manifest.partials ?? {}).map((p) => p.path),
    ...(manifest.styles ?? []),
    ...(manifest.scripts ?? []),
    ...(manifest.webfonts ?? []).map((f) => f.src),
  ].filter(Boolean);
}
