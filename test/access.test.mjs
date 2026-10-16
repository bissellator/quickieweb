// Who may read a published page: the levels, how a record inherits the site's
// default, and what is kept out of the listings.
//
//   node --test test/access.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCESS_LEVELS, levelForRole, admits, effectiveLevel, listedAt, edgeOverrides,
  normalizeSite, normalizeSiteAccess,
} from "../shared/site.mjs";
import { normalizeContent } from "../shared/content.mjs";
import { renderSite } from "../shared/render.mjs";
import { desiredEdgeState, planEdgeSync } from "../shared/access-plan.mjs";
import { loadTemplateFromDir } from "../cli/lib/template-fs.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

test("the content model and the platform model agree on the levels", () => {
  for (const level of ACCESS_LEVELS) assert.equal(normalizeContent({ access: level }).access, level);
  assert.equal(normalizeContent({ access: "wizard" }).access, "", "an unknown level inherits, it is not invented");
});

test("each level admits everyone at or above it, and nobody below", () => {
  assert.ok(admits("public", "public"));
  assert.ok(admits("viewer", "viewer") && admits("viewer", "editor") && admits("viewer", "admin"));
  assert.ok(!admits("viewer", "public"));
  assert.ok(admits("editor", "admin") && !admits("editor", "viewer"));
  assert.ok(admits("admin", "admin") && !admits("admin", "editor"));
});

test("an unknown level locks rather than opens", () => {
  assert.ok(!admits("wizard", "admin"), "a typo in a record must never make a page readable");
});

test("roles read at the matching level; owners, admins and staff read as admins", () => {
  assert.equal(levelForRole("owner"), "admin");
  assert.equal(levelForRole("admin"), "admin");
  assert.equal(levelForRole("staff"), "admin");
  assert.equal(levelForRole("editor"), "editor");
  assert.equal(levelForRole("viewer"), "viewer");
  assert.equal(levelForRole(null), "public", "not a member reads as the public");
});

test("a record follows the site default unless it sets its own", () => {
  assert.equal(effectiveLevel("", "viewer"), "viewer");
  assert.equal(effectiveLevel("editor", "viewer"), "editor");
  assert.equal(effectiveLevel("public", "viewer"), "public", "a page may be MORE open than its site");
  assert.equal(effectiveLevel("", ""), "public");
});

test("a site with no access block is public, so existing sites do not change", () => {
  assert.deepEqual(normalizeSite({}).access, { default: "public", edge: { site: null, paths: {} } });
  assert.equal(normalizeSiteAccess({ default: "nonsense" }).default, "public");
  assert.deepEqual(normalizeSiteAccess({ edge: { site: "nope", paths: { "/a.html": "editor", "b.html": "editor", "/c.html": "wizard" } } }).edge,
    { site: null, paths: { "/a.html": "editor" } });
});

test("listings carry only what the site's own readers may read", () => {
  assert.ok(listedAt("", "public"));
  assert.ok(!listedAt("viewer", "public"), "a viewer page must not appear on the public index");
  assert.ok(listedAt("viewer", "viewer"));
  assert.ok(!listedAt("editor", "viewer"));
  assert.ok(listedAt("public", "viewer"), "a page more open than its site may be listed");
});

test("the edge is told only about pages that differ from the default, and only published ones", () => {
  const recs = [
    { slug: "a", status: "published", access: "" },
    { slug: "b", status: "published", access: "editor" },
    { slug: "c", status: "published", access: "viewer" },   // same as the default
    { slug: "d", status: "draft", access: "admin" },        // not published: nothing to protect yet
    { slug: "e", status: "published", access: "public" },
  ];
  assert.deepEqual(edgeOverrides(recs, "viewer"), { "/b.html": "editor", "/e.html": "public" });
});

// ---- the renderer

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = await loadTemplateFromDir(path.join(ROOT, "templates", "plain"));

const SITE = { name: "S", baseUrl: "https://s.example", nav: [] };
const recs = [
  { type: "article", date: "2026-01-02", status: "published", title: "Open", slug: "open" },
  { type: "article", date: "2026-01-01", status: "published", title: "Secret", slug: "secret", access: "editor" },
  { type: "page", status: "published", title: "Team", slug: "team", access: "admin", nav: { label: "Team" } },
].map((r) => normalizeContent(r));

test("a restricted record is rendered but kept out of the index, nav, feed, search and articles.json", () => {
  const { files } = renderSite({ template: TEMPLATE, site: SITE, records: recs, access: "viewer" });
  assert.ok(files["secret.html"]?.includes("Secret"), "its own page exists; the edge guards it");
  assert.ok(files["team.html"]?.includes("Team"));
  assert.ok(files["index.html"].includes("Open"));
  assert.ok(!files["index.html"].includes("Secret"), "the editor post is not on the viewer-level index");
  assert.ok(!files["index.html"].includes("team.html"), "the admin page is not in the nav");
  for (const f of ["feed.xml", "search-index.json", "articles.json"]) {
    assert.ok(!files[f].includes("Secret") && !files[f].includes("secret.html"), `${f} leaks the restricted post`);
    assert.ok(!files[f].includes("Team"), `${f} leaks the restricted page`);
  }
});

test("on a public site with no levels set, nothing changes", () => {
  const plain = recs.map((r) => ({ ...r, access: "" }));
  const { files } = renderSite({ template: TEMPLATE, site: SITE, records: plain });
  assert.ok(files["index.html"].includes("Open") && files["index.html"].includes("Secret"));
  assert.ok(files["index.html"].includes("team.html"), "the page is in the nav");
});

// ---- syncing the edge store

const published = (slug, access = "") => ({ slug, status: "published", access });

test("a public site with no overrides needs nothing in the store", () => {
  assert.deepEqual(desiredEdgeState("public", [published("a")]), { site: null, paths: {} });
  assert.deepEqual(desiredEdgeState("public", [published("a", "editor")]),
    { site: "public", paths: { "/a.html": "editor" } }, "one protected page still needs the site entry the edge looks up first");
});

// The property the whole two-step sync exists for: at every moment, every page
// is at least as locked as it was before AND as it will be after.
const levelAt = (st, p) => st.paths[p] ?? st.site ?? "public";
const rank = (l) => ACCESS_LEVELS.indexOf(l);
const apply = (state, siteId, { puts, deletes }) => {
  const out = { site: state.site, paths: { ...state.paths } };
  for (const k of deletes) { if (k === siteId) out.site = null; else delete out.paths[k.slice(siteId.length)]; }
  for (const { key, value } of puts) { if (key === siteId) out.site = value; else out.paths[key.slice(siteId.length)] = value; }
  return out;
};

test("between the two steps nothing is more open than before or after, and the end state is exact", () => {
  const states = [
    { site: null, paths: {} },
    { site: "viewer", paths: {} },
    { site: "public", paths: { "/a.html": "admin" } },
    { site: "viewer", paths: { "/a.html": "public", "/b.html": "editor" } },
    { site: "admin", paths: { "/b.html": "viewer" } },
    { site: "editor", paths: { "/c.html": "public" } },
  ];
  const pages = ["/a.html", "/b.html", "/c.html", "/index.html", "/other.html"];
  for (const prev of states) {
    for (const next of states) {
      const plan = planEdgeSync("acme", prev, next);
      const mid = apply(prev, "acme", plan.before);
      assert.deepEqual(mid, plan.max, "the recorded intermediate state is what the store holds");
      for (const p of pages) {
        assert.ok(rank(levelAt(mid, p)) >= rank(levelAt(prev, p)) && rank(levelAt(mid, p)) >= rank(levelAt(next, p)),
          `${p}: ${JSON.stringify(prev)} -> ${JSON.stringify(next)} is briefly ${levelAt(mid, p)}`);
      }
      assert.deepEqual(apply(mid, "acme", plan.after), next, "the second step lands exactly on the new state");
    }
  }
});

test("store keys are the site id and the site id plus the path, nothing else", () => {
  const { before, after } = planEdgeSync("acme", { site: null, paths: {} }, { site: "viewer", paths: { "/t.html": "admin" } });
  const keys = [...before.puts, ...after.puts].map((x) => x.key);
  assert.ok(keys.every((k) => k === "acme" || k === "acme/t.html"), keys.join(", "));
  assert.ok(!keys.includes("_secret"), "a sync can never touch the signing secret");
});
