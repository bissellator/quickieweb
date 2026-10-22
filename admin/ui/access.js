// Sign in to READ a protected site.
//
// The tenant router sends a reader here when a page needs a level they have not
// proved:   /access.html?site=<id>&next=<path>[&switch=1]
//
// Same sign-in as the console (auth.js): the identity provider proves who you
// are and the Lambda exchanges that for a session. Then one call,
// POST /api/access/grant, asks whether this person may read this site. If so it
// answers with a redirect to the site's own /__qw/session carrying a one-minute
// grant, and the edge turns that into a cookie for that site alone.
//
// switch=1 comes from the edge's "not available" page: the person is signed in
// as someone who cannot read that page, so the remembered session is dropped and
// the account chooser is shown again.
//
// for=comment is the comments library asking (shared/comments.mjs, signIn()):
// the same sign-in, but the grant is POST /api/comments/grant, and what it
// becomes is a commenter session on the site's host rather than a reading level.

import * as auth from "./auth.js";
import * as ms from "./ms-signin.js";

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => { if (el) el.hidden = !on; };
const err = (el, msg) => { if (!el) return; el.textContent = msg ?? ""; show(el, Boolean(msg)); };

const params = new URLSearchParams(location.search);
const SITE = (params.get("site") ?? "").toLowerCase();
const NEXT = params.get("next") ?? "/";
const SWITCH = params.get("switch") === "1";
const FOR_COMMENT = params.get("for") === "comment";

const only = (id) => {
  for (const s of ["signinStep", "workingStep", "deniedStep", "failStep"]) show($(s), s === id);
};
const fail = (msg) => { only("failStep"); $("failBody").textContent = msg; };

let asking = false;

async function requestGrant(session) {
  if (asking) return;
  asking = true;
  only("workingStep");
  $("workingWho").textContent = `Signed in as ${session.email}`;
  try {
    const res = await auth.api(FOR_COMMENT ? "/comments/grant" : "/access/grant", {
      method: "POST",
      body: JSON.stringify({ site: SITE, next: NEXT }),
    });
    location.replace(res.redirect);
  } catch (e) {
    asking = false;
    only("deniedStep");
    $("deniedBody").textContent = e.message;
  }
}

function onAuthChange(session, message) {
  if (message) { only("signinStep"); return err($("signinErr"), message); }
  if (!session) { only("signinStep"); return; }
  requestGrant(session);
}

$("switchAccount").addEventListener("click", () => {
  auth.signOut();
  asking = false;
  only("signinStep");
  auth.renderButton($("gbtn"));
});

async function boot() {
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(SITE)) {
    return fail("This page is opened by a protected site when it needs you to sign in. There is nothing to do here on its own.");
  }
  if (FOR_COMMENT) {
    document.title = "Sign in to comment - Quickieweb";
    $("signinTitle").textContent = `Sign in to comment on ${SITE}`;
    $("signinWho").textContent = "Your name is shown with what you write. Your email address is not.";
    $("workingTitle").textContent = "Back to the page...";
    $("deniedTitle").textContent = "You can't comment here";
    $("foot").textContent = "Signing in proves who you are. The site sees your name and an id that " +
      "is the same each time you comment, never your email address.";
  } else {
    $("signinTitle").textContent = `Sign in to read ${SITE}`;
  }
  const cfg = await (await fetch("config.json")).json();
  if (!cfg.googleClientId) return fail("This installation has no sign-in configured.");
  if (SWITCH) auth.signOut();
  only("signinStep");
  await auth.init(cfg.googleClientId, onAuthChange);
  auth.renderButton($("gbtn"));
  if (cfg.microsoftClientId) {
    show($("msbtn"), true);
    // Comes back to this same URL -- site and next intact -- signed in.
    $("msbtn").addEventListener("click", () => ms.start(cfg.microsoftClientId, location.href.replace(/[?&]switch=1/, "")));
  }
}

boot().catch((e) => fail(e.message));
