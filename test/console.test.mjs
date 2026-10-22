// Static checks on the admin console's markup and its script.
//
//   node --test test/console.test.mjs
//
// The console is browser code with no test runner in front of it, so the
// failures it has actually shipped were all of one kind: a reference to an
// element id that does not exist. `document.getElementById` returns null, the
// next line sets a property on it, and the whole console goes blank -- from a
// typo that a parser could have caught.
//
// These read the two files as text. No DOM, no browser, no framework.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI = path.join(ROOT, "admin", "ui");

const html = await readFile(path.join(UI, "index.html"), "utf8");
const app = await readFile(path.join(UI, "app.js"), "utf8");

/** Ids present in the markup, plus any the script injects into innerHTML. */
const declaredIds = new Set([
  ...[...html.matchAll(/\bid="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]),
  ...[...app.matchAll(/\bid="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]),
]);

test("every $(\"id\") in app.js resolves to an element that exists", () => {
  const used = new Set([...app.matchAll(/\$\("([a-zA-Z0-9_-]+)"\)/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !declaredIds.has(id));
  assert.deepEqual(missing, [],
    `app.js reads ids that nothing creates: ${missing.join(", ")}`);
});

test("every tab has the view it switches to", () => {
  // switchView resolves `${name}View` by convention rather than a lookup table.
  // A tab whose view is missing used to hide every view and then throw, which
  // is a blank console from one missing section.
  const tabs = [...html.matchAll(/data-view="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]);
  assert.ok(tabs.length >= 5, "expected the console to have tabs");
  for (const tab of tabs) {
    assert.ok(declaredIds.has(`${tab}View`),
      `tab "${tab}" has no #${tab}View section`);
  }
});

test("ALL_VIEWS names only sections that exist, and every view section", () => {
  const listed = (app.match(/const ALL_VIEWS = \[([\s\S]*?)\];/)?.[1] ?? "")
    .match(/"([a-zA-Z0-9_-]+)"/g).map((s) => s.replace(/"/g, ""));

  for (const id of listed) {
    assert.ok(declaredIds.has(id), `ALL_VIEWS names #${id}, which does not exist`);
  }
  // And the other direction: a view the hide-everything loop does not know
  // about stays on screen underneath the one being opened.
  const sections = [...html.matchAll(/<section class="view[^"]*" id="([a-zA-Z0-9_-]+)"/g)]
    .map((m) => m[1]);
  for (const id of sections) {
    assert.ok(listed.includes(id), `#${id} is a view but is not in ALL_VIEWS`);
  }
});

test("every tab that needs a site is marked, and the ones that do not are not", () => {
  // setTabsForSite hides these when nobody has a site yet, because each one
  // calls an API that answers 400 "No site selected".
  const needsSite = [...html.matchAll(/<button[^>]*data-needs-site[^>]*data-view="([a-z]+)"/g)]
    .map((m) => m[1]);
  assert.deepEqual(needsSite.sort(), ["admins", "articles", "comments", "design", "publish", "security", "stats"]);

  const aiTab = html.match(/<button[^>]*data-view="ai"[^>]*>/)?.[0] ?? "";
  assert.ok(aiTab, "expected a Build with AI tab");
  assert.ok(!aiTab.includes("data-needs-site"),
    "Build with AI must work with no site -- it is what someone with no site needs");
});

test("the error surface the handlers write into exists", () => {
  for (const id of ["globalErr", "gateErr", "designErr", "editErr", "adminErr", "securityErr", "commentsErr"]) {
    assert.ok(declaredIds.has(id), `#${id} is missing`);
  }
});
