// Sign-in for the admin.
//
// Two credentials, and the distinction is why sign-in lasts more than an hour:
//
//   Google ID token -- a login ASSERTION. One hour, and Google Identity Services
//                      will not silently reissue one. Used exactly once, to
//                      prove who you are.
//   session token   -- issued by our own Lambda, HMAC-signed, 12 hours. This is
//                      what every subsequent request carries.
//
// The first version of this used the ID token directly as the credential, which
// meant being logged out every hour, potentially mid-article. That was wrong: an
// assertion is not a session.
//
// The session lives in sessionStorage, not localStorage, and is sent as a bearer
// header rather than a cookie. sessionStorage so a reload keeps you signed in but
// closing the tab does not leave a live credential on disk; a header rather than
// a cookie because a cookie is attached automatically to cross-site requests,
// which is the whole CSRF problem, and a header is not.
//
// None of this is the security boundary. The Lambda re-verifies the signature and
// re-checks admins.json on every single request.

const GIS_SRC = "https://accounts.google.com/gsi/client";
const HINT_KEY = "qw-admin-account";
const SESSION_KEY = "qw-admin-session";

// Renew this far ahead of real expiry so a long save never races the clock.
const RENEW_SKEW_MS = 5 * 60 * 1000;

let clientId = null;
let session = null;      // { token, expiresAt, email, role, name }
let onChange = () => {};
let gisReady = false;

export class AuthError extends Error {}

const remembered = () => {
  try { return localStorage.getItem(HINT_KEY); } catch { return null; }
};

function persist() {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
  catch { /* private mode: the session still works in memory */ }
}

function restore() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null");
    if (saved?.token && Date.now() < saved.expiresAt - RENEW_SKEW_MS) session = saved;
  } catch { /* missing or corrupt: sign in fresh */ }
}

function forget() {
  session = null;
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* nothing stored */ }
}

function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => window.google?.accounts?.id
      ? resolve()
      : reject(new AuthError("Google Identity Services loaded but exposed no id client."));
    s.onerror = () => reject(new AuthError(`Could not load ${GIS_SRC}.`));
    document.head.append(s);
  });
}

// Trade the Google assertion for our own session.
async function exchange(idToken) {
  const res = await fetch("/api/session", {
    method: "POST", headers: { authorization: `Bearer ${idToken}` },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new AuthError(data?.error ?? `Sign-in failed (HTTP ${res.status})`);
  session = {
    token: data.sessionToken, expiresAt: data.expiresAt,
    email: data.email, role: data.role, name: data.name,
  };
  persist();
  try { localStorage.setItem(HINT_KEY, data.email); } catch { /* private mode */ }
  onChange(session);
  return session;
}

export async function init(cid, changeHandler) {
  clientId = cid;
  onChange = changeHandler ?? onChange;
  if (!clientId) throw new AuthError("Server returned no Google client id. Set GOOGLE_CLIENT_ID on the Lambda.");

  restore();
  await loadGis();

  window.google.accounts.id.initialize({
    client_id: clientId,
    callback: (resp) => {
      if (!resp?.credential) return;
      exchange(resp.credential).catch((e) => onChange(null, e.message));
    },
    auto_select: true,
    cancel_on_tap_outside: false,
    // One Tap without the cross-origin iframe.
    //
    // The old prompt works by embedding accounts.google.com/gsi/iframe/select
    // in this page, which trips Google's own report-only frame-ancestors policy
    // and logs a violation into our console on every load -- harmless, since it
    // is Google reporting on Google, but noise that looks like a fault.
    //
    // Under FedCM the browser renders the account chooser itself and no iframe
    // is embedded, so the report stops. It is also where this has to go
    // regardless: the iframe flow depends on third-party cookies.
    use_fedcm_for_prompt: true,
    ...(remembered() ? { login_hint: remembered() } : {}),
  });
  gisReady = true;

  // A restored session means we are already signed in; tell the app so it does
  // not flash the sign-in screen on every reload.
  if (session) onChange(session);
  return Boolean(session);
}

/** Render the official Google button. GIS will not accept a custom one. */
export function renderButton(el) {
  if (!gisReady) return;
  window.google.accounts.id.renderButton(el, {
    theme: "outline", size: "large", text: "signin_with", shape: "rectangular", width: 280,
  });
  if (!session) window.google.accounts.id.prompt(); // One Tap for a returning admin
}

/**
 * Ask GIS for a fresh credential without showing the full sign-in screen. Works
 * when the browser still has a live Google session and consent was already
 * given, which is the common case for "my session just aged out".
 */
let reauthInFlight = null;

function silentReauth() {
  // Two concurrent 401s must not both call prompt(): GIS aborts the first
  // attempt, which is the "FedCM get() rejects with AbortError" console noise.
  if (reauthInFlight) return reauthInFlight;
  reauthInFlight = doSilentReauth().finally(() => { reauthInFlight = null; });
  return reauthInFlight;
}

function doSilentReauth() {
  return new Promise((resolve) => {
    if (!gisReady) return resolve(false);
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };

    // If One Tap cannot display, give up rather than hanging the caller.
    window.google.accounts.id.prompt((notification) => {
      if (notification.isNotDisplayed?.() || notification.isSkippedMoment?.()) done(false);
    });
    // The initialize() callback runs exchange() and fires onChange; poll briefly
    // for the result rather than restructuring the GIS callback contract.
    const started = Date.now();
    const tick = setInterval(() => {
      if (session && Date.now() < session.expiresAt) { clearInterval(tick); done(true); }
      else if (Date.now() - started > 8000) { clearInterval(tick); done(false); }
    }, 200);
  });
}

export const isSignedIn = () => Boolean(session) && Date.now() < session.expiresAt;
export const whoAmI = () => session;
export const expiresAt = () => session?.expiresAt ?? 0;

export function signOut() {
  forget();
  try { localStorage.removeItem(HINT_KEY); } catch { /* nothing stored */ }
  window.google?.accounts?.id?.disableAutoSelect();
  onChange(null);
}

/**
 * fetch() with the session attached. On a 401 it tries one silent re-auth and
 * replays the request, so an aged-out session costs a moment rather than the
 * work in progress.
 */
// Which site the console is currently editing. Sent on every request; the
// server authorizes it against membership rather than trusting it, so setting
// this to somebody else's site id gets a 404, not their content.
let currentSite = null;
export const setSite = (siteId) => { currentSite = siteId || null; };
export const getSite = () => currentSite;

export async function api(path, opts = {}, retry = true) {
  if (!session) throw new AuthError("Not signed in.");

  const send = () => {
    const headers = { ...(opts.headers ?? {}), authorization: `Bearer ${session.token}` };
    if (currentSite && !headers["x-qw-site"]) headers["x-qw-site"] = currentSite;
    if (opts.body && !(opts.body instanceof Blob) && !headers["content-type"]) {
      headers["content-type"] = "application/json";
    }
    return fetch(`/api${path}`, { ...opts, headers });
  };

  let res = await send();

  if (res.status === 401 && retry) {
    const ok = await silentReauth();
    if (ok) res = await send();
    else {
      forget();
      onChange(null, "Your session expired. Sign in again.");
      throw new AuthError("Your session expired. Sign in again.");
    }
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    // Carry the body, not just its message. A rejected template upload answers
    // with the validator's findings, and dropping them here would turn "line 12
    // of layouts/article.html" into "400".
    const err = new AuthError(data?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    err.findings = data?.findings;
    throw err;
  }
  return data;
}
