// Client-side search: the index, and the pact between its two tokenizers.
//
//   node --test test/search.test.mjs
//
// The first test is the one that matters. The index is built in Node and queried
// in a browser by two separately-written tokenizers, and if they ever disagree
// the search silently finds nothing -- no error, no warning, just a box that
// never matches. So they are run over the same inputs and compared.

import test from "node:test";
import assert from "node:assert/strict";

import {
  tokenize, stripHtml, buildSearchIndex, STOPWORDS, CLIENT_SOURCE, SEARCH_INDEX_VERSION,
} from "../shared/search.mjs";

// Pull the client's tokenizer out of the emitted source and run it for real,
// rather than trusting that the copy in the comment is still accurate.
const clientTokenize = (() => {
  const start = CLIENT_SOURCE.indexOf("function tokenize(text) {");
  assert.ok(start > -1, "the client must still contain a tokenize()");
  const end = CLIENT_SOURCE.indexOf("\n  }", start) + 4;
  const body = CLIENT_SOURCE.slice(start, end);
  // eslint-disable-next-line no-new-func -- our own generated source, in a test.
  return new Function("STOP", `${body}; return tokenize;`)(new Set([...STOPWORDS]));
})();

test("the build-time and query-time tokenizers are the same function", () => {
  const inputs = [
    "Compute costs money",
    "  MiXeD Case, punctuation! and---dashes  ",
    "don't split contractions",
    "a an the and or",                      // pure stopwords
    "x y ab abc",                           // length boundaries
    "'quoted' -leading- trailing-",         // trimmed edge characters
    "CO2 s3 us-east-1 2026",                // digits and identifiers
    "über naïve café",                      // non-ASCII
    "supercalifragilisticexpialidociousandthensome", // over the length cap
    "", "   ", null, undefined,
  ];
  for (const s of inputs) {
    assert.deepEqual(clientTokenize(s), tokenize(s), `disagreement on ${JSON.stringify(s)}`);
  }
});

test("tokenizing drops what nobody searches for and keeps what they do", () => {
  assert.deepEqual(tokenize("The cost of compute"), ["cost", "compute"]);
  assert.deepEqual(tokenize("a"), [], "single characters carry no signal");
  assert.ok(tokenize("us-east-1").includes("us-east-1"), "hyphenated identifiers survive whole");
  assert.deepEqual(tokenize("'quoted'"), ["quoted"], "edge punctuation is trimmed");
});

test("HTML is stripped to its text, scripts and styles removed entirely", () => {
  assert.match(stripHtml("<p>Body <strong>copy</strong></p>"), /Body\s+copy/);
  const withScript = stripHtml('<p>keep</p><script>var secret = "drop";</script>');
  assert.match(withScript, /keep/);
  assert.ok(!withScript.includes("secret"), "script contents must not be indexed");
  assert.ok(!stripHtml("<style>.a{color:red}</style>x").includes("color"));
  assert.match(stripHtml("a&nbsp;b"), /a\s+b/);
});

// ------------------------------------------------------------------- index
const ENTRIES = [
  {
    url: "compute.html", title: "The cost of compute", dek: "An invoice arrived.",
    type: "article", dateDisplay: "January 1, 2026", categoryLabel: "Bill Shock",
    tags: ["cloud"], bodyHtml: "<p>Somebody paid for servers nobody used.</p>",
  },
  {
    url: "about.html", title: "About", dek: "", type: "page",
    bodyHtml: "<p>A standing page about compute and nothing else.</p>",
  },
];

test("the index carries what a result row needs and nothing more", () => {
  const idx = buildSearchIndex(ENTRIES);
  assert.equal(idx.v, SEARCH_INDEX_VERSION);
  assert.equal(idx.docs.length, 2);
  const [url, title, dek, date, type, category] = idx.docs[0];
  assert.equal(url, "compute.html", "a relative URL, so results work under any base");
  assert.equal(title, "The cost of compute");
  assert.equal(dek, "An invoice arrived.");
  assert.equal(date, "January 1, 2026");
  assert.equal(type, "article");
  assert.equal(category, "Bill Shock");
});

test("body text is indexed -- the thing neither reference site could do", () => {
  const idx = buildSearchIndex(ENTRIES);
  assert.ok(idx.terms.servers, '"servers" appears only in the body and must be findable');
  assert.ok(idx.terms.invoice, "and in the dek");
  assert.ok(idx.terms.cloud, "and in the tags");
});

test("a title match outweighs the same word in a body", () => {
  const idx = buildSearchIndex(ENTRIES);
  const weights = Object.fromEntries(
    idx.terms.compute.split(" ").map((p) => p.split(":").map(Number)));
  // doc 0 has "compute" in its title, doc 1 only in its body.
  assert.ok(weights[0] > weights[1],
    `title-weighted ${weights[0]} must beat body-only ${weights[1]}`);
});

test("postings are compact and parseable the way the client parses them", () => {
  const idx = buildSearchIndex(ENTRIES);
  for (const [term, raw] of Object.entries(idx.terms)) {
    for (const pair of raw.split(" ")) {
      const [doc, weight] = pair.split(":").map(Number);
      assert.ok(Number.isInteger(doc) && doc >= 0 && doc < idx.docs.length, `${term} -> doc ${doc}`);
      assert.ok(Number.isInteger(weight) && weight > 0, `${term} -> weight ${weight}`);
    }
  }
});

test("terms are sorted, because the client binary-searches prefixes", () => {
  const idx = buildSearchIndex(ENTRIES);
  const keys = Object.keys(idx.terms);
  assert.deepEqual(keys, [...keys].sort(),
    "an unsorted dictionary makes prefix lookup return nothing rather than fail loudly");
});

test("an empty site produces a valid, empty index rather than throwing", () => {
  const idx = buildSearchIndex([]);
  assert.deepEqual(idx.docs, []);
  assert.deepEqual(idx.terms, {});
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(idx)));
});

test("a stopword-only document still gets a row, just no terms", () => {
  const idx = buildSearchIndex([{ url: "a.html", title: "The and or", bodyHtml: "" }]);
  assert.equal(idx.docs.length, 1, "it stays browsable even though it is unsearchable");
  assert.deepEqual(Object.keys(idx.terms), []);
});

// ------------------------------------------------------------------ client
test("the client escapes before it highlights", () => {
  // A title containing markup must not re-enter as markup on its way through the
  // highlighter. Escaping first and marking the escaped text is what prevents it.
  const escIdx = CLIENT_SOURCE.indexOf("function esc(");
  const markIdx = CLIENT_SOURCE.indexOf("function mark(");
  assert.ok(escIdx > -1 && markIdx > escIdx, "esc must be defined before mark");
  const markBody = CLIENT_SOURCE.slice(markIdx, CLIENT_SOURCE.indexOf("\n  }", markIdx));
  assert.match(markBody, /var out = esc\(text\)/, "mark() must start from escaped text");
});

test("the client never fetches on page load", () => {
  // The whole flat-stack argument for search rests on this: the index is fetched
  // on interaction, never eagerly. The obvious alternative -- shipping the
  // manifest with every page -- charges every reader for a feature most of them
  // never touch.
  const fetches = [...CLIENT_SOURCE.matchAll(/fetch\(/g)];
  assert.equal(fetches.length, 1, "exactly one fetch, inside load()");
  const loadIdx = CLIENT_SOURCE.indexOf("function load()");
  assert.ok(fetches[0].index > loadIdx, "and it lives inside load()");
  // load() is reached from focus/input/submit, and from ?q= -- never from the
  // top level unconditionally.
  assert.match(CLIENT_SOURCE, /input\.addEventListener\("focus", run\)/);
});

test("the search box reveals itself, so no-JS readers see no dead control", () => {
  assert.match(CLIENT_SOURCE, /form\.hidden = false/);
  // And it bails out entirely when a template did not opt in.
  assert.match(CLIENT_SOURCE, /if \(!form \|\| !input \|\| !panel\) return;/);
});

test("the client asks for the index relatively, so previews work", () => {
  assert.match(CLIENT_SOURCE, /fetch\("search-index\.json"/,
    "a root-absolute path here would break the preview and any based rendering");
  assert.ok(!CLIENT_SOURCE.includes('fetch("/search-index.json"'));
});
