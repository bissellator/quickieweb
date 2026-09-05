# The admin plane

Editing and publishing happen entirely in S3. Nothing needs a git checkout, and
nothing needs this laptop. The admin is a Lambda that only runs while somebody is
actually editing, so the management plane scales to zero along with the site.

```
browser ──► CloudFront ──┬── /*        ──► S3 live bucket        (OAC, read-only)
                         ├── /api/*    ──► Lambda Function URL   (plain custom origin)
                         └── /admin*   ──► same Lambda, serves the editor UI

Lambda ──► S3 staging  (drafts, media, admins.json, _internal/*)
       ──► S3 live     (publish = server-side copy)
       ──► S3 logs     (read-only, for the Stats tab)
       ──► CloudFront  (invalidation, this distribution only)

  us-east-1: the Lambda        us-west-2: all three buckets
```

## The one manual step: a Google OAuth client

Everything else is provisioned by script. This part cannot be — it lives in the
Google Cloud console, not AWS.

1. <https://console.cloud.google.com/apis/credentials> → **Create credentials** →
   **OAuth client ID** → **Web application**.
2. **Authorized JavaScript origins**: your `site.baseUrl` from `config.json`
   (add the `www.` form too if you will ever use it).
3. There is no redirect URI to set — Google Identity Services posts the credential
   back to the page. Leave that list empty.
4. Copy the client ID (it ends in `.apps.googleusercontent.com`) and run:

```bash
node infra/deploy-lambda.mjs --client-id 1234-abc.apps.googleusercontent.com
```

The client ID is **not a secret** — it is public by design and appears in every
sign-in request a browser makes. There is no client secret anywhere in this
system, because there is no server-side OAuth exchange: the browser gets an ID
token and the Lambda verifies its signature.

Until the client ID is set, `/api/health` reports `clientId: null` and the sign-in
page says so rather than failing silently.

## How authorization actually works

Two separate things, and conflating them is how admin panels get walked into:

| | Question | Answered by |
|---|---|---|
| **Authentication** | Is this really `alice@example.com`? | Google. Proven by an RS256 signature over the ID token, verified in `admin/lib/auth.mjs` against Google's JWKS. |
| **Authorization** | May `alice@example.com` edit? | `admins.json` in the **private** staging bucket. |

The email is only ever read from the *verified* token payload. No route anywhere
trusts an email out of a request body.

Worth contrasting with the common browser-side pattern: a page requests a Google
**access token** for some Google API and lets Google enforce access to the
resource, so the email the page displays is cosmetic and it does not matter.
There is no equivalent gatekeeper in front of an S3 bucket, so verification has
to happen server-side, before any write.

Three properties worth keeping:

- **An empty or missing member list denies everyone.** The common basic-auth
  helper returns `true` when no credentials are configured, which is convenient
  locally and catastrophic if config ever fails to load in production. This one
  throws.
- **`admins.json` never gets published.** It lives only in staging, and `publish`
  skips it explicitly. Putting it on the live site would publish everyone's email.
- **You cannot lock the site out.** Saving a list with no owner, or one that drops
  your own address, is refused.

Roles: `owner` can edit the admin list; `editor` can do everything else.

### Sessions, and why sign-in used to last an hour

A Google ID token is a login **assertion**, not a session. It lives one hour and
GIS will not silently reissue one. The first version of this admin used it
directly as the credential, so it logged you out every hour, potentially
mid-article. That was the wrong shape.

Now it is exchanged once:

```
browser --(Google ID token)--> POST /api/session --> { sessionToken, expiresAt }
browser --(sessionToken)-----> every other route
```

The session token is HMAC-SHA256 signed by the Lambda over `{email, role, exp}`,
valid **12 hours**. No session store, nothing running — the token carries its own
claims and the signature is what makes it trustworthy.

Details that matter:

- **The role is re-checked against `admins.json` on every request**, not read
  from the token. Revoking someone takes effect immediately rather than at their
  next sign-in.
- **sessionStorage, not localStorage.** A reload keeps you signed in; closing the
  tab does not leave a live credential on disk.
- **A bearer header, not a cookie.** Browsers attach cookies to cross-site
  requests automatically, which is the entire CSRF problem. A header is not sent
  that way, so there is no CSRF surface and no token to forge.
- **One silent retry on 401.** If the session ages out mid-use, the client asks
  GIS for a fresh credential and replays the request. You notice a pause, not a
  logout.
- **`SESSION_SECRET` is read back from the live function config on redeploy.**
  Regenerating it would sign everyone out on every deploy; writing it to
  `config.json` would put a secret in the repo. It exists only as a Lambda
  environment variable.

Work in the editor is additionally mirrored to `localStorage` every five seconds
while dirty, and offered back on next load. Belt and braces: an expired session
or a closed laptop should never cost an article.

## Bootstrapping the first owner

Chicken-and-egg: the Lambda refuses everything when the list is missing, and only
an owner can write the list through the API. So the first owner is placed out of
band, with AWS credentials:

```bash
node infra/seed-staging.mjs --owner you@example.com
```

This also uploads `_internal/config.json` — site identity plus the category
taxonomy, both taken from `config.json` — and any posts already in `content/`.
It will not overwrite an existing `admins.json` unless you pass `--force`;
otherwise re-running it would silently demote everyone added through the UI.

Re-run it after editing `config.json`. That is how a tagline, a nav link or a
new category reaches production: the Lambda holds no copy of the config, so it
is a bucket write and a rebuild, not a redeploy.

## Publishing

`GET /api/publish` returns the changeset; `POST /api/publish` performs it.

Publishing re-renders every published article, diffs staging against live by ETag,
copies only what differs (server-side, inside S3 — bytes never round-trip through
a browser or this laptop), deletes what staging no longer has, and invalidates the
CDN. Under ~15 changed paths it invalidates precisely; past that it uses `/*`,
because only the first 1000 paths per month are free.

`admin/*`, `admins.json`, `sitedata.json`, `media/*` and `_internal/*` are never
published. The local `cli/deploy.mjs` excludes the same prefixes from its
`--delete` sync: omitting `_internal/*` there once wiped the entire article store
the admin reads from, leaving the rendered site up and its source gone.

## Writing

The body is one free-form CKEditor 5 instance, stored as HTML. See
[The editor](#the-editor) for the version, where it is served from and under
which licence — it is vendored, never loaded from a CDN.

The toolbar carries headings, bold/italic, inline code, links, lists, indent,
block quotes, **code blocks**, tables, horizontal rules, undo/redo, and
**source editing** for when you want the markup directly.

A code block is published as `<pre><code class="language-…">`, which the
sanitizer preserves and each template styles. Its text is indexed for search
like any other body copy.

Two things the editor does for you:

- **Word count**, live, next to the Body label.
- **Insert image** uploads to staging through `sharp` (1400px webp plus a 480px
  thumbnail) and drops it at the cursor. The original is not kept.

Unsaved work is protected by a dirty flag: switching tabs, going Back, or closing
the browser all warn first.

An article written before the switch still has `sections`. Opening it folds those
into HTML so it edits as prose; saving drops the old field. The renderer still
handles `sections` for anything not yet re-saved, so nothing published breaks.

Stored HTML is sanitized at render time — script, iframe, object, embed, form,
link, meta and base tags, `on*` handlers, and `javascript:` URLs are stripped.
Admins are trusted, but a compromised admin session should not be able to plant
something every reader then executes.

## Stats

A Stats tab, from CloudFront access logs. No tracking script, no cookies, no
third party, nothing added to the public pages. The CDN already writes down every
request it serves.

Standard logging **v2** (JSON lines to S3) is enabled by `infra/enable-logging.mjs`.
v2 over the legacy format because one JSON object per line cannot silently shift
columns when AWS adds a field.

`POST /api/stats` folds newly delivered log objects into a stored daily report,
incrementally — a metadata file records which objects are already counted, so a
run only pays for what arrived since the last one. Capped at 300 files per run so
a backlog cannot blow the 60s timeout; progress is recorded either way, so
running again continues.

### Two files, and why

```
_internal/stats/daily.json        one small summary row per day
_internal/stats/days/<date>.json  everything else, read only when you open it
_internal/stats/metadata.json     which log objects are already folded in
_internal/geo/dbip-city-lite.mmdb.gz   the IP-to-city database
```

The Stats tab opens on `daily.json` alone, which stays a few kilobytes no matter
how much detail accumulates behind it. The drill-down is a second request. An
earlier version kept both in `daily.json`; thirty days of full detail is a few
megabytes, and re-reading and re-writing all of it on every processing run is
fine right up until it is the entire Lambda budget.

### The tabs

A deliberately compact treatment of a much larger subject; a full analytics
product does far more. This one covers
treatment than the single summary page this started as.

| Tab | What is in it |
|---|---|
| **Overview** | Visits, page views, pages per visit, bounce rate, average visit, bandwidth, cache hit rate, requests, bots, probes, admin, errors; the per-day sparkline; audio completion; channels, top pages, referrers, countries |
| **Audience** | Browsers, operating systems, devices, device/OS pairs, entry and exit pages, and visits by channel with bounce rate, pages per visit and average time |
| **Content** | Pages, assets, audio files, status codes, hostnames, CDN edge locations |
| **Geography** | Countries, regions and cities for readers and for scanners separately, each with coordinates, plus the top client and scanner addresses |
| **Acquisition** | Channels, campaigns by click and by visit, sources, mediums, source/medium, terms, ad content, click IDs, **every query parameter seen**, referrer hosts and full URLs, landing pages by channel |
| **Bots** | Named bots and unidentified crawlers, each expandable to the paths it crawled, with a sample user agent for the unnamed ones |
| **Security** | Probe patterns, most-requested probe paths, 404 and 403 paths, top scanner addresses, and the probe log: the last 200 attempts with time, address, city, path, status and pattern |
| **Days** | Every processed day with its numbers. Picking one scopes every other tab to that date, and shows the hour-by-hour breakdown |

"Every query parameter seen" earns its place: it is how you find out the site is
being linked with a tag nobody here chose.

### Geography

City, region and coordinates come from an IP lookup against a MaxMind-format
database. `admin/lib/mmdb.mjs` is a ~250-line reader for the `.mmdb` container,
written rather than imported: signal uses `geoip-lite`, and a publication whose
fifth rule is *every dependency is a decision* should not pull in 150MB of
someone else's code to answer "which city".

```bash
node infra/fetch-geodb.mjs          # download DB-IP City Lite, verify, upload
node infra/fetch-geodb.mjs --check  # what is in the bucket now
```

DB-IP publishes City Lite monthly under **CC BY 4.0** with no account, which is
why it is the default rather than MaxMind's GeoLite2 (same format, but needs a
license key, so "run one command" is impossible). The attribution to db-ip.com on
the Geography tab is a licence condition — leave it there. A GeoLite2 file can be
dropped in with `--fetch-geodb --file`; the reader does not care which it is
handed.

The database lives in the staging bucket, not the deployment package: 127MB
unpacked would be twelve times the size of the whole Lambda, it changes monthly
while the code does not, and it is loaded lazily — only a run that actually has
log files to process pays for it. With no database present everything still
works and geography degrades to CloudFront's country code, which the tab says
rather than showing an empty table.

Two accuracy notes worth repeating to anyone reading the numbers: free city
databases are approximate, so treat a city as a neighbourhood-sized guess; and
country still comes from CloudFront's own `c-country` where it is present,
because that is better than an IP database.

### Reprocessing

`POST /api/stats` is incremental. `POST /api/stats?force=1` — the **Rebuild**
button — clears the processed set and re-reads every log object still in the
bucket. That is needed whenever `stats.mjs` learns a new dimension: days already
folded in keep their old, thinner shape forever otherwise, because their log
files are marked done.

For a backlog too large for a 60s invocation, or to check a change to the
accumulator against real logs before deploying it:

```bash
node infra/rebuild-stats.mjs --dry-run   # parse, print, write nothing
node infra/rebuild-stats.mjs             # rebuild and upload
```

### What the numbers mean

Four things worth understanding before quoting any of them:

- **The admin plane is checked first, and separately.** Editing an article is not
  23 people visiting. This check used to sit *below* the probe check, which
  produced a genuinely funny result: saving an article whose slug contained the
  word "wordpress" filed the author as a scanner from Oregon.
- **A request the origin actually served is never a probe**, whatever the path
  looks like. Behind CloudFront and an OAC, a 200 means the key exists in our own
  bucket, which means we put it there. The guard has to live in `fold` rather
  than in the pattern matcher, because `isLegitimateRequest` consults
  `detectProbePattern` itself — a publication that writes about `wp-config.php`
  and `.env` files trips every pattern in the list with its own article slugs,
  and the status code is the thing that cannot lie.
- **Probes are counted separately, not discarded.** The first log file this site
  ever produced was 55 out of 56 requests hitting `/.env`, `/.git/HEAD` and
  `/.env.backup`. Folded into the main tables, scanners would drown the real
  traffic and make the Philippines look like the biggest audience.
- **Bots are excluded from page views** but still counted, so the headline number
  means humans. They still cost bandwidth, so they stay in requests.
- **Audio completion is reconstructed from HTTP range requests.** A browser
  streaming an mp3 asks for byte ranges; the furthest byte an IP reached against
  the file size gives a completion percentage. A play is over 10%, finished is
  90% or more. It is the only way to know whether anyone listened to the end
  without putting a tracker in the page.

### Privacy

Raw logs contain IP addresses and expire after 30 days by lifecycle rule.

Stored reports **do** retain a bounded top-N of client and scanner addresses with
their geography. That reverses an earlier rule here, deliberately: this file used
to collapse every address to a count before writing and said so loudly, and the
scanner table turns out to be the raw material for half of what the publication
writes about. Session fingerprints are still never written — those exist only
inside a run, and unique visitors are still counted per run and collapsed to an
integer, which is why that one number is additive across runs and slightly
overstated.

If you would rather have the old rule back, it is the `accumulateIp` calls in
`admin/lib/stats.mjs` and the `ips` block in `sealDay`.

## Templates

`type` on a record picks the layout:

- `article` — the five-section format
- `podcast` — adds a plain `<audio>` element and an enclosure in `/podcast.xml`

`podcast.xml` is only written when at least one published article has audio, so
there is never a zero-item feed failing validation.

Audio duration is measured **in the browser** before upload and sent with the
article. Deriving it server-side would mean putting ffmpeg in the bundle, which is
a lot of megabytes for one number.

Images are resized by `sharp` in the Lambda into a 1400px webp and a 480px
thumbnail. The original is deliberately not kept — it is the largest object and
nothing reads it.

A gallery layout is not built. Adding one means a new layout name in
`REQUIRED_LAYOUTS`/`OPTIONAL_LAYOUTS` and a matching root in `LAYOUT_ROOTS`.

## Local development

```bash
QW_LOCAL=1 \
STAGING_BUCKET=<deploy.stagingBucket> \
LIVE_BUCKET=<deploy.bucket> \
DISTRIBUTION_ID=<deploy.distributionId> \
GOOGLE_CLIENT_ID=<id> \
node admin/server.mjs
```

Same router, same auth, real buckets. There is no offline mode and no auth bypass;
a dev backdoor in an admin is a production backdoor that happens to be documented.

## Rebuilding and redeploying

```bash
bash infra/build-lambda.sh        # ~10.6MB zip, forces the linux-x64 sharp binary
node infra/deploy-lambda.mjs      # push code + config
node infra/wire-cloudfront.mjs    # only needed if routing changes
```

The build script cross-compiles `sharp` with `--os=linux --cpu=x64 --libc=glibc`
because it usually runs on Windows, and it hard-fails if `@img/sharp-linux-x64` is
missing rather than shipping a bundle that crashes on cold start.

## Why not the Lambda Web Adapter

A common alternative is to run an Express-shaped server behind the Lambda Web
Adapter layer, with a shell script as the handler.
This one exports a native Function URL handler instead: the routing is small, it is
one fewer cross-account layer to depend on, and cold starts are quicker. Every
dependency is a decision, including our own.

## Why the Function URL is IAM-authenticated

The first attempt used `AuthType: NONE`, which returned 403 on every request. The
cause was an Organization SCP on this account blocking public Lambda Function URLs.

IAM auth plus a CloudFront OAC is the better answer anyway: CloudFront signs each
origin request with SigV4, and the Function URL rejects anything unsigned. The
admin plane has exactly one reachable front door.

Note the origin request policy is **AllViewerExceptHostHeader**. The Function URL
validates the SigV4 signature against its own hostname, so forwarding the viewer's
`Host` breaks every signed request.

## Costs

The Lambda bills only while a request is in flight. A day of editing is a few
thousand invocations at most, comfortably inside the free tier. Idle cost is zero,
which is the point.

Fixed costs remain the domain ($16/yr) and the Route 53 hosted zone ($6/yr). Alias
queries to CloudFront are not billed.

## The editor

CKEditor 5, **vendored** into `admin/ui/ckeditor.js` and `admin/ui/ckeditor.css`
and served from our own bucket. Never a CDN: `cdn.ckeditor.com` would hold
script-execution rights inside the authenticated console with nothing pinning the
bytes, and the admin CSP would have to widen from `script-src 'self'` to admit
it. The trade is that we own CKEditor's security updates, which a CDN used to
hand over silently.

### Licensing

CKEditor 5 is dual-licensed: **GPL-2.0-or-later, or commercial terms from
CKSource.** Quickieweb uses the GPL arm, declared explicitly as
`licenseKey: "GPL"`.

**This is not new, and the upgrade did not cause it.** CKEditor 5 has been
GPL-or-commercial since 2017. The 41.3.1 build this project inherited from
the 41.3.1 build this project started from is GPL too — its own header says so.
What changed in v44
is only enforcement: the runtime now refuses to start until you name which arm
you are on. The obligation was always there; the software just started making you
say it out loud. Declining the upgrade would have kept the same obligation,
undeclared.

Two consequences worth knowing before anyone reaches for a proprietary feature:

- The console is a GPL derivative work. Distributing it — which serving it to a
  browser is — obliges us to offer its source under the GPL. Quickieweb's console
  is open source anyway, so this is satisfied, but it means the console can never
  carry a proprietary component.
- `admin/ui/ckeditor-LICENSE.md` ships beside the bundle for the same reason.
  A vendored build whose header points at a LICENSE.md that never ships beside
  it is a small compliance gap worth not having.

If the commercial side ever needs the console to stop being GPL, the options are
a CKSource commercial licence or a permissively-licensed editor. The coupling is
small on purpose — `create`, `getData`, `setData`, one `change:data` listener and
one `model.change` for image insertion — so that swap is hours, not weeks.

### Refreshing the vendored build

```bash
mkdir /tmp/ck && cd /tmp/ck && npm init -y && npm i ckeditor5@latest
cp node_modules/ckeditor5/dist/browser/ckeditor5.umd.js  <repo>/admin/ui/ckeditor.js
cp node_modules/ckeditor5/dist/ckeditor5.css             <repo>/admin/ui/ckeditor.css
cp node_modules/ckeditor5/LICENSE.md                     <repo>/admin/ui/ckeditor-LICENSE.md
```

Done in a scratch directory on purpose: the repo gains no dependency, and nothing
in `package.json` pretends to manage a file we copied by hand.

### Why the plugin list is explicit

CKEditor 5 v42 replaced the prebuilt "Classic build" with one package containing
every plugin and no defaults. Before that, the vendored 41.3.1 build simply did
not contain `Code`, `CodeBlock`, `HorizontalLine` or `SourceEditing` — and a
toolbar item naming a missing plugin is dropped with only a console warning, so
this config promised three buttons that could never appear, for months.

`ensureEditor()` now checks every toolbar entry against
`editor.ui.componentFactory` after startup and surfaces anything missing in the
editor's error line. A stale bundle should be loud, not invisible.
