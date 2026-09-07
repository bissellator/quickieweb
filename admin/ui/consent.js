// The OAuth consent screen.
//
// Reuses the console's own sign-in: Google Identity Services proves who you
// are, the ID token is exchanged for a session, and only then is anything about
// the grant rendered. The list of sites you belong to is itself information, so
// it waits behind sign-in rather than beside it.
//
// The screen shows what you CANNOT grant as well as what you can. A site you
// are only an editor on appears greyed with the reason, because a site that is
// simply absent reads as a broken product rather than as a permission boundary.

import * as auth from "./auth.js";

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => { if (el) el.hidden = !on; };
const err = (el, msg) => { if (!el) return; el.textContent = msg ?? ""; show(el, Boolean(msg)); };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// The signed authorize request, handed over in the fragment rather than the
// query string: a fragment is not sent to the server on a page load and does
// not land in an access log.
const STATE = decodeURIComponent(location.hash.slice(1));

const only = (id) => {
  for (const s of ["signinStep", "grantStep", "doneStep", "failStep"]) show($(s), s === id);
};

const fail = (msg) => { only("failStep"); $("failBody").textContent = msg; };

let context = null;

const RESOURCE_LABEL = {
  content: "Posts and pages",
  templates: "Templates",
  static: "Static pages",
  theme: "Colours and fonts",
  media: "Images and audio",
  stats: "Visitor stats",
  members: "People",
  publish: "Publishing",
};

function renderSites() {
  $("clientName").textContent = `${context.client.name} wants access`;
  $("asWho").textContent = `Signed in as ${context.email}`;

  $("siteList").innerHTML = context.sites.map((s) => {
    const grants = s.suggested.map((sc) => sc.split(":")[2]);
    const uniq = [...new Set(grants)];
    const canGrant = uniq.length > 0;
    return `<div class="site${canGrant ? "" : " off"}">
      <div class="site-head">
        <label>
          <input type="checkbox" data-site="${esc(s.siteId)}"${canGrant ? "" : " disabled"}>
          ${esc(s.name)}
        </label>
        <span class="site-role">${esc(s.role)}</span>
      </div>
      <div class="grants">
        ${canGrant
          ? `<ul>${uniq.map((r) => `<li>${esc(RESOURCE_LABEL[r] ?? r)}</li>`).join("")}</ul>`
          : ""}
        ${s.refused.length && !canGrant
          ? `<p class="refused">You are ${esc(s.role)} here, so you cannot grant an application write access.</p>`
          : ""}
        ${s.refused.length && canGrant
          ? `<p class="refused">${s.refused.length} thing(s) you cannot grant were dropped.</p>`
          : ""}
      </div>
    </div>`;
  }).join("") || '<p class="muted">You are not a member of any site yet.</p>';

  // Publishing is never in the suggested set, and saying so is what makes the
  // grant legible. A screen that lists only what it takes asks the reader to
  // reason about the complement.
  $("foot").textContent =
    "Publishing is not included: this application cannot put anything live. "
    + "You can revoke this at any time from the console.";
}

async function loadContext() {
  try {
    context = await auth.api(`/consent?state=${encodeURIComponent(STATE)}`);
  } catch (e) {
    return fail(e.message);
  }
  only("grantStep");
  renderSites();
}

function onAuthChange(session, message) {
  if (message) return err($("signinErr"), message);
  if (!session) { only("signinStep"); return; }
  loadContext();
}

$("allow").addEventListener("click", async () => {
  err($("grantErr"), null);
  const chosen = [...document.querySelectorAll("[data-site]:checked")].map((c) => c.dataset.site);
  if (!chosen.length) return err($("grantErr"), "Tick at least one site, or press Cancel.");

  // Send only the scopes for the sites that were ticked. The server clamps
  // these against membership again -- the screen is a courtesy, the server is
  // the boundary.
  const scopes = context.sites
    .filter((s) => chosen.includes(s.siteId))
    .flatMap((s) => s.suggested);

  const btn = $("allow");
  btn.disabled = true;
  btn.textContent = "Approving...";
  try {
    const res = await auth.api("/consent", {
      method: "POST",
      body: JSON.stringify({ state: STATE, scopes, days: Number($("days").value) || 30 }),
    });
    only("doneStep");
    // Hand the code back to the application that asked for it.
    location.href = res.redirect;
  } catch (e) {
    err($("grantErr"), e.message);
    btn.disabled = false;
    btn.textContent = "Allow";
  }
});

$("cancel").addEventListener("click", () => {
  // Closing is the honest outcome: there is nowhere to send someone who
  // declined, and redirecting back with an error would hand the application a
  // response it may treat as a retryable failure.
  only("failStep");
  $("failBody").textContent = "Nothing was approved. You can close this window.";
});

async function boot() {
  if (!STATE) return fail("This page is opened by an application asking for access. There is nothing to approve.");
  const cfg = await (await fetch("config.json")).json();
  if (!cfg.googleClientId) return fail("This installation has no Google client id configured.");
  await auth.init(cfg.googleClientId, onAuthChange);
  auth.renderButton($("gbtn"));
}

boot().catch((e) => fail(e.message));
