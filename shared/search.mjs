// Client-side search: the index, and the code that queries it.
//
// A flat-stack site has no server to ask, so search is a file the reader's
// browser downloads and queries itself. The whole design follows from one rule:
// READING MUST NOT GET SLOWER. The index is never fetched on page load, only on
// the first interaction with the search box, so a reader who never searches pays
// nothing for the feature existing.
//
// WHY NOT A LIBRARY
//
// Fuse.js is ~25KB and buys fuzzy matching over metadata. Measured against a
// real 53-page corpus, a full-text inverted index costs 31KB gzipped -- about
// 600 bytes per page, roughly the same as the metadata-only manifest it
// replaces, because the term dictionary is shared and postings compress hard.
// So a purpose-built matcher is smaller than the library AND searches body text,
// which no amount of tuning would have got out of a title-only index.
//
// WHY NO STEMMING
//
// Stemming means the same transformation has to run at build time and at query
// time, in two languages, forever. Prefix matching subsumes most of its value --
// "comput" already finds "computing" and "computer" -- and leaves a tokenizer
// simple enough that both sides are obviously the same function. There is a test
// asserting they agree.
//
// Pure: no filesystem, no S3, no network.

export const SEARCH_INDEX_VERSION = 1;

// Deliberately short. A stopword list is a judgement call about what nobody
// searches for, and every entry is a word somebody can no longer find. These are
// the ones that appear in nearly every document and carry nearly no signal.
export const STOPWORDS = new Set(`a an the and or but if then else of in on at to for
from by with as is are was were be been being it its this that these those i you your
we our they them their he she his her not no nor so than too very can will just should
now what which who whom when where why how all any both each few more most other some
such only own same do does did has have had s t`.split(/\s+/).filter(Boolean));

/**
 * The one tokenizer. Whatever changes here must change in CLIENT_SOURCE below,
 * and test/search.test.mjs runs both over the same inputs to prove they match --
 * a build-time tokenizer that disagrees with the query-time one produces a
 * search that silently finds nothing.
 */
export function tokenize(text) {
  const out = [];
  for (const raw of String(text ?? "").toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []) {
    const w = raw.replace(/^['-]+|['-]+$/g, "");
    if (w.length < 2 || w.length > 24) continue;
    if (STOPWORDS.has(w)) continue;
    out.push(w);
  }
  return out;
}

/** Body copy arrives as HTML. Tags are noise; their text is not. */
export const stripHtml = (html) =>
  String(html ?? "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#\d+);/g, " ");

// Field weights. A term in a title says far more about what a document is about
// than the same term buried in the body, and ranking has to reflect that or the
// top result is whichever page is longest.
const FIELD_WEIGHTS = { title: 8, tag: 6, dek: 4, body: 1 };
const MAX_WEIGHT = 99;

/**
 * Build the index a browser will query.
 *
 * @param docs  projected posts and pages (from the view model)
 * @returns { v, built, docs, terms }
 *
 * Postings are a compact string -- "0:14 3:2 9:1" -- rather than nested arrays.
 * It is meaningfully smaller before compression and trivial to parse, and the
 * index is the one file whose size a reader actually waits on.
 */
export function buildSearchIndex(entries) {
  const docs = [];
  const terms = new Map();

  entries.forEach((e, i) => {
    docs.push([
      e.url,
      e.title ?? "",
      (e.dek ?? "").slice(0, 160),
      e.dateDisplay ?? "",
      e.type ?? "",
      e.categoryLabel ?? "",
    ]);

    // Accumulate per-term weight for THIS document across its fields, so a term
    // in both the title and the body scores once, higher.
    const weights = new Map();
    const add = (text, weight) => {
      for (const t of tokenize(text)) weights.set(t, Math.min((weights.get(t) ?? 0) + weight, MAX_WEIGHT));
    };
    add(e.title, FIELD_WEIGHTS.title);
    add(e.dek, FIELD_WEIGHTS.dek);
    add(e.categoryLabel, FIELD_WEIGHTS.tag);
    for (const tag of e.tags ?? []) add(tag, FIELD_WEIGHTS.tag);
    add(stripHtml(e.bodyHtml), FIELD_WEIGHTS.body);

    for (const [term, w] of weights) {
      if (!terms.has(term)) terms.set(term, []);
      terms.get(term).push(`${i}:${w}`);
    }
  });

  // Sorted so the client can binary-search a prefix range instead of scanning
  // every term on every keystroke.
  const sorted = [...terms.keys()].sort();
  const out = {};
  for (const t of sorted) out[t] = terms.get(t).join(" ");

  return { v: SEARCH_INDEX_VERSION, built: new Date().toISOString().slice(0, 10), docs, terms: out };
}

/** Rough gzipped size, for the build's "this is getting big" warning. */
export const estimateIndexBytes = (index) => JSON.stringify(index).length;

// ---------------------------------------------------------------------------
// The client.
//
// Embedded as a string rather than read from disk because shared/ must stay pure
// -- the Lambda renders from S3 and has no filesystem to read a sibling file
// from. It is emitted verbatim as assets/search.js by renderSite.
//
// The interaction model is the one good documentation search has settled on: focus or
// type to open, arrows to move, Enter to follow, Escape and click-outside to
// close, "/" to focus from anywhere, and an EMPTY query that lists everything so
// the box doubles as a table of contents.
// ---------------------------------------------------------------------------
export const CLIENT_SOURCE = `// Quickieweb search. Generated -- edit shared/search.mjs instead.
(function () {
  "use strict";

  var form = document.querySelector("[data-qw-search]");
  var input = document.querySelector("[data-qw-search-input]");
  var panel = document.querySelector("[data-qw-search-results]");
  if (!form || !input || !panel) return;

  // The markup ships hidden so a reader without JavaScript never sees a control
  // that cannot work. Revealing it here is the progressive-enhancement hinge.
  form.hidden = false;

  var STOP = new Set(${JSON.stringify([...STOPWORDS])});
  var MAX = 8;
  var index = null;
  var loading = null;
  var active = -1;

  // MUST match tokenize() in shared/search.mjs.
  function tokenize(text) {
    var out = [];
    var m = String(text == null ? "" : text).toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || [];
    for (var i = 0; i < m.length; i++) {
      var w = m[i].replace(/^['-]+|['-]+$/g, "");
      if (w.length < 2 || w.length > 24) continue;
      if (STOP.has(w)) continue;
      out.push(w);
    }
    return out;
  }

  // Fetched once, on first interaction -- never on page load. A reader who does
  // not search never downloads this at all.
  function load() {
    if (index) return Promise.resolve(index);
    if (!loading) {
      loading = fetch("search-index.json", { credentials: "same-origin" })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (j) { index = j; return j; })
        .catch(function (e) {
          loading = null;
          panel.innerHTML = '<p class="qw-s-msg">Search is unavailable right now.</p>';
          throw e;
        });
    }
    return loading;
  }

  var keys = null;
  function termKeys() {
    if (!keys) keys = Object.keys(index.terms);
    return keys;
  }

  // Lower bound via binary search, so a prefix costs log(n) rather than a scan
  // of every term on every keystroke.
  function lowerBound(arr, target) {
    var lo = 0, hi = arr.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid] < target) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function postings(term) {
    var raw = index.terms[term];
    if (!raw) return [];
    return raw.split(" ").map(function (p) {
      var c = p.split(":");
      return [parseInt(c[0], 10), parseInt(c[1], 10)];
    });
  }

  function search(query) {
    var words = tokenize(query);
    if (!words.length) return null;

    var scores = new Map();
    var matchedWords = new Map();
    var all = termKeys();

    words.forEach(function (word) {
      // Exact first, then every term that starts with it. A prefix scores lower
      // than an exact hit and decays with how much was left unspecified, so
      // "comput" ranks "compute" above "computerisation".
      var seen = new Set();
      var apply = function (term, factor) {
        if (seen.has(term)) return;
        seen.add(term);
        postings(term).forEach(function (p) {
          var doc = p[0];
          scores.set(doc, (scores.get(doc) || 0) + p[1] * factor);
          if (!matchedWords.has(doc)) matchedWords.set(doc, new Set());
          matchedWords.get(doc).add(word);
        });
      };

      if (index.terms[word]) apply(word, 1);
      for (var i = lowerBound(all, word); i < all.length; i++) {
        var term = all[i];
        if (term.indexOf(word) !== 0) break;
        if (term === word) continue;
        apply(term, 0.6 * (word.length / term.length));
      }
    });

    // Documents matching every word beat documents matching one word loudly.
    var results = [];
    scores.forEach(function (score, doc) {
      var hit = matchedWords.get(doc).size;
      results.push({ doc: doc, score: score * Math.pow(4, hit - 1), words: matchedWords.get(doc) });
    });
    results.sort(function (a, b) { return b.score - a.score; });
    return results.slice(0, MAX);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Highlight AFTER escaping, and only on the escaped text, so a title
  // containing markup can never re-enter as markup.
  function mark(text, words) {
    var out = esc(text);
    if (!words) return out;
    words.forEach(function (w) {
      out = out.replace(new RegExp("(" + w.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&") + ")", "gi"),
        "<mark>$1</mark>");
    });
    return out;
  }

  function row(d, words) {
    var meta = [d[3], d[5]].filter(Boolean).join(" \\u00b7 ");
    return '<a class="qw-s-hit" href="' + esc(d[0]) + '">' +
      '<span class="qw-s-title">' + mark(d[1], words) + "</span>" +
      (meta ? '<span class="qw-s-meta">' + esc(meta) + "</span>" : "") +
      (d[2] ? '<span class="qw-s-dek">' + mark(d[2], words) + "</span>" : "") +
      "</a>";
  }

  function render(query) {
    if (!index) return;
    var hits = search(query);

    if (hits === null) {
      // An empty query lists everything: the box is a table of contents as well
      // as a search, which is the cheapest way to make it useful on a small site.
      panel.innerHTML = index.docs.slice(0, 30).map(function (d) { return row(d, null); }).join("") ||
        '<p class="qw-s-msg">Nothing published yet.</p>';
    } else if (!hits.length) {
      panel.innerHTML = '<p class="qw-s-msg">No matches for &ldquo;' + esc(query) + '&rdquo;.</p>';
    } else {
      panel.innerHTML = hits.map(function (h) { return row(index.docs[h.doc], h.words); }).join("");
    }
    open();
    setActive(-1);
  }

  function open() { panel.hidden = false; form.setAttribute("data-qw-open", ""); }
  function close() { panel.hidden = true; form.removeAttribute("data-qw-open"); setActive(-1); }
  function rows() { return Array.prototype.slice.call(panel.querySelectorAll(".qw-s-hit")); }

  function setActive(i) {
    var all = rows();
    all.forEach(function (el, n) { el.classList.toggle("is-active", n === i); });
    if (i >= 0 && all[i]) all[i].scrollIntoView({ block: "nearest" });
    active = i;
  }

  function run() {
    var q = input.value;
    load().then(function () { render(q); }).catch(function () {});
    // Keep the query in the URL so a search is shareable and survives a reload.
    // replaceState, not pushState: every keystroke would otherwise be a history
    // entry and Back would walk letter by letter.
    try {
      var url = new URL(window.location.href);
      if (q) url.searchParams.set("q", q); else url.searchParams.delete("q");
      window.history.replaceState(null, "", url);
    } catch (e) { /* file:// and other opaque origins */ }
  }

  form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
  input.addEventListener("focus", run);
  input.addEventListener("input", run);

  input.addEventListener("keydown", function (e) {
    var all = rows();
    if (e.key === "Escape") { input.value = ""; close(); input.blur(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(active + 1, all.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(active - 1, -1)); }
    else if (e.key === "Enter") {
      var target = all[active] || all[0];
      if (target) { e.preventDefault(); window.location.href = target.getAttribute("href"); }
    }
  });

  document.addEventListener("click", function (e) {
    if (!e.target.closest("[data-qw-search]") && !e.target.closest("[data-qw-search-results]")) close();
  });

  // "/" focuses from anywhere, unless you are already typing somewhere.
  document.addEventListener("keydown", function (e) {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    e.preventDefault();
    input.focus();
    input.select();
  });

  // Arriving with ?q= runs the search immediately, so a shared link works.
  try {
    var q0 = new URL(window.location.href).searchParams.get("q");
    if (q0) { input.value = q0; run(); }
  } catch (e) { /* opaque origin */ }
})();
`;
