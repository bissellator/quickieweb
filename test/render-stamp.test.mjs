import { test } from "node:test";
import assert from "node:assert/strict";

import { renderStamp, staleReason } from "../admin/lib/render-stamp.mjs";

const site = (over = {}) => ({
  template: { id: "stuck", version: "", scope: "site" },
  theme: { "color.bg": "#fff" },
  site: { name: "Stuck" },
  access: { default: "public" },
  taxonomy: { categories: { a: { label: "A" } } },
  ...over,
});
const tpl = (version) => ({ manifest: { id: "stuck" }, version });

test("an unchanged site is not stale", () => {
  const s = renderStamp(site(), tpl("1.0.0"));
  assert.equal(staleReason(s, renderStamp(site(), tpl("1.0.0"))), null);
});

test("a newer version of a tracked template is reported as a template change", () => {
  const was = renderStamp(site(), tpl("1.0.0"));
  assert.equal(staleReason(was, renderStamp(site(), tpl("1.0.1"))),
    "the template changed (stuck@1.0.0 (site) -> stuck@1.0.1 (site))");
});

test("a theme, settings, access or taxonomy change is stale", () => {
  const was = renderStamp(site(), tpl("1.0.0"));
  for (const over of [
    { theme: { "color.bg": "#000" } },
    { site: { name: "Other" } },
    { access: { default: "members" } },
    { taxonomy: { categories: {} } },
  ]) {
    assert.equal(staleReason(was, renderStamp(site(over), tpl("1.0.0"))), "the site's settings or theme changed");
  }
});

test("no stamp at all is stale", () => {
  assert.match(staleReason(null, renderStamp(site(), tpl("1.0.0"))), /no record/);
});
