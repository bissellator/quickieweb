// What a site's staging render was built from.
//
// Every content write re-renders staging, so the Publish view can trust a
// changeset computed against it -- unless something OTHER than content changed
// since: a template pushed and activated from the CLI, a site record edited by
// a script, a new version of a template the site tracks as "latest". None of
// those touch staging, so the changeset would read "up to date" while publishing
// would in fact re-render every page. The stamp records the non-content inputs
// of the last render; when they no longer match, staging is stale and the
// Publish view rebuilds before it reports anything.

import { createHash } from "node:crypto";

export const RENDER_STAMP_KEY = "_internal/rendered-with.json";

/**
 * @param site      the registry record
 * @param template  the loaded template, with its version resolved
 * @returns {{ template: string, hash: string }}
 */
export function renderStamp(site, template) {
  const label = `${template.manifest.id}@${template.version}${site.template?.scope === "site" ? " (site)" : ""}`;
  const hash = createHash("sha256").update(JSON.stringify({
    template: label,
    theme: site.theme ?? null,
    site: site.site ?? null,
    access: site.access?.default ?? null,
    taxonomy: site.taxonomy?.categories ?? null,
  })).digest("hex");
  return { template: label, hash };
}

/**
 * Why staging needs rebuilding, or null when it does not.
 * @param was  the stored stamp, or null when there is none
 * @param now  renderStamp() for the site as it is now
 */
export function staleReason(was, now) {
  if (!was?.hash) return "staging had no record of what it was built from";
  if (was.hash === now.hash) return null;
  if (was.template !== now.template) return `the template changed (${was.template} -> ${now.template})`;
  return "the site's settings or theme changed";
}
