---
name: quickieweb-template
description: Write, modify or debug a Quickieweb site template. Use when asked to build a theme, layout or template for a Quickieweb site, to restyle one, to add a design token (colour, font, logo), or when a template fails validation. Covers the manifest, the Handlebars-subset language, the view model, design tokens, and the validator.
---

# Writing a Quickieweb template

A template turns a site's content into HTML. It is **data, not code** — markup, a
manifest, a stylesheet. Nothing in it executes, because Quickieweb renders
templates from a shared library in one process for many sites at once.

**The single most important instruction: run the validator, and do not stop
until it passes.**

```bash
node cli/validate-template.mjs templates/<id>
```

A template that reads a field that does not exist renders *nothing there* and
fails silently. The validator resolves every `{{path}}` against the real data
model and tells you the line and what is actually available. Guessing field
names is the main way this task goes wrong — `post.headline` does not exist, it
is `post.title`.

## Do this, in this order

1. **Read `docs/TEMPLATE-SPEC.md`.** The data tables in it are generated from
   `shared/template/viewmodel.mjs`, so they are correct by construction. Do not
   work from memory of Handlebars or of other static site generators.
2. **Copy an existing template** rather than starting empty:
   `templates/plain` is minimal, `templates/journal` is fuller.
3. Change `id`, `name`, `version`, `description` in `template.json`.
4. Write the layouts.
5. `node cli/validate-template.mjs templates/<id>` — fix everything, repeat.
6. `node cli/build.mjs --template <id>` and read `site/index.html`,
   `site/about.html` and one post to check the output is sane.

## The four required layouts

`index`, `article`, `page`, `404`. All four, every time. `page` renders static
pages (About, Contact) and is required because a site that switches templates
must not lose its About page.

## The language

A Handlebars subset:

```handlebars
{{ path }}                          escaped
{{{ path }}}                        raw -- ONLY for {{{post.bodyHtml}}},
                                    {{{page.bodyHtml}}} and {{{seo.jsonLd}}}
{{#if path}} … {{else}} … {{/if}}
{{#unless path}} … {{/unless}}
{{#each path}} … {{else}} … {{/each}}
{{> partial}}
{{! comment }}
```

Inside `{{#each}}`: `{{.}}`, `{{@index}}`, `{{@number}}`, `{{@first}}`, `{{@last}}`.

**These do not exist. Do not write them:**

| Not supported | Use instead |
|---|---|
| `{{^thing}}` | `{{#unless thing}}` |
| `{{#if a b}}`, `{{#if (eq a b)}}` | restructure; there are no expressions |
| `{{formatDate post.date}}` and any other helper | `{{post.dateDisplay}}` — the data is pre-formatted |
| `{{> card post}}` (partial parameters) | put the partial inside `{{#each}}` and declare its `context` |
| `{{#with}}` | `{{#if}}`, or dotted paths |

There is no escape hatch. If a layout needs a value that is not in the view
model, the answer is to add it to `shared/template/viewmodel.mjs` (and its
`SHAPES` entry), not to invent syntax.

## Two rules the validator will not let you break

**No JavaScript of your own.** Exactly one `<script>` form is allowed:

```handlebars
{{#each template.scripts}}<script src="{{.}}" defer></script>{{/each}}
```

The URL comes from the view model, never from you. An inline body or a literal
`src` is refused. Structured data is already `{{{seo.jsonLd}}}`, wrapped in its
own tag.

Rendering `template.scripts` is also how a template gets **search**, which the
platform supplies. Add the three hooks and it works:

```html
<form class="search" data-qw-search hidden role="search">
  <input type="search" data-qw-search-input placeholder="Search" aria-label="Search this site">
  <div class="search-results" data-qw-search-results hidden></div>
</form>
```

Keep `hidden` on the form — the script removes it, so a reader without
JavaScript never sees a dead control. Style `.qw-s-hit` (plus `.is-active`),
`.qw-s-title`, `.qw-s-meta`, `.qw-s-dek`, `.qw-s-msg` and `<mark>`.

**No external URLs for assets.** No Google Fonts, no CDN stylesheets, no
remote images. Ship the file in the package. A third-party request is a
dependency that can break a customer's site without anyone touching it.

## Design tokens are the whole customization story

Anything a site owner should be able to change must be a token. A colour
hardcoded in your CSS is a colour the customer cannot change.

```json
"tokens": {
  "color.ink": { "type": "color", "default": "#14161a", "label": "Body text", "group": "Color" },
  "font.body": { "type": "font",  "default": "system-ui, sans-serif", "label": "Body font" },
  "logo":      { "type": "image", "optional": true, "label": "Masthead logo" }
}
```

One key, three spellings:

| `color.ink` | in `template.json` |
| `{{theme.color.ink}}` | in a layout |
| `var(--color-ink)` | in the stylesheet |

Types: `color`, `font`, `image`, `text`, `number`, `select` (needs `options`),
`boolean`. Every non-optional token needs a `default`. A key that is a prefix of
another (`color` and `color.ink`) is rejected.

The admin builds its customization form from this, so a good `label` and `group`
are user-facing work, not metadata.

### Dark mode

Declare parallel `dark.*` colour tokens and remap them in your own stylesheet —
see `templates/journal/assets/style.css`. Do not hardcode a dark palette; a
customer who sets a brand accent should set its dark counterpart too.

## Partials and context

Partials take no parameters. A partial used inside `{{#each posts}}` reads the
post's fields bare (`{{title}}`, not `{{post.title}}`), so it must declare what
it is rendered against or the validator cannot check it:

```json
"partials": {
  "head": "partials/head.html",
  "card": { "path": "partials/card.html", "context": "post" }
}
```

Contexts: `post`, `page`, `navItem`. Omit it and the partial may only read what
every layout has (`site`, `nav`, `posts`, `pages`, `theme`, `seo`, `build`,
`template`).

## Reading the validator

```
error  layouts/index.html:12  {{post.headlien}} -- post has no field "headlien".
       Available here: post.type, post.slug, post.url, post.title, post.dek, …
```

The "Available here" list is the authoritative answer. Use it rather than
guessing again.

## Publishing

```bash
node cli/templates.mjs publish templates/<id>
```

Versions are **immutable**. Sites pin them, so republishing over an existing
version would silently change every site that pinned it. Bump `version` in
`template.json` instead — the publish will refuse otherwise.
