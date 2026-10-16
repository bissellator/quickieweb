// Sign in with Microsoft: personal accounts and work or school (Entra ID).
//
// The authorization-code flow with PKCE, which is what Microsoft supports for a
// browser app with no client secret. No library: the flow is two redirects and
// one POST.
//
//   start()     remember a PKCE verifier, state and nonce in sessionStorage,
//               then send the browser to Microsoft
//   complete()  on /signin-microsoft.html: check state, redeem the code for an ID
//               token (Microsoft's token endpoint answers CORS for a registered
//               single-page-app redirect URI), check the nonce, trade the ID token
//               for OUR session via auth.js, and go back where we came from
//
// The Lambda verifies the ID token itself (admin/lib/auth.mjs): signature,
// audience, issuer, and that the email is one Microsoft vouches for. Nothing
// here is the security boundary; the state and nonce checks only stop a
// different sign-in being injected into this browser's flow.

import { exchangeIdToken } from "./auth.js";

const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
const KEY = "qw-ms-signin";
const redirectUri = () => `${location.origin}/signin-microsoft.html`;

const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));

export async function start(clientId, returnTo = location.href) {
  const verifier = random(48);
  const challenge = b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = random(16);
  const nonce = random(16);
  sessionStorage.setItem(KEY, JSON.stringify({ verifier, state, nonce, returnTo, clientId }));

  const q = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri(),
    response_mode: "query",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  location.assign(`${AUTHORITY}/authorize?${q}`);
}

/** Finish on the callback page. Resolves to where to send the browser next. */
export async function complete() {
  const saved = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
  sessionStorage.removeItem(KEY);
  const q = new URLSearchParams(location.search);

  if (q.get("error")) throw new Error(q.get("error_description") || q.get("error"));
  if (!saved) throw new Error("This sign-in was not started from this browser tab. Start again.");
  if (!q.get("code") || q.get("state") !== saved.state) {
    throw new Error("The sign-in response did not match the request. Start again.");
  }

  const res = await fetch(`${AUTHORITY}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: saved.clientId,
      grant_type: "authorization_code",
      code: q.get("code"),
      redirect_uri: redirectUri(),
      code_verifier: saved.verifier,
      scope: "openid email profile",
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.id_token) {
    throw new Error(data?.error_description?.split("\r\n")[0] ?? `Microsoft sign-in failed (HTTP ${res.status})`);
  }

  const claims = JSON.parse(atob(data.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  if (claims.nonce !== saved.nonce) throw new Error("The sign-in response did not match the request. Start again.");

  await exchangeIdToken(data.id_token);

  // Back to the page that started it -- on this same origin only.
  const back = new URL(saved.returnTo, location.origin);
  return back.origin === location.origin ? back.href : `${location.origin}/`;
}
