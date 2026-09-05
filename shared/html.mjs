// HTML primitives shared by the template engine and the renderer.
// No filesystem, no S3, no network.

export const esc = (s = "") =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Escaping for a value interpolated into a CSS declaration. Design tokens reach
// the stylesheet from site config, and a token value containing `}` or `<` could
// otherwise close the rule and open a <style>-escaping payload.
export const escCss = (s = "") => String(s).replace(/[<>{}\\;@]/g, "");

// The post body is authored in a rich-text editor and stored as HTML. Admins are
// trusted, but stored HTML rendered onto a public page still deserves a
// conservative pass: a compromised admin session should not be able to plant a
// script tag that every reader then executes.
const SANITIZE = [
  [/<\s*(script|iframe|object|embed|form|link|meta|base)\b[\s\S]*?<\/\s*\1\s*>/gi, ""],
  [/<\s*(script|iframe|object|embed|form|link|meta|base)\b[^>]*\/?>/gi, ""],
  [/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ""],
  [/(href|src|action)\s*=\s*("|')?\s*javascript:[^"'\s>]*("|')?/gi, ""],
];

export function sanitizeHtml(html = "") {
  let out = String(html);
  for (const [re, rep] of SANITIZE) out = out.replace(re, rep);
  return out;
}

/** Absolute URL for a site-root path. Feeds need these; pages do not. */
export const absUrl = (baseUrl, u = "") =>
  /^https?:\/\//i.test(u) ? u : `${baseUrl}${u.startsWith("/") ? "" : "/"}${u}`;
