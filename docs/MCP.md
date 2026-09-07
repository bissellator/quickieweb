# The MCP server

Design, not yet built. The goal is that someone points an MCP client at
Quickieweb, is sent to `app.quickieweb.com` to log in and approve, and their
agent can then draft templates, write posts and upload pages against exactly the
sites they already have access to — with no key to paste anywhere.

The connection model follows the one the Airbrx gateway ships
(`~/airbrx/airbrx-api/api/handlers/oauth-authcode.js`), because it is a working
implementation of the same problem and being unusual here buys nothing.

---

## The shape: the MCP server decides nothing

The MCP server is a **resource server and nothing else**. It verifies no token,
signs no token, and makes no authorization decision. It attaches the caller's
bearer to a request against the admin API, forwards it, and returns the answer.

Everything that decides what a caller may do already exists and stays where it
is: `siteContext()` resolves the site, `roleInSite()` resolves the role,
`canAdminister()` gates the writes. `upload_template` is a
`POST /api/templates` carrying the agent's token — the validator runs, the
findings come back, the same 403 fires for a non-owner.

**Why it matters that this is the rule and not a convenience.** The alternative
is a second authorization model living in the MCP server, which then has to be
kept in step with the first one forever. The two drift, and the drift is
invisible until an agent does something a person could not. An agent is not a
distinct class of caller, so there is nothing to keep in step.

---

## Two well-known documents, in two different places

This trips people up, so it is worth being explicit. The MCP specification
splits discovery across the resource server and the authorization server, and
Quickieweb has one of each:

| document | served by | says |
| --- | --- | --- |
| `/.well-known/oauth-protected-resource` | `mcp.quickieweb.com` | "the authorization server for this resource is `https://app.quickieweb.com`" |
| `/.well-known/oauth-authorization-server` | `app.quickieweb.com` | RFC 8414 metadata: where to register, authorize and get a token |

The admin Lambda becomes the authorization server. That is the right home for
it: it already verifies Google identity, already issues signed tokens, and
already knows every site and role. The MCP server holds no credentials at all.

---

## The flow

```
  discover   GET  mcp.quickieweb.com/mcp            -> 401 + WWW-Authenticate
             GET  /.well-known/oauth-protected-resource
             GET  app.quickieweb.com/.well-known/oauth-authorization-server
  register   POST /register                          RFC 7591, returns client_id
  authorize  GET  /authorize?...&code_challenge=...  PKCE S256
                  |
                  '-> app.quickieweb.com consent page: Google sign-in, pick sites
  consent    POST /authorize/consent                 mints a scoped PAT, issues a code
  token      POST /oauth/token                       code + code_verifier -> tokens
```

Two properties of this that are load-bearing, both taken from the Airbrx
implementation:

**The authorize request travels as a signed JWT, not as server state.** Nothing
is stored between `/authorize` and `/authorize/consent`. The redirect URI, the
PKCE challenge, the client id and the nonce are packed into a JWT this server
signs — with the same HMAC secret machinery `admin/lib/auth.mjs` already uses for
sessions — and handed to the consent page as a parameter. A Lambda that scales to
zero cannot hold a pending authorization in memory, and adding a session store to
a platform whose entire point is not having one would be an odd place to start.

**A scoped personal access token is the durable credential underneath.** The
consent step mints a PAT, and the authorization code binds to that PAT's storage
hash. The client receives a normal `access_token` and a PAT-backed
`refresh_token` and **never sees the raw PAT secret** — the secret exists only
long enough to compute the hash. So revoking a connected app is the same
operation as revoking a token, and there is one thing to audit rather than two.

State lives in the platform bucket beside `accounts/`, which is already the
registry and already versioned:

```
oauth/clients/<client_id>.json    a registered client
oauth/codes/<code_hash>.json      a one-time authorization code
oauth/pats/<hash>.json            a scoped token, and what it may reach
```

Codes are one-time and short-lived: delete on redemption, and treat a second
presentation as an attack rather than a retry.

---

## Registration

`POST /register` takes `redirect_uris` and returns a `client_id`. No client
secret — these are public PKCE clients, and `token_endpoint_auth_methods_
supported` is `["none"]`.

The one rule worth enforcing hard: **`redirect_uris` must be `https:` or an
`http` loopback** (`localhost`, `127.0.0.1`, `::1`). Anything else is an open
redirect with an authorization code attached to it. Constrain `grant_types` and
`response_types` to what this server actually supports regardless of what the
client asked for.

---

## The consent screen

Served by the admin Lambda at `app.quickieweb.com/authorize`. It reuses the
sign-in that already exists: Google Identity Services proves who you are, the ID
token is exchanged for a session exactly as the console does it, and only then
does the grant screen render.

What makes it a *Quickieweb* consent screen rather than a generic one is that
**consent is per site**. This is a multi-site platform; a grant that says
"templates:write" without saying where is a grant that can rewrite the wrong
site.

```
 ┌─────────────────────────────────────────────┐
 │ Quickieweb                                  │
 │                                             │
 │ Claude Desktop wants access                 │
 │ Signed in as you@example.com                │
 │                                             │
 │  ┌─────────────────────────────────────┐    │
 │  │ crunchyts                     owner │    │
 │  │ Read content · Templates · Pages    │    │
 │  └─────────────────────────────────────┘    │
 │  ┌─────────────────────────────────────┐    │
 │  │ www                           owner │    │
 │  │ Read content only                   │    │
 │  └─────────────────────────────────────┘    │
 │  ┌─────────────────────────────────────┐    │
 │  │ acme-co                      editor │    │
 │  │ Cannot grant templates — not owner  │    │
 │  └─────────────────────────────────────┘    │
 │                                             │
 │  [ Cancel ]              [ Allow ]          │
 │                                             │
 │  Expires in 30 days. Revoke in Settings.    │
 │  Publishing is not included.                │
 └─────────────────────────────────────────────┘
```

Four rules the screen enforces, each of which is a bug if it is missing:

- **You cannot grant what you do not hold.** Intersect the requested scopes with
  your role on each site, and render the shortfall as a disabled row that says
  why — not a silently missing one. A person who cannot see why a site is absent
  assumes the product is broken.
- **Sites are opt-in individually.** Membership in six sites is not a grant of
  six.
- **Absent scopes are stated.** "Publishing is not included" is the sentence
  that makes a grant legible. A consent screen that lists only what it is taking
  asks you to reason about the complement.
- **A grant is a listed object.** Connected apps appear in the console with
  their scopes and last-used date, and revoke immediately.

---

## Scopes

Three axes, mirroring the API rather than inventing a parallel vocabulary:
`qw:<site>:<resource>:<action>`.

| resource | read | write |
| --- | --- | --- |
| `content` | list and read posts, pages, galleries | create, edit, delete records |
| `templates` | list both shelves, read a package | upload, adopt, delete a private template |
| `static` | list and read static pages | upload and delete them |
| `theme` | read the token form and values | set token overrides |
| `media` | list uploads | upload images and audio |
| `stats` | read log-derived reports | — |
| `members` | list members and roles | change them |
| `publish` | read the pending changeset | promote staging to live |

`publish` is deliberately its own resource rather than part of `content:write`.
Drafting and going live have different blast radii, and an agent that can draft
but not publish is the common case, not the exotic one.

**Effective reach is the intersection** of what the token allows and what your
membership allows, evaluated per request by the API. A token minted while you
were an owner does not keep owner rights after you are demoted — a scope is a
ceiling, never a grant.

### What to advertise in discovery

Airbrx advertises a **single coarse scope** and treats the inbound `scope`
parameter as advisory, because the real authorization is the per-site set chosen
on the consent screen. Do the same in v1. Trying to project
site × resource × action into OAuth scope strings means every client has to
learn a site list before it can ask for anything, and MCP clients ask for scopes
before they know who you are. The consent screen is the right place for that
decision and the only place with the information to make it.

---

## Headless clients

Two options, and the design should ship the first:

- **Personal access token.** Minted in the console, scoped at creation, presented
  as the bearer. The MCP server recognizes the `qwp_` prefix and exchanges it for
  a short-lived session token, cached for its life — a warm client exchanges
  about once every twelve hours, not once per call. Never logged.
- **Device authorization grant** (`urn:ietf:params:oauth:grant-type:device_code`)
  for a client with no browser but a human present. Airbrx implements this;
  Quickieweb can add it later without changing anything above.

Scope a headless token to the one site and the operations the job needs. An
agent that only drafts templates should hold a token with no `publish` path at
all — that makes "it cannot put anything live" structural rather than a matter
of prompting.

---

## The tools

Each carries an MCP annotation so a well-behaved client can prompt before the
ones that matter. **Destructive** means it changes something a reader can
already see, or throws work away.

| tool | | |
| --- | --- | --- |
| `whoami` | read | Identity, every site and role, effective reach. The first move. |
| `list_content` | read | Posts, pages and galleries with status and slug. |
| `get_content` | read | One record, body included. |
| `put_content` | write | Create or replace a record. Stages a rebuild. |
| `delete_content` | destructive | Remove a record and its rendered page. |
| `list_templates` | read | Both shelves, active one marked. |
| `get_template` | read | A package as `{path: text}` — the shape to edit and send back. |
| `validate_template` | read | Dry run. Findings with file and line, writing nothing. |
| `upload_template` | write | Store as a new immutable version of this site's own. |
| `adopt_template` | destructive | Switch the site to it. Re-renders every page. |
| `delete_template` | destructive | Drop a private template and every version. |
| `list_static_pages` | read | Hand-authored pages and their paths. |
| `put_static_page` | write | Upload a complete document, published verbatim. |
| `delete_static_page` | destructive | Remove source and staged copy both. |
| `get_theme` | read | The token form the active template declares, and values. |
| `set_theme` | destructive | Overwrite token overrides. Re-renders every page. |
| `preview_link` | write | A 15-minute authenticated URL of staged work, drafts included. |
| `preview_changeset` | read | Exactly what a publish would copy and delete. |
| `publish` | destructive | Promote staging to live and invalidate the CDN. |

### Why `validate_template` earns its place

It is the loop that makes an LLM able to write a template at all: draft,
validate, read findings that name a file and a line, fix, upload. Without a dry
run the model is guessing against a contract it cannot see, and its first signal
is a rejected upload. `validateTemplate()` already returns findings in that
shape and `POST /api/templates` already returns them on a 400 — this tool is the
same check with no write behind it.

### The sharpest edge

**Publish promotes everything staged, not only what the agent touched.** A
changeset is a diff of the whole staging bucket against live, so a colleague's
half-finished draft, saved an hour ago, goes live alongside the agent's work.
The write succeeds either way.

Worth a standing instruction, the way Airbrx handles rule writes:

> Before any publish, run `preview_changeset` and show me the list. Do not
> publish if it contains anything I did not ask for.

That is advisory — nothing in the server forces it. Scoping the token without
`publish` is the structural version of the same guarantee.

---

## Prompts, not autonomy

Two multi-step routines ship as MCP prompts, which surface in most clients as
slash commands someone picks deliberately. An agent does not start one
mid-conversation.

- **Build a template** — read the active template as a starting point, draft
  against the spec, validate, fix, upload, issue a preview link, and stop. It
  never adopts and never publishes; a human looks at the preview and decides.
- **Publish review** — walk the changeset, group it by cause (edited records, a
  template switch, a theme change, a static page), and name anything the agent
  did not author. Ends at a recommendation.

Both open with `whoami`, so a step you lack the role for is announced up front
rather than attempted and failed three tools later.

---

## Where it runs

A second small Lambda behind `mcp.quickieweb.com`, holding no credentials of its
own. No S3 access, no template cache, no renderer — it forwards HTTP and
translates errors.

**Measured 2026-09-06, against the live distribution.** The shared CloudFront
distribution rewrites errors through `CustomErrorResponses`, and the question was
whether that breaks MCP discovery. It does not:

| from the API | direct to the Lambda | through CloudFront |
| --- | --- | --- |
| `GET /api/me` unauthenticated | `401` + JSON | **`401` + JSON — passes through** |
| forged preview token | `403` + JSON | `404` + the platform's HTML page |

So `CustomErrorResponses` covers `403`/`404` and leaves `401` alone. **Discovery
works on the distribution that exists** — the auth challenge reaches the client
intact, which is the one thing the flow cannot survive losing. (`WWW-Authenticate`
itself is untested only because nothing emits one yet; `Content-Type` survives,
so a response header is not being stripped.)

> **Still worth the second distribution, for a different reason.** The MCP server
> forwards API responses, and a `403` — "you are not an owner of that site" — will
> reach the agent as a `404` HTML page. An agent told "not found" when the truth is
> "not permitted" will retry, or conclude the site does not exist, instead of
> reporting the real problem. That is a bad tool surface rather than a broken
> handshake, so it is a quality bar, not a blocker. Serve `app.` and `mcp.` from a
> distribution with no `CustomErrorResponses`; an exact-match alias beats the
> `*.quickieweb.com` wildcard on the existing one.

One more transport detail: an expired token must come back as a **transport-level
401**, not a tool result saying "auth failed". The first makes the client
re-authenticate; the second makes it report a broken tool to the user.

---

## What has to be built

Most of the surface exists. The authorization server is the real work.

**Have already**

- Google identity verification, JWKS-cached (`admin/lib/auth.mjs`)
- HMAC-signed self-contained tokens, no session store — the same machinery the
  authorize-state JWT needs
- Per-site membership and roles (`roleInSite`, `canAdminister`)
- The whole tool surface as REST, already validating and authorizing
- Bearer-token auth rather than cookies, so there is no CSRF surface here

**To build**

- Scope vocabulary, and scope checks alongside the existing role checks
- Authorization server: the two metadata documents, `/register`, `/authorize`,
  `/authorize/consent`, `/oauth/token`, PKCE verification
- The consent screen, and a Connected apps list that can revoke
- Personal access tokens: mint, list, scope, revoke
- `oauth/` storage in the platform bucket
- The MCP server itself — thin, and last, because it is the easy part
- A distribution that does not rewrite `403` (quality, not a blocker — see above)

**Sequencing.** Scopes first. Adding them after the fact means auditing every
route twice, and the second audit is the one that misses something.
