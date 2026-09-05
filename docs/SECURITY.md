# The security model

What protects what, and why each choice is the way it is. Most of these look
arbitrary until the failure they prevent is named, so the failure is named.

Reporting a vulnerability: see [SECURITY.md at the repository root](../SECURITY.md).

---

## The shape

```
reader   ──► CloudFront ──► S3 live bucket            (OAC, read-only, one distribution)
editor   ──► CloudFront ──► /api/*  ──► Lambda        (Function URL, origin-secret gated)
                           /admin/* ──► S3 admin/     (static console, never served by Lambda)

Lambda ──► S3 staging   drafts, media, _internal/*    (private, not an origin)
       ──► S3 live      publish = server-side copy
       ──► platform     templates read-only, accounts read-write
```

Three properties hold the whole thing up:

1. **Nothing reaches S3 except CloudFront.** Block Public Access on all four
   settings, ACLs disabled entirely (`BucketOwnerEnforced`), and a bucket policy
   whose only allow is the CloudFront service principal *conditioned on one
   distribution ARN*. Without that condition any distribution in any AWS account
   could name your bucket as its origin — the confused-deputy hole in every OAC
   example that omits it.
2. **Staging is not an origin on anything.** Unpublished drafts are unreachable
   by structure, not by a path rule somebody could get wrong. This is the reason
   staging and live are separate buckets rather than two prefixes in one: merged,
   that boundary becomes a `Resource` ARN, and getting it wrong once exposes
   every tenant's unpublished work.
3. **Every `/api/*` route authenticates.** There is no dev bypass and no "auth
   disabled when unconfigured" path.

---

## Identity and authorization are separate questions

| | Question | Answered by |
|---|---|---|
| **Authentication** | Is this really `alice@example.com`? | Google. An RS256 signature over the ID token, verified in `admin/lib/auth.mjs` against Google's JWKS. |
| **Authorization** | May `alice@example.com` edit *this site*? | That site's `members` list in the platform registry. |

Conflating them is how admin panels get walked into. Concretely:

- The email is read only from the **verified** token payload. No route anywhere
  trusts an email out of a request body.
- `email_verified` is required. An unverified Google address can be one the
  holder does not control, which would let somebody claim a membership by
  signing up with your address.
- `alg` is pinned to RS256 rather than read from the token. Reading it is the
  `alg: none` and HMAC-confusion family of attacks.
- `aud` must equal our client id, so a token minted for a different application
  is refused.
- **An empty or missing member list denies everyone.** The common basic-auth
  helper returns `true` when nothing is configured — convenient locally,
  catastrophic if config fails to load in production. This one throws.
- **The role is re-read on every request**, never taken from the session token,
  so removing somebody takes effect immediately rather than at their next
  sign-in.
- **You cannot lock a site out.** A member list with no owner, or one that drops
  your own address, is refused.

### Sessions

A Google ID token is a login *assertion*, not a session: it lives one hour and
Google Identity Services will not silently reissue one. Using it directly as the
credential logs people out every hour, potentially mid-article.

It is exchanged once for a session token — HMAC-SHA256 over `{email, role, exp}`,
12 hours, no session store. Details that matter:

- **`sessionStorage`, not `localStorage`.** A reload keeps you signed in; closing
  the tab does not leave a live credential on disk.
- **A bearer header, not a cookie.** Browsers attach cookies to cross-site
  requests automatically, which is the entire CSRF problem. A header is not sent
  that way, so there is no CSRF surface.
- **One silent retry on 401.** An expired session mid-use looks like a pause, not
  a logout.
- **`SESSION_SECRET` is read back from the live function on redeploy.**
  Regenerating it would sign everyone out on every deploy; writing it to config
  would put a secret in the repository.

### Preview links

A preview token is a *separate* HMAC, domain-separated with a `preview.` prefix
so it can never be replayed as a session and vice versa. It lives 15 minutes,
names one site, and grants only a rendering of content the holder could already
see. Membership is re-checked on every preview fetch, so removing somebody kills
their open preview immediately.

It travels in the URL path, which is a real cost: URLs land in history, in
`Referer`, and in access logs. That is why it is deliberately weak — short-lived,
read-only, single-site.

---

## Multi-tenant isolation

Under the `buckets` driver a site owns its buckets and isolation is enforced by
IAM. Under the `prefix` driver — what the hosted model uses — many sites share
two buckets and **isolation is enforced by code**. That is the honest trade, and
it means two functions are security boundaries:

- `keyFor()` in `shared/site.mjs`, the single place a storage key is built. It
  refuses `..` outright. Nothing else concatenates a prefix.
- The CloudFront Function in `infra/edge/tenant-router.js`, which maps a `Host`
  header to a prefix. An unrecognised host gets a 404 — **never a default site**,
  because a fallback there serves one tenant's content under another's name.

Both are heavily tested, and one test asserts they agree with each other on
every label: if they drift, the console writes to one prefix while readers are
served from another, and the symptom is a site that saves successfully and stays
blank.

Two more, worth stating because they are easy to get wrong:

- `unkeyFor()` requires the trailing slash, so prefix `sites/ac` does not match
  `sites/acme/…`.
- A publish invalidates `/{prefix}*`, not `/*`. A wildcard on a shared
  distribution would dump every other tenant's cache on every publish.

---

## The origin lockdown

The Lambda's Function URL is `AuthType: NONE` and reachable by anyone who learns
the hostname. Every `/api/*` route authenticates, so data is not exposed — but
*invocation* is: unbounded concurrency, unbounded cost, and any rate limit or WAF
rule placed in front of CloudFront can be walked around by calling the function
URL directly.

CloudFront attaches a shared secret as an origin custom header. It overwrites any
same-named header from the viewer before forwarding, so a caller coming through
the CDN cannot spoof it and a caller going direct does not have it.

**Two variables, not one, and the separation is the safety property.**
`ORIGIN_SECRET` makes the value known so `/api/health` can *report* whether the
header arrived; `ORIGIN_ENFORCE` makes it *required*. Deploy the first, confirm
CloudFront is really sending it, then set the second. Turning enforcement back
off is a configuration change measured in seconds rather than a redeploy.

```bash
node infra/set-origin-enforce.mjs        # report
node infra/set-origin-enforce.mjs on     # enable (checks before it does)
node infra/set-origin-enforce.mjs off    # rollback
```

---

## Content

The post body is authored in a rich-text editor and stored as HTML. Admins are
trusted, but stored HTML rendered onto a public page still gets a conservative
pass: a compromised editor session must not be able to plant a script tag that
every reader then executes. `sanitizeHtml` in `shared/html.mjs` strips
`script`/`iframe`/`object`/`embed`/`form`/`link`/`meta`/`base`, `on*` handlers and
`javascript:` URLs.

Templates are **data, not code** — no `eval`, no function calls, no expressions.
That is what makes it safe to render a template from a shared library in one
process serving many tenants. The one permitted `<script>` form is
`<script src="{{…}}">` with no body, so the URL comes from the view model rather
than from the template.

Design token values reach the stylesheet from site config, so they are escaped
for a CSS context: a value containing `}` could otherwise close the rule.

---

## Headers

The distribution attaches HSTS (`max-age=63072000; includeSubDomains`, **no
`preload`** — that is effectively irreversible), `nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, a `Permissions-Policy`
denying camera/microphone/geolocation, and `frame-ancestors`.

One header is load-bearing and easy to break:
`Cross-Origin-Opener-Policy: same-origin-allow-popups` on the console. The
default COOP severs Google Identity Services' `postMessage` channel and sign-in
hangs with a console message about a blocked `window.postMessage` call. S3 will
not set it; the response headers policy must.

Ship CSP as `Content-Security-Policy-Report-Only` first. Google Identity Services
plus a rich-text editor is exactly where a CSP fails silently and only at the
moment somebody tries to log in.

---

## Known gaps

Stated rather than discovered later.

- **`SESSION_SECRET` and `ORIGIN_SECRET` are plaintext Lambda environment
  variables**, not SSM parameters. Moving them is its own piece of work.
- **CloudFront custom error pages are distribution-wide**, so a 403 or 404 from
  `/api/*` is replaced by the site 404 page and the API cannot signal
  "forbidden" to a client. The fix is a second distribution for the console; an
  exact-match alias beats a wildcard on another distribution.
- **Per-tenant 404 pages do not work under the `prefix` driver**, for the same
  reason: the error page is fetched without re-running the viewer-request
  function, so it resolves at the bucket root.
- **The console loads one third-party script**,
  `accounts.google.com/gsi/client`. Unavoidable for Google sign-in, but it is a
  script with execution rights inside an authenticated page.
- **No WAF rate limit** in front of the distribution.
