# Contributing

## Running it

```bash
git clone <your fork>
cd quickieweb
cp config.example.json config.json      # then fill in your own values
npm run fetch-editor                    # vendors CKEditor into admin/ui/
npm test
```

There are no dependencies to install. Node 18+, the AWS CLI, and `curl`.
`npm test` runs the unit tests, validates every template, and checks that the
generated tables in `docs/TEMPLATE-SPEC.md` are not stale.

## What tends to matter here

**Say why, not what.** The code is fairly heavily commented, and almost all of it
explains a decision rather than a mechanism. `// Length first: timingSafeEqual
throws on a mismatch rather than returning false, which would surface as a 500
instead of a clean 401` is worth writing. `// compare the buffers` is not.

**A test should name the failure it prevents.** Several tests here exist because
something specific went wrong once — a tokenizer that disagreed with its own
client, a preview token whose forged signature verified, a stylesheet linked but
never produced. The test names say so.

**One source for a fact.** The spec's data tables are generated from the code.
The tokenizer exists once and both sides are tested against each other. The user
key is derived in one function two callers share. If you find yourself writing a
second copy of something, that is the bug.

**Templates are data, not code.** The engine has no `eval`, no function calls and
no expressions, and it must stay that way — templates are rendered from a shared
library in one process serving many sites.

## Templates

`docs/TEMPLATE-SPEC.md` is the contract, and
`node cli/validate-template.mjs templates/<id>` decides whether you have met it.
Exit code 0 means publishable. Please do not ship a template that has not passed
it.

## Pull requests

- `npm test` green.
- If you changed the view model, run `node cli/gen-spec.mjs` so the spec matches.
- Bump a template's `version` if you changed it — published versions are
  immutable and sites pin them.
- No new runtime dependencies without a conversation first. The repository having
  none is a feature, not an oversight.

## Licence

Contributions are accepted under the Apache License 2.0, the same terms as the
project. See LICENSE and NOTICE.
