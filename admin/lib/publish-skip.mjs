// What a publish must never move, in either direction: never copied from
// staging, never deleted from live. admin/lib/store.mjs computeChangeset() is
// the one caller; kept apart from it, with no AWS SDK, so a test can hold it.
//
//   admin/          the console, the tool that fixes a bad publish
//   _internal/      the article store the admin edits from; deleting it once
//                   cost the entire source of truth behind a rendered site
//   admins.json, sitedata.json
//   _comments/, _pending/
//                   readers' comments, written straight to LIVE by the edge and
//                   never staged. To a publish they look like files staging no
//                   longer has, so before they were listed here every publish
//                   deleted every comment on the site.

import { COMMENTS_PREFIX, PENDING_PREFIX } from "./comments.mjs";

export const SKIP_PREFIXES = Object.freeze(["admin/", "_internal/", "admins.json", "sitedata.json", COMMENTS_PREFIX, PENDING_PREFIX]);

/** Whether a site-relative key is one a publish leaves alone. */
export const skippedByPublish = (key) => SKIP_PREFIXES.some((p) => key.startsWith(p));
