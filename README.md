# Quickieweb

A publishing platform that costs nothing when nobody is reading.

Pages are rendered once, when you save them, and served as files from object
storage behind a CDN. There is no server on the read path, no database, and no
runtime for anyone to exploit. A page costs the same whether one person reads it
or a hundred thousand do. The editor is a Lambda that wakes when you open it and
goes back to sleep when you close the tab.

Two ways to use it:

- **Run it yourself.** This repository, pointed at your own AWS account. Your
  buckets, your CDN, your domain, your bill — which for a small site rounds to
  the price of a coffee a year. Instructions below.
- **[quickieweb.com](https://quickieweb.com)** — the hosted version. We run the
  infrastructure, you get a subdomain, and the template library lives with us.

Same codebase. The difference is one field on a site record, which is deliberate:
the moment the self-hosted version becomes a demo of the hosted one, it stops
being worth running.

---

## What you get

- **Static sites** — real HTML, readable with JavaScript off, indexable,
  shareable. Feeds included; podcast feeds when a post has audio.
- **A template system** where templates are *data, not code*. Nothing in a
  template executes. A validator checks every field reference before publication,
  so a typo is an error with a line number rather than a blank space on a page.
- **Point-and-click customization** — colours, fonts, logos. The form is
  generated from whatever the template declares, so a new template gets one for
  free.
- **Static pages** alongside dated posts. An About page can put itself in the
  masthead without editing config.
- **Photo galleries** as a post type. Drop images into the editor and they come
  out as a responsive grid with a lightbox — keyboard, swipe, captions — that
  the platform supplies, so no template has to ship JavaScript to get one.
- **Client-side search over full body text.** The index is fetched on the first
  interaction with the search box and never on page load, so a reader who does
  not search pays nothing for the feature existing.
- **Web analytics from CloudFront access logs** — visits, referrers, bots,
  city-level geography — with no tracking script anywhere on the public site.
- **Many sites from one installation**, each with its own members, and each
  person seeing only the sites they belong to.

Not built: comments, search-as-you-type against a server, or anything else that
needs to think while a reader waits. If your site needs to run code for every
visitor, this is the wrong tool.

---

## Running it in your own AWS account

You need Node 18+, the AWS CLI, `curl`, a domain in Route 53 (or one you can
repoint there), and an AWS account. Everything is a script; there is no IaC tool
to learn.

### 1. Get the code

```bash
git clone https://github.com/bissellator/quickieweb.git
cd quickieweb
cp config.example.json config.json
npm run fetch-editor
```

`config.json` is gitignored — it will hold your bucket names, distribution ids
and certificate ARN, and publishing that hands a stranger a map of your
infrastructure. `fetch-editor` vendors CKEditor into `admin/ui/`; it is not
committed because this project is Apache-2.0 and CKEditor is GPL. See NOTICE.

Fill in `config.json`. Every script refuses to run against a `REPLACE-ME`.

### 2. Make a scoped deploy user

```bash
node infra/create-deploy-user.mjs --admin-profile <your-admin-profile>
export AWS_PROFILE=quickieweb
```

This is not optional politeness. A deploy script running on a root or full-admin
key means "the script had a bug" and "the key leaked" both resolve to total
account compromise. The policy in `infra/iam/deploy-user-policy.json` scopes the
new key to your `quickieweb-*` buckets, `qw-*` functions and `qw-*` roles, and
the secret is written straight into `~/.aws/credentials` without ever being
printed. Its residual weakness is documented at the top of the script rather than
glossed over.

### 3. Provision

```bash
node infra/provision-platform.mjs    # template library + account registry
node infra/provision.mjs             # buckets, certificate, distribution, DNS, OAC
```

### 4. Create a Google OAuth client

The one step that cannot be scripted — it lives in the Google Cloud console. A
personal Google account is fine; you do not need Workspace or a billing account.

1. <https://console.cloud.google.com/apis/credentials> → **Create credentials** →
   **OAuth client ID** → **Web application**
2. **Authorized JavaScript origins**: the hostname your console will be served
   from. Wildcards are not accepted, so use one host.
3. Leave **redirect URIs** empty — Google Identity Services posts the credential
   back to the page.
4. Add yourself as a **test user** on the consent screen. A new External app
   starts in Testing, where only listed users can sign in; everyone else sees
   "access blocked" and it looks like your install is broken.

Quickieweb asks only for `openid email profile`, so publishing the app to
production needs no verification review.

### 5. Deploy

```bash
node infra/deploy-lambda.mjs --client-id <id>.apps.googleusercontent.com
node infra/wire-cloudfront.mjs
node infra/deploy-admin-ui.mjs
node infra/seed-platform-admin.mjs --email you@example.com   # makes you staff
node infra/enable-logging.mjs                                # access logs, for stats
node infra/fetch-geodb.mjs                                   # IP-to-city, monthly
```

Then sign in and create your first site.

### Publishing from a checkout

The console is not the only way in. You can author locally and push:

```bash
node cli/build.mjs                # content/*.json -> site/
node cli/deploy.mjs --dry-run
node cli/deploy.mjs
```

`deploy.mjs` never deletes. The repository and the console are two authors of the
same bucket and only one of them writes back, so a mirroring sync would take down
posts written in the console. Pruning is opt-in behind `--prune`, and
`--dry-run --prune` shows you what it would take first.

---

## Templates

A template is a manifest, some layouts, and a stylesheet. It cannot execute
anything — the engine is a Handlebars subset with no expressions, no helpers and
no function calls, because templates are rendered from a shared library in one
process serving many sites.

```bash
cp -r templates/plain templates/mine
# edit templates/mine/template.json and its layouts
node cli/validate-template.mjs templates/mine
node cli/build.mjs --template mine
```

The validator resolves every `{{path}}` against the real data model, so a
misspelled field fails with a line number instead of rendering nothing. It also
enforces the two rules that make a shared library safe: no template-supplied
JavaScript, and no external asset URLs.

- **`docs/TEMPLATE-SPEC.md`** is the contract. Its data tables are *generated*
  from the code, so they cannot drift.
- **`skills/quickieweb-template/`** is the same contract packaged as an agent
  skill, so an LLM can write a template and check its own work.

Three ship with the repository: `journal` (editorial), `ledger` (dense archive)
and `plain` (minimal).

---

## How it is put together

```
config.json              your installation. Gitignored; start from config.example.json
shared/                  pure — no filesystem, no S3, no network
  render.mjs             content + template -> the complete set of files a site is made of
  gallery.mjs            the lightbox, emitted as assets/gallery.js
  content.mjs            the content model: article, podcast, gallery, page
  site.mjs               sites, membership, storage drivers, tenant key isolation
  search.mjs             the search index, and the client that queries it
  template/              the engine, manifest, design tokens, view model, validator
templates/               journal, ledger, plain
content/                 locally authored posts and pages (optional)
marketing/               this installation's own site -- edit or replace it
cli/                     build, deploy, template library, template validator
admin/
  server.mjs             one router, two entry points (Lambda + local node:http)
  lib/                   auth, S3 store, registry, template loading, log-derived stats
  ui/                    the console: static objects in S3, never served by Lambda
infra/                   provisioning and deployment (AWS CLI + SDK, no IaC)
docs/TEMPLATE-SPEC.md    the template contract
docs/ADMIN.md            auth model, stats, the editor, the one manual step
docs/SECURITY.md         the security model, and its known gaps
docs/MCP.md              connecting an AI client: the design, not yet built
```

`shared/` being pure is what lets the CLI and the Lambda produce byte-identical
output. A page built locally and one published from the console are the same
bytes.

---

## Tests

```bash
npm test
```

Unit tests, template validation, and a check that the generated spec is current.
No framework — `node --test`.

---

## Dependencies

The repository has none. The Lambda bundle has five, installed into a build
directory and never here:

| Package | Why it earned its place |
|---|---|
| `@aws-sdk/client-s3` | Content, the registry and the template library all live in S3. |
| `@aws-sdk/client-cloudfront` | CDN invalidation on publish. |
| `@aws-sdk/client-cloudfront-keyvaluestore` | Writing who may read which page to the edge store, for protected sites. |
| `@aws-sdk/signature-v4a` | That store's API is signed with SigV4A, which the other clients do not need; this is AWS's pure-JavaScript signer. |
| `sharp` | Resizing uploaded images to web renditions. |

CKEditor is fetched by `npm run fetch-editor` and gitignored.

That is a deliberate constraint rather than an accident, and it is the same
argument the platform makes about running code: every dependency is a decision,
and most of them are made once and paid for forever.

---

## Licence

Apache License 2.0 — see [LICENSE](LICENSE).

CKEditor, which the console uses, is GPL-2.0-or-later or commercial and is
**not** bundled here. [NOTICE](NOTICE) explains what that means for a build you
distribute. Security reports: [SECURITY.md](SECURITY.md). Contributions:
[CONTRIBUTING.md](CONTRIBUTING.md).
