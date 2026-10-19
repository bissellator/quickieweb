// Design tokens: the customization contract between a template and a site.
//
// A template declares the knobs it exposes ("tokens" in template.json). A site
// stores overrides. Resolving the two produces one flat map, which is handed to
// templates as `theme.*` and emitted as CSS custom properties.
//
// The point of declaring them is that the admin's customization form is
// GENERATED from the manifest -- a template that adds a colour gets a colour
// picker for free, and a template cannot be customized in a way it did not
// anticipate. Anything a site should be able to change has to be a token.

import { escCss } from "../html.mjs";

export const TOKEN_TYPES = ["color", "font", "image", "text", "number", "select", "boolean"];

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const CSS_FN = /^(?:rgb|rgba|hsl|hsla|oklch|color)\([^;{}<>]*\)$/i;
// Font stacks are the one token type with a lot of legal punctuation. Allow
// letters, digits, spaces, quotes, commas and hyphens; nothing that could close
// a declaration.
const FONT_STACK = /^[A-Za-z0-9 ,'"\-_]+$/;

/** `color.ink` -> `--color-ink`. Dots and underscores both become hyphens. */
export const cssVarName = (key) => `--${String(key).replace(/[._]/g, "-")}`;

/**
 * Is this override safe and of the right shape? Returns null when fine, or a
 * message. Overrides arrive from site config, which an editor can write, so
 * they are validated rather than trusted.
 */
export function validateTokenValue(spec, value) {
  const type = spec?.type ?? "text";

  switch (type) {
    case "color":
      if (typeof value !== "string") return "must be a string";
      if (!HEX.test(value) && !CSS_FN.test(value) && !/^[a-z]+$/i.test(value)) {
        return "must be a hex colour, a CSS colour function, or a named colour";
      }
      return null;

    case "font":
      if (typeof value !== "string") return "must be a string";
      if (!FONT_STACK.test(value)) return "must be a plain CSS font stack";
      return null;

    case "image":
      if (typeof value !== "string") return "must be a URL string";
      if (!/^\/[\w\-./]*$/.test(value) && !/^https:\/\/[\w\-./?=&%]+$/i.test(value)) {
        return "must be a site-root path or an https URL";
      }
      return null;

    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
      if (spec.min !== undefined && value < spec.min) return `must be at least ${spec.min}`;
      if (spec.max !== undefined && value > spec.max) return `must be at most ${spec.max}`;
      return null;

    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";

    case "select": {
      const opts = (spec.options ?? []).map((o) => (typeof o === "string" ? o : o.value));
      return opts.includes(value) ? null : `must be one of: ${opts.join(", ")}`;
    }

    case "text":
      if (typeof value !== "string") return "must be a string";
      return value.length > 400 ? "must be 400 characters or fewer" : null;

    default:
      return `unknown token type "${type}"`;
  }
}

/**
 * Template defaults <- site overrides. Unknown override keys are dropped rather
 * than passed through: a token the template does not declare has no CSS variable
 * and no form field, so honouring it would only create a silent dependency on a
 * template that may be swapped out tomorrow.
 *
 * Returns { theme, warnings }.
 */
export function resolveTokens(manifest, overrides = {}) {
  const specs = manifest.tokens ?? {};
  const theme = {};
  const warnings = [];

  for (const [key, spec] of Object.entries(specs)) {
    if (spec.default !== undefined) theme[key] = spec.default;
  }

  for (const [key, value] of Object.entries(overrides)) {
    const spec = specs[key];
    if (!spec) {
      warnings.push(`theme.${key} is not a token of template "${manifest.id}" -- ignored`);
      continue;
    }
    if (value === null || value === undefined) continue;
    const problem = validateTokenValue(spec, value);
    if (problem) {
      warnings.push(`theme.${key} ${problem} -- using the template default`);
      continue;
    }
    theme[key] = value;
  }

  for (const [key, spec] of Object.entries(specs)) {
    if (theme[key] === undefined && !spec.optional) {
      warnings.push(`theme.${key} has no value and no default`);
    }
  }

  return { theme, warnings };
}

/**
 * The resolved tokens as a stylesheet. Templates link this and consume it as
 * `var(--color-ink)`, which is what lets a colour change be a config edit and a
 * rebuild rather than a template fork.
 *
 * Image tokens get two variables: the bare URL and a `url()` form, because a
 * background wants one and an <img src> wants the other.
 */
export function tokensToCss(manifest, theme) {
  const specs = manifest.tokens ?? {};
  const lines = [];

  for (const [key, value] of Object.entries(theme)) {
    if (value === undefined || value === null || value === "") continue;
    const type = specs[key]?.type ?? "text";
    const name = cssVarName(key);

    if (type === "image") {
      lines.push(`  ${name}: ${escCss(value)};`);
      lines.push(`  ${name}-url: url("${escCss(value)}");`);
    } else if (type === "boolean") {
      lines.push(`  ${name}: ${value ? 1 : 0};`);
    } else {
      lines.push(`  ${name}: ${escCss(String(value))};`);
    }
  }

  const faces = (manifest.webfonts ?? []).map((f) => `@font-face {
  font-family: ${JSON.stringify(String(f.family))};
  src: url("${escCss(f.src)}") format("${escCss(f.format ?? "woff2")}");
  font-weight: ${escCss(String(f.weight ?? "400"))};
  font-style: ${escCss(String(f.style ?? "normal"))};
  font-display: swap;
}`).join("\n");

  // No banner for a template that opted out of platform assets: it names the
  // tooling, and that site must not be traceable to it.
  const banner = manifest.platformAssets === false ? "" : `/* Generated from template "${escCss(manifest.id)}" tokens and this site's theme.
   Do not edit: cli/build.mjs and the admin both overwrite it on every build. */
`;
  return `${banner}${faces ? `${faces}\n\n` : ""}:root {
${lines.join("\n")}
}
`;
}

/**
 * The form the admin renders, grouped as the template asked. Purely derived --
 * the admin has no per-template knowledge and never needs updating when a new
 * template appears in the library.
 */
export function tokenForm(manifest, theme = {}) {
  const groups = new Map();
  for (const [key, spec] of Object.entries(manifest.tokens ?? {})) {
    const group = spec.group ?? "General";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({
      key,
      type: spec.type ?? "text",
      label: spec.label ?? key,
      help: spec.help ?? "",
      options: spec.options ?? null,
      optional: Boolean(spec.optional),
      default: spec.default ?? null,
      value: theme[key] ?? spec.default ?? null,
    });
  }
  return [...groups].map(([group, fields]) => ({ group, fields }));
}
