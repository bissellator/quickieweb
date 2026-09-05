# marketing/

The content for **this installation's own site** — the one served at your apex,
seeded by `infra/seed-marketing-site.mjs`.

What ships here is quickieweb.com's copy. If you are running your own
installation, either edit these files or point the seeder somewhere else:

```bash
node infra/seed-marketing-site.mjs --owner you@example.com --content my-site
```

The format is the same one `content/` uses — one JSON file per post or page. See
`content/post.json.sample` and `content/page.json.sample`.

Nothing here is special-cased. It renders through the same engine, the same
templates and the same publish path as any tenant site; the only difference is
that the seeder writes it out of band, because the apex site's id (`www`) is a
reserved name the console's "New site" button will not create.
