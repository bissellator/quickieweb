// What a publish never moves (admin/lib/publish-skip.mjs). Comments are written
// straight to live and never staged, so a publish that doesn't skip them sees
// them as files staging lost and deletes them -- which it did, on every publish.
import test from "node:test";
import assert from "node:assert/strict";

import { SKIP_PREFIXES, skippedByPublish } from "../admin/lib/publish-skip.mjs";
import { COMMENTS_PREFIX, PENDING_PREFIX } from "../admin/lib/comments.mjs";

test("a publish leaves readers' comments, published and waiting, alone", () => {
  assert.ok(SKIP_PREFIXES.includes(COMMENTS_PREFIX) && SKIP_PREFIXES.includes(PENDING_PREFIX));
  assert.ok(skippedByPublish("_comments/bible-eddie-conner/picture-x/20261025T185744113Z-claude0000000001-comment.json"));
  assert.ok(skippedByPublish("_pending/2026-09-04-hello/20261022T200337749Z-cdb3826faefd0a58-comment.json"));
});

test("a publish leaves the console and the article store alone, and moves the site", () => {
  for (const k of ["admin/app.js", "_internal/articles/index.json", "admins.json", "sitedata.json"]) assert.ok(skippedByPublish(k), k);
  for (const k of ["index.html", "assets/style.css", "bible-eddie-conner.html", "comments.html", "assets/_comments.js"]) {
    assert.ok(!skippedByPublish(k), k);
  }
});
