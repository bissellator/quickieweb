// Admin UI. Nothing here is a security boundary: the Lambda re-verifies the
// Google ID token and re-checks the admin list on every single request. Hiding
// a button is a courtesy, not a control.

import * as auth from "./auth.js";
import * as ms from "./ms-signin.js";

const $ = (id) => document.getElementById(id);
// Tolerant of a missing element on purpose. These are called in loops over
// lists of ids, and one stale id used to throw halfway through -- leaving every
// view hidden and the console blank, which reads as "the tool is broken" rather
// than "one panel is missing". Warn loudly, carry on.
const show = (el, on = true) => {
  if (!el) return console.warn("show(): no such element");
  el.hidden = !on;
};
const err = (el, msg) => {
  if (!el) return console.warn("err():", msg);
  el.textContent = msg ?? "";
  show(el, Boolean(msg));
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ALL_VIEWS = ["gate", "emptyView", "articlesView", "editorView", "designView",
  "adminsView", "securityView", "publishView", "statsView", "aiView"];

/**
 * One place that hides everything, so a new view cannot be forgotten in one of
 * the several paths that switch between them. The bug this replaces was exactly
 * that: the sign-in gate stayed on screen behind a signed-in console.
 */
function hideAll() {
  for (const id of [...ALL_VIEWS, "tabs", "siteSwitch"]) show($(id), false);
}

/**
 * Most of the console is meaningless without a site: every one of those tabs
 * calls an API that answers "No site selected" with a 400. Showing them anyway
 * turns a clear empty state into five different error messages.
 *
 * "Build with AI" is the exception and stays available -- it explains how to get
 * a site's design built, which is exactly what someone with nothing yet wants.
 */
function setTabsForSite(hasSite) {
  show($("tabs"), true);
  for (const t of document.querySelectorAll(".tab")) {
    show(t, hasSite || !t.hasAttribute("data-needs-site"));
  }
}

let me = null;
let taxonomy = { categories: {} };
let editing = null;
let editor = null;   // the CKEditor instance
let dirty = false;
let knownTags = [];  // every tag used on the current site, from the article list

// ------------------------------------------------------------------ startup
async function boot() {
  // Read the client id from a flat file beside this one, not from /api/health.
  // Loading the admin used to wake the Lambda on every page view for a value
  // that is a build-time constant; now the whole admin UI is static objects in
  // S3 and nothing here touches compute until you actually sign in.
  const cfg = await (await fetch("config.json")).json();
  // The admin is one build serving whatever site it was deployed alongside, so
  // its own name comes from that deploy rather than from this file.
  if (cfg.siteName) $("brand").innerHTML = `${esc(cfg.siteName)} <em>admin</em>`;
  if (!cfg.googleClientId) {
    err($("gateErr"), "No googleClientId in config.json. See docs/ADMIN.md.");
    return;
  }
  await auth.init(cfg.googleClientId, onAuthChange);
  auth.renderButton($("gbtn"));
  if (cfg.microsoftClientId) {
    show($("msbtn"), true);
    $("msbtn").addEventListener("click", () => ms.start(cfg.microsoftClientId));
  }
  // Keep a local copy of whatever is in the editor, so an expired session or a
  // closed tab never costs an article. Cleared on a successful save.
  restoreLocalDraft();
}

async function onAuthChange(profile, message) {
  if (message) err($("gateErr"), message);
  if (!profile) {
    hideAll();
    show($("gate"), true);
    auth.setSite(null);
    return;
  }
  try {
    me = await auth.api("/me");
  } catch (e) {
    // A valid Google account is no longer refused here -- /api/me answers for
    // anyone with a good token, and what they may reach is decided per site.
    // Reaching this catch means a bad or expired token, or the server is down.
    err($("gateErr"), e.message);
    auth.signOut();
    return;
  }
  err($("gateErr"), null);
  hideAll();
  $("whoEmail").textContent = me.staff ? `${me.email} (staff)` : me.email;
  show($("who"), true);

  // Which sites this person may open. An empty list is not an error: it is what
  // a valid Google account that nobody has added to anything looks like, and
  // saying so plainly beats an empty console with no explanation.
  if (!(await loadSites())) return;

  setTabsForSite(true);
  await loadTaxonomy();
  switchView("articles");
}

// ------------------------------------------------------------------- sites
let sites = [];
const SITE_KEY = "qw-admin-site";

async function loadSites() {
  const res = await auth.api("/sites");
  sites = res.sites ?? [];
  show($("newSite"), Boolean(res.staff));

  if (!sites.length) {
    hideAll();
    $("emptyTitle").textContent = res.staff ? "No sites yet" : "Nothing to edit yet";
    $("emptyBody").textContent = res.staff
      ? "Use + New site in the bar above to create the first one. It will be live at "
        + `<name>.${res.hostedDomain ?? "the platform domain"} as soon as it is created.`
      : `You are signed in as ${me.email}, but you are not a member of any site. `
        + "Ask an owner of the site you need to add your address on its People tab.";
    show($("emptyView"), true);
    // Not hideAll's blank screen: leave the tabs bar up with only what works
    // without a site, so there is somewhere to go from here.
    setTabsForSite(false);
    // Staff still need the button; the empty selector beside it would only be a
    // dropdown with nothing in it, so it stays hidden until there is a choice.
    show($("siteSelect"), false);
    show($("siteSwitch"), Boolean(res.staff));
    return false;
  }
  show($("siteSelect"), true);

  // Remember the last site per browser. A console that always reopens on
  // whichever site happens to sort first is a console you re-navigate every
  // time.
  let chosen = null;
  try { chosen = localStorage.getItem(SITE_KEY); } catch { /* private mode */ }
  if (!sites.some((s) => s.siteId === chosen)) chosen = sites[0].siteId;

  $("siteSelect").innerHTML = sites.map((s) =>
    `<option value="${esc(s.siteId)}"${s.siteId === chosen ? " selected" : ""}>` +
    `${esc(s.name || s.siteId)}${s.viaStaff ? " (staff)" : ""}</option>`).join("");
  show($("siteSwitch"), true);
  selectSite(chosen);
  return true;
}

function selectSite(siteId) {
  auth.setSite(siteId);
  try { localStorage.setItem(SITE_KEY, siteId); } catch { /* private mode */ }
  const site = sites.find((s) => s.siteId === siteId);
  if (site) $("siteSelect").title = `${site.baseUrl} - you are ${site.role}`;
}

$("siteSelect").addEventListener("change", async (ev) => {
  if (dirty && !confirm("You have unsaved changes. Switch site anyway?")) {
    ev.target.value = auth.getSite();
    return;
  }
  dirty = false;
  selectSite(ev.target.value);
  await loadTaxonomy();
  switchView("articles");
});

$("newSite").addEventListener("click", async () => {
  const siteId = prompt(
    "Subdomain for the new site.\n\n" +
    "3-40 characters, lowercase letters, digits and hyphens.\n" +
    "It becomes <id>.quickieweb.com and cannot be changed later.");
  if (!siteId) return;

  const name = prompt("Display name for the site?", siteId) ?? siteId;
  const ownerEmail = prompt("Owner's email address?", me.email);
  if (!ownerEmail) return;

  $("newSite").disabled = true;
  $("newSite").textContent = "Creating...";
  try {
    const res = await auth.api("/sites", {
      method: "POST",
      body: JSON.stringify({ siteId: siteId.trim().toLowerCase(), name, ownerEmail }),
    });
    // Provisioning publishes immediately, so the URL works the moment this
    // returns rather than after somebody remembers to press Publish.
    alert(`Created ${res.site.siteId}\n\n${res.url}`);
    await loadSites();
    selectSite(res.site.siteId);
    $("siteSelect").value = res.site.siteId;
    await loadTaxonomy();
    switchView("articles");
  } catch (e) {
    alert(`Could not create the site:\n\n${e.message}`);
  } finally {
    $("newSite").disabled = false;
    $("newSite").textContent = "+ New site";
  }
});

async function loadTaxonomy() {
  // The console serves every site from one host, so it cannot read the tenant's
  // own /taxonomy.json the way a per-site admin did. The API answers for
  // whichever site is currently selected, and authorizes that selection.
  const res = await auth.api("/site");
  taxonomy = res.taxonomy ?? { categories: {} };
}

// -------------------------------------------------------------------- views
// A tab's view is `<name>View`, by convention rather than by a lookup table.
// The table this replaces was a second list to keep in step with ALL_VIEWS and
// the markup, and adding a tab without an entry in it hid every view and then
// threw -- which is exactly what happened when the AI tab was added.
const LOADERS = {
  articles: () => loadArticles(),
  design: () => loadDesign(),
  admins: () => loadAdmins(),
  security: () => loadSecurity(),
  publish: () => loadChangeset(),
  stats: () => loadStats(),
  ai: () => loadContract(),
};

function switchView(name) {
  const view = $(`${name}View`);
  if (!view) return console.warn(`switchView: no view for "${name}"`);

  for (const id of ALL_VIEWS) show($(id), false);
  show(view, true);
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-on", t.dataset.view === name));

  // A loader that throws must not take the view down with it: the panel is
  // already on screen, so report into it and leave the rest of the console
  // usable.
  Promise.resolve()
    .then(LOADERS[name] ?? (() => {}))
    .catch((e) => {
      console.error(`${name} failed to load`, e);
      err($("globalErr"), `Could not load ${name}: ${e.message}`);
    });
}

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    if (dirty && !confirm("You have unsaved changes. Leave anyway?")) return;
    err($("globalErr"), null);
    try {
      switchView(t.dataset.view);
    } catch (e) {
      console.error(e);
      err($("globalErr"), `Something went wrong opening that tab: ${e.message}`);
    }
  }));

// Anything that escapes everywhere else. Without this the only sign of a bug is
// a console line nobody has open, and a screen that quietly stopped responding.
window.addEventListener("error", (e) => {
  err($("globalErr"), `Something went wrong: ${e.message ?? "unknown error"}`);
});
window.addEventListener("unhandledrejection", (e) => {
  const m = e.reason?.message ?? String(e.reason ?? "unknown error");
  // An expired session is a normal end to a working day, not a crash.
  if (/session|sign in|401/i.test(m)) return;
  err($("globalErr"), `Something went wrong: ${m}`);
});
$("signOut").addEventListener("click", () => auth.signOut());

// Browsers only honour this if the page has been interacted with, which by the
// time you have typed an article it certainly has.
window.addEventListener("beforeunload", (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = "";
});

// ----------------------------------------------------------------- articles
async function loadArticles() {
  const list = $("articleList");
  list.innerHTML = "<li class='muted'>loading...</li>";
  try {
    const items = await auth.api("/articles");
    knownTags = [...new Set(items.flatMap((a) => a.tags ?? []))];
    list.innerHTML = items.length ? "" : "<li class='muted'>Nothing here yet.</li>";
    for (const a of items) {
      const li = document.createElement("li");
      li.className = "item";
      // Posts, episodes and pages share one list. A page has no date and no
      // category, so its second line says where it sits in the nav instead.
      const meta = a.type === "page"
        ? (a.nav?.label ? `page &middot; in the nav as "${esc(a.nav.label)}"` : "page")
        : `${esc(a.date)}${a.categoryLabel ? ` &middot; ${esc(a.categoryLabel)}` : ""}`;
      li.innerHTML = `
        <div>
          <span class="pill ${esc(a.status)}">${esc(a.status)}</span>
          ${a.type === "podcast" ? '<span class="pill audio">audio</span>' : ""}
          ${a.type === "gallery" ? '<span class="pill images">gallery</span>' : ""}
          ${a.type === "page" ? '<span class="pill page">page</span>' : ""}
          <strong>${esc(a.title)}</strong>
          <div class="muted small">${meta}</div>
        </div>
        <div>
          <button class="btn" data-edit="${esc(a.slug)}">Edit</button>
          <button class="btn danger" data-del="${esc(a.slug)}">Delete</button>
        </div>`;
      list.append(li);
    }
  } catch (e) {
    list.innerHTML = `<li class="err">${esc(e.message)}</li>`;
  }
}

$("articleList").addEventListener("click", async (ev) => {
  const edit = ev.target.dataset.edit;
  const del = ev.target.dataset.del;
  if (edit) return openEditor(await auth.api(`/articles/${edit}`));
  if (del) {
    if (!confirm(`Delete ${del}? This removes the article and its rendered page from staging.`)) return;
    await auth.api(`/articles/${del}`, { method: "DELETE" });
    loadArticles();
  }
});

$("newArticle").addEventListener("click", () => openEditor(null));
$("backToList").addEventListener("click", () => {
  if (dirty && !confirm("You have unsaved changes. Leave anyway?")) return;
  switchView("articles");
});

function fillSelect(el, entries, selected) {
  el.innerHTML = "";
  for (const [value, label] of entries) {
    const o = document.createElement("option");
    o.value = value; o.textContent = label;
    if (value === selected) o.selected = true;
    el.append(o);
  }
}

const countWords = (html) =>
  (html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").trim().match(/\S+/g) ?? []).length;

function markDirty() {
  dirty = true;
  $("saveState").textContent = "unsaved";
  $("saveState").className = "savestate dirty";
}

async function ensureEditor() {
  if (editor) return editor;

  // CKEditor 5 v48, vendored into admin/ui/ckeditor.js and served from our own
  // bucket. Never a CDN: cdn.ckeditor.com would hold script-execution rights
  // inside the authenticated console with nothing pinning the bytes, and the
  // admin CSP would have to widen from script-src 'self' to admit it.
  //
  // v42 replaced the prebuilt "Classic build" with one package that carries
  // every plugin and no defaults, so the plugin list below is now explicit.
  // That is the whole reason code blocks were missing: the old 41.3.1 build
  // simply did not contain CodeBlock, and no configuration could conjure it.
  const CK = window.CKEDITOR;
  if (!CK || !CK.ClassicEditor) {
    throw new Error("CKEditor did not load. Check that admin/ckeditor.js was deployed.");
  }

  editor = await CK.ClassicEditor.create($("f-body"), {
    // Quickieweb uses CKEditor under the GPL arm of its dual licence. v44+
    // refuses to start without this being stated, which is a fair way to make
    // a licensing choice explicit rather than accidental. The obligation that
    // follows is real: the console is GPL, and ckeditor-LICENSE.md ships beside
    // the bundle because distributing it requires distributing the terms.
    licenseKey: "GPL",

    plugins: [
      CK.Essentials, CK.Paragraph, CK.Heading,
      CK.Bold, CK.Italic, CK.Code, CK.Link, CK.AutoLink,
      CK.BlockQuote, CK.CodeBlock, CK.HorizontalLine,
      CK.List, CK.Indent, CK.IndentBlock,
      CK.Table, CK.TableToolbar, CK.TableCaption,
      CK.Image, CK.ImageBlock, CK.ImageInline, CK.ImageCaption, CK.ImageStyle, CK.ImageToolbar,
      CK.ImageUpload, MediaUploadAdapter, PreferPastedImageFiles,
      CK.Autoformat, CK.TextTransformation, CK.PasteFromOffice,
      CK.SourceEditing,
    ].filter(Boolean),

    // A working writer's toolbar. Enough to restructure a piece properly --
    // headings, lists, quotes, links, code, tables -- without a ribbon of things
    // nobody uses on a text site.
    toolbar: [
      "heading", "|",
      "bold", "italic", "code", "link", "|",
      "bulletedList", "numberedList", "outdent", "indent", "|",
      "blockQuote", "codeBlock", "insertTable", "horizontalLine", "|",
      "undo", "redo", "|",
      "sourceEditing",
    ],

    heading: {
      options: [
        { model: "paragraph", title: "Paragraph", class: "ck-heading_paragraph" },
        { model: "heading2", view: "h2", title: "Section", class: "ck-heading_heading2" },
        { model: "heading3", view: "h3", title: "Sub-section", class: "ck-heading_heading3" },
      ],
    },

    // The languages a code block can be tagged as. The label is what the writer
    // picks from; `className` is what lands in the published HTML as
    // <pre><code class="language-…">, which a template can style or a highlighter
    // can later pick up. "plaintext" is first because it is the honest default.
    codeBlock: {
      languages: [
        { language: "plaintext", label: "Plain text" },
        { language: "bash", label: "Shell" },
        { language: "javascript", label: "JavaScript" },
        { language: "json", label: "JSON" },
        { language: "html", label: "HTML" },
        { language: "css", label: "CSS" },
        { language: "python", label: "Python" },
        { language: "sql", label: "SQL" },
        { language: "yaml", label: "YAML" },
        { language: "diff", label: "Diff" },
      ],
    },

    table: { contentToolbar: ["tableColumn", "tableRow", "mergeTableCells", "toggleTableCaption"] },
    image: { toolbar: ["imageStyle:inline", "imageStyle:block", "imageStyle:side", "|", "toggleImageCaption"] },
    link: { addTargetToExternalLinks: false, defaultProtocol: "https://" },
  });

  const imageUtils = editor.plugins.get("ImageUtils");
  editor.conversion.for("editingDowncast").add((dispatcher) => {
    for (const name of ["imageBlock", "imageInline"]) {
      dispatcher.on(`attribute:src:${name}`, (evt, data, api) => {
        if (!data.attributeNewValue) return;
        const img = imageUtils.findViewImgElement(api.mapper.toViewElement(data.item));
        if (img) api.writer.setAttribute("src", displaySrc(data.attributeNewValue), img);
      }, { priority: "low" });
    }
  });

  editor.model.document.on("change:data", () => {
    markDirty();
    $("wordCount").textContent = `${countWords(editor.getData())} words`;
  });

  // A toolbar item naming a plugin that is not loaded is dropped silently, with
  // only a console warning -- which is exactly how three dead buttons survived
  // in this config for months. Fail loudly instead.
  const missing = editor.config.get("toolbar")
    .filter((item) => item !== "|" && !editor.ui.componentFactory.has(item));
  if (missing.length) {
    console.error(`Toolbar names components this build does not have: ${missing.join(", ")}`);
    err($("editErr"), `Editor is missing: ${missing.join(", ")}. The vendored CKEditor build may be stale.`);
  }

  return editor;
}

// Bodies store images root-relative ("/media/x.webp", "/articleimages/x.webp"),
// which is what the published page needs. The console is on another host, where
// those paths 404, so the EDITING view resolves them elsewhere; the data the
// editor saves is untouched. Not against the site's own host: a protected site
// answers there with a sign-in redirect. The API serves them from staging under
// a short-lived link (POST /view-token), which also covers unpublished uploads.
// A fresh upload is shown from the file the browser already has.
const localImages = new Map();
let mediaView = null;   // { siteId, base, expiresAt }

async function ensureMediaView() {
  const siteId = auth.getSite();
  if (mediaView?.siteId === siteId && mediaView.expiresAt - Date.now() > 30 * 60 * 1000) return;
  const res = await auth.api("/view-token", { method: "POST" });
  mediaView = { siteId, base: res.base, expiresAt: res.expiresAt };
}

function displaySrc(src) {
  if (!src || !src.startsWith("/") || src.startsWith("//")) return src;
  if (localImages.has(src)) return localImages.get(src);
  if (mediaView?.siteId === auth.getSite()) return mediaView.base + src;
  const base = sites.find((s) => s.siteId === auth.getSite())?.baseUrl;
  return base ? base.replace(/\/+$/, "") + src : src;
}

// The Lambda takes 6 MB a request, so a binary body has about 4 MB to work
// with, and a pasted screenshot or a generated PNG is often bigger. The server
// cuts every image down to 1400px wide anyway, so an oversized one is scaled to
// twice that here first; nothing visible is lost.
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_MAX_WIDTH = 2800;

async function shrinkImage(file) {
  if (file.size <= IMAGE_MAX_BYTES) return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_MAX_WIDTH / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
  if (!blob) throw new Error("this browser could not re-encode the image");
  if (blob.size > IMAGE_MAX_BYTES) {
    throw new Error(`the image is still ${Math.round(blob.size / 1048576)} MB after scaling; the limit is 4 MB`);
  }
  const stem = (file.name || "pasted").replace(/\.[a-z0-9]+$/i, "");
  return new File([blob], `${stem}.webp`, { type: "image/webp" });
}

/** Upload one image to the site's staging media and return its stored URL. */
async function uploadImage(original) {
  const file = await shrinkImage(original);
  const res = await auth.api(`/media?kind=image&filename=${encodeURIComponent(file.name || "pasted")}`, {
    method: "POST", body: file, headers: { "content-type": file.type || "image/jpeg" },
  });
  localImages.set(res.url, URL.createObjectURL(file));
  return res.url;
}

// Stories are written by pasting a picture, writing about it, pasting the next.
// ImageUpload catches pasted and dropped image files (and data:/blob: images in
// pasted HTML) and hands each to this adapter, which sends it through the same
// media endpoint as the Insert image button. A failure reaches the editor as a
// rejected upload, which removes the placeholder and is shown below.
function MediaUploadAdapter(ed) {
  ed.plugins.get("FileRepository").createUploadAdapter = (loader) => ({
    async upload() {
      const file = await loader.file;
      try {
        return { default: await uploadImage(file) };
      } catch (e) {
        err($("editErr"), `Image upload failed: ${e.message}`);
        throw e;
      }
    },
    abort() {},
  });
}

// "Copy image" in a browser puts the picture on the clipboard twice: as a file
// and as <img src="https://their-site/...">. CKEditor prefers the HTML, which
// would hotlink someone else's server instead of uploading. When the HTML is
// nothing but images, upload the files instead.
function PreferPastedImageFiles(ed) {
  ed.editing.view.document.on("clipboardInput", (evt, data) => {
    const files = Array.from(data.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    const html = data.dataTransfer.getData("text/html");
    if (html && new DOMParser().parseFromString(html, "text/html").body.textContent.trim()) return;
    evt.stop();
    ed.model.change((writer) => {
      if (data.targetRanges) {
        writer.setSelection(data.targetRanges.map((r) => ed.editing.mapper.toModelRange(r)));
      }
      ed.execute("uploadImage", { file: files });
    });
  }, { priority: "high" });
}

/** A gallery record as one editable document: prose first, then its pictures. */
function withImages(a) {
  const body = a?.body ?? "";
  if (a?.type !== "gallery" || !a?.images?.length) return body;
  const tags = a.images.map((i) =>
    `<p><img src="${esc(i.url)}" alt="${esc(i.alt)}"`
    + (i.caption ? ` title="${esc(i.caption)}"` : "")
    + (i.width ? ` width="${i.width}"` : "")
    + (i.height ? ` height="${i.height}"` : "")
    + "></p>").join("");
  return body + tags;
}

// One checkbox per tag: every tag on the site plus any this post carries, in
// name order, with the post's own already ticked.
function renderTagPicks(selected) {
  const box = $("f-tags");
  const names = [...new Set([...knownTags, ...selected])].sort((x, y) => x.localeCompare(y));
  box.innerHTML = names.length ? names.map((t) =>
    `<label><input type="checkbox" value="${esc(t)}"${selected.includes(t) ? " checked" : ""}>${esc(t)}</label>`).join("")
    : "<span class='muted small'>No tags yet. Add the first one below.</span>";
}
const pickedTags = () => [...$("f-tags").querySelectorAll("input:checked")].map((i) => i.value);

$("f-tags").addEventListener("change", markDirty);
function addTag() {
  const name = $("f-newtag").value.trim().replace(/\s+/g, " ");
  if (!name) return;
  const existing = [...knownTags, ...pickedTags()].find((t) => t.toLowerCase() === name.toLowerCase());
  renderTagPicks([...new Set([...pickedTags(), existing ?? name])]);
  $("f-newtag").value = "";
  markDirty();
}
$("addTag").addEventListener("click", addTag);
$("f-newtag").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") { ev.preventDefault(); addTag(); }
});

async function openEditor(a) {
  editing = a;
  err($("editErr"), null);
  const TYPE_LABEL = { article: "post", podcast: "episode", gallery: "gallery", page: "page" };
  const type = a?.type ?? "article";
  $("editorTitle").textContent = `${a ? "Edit" : "New"} ${TYPE_LABEL[type] ?? "post"}`;

  fillSelect($("f-category"),
    Object.entries(taxonomy.categories ?? {}).map(([k, c]) => [k, c.label]),
    a?.category);
  renderTagPicks(a?.tags ?? []);

  $("f-headline").value = a?.title ?? "";
  $("f-dek").value = a?.dek ?? "";
  $("f-status").value = a?.status ?? "draft";
  $("f-access").value = a?.access ?? "";
  $("f-template").value = type;
  $("f-date").value = a?.date ?? new Date().toISOString().slice(0, 10);
  $("f-src-title").value = a?.source?.title ?? "";
  $("f-src-url").value = a?.source?.url ?? "";
  $("f-src-pub").value = a?.source?.publisher ?? "";
  $("f-src-fig").value = a?.source?.figure ?? "";
  $("f-src-disc").value = a?.source?.discussionUrl ?? "";
  $("f-pull").value = a?.pullQuote ?? "";
  $("f-nav-label").value = a?.nav?.label ?? "";
  $("f-nav-order").value = a?.nav?.order ?? 0;
  $("f-audiourl").value = a?.audio?.url ?? "";
  $("galleryMeta").textContent = a?.images?.length
    ? `${a.images.length} image${a.images.length === 1 ? "" : "s"}, taken from the body. `
      + "Add, remove or reorder them there; a caption is the image's title text."
    : "Insert images into the body. They are split out into a grid when you save.";
  $("audioMeta").textContent = a?.audio
    ? `${a.audio.mimeType ?? ""} ${a.audio.byteLength ?? 0} bytes${a.audio.durationSeconds ? `, ${Math.round(a.audio.durationSeconds)}s` : ""}`
    : "";

  const ed = await ensureEditor();
  try {
    await ensureMediaView();
  } catch (e) {
    err($("editErr"), `Images in this post may not display: ${e.message}`);
  }
  // A gallery is stored split -- prose in `body`, pictures in `images` -- but it
  // is AUTHORED as one document. Putting the images back means the editor shows
  // what the page will show, in the order the page will show it, and saving
  // splits them out again. Without this, opening a saved gallery would present
  // an author with their captions gone and a body that looks half-deleted.
  ed.setData(withImages(a));
  $("wordCount").textContent = `${countWords(ed.getData())} words`;

  dirty = false;
  $("saveState").textContent = "";
  $("saveState").className = "savestate";

  toggleType();
  for (const id of ALL_VIEWS) show($(id), false);
  show($("editorView"), true);
}

// A page has no date, no category, no source and no pull quote; a post has no
// masthead slot. Showing every field for every type is how records end up
// carrying data their own renderer never reads.
function toggleType() {
  const type = $("f-template").value;
  const isPage = type === "page";
  show($("audioFields"), type === "podcast");
  show($("galleryFields"), type === "gallery");
  show($("navFields"), isPage);
  show($("dateField"), !isPage);
  show($("categoryField"), !isPage);
  show($("tagsField"), !isPage);
  show($("sourceFields"), !isPage);
  show($("pullField"), !isPage);
}
$("f-template").addEventListener("change", () => { toggleType(); markDirty(); });
for (const id of ["f-headline", "f-dek", "f-status", "f-access", "f-date", "f-category",
  "f-src-title", "f-src-url", "f-src-pub", "f-src-fig", "f-src-disc", "f-pull",
  "f-nav-label", "f-nav-order"]) {
  $(id).addEventListener("input", markDirty);
}

// ---- inline images: uploaded to staging, then inserted at the cursor
$("insertImage").addEventListener("click", () => $("f-imagefile").click());
$("f-imagefile").addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  const ed = await ensureEditor();
  try {
    $("saveState").textContent = "uploading image...";
    const url = await uploadImage(file);
    ed.model.change((writer) => {
      const el = writer.createElement("imageBlock", { src: url });
      ed.model.insertContent(el, ed.model.document.selection);
    });
    markDirty();
  } catch (e) {
    err($("editErr"), `Image upload failed: ${e.message}`);
  } finally {
    ev.target.value = "";
  }
});

// Duration is measured here because the Lambda would need ffmpeg to work it out,
// and that is a big dependency for one number.
$("f-audiofile").addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  $("audioMeta").textContent = "uploading...";
  try {
    const durationSeconds = await new Promise((resolve) => {
      const el = new Audio();
      el.preload = "metadata";
      el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) ? el.duration : null);
      el.onerror = () => resolve(null);
      el.src = URL.createObjectURL(file);
    });
    const res = await auth.api(`/media?kind=audio&filename=${encodeURIComponent(file.name)}`, {
      method: "POST", body: file, headers: { "content-type": file.type || "audio/mpeg" },
    });
    $("f-audiourl").value = res.url;
    $("f-audiourl").dataset.duration = durationSeconds ?? "";
    $("f-audiourl").dataset.mime = res.mimeType;
    $("f-audiourl").dataset.bytes = res.byteLength;
    $("audioMeta").textContent = `${res.mimeType}, ${res.byteLength} bytes${durationSeconds ? `, ${Math.round(durationSeconds)}s` : ""}`;
    markDirty();
  } catch (e) {
    $("audioMeta").textContent = `upload failed: ${e.message}`;
  }
});

$("saveArticle").addEventListener("click", async () => {
  err($("editErr"), null);
  const ed = await ensureEditor();
  const audioUrl = $("f-audiourl").value;
  const type = $("f-template").value;
  const isPage = type === "page";

  const payload = {
    type,
    title: $("f-headline").value.trim(),
    dek: $("f-dek").value.trim(),
    status: $("f-status").value,
    // "" means "follow the site's default", which is what most things want.
    access: $("f-access").value,
    body: ed.getData(),
  };

  if (isPage) {
    // A label is what puts a page in the masthead; no label means it exists at
    // its URL but is not advertised.
    payload.nav = $("f-nav-label").value.trim()
      ? { label: $("f-nav-label").value.trim(), order: Number($("f-nav-order").value) || 0 }
      : null;
  } else {
    payload.date = $("f-date").value;
    payload.category = $("f-category").value;
    payload.categoryLabel = taxonomy.categories?.[$("f-category").value]?.label ?? "";
    payload.tags = pickedTags();
    payload.pullQuote = $("f-pull").value.trim();
    payload.source = {
      title: $("f-src-title").value.trim(),
      url: $("f-src-url").value.trim(),
      publisher: $("f-src-pub").value.trim(),
      figure: $("f-src-fig").value.trim(),
      discussionUrl: $("f-src-disc").value.trim(),
    };
    payload.audio = type === "podcast" && audioUrl ? {
      url: audioUrl,
      mimeType: $("f-audiourl").dataset.mime || "audio/mpeg",
      byteLength: Number($("f-audiourl").dataset.bytes || 0),
      durationSeconds: Number($("f-audiourl").dataset.duration || 0) || null,
    } : null;
  }

  if (!payload.title) return err($("editErr"), "A title is required.");
  if (payload.status === "published" && !payload.dek) {
    return err($("editErr"), "A published article needs a dek.");
  }
  if (payload.status === "published" && !payload.body.trim()) {
    return err($("editErr"), "A published article needs a body.");
  }
  // The body check above passes for a gallery of pictures and no prose, because
  // at this point the pictures are still IN the body -- they are split out on
  // the server. So the thing left to check is that there are any.
  if (type === "gallery" && payload.status === "published"
      && !payload.body.toLowerCase().includes("<img")) {
    return err($("editErr"), "A published gallery needs at least one image in the body.");
  }

  const btn = $("saveArticle");
  btn.disabled = true;
  $("saveState").textContent = "saving...";
  try {
    if (editing) await auth.api(`/articles/${editing.slug}`, { method: "PUT", body: JSON.stringify(payload) });
    else await auth.api("/articles", { method: "POST", body: JSON.stringify(payload) });
    dirty = false;
    clearLocalDraft();
    $("saveState").textContent = "saved";
    $("saveState").className = "savestate ok";
    switchView("articles");
  } catch (e) {
    err($("editErr"), e.message);
    $("saveState").textContent = "";
  } finally {
    btn.disabled = false;
  }
});

// -------------------------------------------------------------------- stats
//
// Two endpoints behind one screen. /stats is the rolled-up summary and is what
// the Overview and Days tabs read. /stats/detail is the drill-down -- geography
// down to city, per-bot crawl paths, campaign parameters, the probe log -- and
// is fetched only when a tab that needs it is opened, then cached. Opening the
// admin should not pull a megabyte of tables nobody looked at.

const fmtBytes = (b) => {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1);
  return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};

const fmtMins = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`);
const num = (n) => (n ?? 0).toLocaleString();

const tile = (label, value, sub = "") =>
  `<div class="tile"><div class="tile-v">${esc(value)}</div><div class="tile-l">${esc(label)}</div>${
    sub ? `<div class="tile-s">${esc(sub)}</div>` : ""}</div>`;

const table = (title, rows, opts = {}) => {
  const { fmt = num, note = "", labelKey = "key" } = opts;
  if (!rows?.length) return "";
  const max = Math.max(...rows.map((r) => r.count), 1);
  return `<div class="statbox"><h3>${esc(title)}</h3><ul class="bars">${rows.map((r) => {
    const label = r.label ?? r[labelKey] ?? "";
    return `<li><span class="bar-l" title="${esc(label)}">${esc(label)}</span>
     <span class="bar-t"><span class="bar-f" style="width:${Math.round((r.count / max) * 100)}%"></span></span>
     <span class="bar-c">${esc(fmt(r.count))}</span></li>`;
  }).join("")}</ul>${note ? `<p class="muted small">${esc(note)}</p>` : ""}</div>`;
};

// A plain table for rows that carry more than one number.
const grid = (title, cols, rows, note = "") => {
  if (!rows?.length) return "";
  return `<div class="statbox"><h3>${esc(title)}</h3>
    <div class="tblwrap"><table class="tbl"><thead><tr>${
      cols.map((c) => `<th${c.right ? ' class="r"' : ""}>${esc(c.head)}</th>`).join("")
    }</tr></thead><tbody>${rows.map((r) => `<tr>${
      cols.map((c) => `<td${c.right ? ' class="r"' : ""}>${c.raw ? c.get(r) : esc(String(c.get(r) ?? ""))}</td>`).join("")
    }</tr>`).join("")}</tbody></table></div>${note ? `<p class="muted small">${esc(note)}</p>` : ""}</div>`;
};

const place = (r) => [r.city, r.region, r.countryName || r.country].filter(Boolean).join(", ");
const latlng = (r) => (r.lat === null || r.lat === undefined ? "" : `${r.lat.toFixed(2)}, ${r.lng.toFixed(2)}`);

// ------------------------------------------------------------- state + tabs
let statsSummary = null;
let statsDetail = null;
let statsDetailScope = null;   // null = the whole window, or a YYYY-MM-DD
let statsTab = "overview";

function statsWindowDays() {
  return $("statsWindow").value;
}

async function ensureDetail() {
  if (statsDetail !== null) return statsDetail;
  const q = statsDetailScope
    ? `date=${encodeURIComponent(statsDetailScope)}`
    : `days=${statsWindowDays()}`;
  statsDetail = await auth.api(`/stats/detail?${q}`);
  return statsDetail;
}

function scopeLine() {
  const d = statsDetailScope;
  return `<p class="muted small scope">${
    d ? `Showing <strong>${esc(d)}</strong> only.` : `Rolled across the last ${esc(statsWindowDays())} days.`
  }${d ? ' <button class="linkbtn" id="clearScope">show the whole window</button>' : ""}</p>`;
}

// ------------------------------------------------------------------ panels
function panelOverview(s) {
  const t = s.totals;
  const peak = Math.max(...s.daily.map((d) => d.sessions), 1);
  return `
    <div class="tiles">
      ${tile("visits", num(t.sessions), "30 min session gap")}
      ${tile("page views", num(t.pageViews))}
      ${tile("pages / visit", t.pagesPerSession)}
      ${tile("bounce rate", t.bounceRate + "%", "saw one page")}
      ${tile("avg visit", fmtMins(t.avgSessionSec))}
      ${tile("bandwidth", fmtBytes(t.bandwidth))}
    </div>
    <div class="tiles">
      ${tile("requests", num(t.requests), "everything the CDN served")}
      ${tile("cache hits", t.cacheHitRate === null ? "n/a" : t.cacheHitRate + "%", "served from the edge")}
      ${tile("bots", num(t.bots), "not counted as visits")}
      ${tile("probes", num(t.probes), "scanners, counted apart")}
      ${tile("admin", num(t.internal), "your own editing")}
      ${tile("errors", num(t.errors))}
    </div>

    <div class="statbox"><h3>Visits per day</h3>
      <ul class="spark">${s.daily.slice().reverse().map((d) =>
        `<li title="${esc(d.date)}: ${d.sessions} visits, ${d.pageViews} views"><span style="height:${
          Math.max(2, Math.round((d.sessions / peak) * 100))}%"></span></li>`).join("")}</ul>
      <p class="muted small">${esc(s.daily.at(-1).date)} to ${esc(s.daily[0].date)}</p>
    </div>

    ${s.audioListens?.length ? grid("Audio", [
      { head: "File", get: (a) => a.file },
      { head: "Plays", right: true, get: (a) => num(a.plays) },
      { head: "Listeners", right: true, get: (a) => num(a.uniqueListeners) },
      { head: "Finished", right: true, get: (a) => a.completionRate + "%" },
      { head: "Avg", right: true, get: (a) => a.avgCompletion + "%" },
    ], s.audioListens, "From HTTP range requests. A play is over 10% of the file; finished is 90% or more.") : ""}

    <div class="statgrid">
      ${table("How they arrived", s.channels)}
      ${table("Top pages", s.pages)}
      ${table("Referrers", s.referrers)}
      ${table("Countries", s.countries)}
    </div>
    <p class="muted small">Window: ${esc(String(s.windowDays))} days.${
      s.lastRun ? ` Logs last processed ${esc(s.lastRun)}.` : ""} ${esc(s.geoQuality?.note ?? "")}</p>`;
}

function panelAudience(d, s) {
  const ch = d.acquisition?.channels ?? [];
  return `${scopeLine()}
    <div class="statgrid">
      ${table("Browsers", d.audience?.browsers)}
      ${table("Operating systems", d.audience?.os)}
      ${table("Devices", d.audience?.devices)}
      ${table("Device / OS", d.audience?.deviceCategories)}
      ${table("Entry pages", d.visits?.entryPages)}
      ${table("Exit pages", d.visits?.exitPages)}
    </div>
    ${grid("Visits by channel", [
      { head: "Channel", get: (r) => r.key },
      { head: "Visits", right: true, get: (r) => num(r.count) },
      { head: "Bounced", right: true, get: (r) => (r.count ? Math.round((r.bounces / r.count) * 100) + "%" : "-") },
      { head: "Pages/visit", right: true, get: (r) => (r.count ? (r.pageViews / r.count).toFixed(1) : "-") },
      { head: "Avg time", right: true, get: (r) => (r.count ? fmtMins(Math.round(r.seconds / r.count)) : "-") },
    ], ch)}`;
}

function panelContent(d) {
  return `${scopeLine()}
    <div class="statgrid">
      ${table("Pages", d.content?.pages)}
      ${table("Assets", d.content?.assets)}
      ${table("Audio files", d.content?.audio)}
      ${table("Status codes", d.content?.statuses)}
      ${table("Hostnames", d.content?.hosts)}
      ${table("CDN edge locations", d.content?.edgeLocations, {
        note: "The POP that served the request. Roughly where the reader was.",
      })}
    </div>`;
}

function panelGeo(d, s) {
  const g = d.geo ?? {};
  const anyCity = (g.cities?.length ?? 0) + (g.scannerCities?.length ?? 0) > 0;
  return `${scopeLine()}
    ${anyCity ? "" : `<p class="warn small">No city-level data in this window. Install a
      database with <code>node infra/fetch-geodb.mjs</code>, then process logs again.</p>`}
    <h2 class="subhead">Readers</h2>
    <div class="statgrid">
      ${table("Countries", g.countries)}
      ${grid("Regions", [
        { head: "Region", get: (r) => `${r.region}, ${r.countryName || r.country}` },
        { head: "Lat, lng", get: latlng },
        { head: "Hits", right: true, get: (r) => num(r.count) },
      ], g.regions)}
      ${grid("Cities", [
        { head: "City", get: place },
        { head: "Lat, lng", get: latlng },
        { head: "Hits", right: true, get: (r) => num(r.count) },
      ], g.cities)}
      ${grid("Top client addresses", [
        { head: "IP", get: (r) => r.ip },
        { head: "Where", get: place },
        { head: "Hits", right: true, get: (r) => num(r.count) },
      ], d.ips?.clients)}
    </div>
    <h2 class="subhead">Scanners</h2>
    <div class="statgrid">
      ${table("Scanner countries", g.scannerCountries)}
      ${grid("Scanner regions", [
        { head: "Region", get: (r) => `${r.region}, ${r.countryName || r.country}` },
        { head: "Lat, lng", get: latlng },
        { head: "Probes", right: true, get: (r) => num(r.count) },
      ], g.scannerRegions)}
      ${grid("Scanner cities", [
        { head: "City", get: place },
        { head: "Lat, lng", get: latlng },
        { head: "Probes", right: true, get: (r) => num(r.count) },
      ], g.scannerCities)}
    </div>
    <p class="muted small">${esc(s.geoQuality?.note ?? "")} City and region data from
      <a href="https://db-ip.com" rel="noopener">DB-IP</a>, CC BY 4.0. Free city databases
      are approximate; treat a city as a neighbourhood-sized guess.</p>`;
}

function panelAcquisition(d) {
  const a = d.acquisition ?? {};
  const empty = !["campaigns", "sources", "mediums", "terms", "content", "clickIds"]
    .some((k) => a[k]?.length);
  return `${scopeLine()}
    ${empty ? `<p class="muted small">No campaign parameters seen in this window. The
      tables below still show every query parameter that arrived, which is how you find
      out you are being linked with a tag you did not know about.</p>` : ""}
    <div class="statgrid">
      ${table("Channels", a.channels, { labelKey: "key" })}
      ${table("Campaigns (clicks)", a.campaigns)}
      ${table("Campaigns (visits)", a.campaignVisits, { note: "Read off the entry request of each visit." })}
      ${table("Sources", a.sources)}
      ${table("Mediums", a.mediums)}
      ${table("Source / medium", a.sourceMediums)}
      ${table("Terms", a.terms)}
      ${table("Ad content", a.content)}
      ${table("Click IDs", a.clickIds)}
      ${table("Every query parameter", a.queryKeys, {
        note: "Campaign or not. The fastest way to spot a tag we do not recognise.",
      })}
      ${table("Referrer hosts", a.referrers)}
      ${table("Referrer URLs", a.referrerUrls)}
      ${table("Landing pages by channel", a.landings)}
    </div>`;
}

function botBlock(title, rows, showUA) {
  if (!rows?.length) return "";
  return `<div class="statbox"><h3>${esc(title)}</h3>
    <div class="botlist">${rows.map((b, i) => `
      <details class="bot">
        <summary>
          <span class="bot-n">${esc(b.name)}</span>
          <span class="bot-c">${esc(b.category ?? "")}</span>
          <span class="bot-h">${num(b.count)} hits</span>
          <span class="bot-o">${num(b.objectsCrawled)} objects</span>
        </summary>
        ${showUA && b.sampleUA ? `<p class="ua">${esc(b.sampleUA)}</p>` : ""}
        <ul class="bars">${(b.topPaths ?? []).map((p) =>
          `<li><span class="bar-l" title="${esc(p.key)}">${esc(p.key)}</span>
           <span class="bar-t"></span><span class="bar-c">${num(p.count)}</span></li>`).join("")}</ul>
      </details>`).join("")}</div></div>`;
}

function panelBots(d) {
  const b = d.bots ?? {};
  return `${scopeLine()}
    <div class="tiles">
      ${tile("named bots", num(b.known?.length))}
      ${tile("unidentified", num(b.unknown?.length))}
      ${tile("bot requests", num((b.known ?? []).concat(b.unknown ?? []).reduce((n, x) => n + x.count, 0)))}
    </div>
    ${table("Bot categories", b.categories)}
    ${botBlock("Named bots", b.known, false)}
    ${botBlock("Unidentified crawlers", b.unknown, true)}
    <p class="muted small">Open a row for the paths it crawled. Unidentified crawlers show a
      sample user agent, which is what you need to decide whether to name one in
      <code>admin/lib/classify.mjs</code>.</p>`;
}

function panelSecurity(d) {
  const sec = d.security ?? {};
  return `${scopeLine()}
    <div class="statgrid">
      ${table("Probe patterns", sec.probePatterns)}
      ${table("Most-requested probe paths", sec.probePaths)}
      ${table("404 paths", sec.top404Paths)}
      ${table("403 paths", sec.top403Paths)}
      ${grid("Top scanner addresses", [
        { head: "IP", get: (r) => r.ip },
        { head: "Where", get: place },
        { head: "Probes", right: true, get: (r) => num(r.count) },
      ], d.ips?.scanners)}
    </div>
    ${grid("Probe log", [
      { head: "Time", get: (p) => (p.t || "").replace("T", " ").replace("Z", "") },
      { head: "Address", get: (p) => p.ip },
      { head: "Where", get: (p) => [p.city, p.country].filter(Boolean).join(", ") },
      { head: "Path", get: (p) => p.path },
      { head: "Status", right: true, get: (p) => p.status },
      { head: "Pattern", get: (p) => p.pattern },
    ], sec.probeLog, "The most recent attempts, newest first. This is the table an article quotes.")}`;
}

function panelDays(s) {
  return `<p class="muted small">Pick a day to scope every other tab to it.</p>
    ${grid("Days", [
      { head: "Date", raw: true, get: (d) => `<button class="linkbtn day" data-date="${esc(d.date)}">${esc(d.date)}</button>` },
      { head: "Visits", right: true, get: (d) => num(d.sessions) },
      { head: "Page views", right: true, get: (d) => num(d.pageViews) },
      { head: "Requests", right: true, get: (d) => num(d.requests) },
      { head: "Bots", right: true, get: (d) => num(d.bots) },
      { head: "Probes", right: true, get: (d) => num(d.probes) },
      { head: "Errors", right: true, get: (d) => num(d.errors) },
      { head: "Bandwidth", right: true, get: (d) => fmtBytes(d.bandwidth) },
    ], s.daily)}
    ${statsDetail?.hourly ? hourlyChart(statsDetail.hourly) : ""}`;
}

function hourlyChart(hours) {
  const peak = Math.max(...hours.map((h) => h.requests), 1);
  return `<div class="statbox"><h3>By hour (UTC)</h3>
    <ul class="hours">${hours.map((h) => `
      <li title="${h.hour}:00 — ${h.requests} requests, ${h.pageViews} page views, ${h.probes} probes">
        <span class="h-bar" style="height:${Math.max(2, Math.round((h.requests / peak) * 100))}%"></span>
        <span class="h-l">${h.hour}</span>
      </li>`).join("")}</ul></div>`;
}

// ------------------------------------------------------------------- render
async function renderStatsTab() {
  const box = $("statsBody");
  const s = statsSummary;
  if (statsTab === "overview") { box.innerHTML = panelOverview(s); return; }
  if (statsTab === "days") {
    box.innerHTML = panelDays(s);
    box.querySelectorAll("button.day").forEach((b) =>
      b.addEventListener("click", () => selectDay(b.dataset.date)));
    return;
  }

  box.innerHTML = "<p class='muted'>loading detail...</p>";
  let d;
  try {
    d = await ensureDetail();
  } catch (e) {
    box.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    return;
  }
  if (!d || d.empty) {
    box.innerHTML = "<p class='muted'>No detail for this window yet. Process some logs first.</p>";
    return;
  }
  const panels = {
    audience: () => panelAudience(d, s),
    content: () => panelContent(d),
    geo: () => panelGeo(d, s),
    acquisition: () => panelAcquisition(d),
    bots: () => panelBots(d),
    security: () => panelSecurity(d),
  };
  box.innerHTML = (panels[statsTab] ?? (() => ""))();
  const clear = $("clearScope");
  if (clear) clear.addEventListener("click", () => selectDay(null));
}

function selectDay(date) {
  statsDetailScope = date;
  statsDetail = null;
  if (date && statsTab === "days") statsTab = "overview";
  syncStatsTabs();
  renderStatsTab();
}

function syncStatsTabs() {
  document.querySelectorAll("#statsTabs .subtab").forEach((b) =>
    b.classList.toggle("is-on", b.dataset.stab === statsTab));
}

async function loadStats() {
  const box = $("statsBody");
  box.innerHTML = "<p class='muted'>loading...</p>";
  show($("statsTabs"), false);
  try {
    statsSummary = await auth.api(`/stats?days=${statsWindowDays()}`);
    statsDetail = null;

    if (!statsSummary.daily.length) {
      box.innerHTML = `<p class="muted">No data yet. CloudFront delivers logs every few
        minutes; press <strong>Process new logs</strong> once some have arrived.</p>
        ${statsSummary.lastRun ? `<p class="muted small">Last processed ${esc(statsSummary.lastRun)}.</p>` : ""}`;
      return;
    }
    show($("statsTabs"), true);
    syncStatsTabs();
    await renderStatsTab();
  } catch (e) {
    box.innerHTML = `<p class="err">${esc(e.message)}</p>`;
  }
}

document.querySelectorAll("#statsTabs .subtab").forEach((b) =>
  b.addEventListener("click", () => {
    statsTab = b.dataset.stab;
    syncStatsTabs();
    renderStatsTab();
  }));

$("statsWindow").addEventListener("change", () => {
  statsDetailScope = null;
  loadStats();
});

$("rebuildStats").addEventListener("click", async () => {
  if (!confirm("Re-read every log file in the bucket and rebuild the whole report?\n\nSafe, but it can take a few runs if there is a backlog.")) return;
  const btn = $("rebuildStats");
  btn.disabled = true;
  btn.textContent = "Rebuilding...";
  try {
    const r = await auth.api("/stats?force=1", { method: "POST" });
    if (r.truncated) {
      alert(`Rebuilt from ${r.processed} log files. ${r.skipped} remain — press Rebuild again to continue.`);
    }
    statsDetailScope = null;
    await loadStats();
  } catch (e) {
    err($("statsBody"), e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Rebuild";
  }
});

$("refreshStats").addEventListener("click", async () => {
  const btn = $("refreshStats");
  btn.disabled = true;
  btn.textContent = "Processing...";
  try {
    const r = await auth.api("/stats", { method: "POST" });
    btn.textContent = `Processed ${r.processed}`;
    if (r.truncated) {
      alert(`Processed ${r.processed} log files. ${r.skipped} remain — run again to continue.`);
    }
    if (r.processed && !r.geo) {
      alert("Logs processed, but no geo database is loaded, so there are no cities.\n\nRun: node infra/fetch-geodb.mjs");
    }
    statsDetailScope = null;
    await loadStats();
  } catch (e) {
    err($("statsBody"), e.message);
  } finally {
    btn.disabled = false;
    setTimeout(() => { btn.textContent = "Process new logs"; }, 2500);
  }
});

// ------------------------------------------------------------------- admins
let adminList = [];
// The roles come from the server and are kept here, not re-defaulted on every
// redraw. A default that lacked a member's role would leave their <select> with
// no matching option, and a browser shows the FIRST option -- "owner" -- so the
// next Save would have promoted a viewer to owner.
let adminRoles = ["owner", "admin", "editor", "viewer"];

const ROLE_HELP = {
  owner: "everything, and a site always keeps one",
  admin: "everything: settings, members, security, publishing",
  editor: "writes and publishes content",
  viewer: "reads the protected site; no console",
};

async function loadAdmins() {
  err($("adminErr"), null);
  // Membership is per SITE, so the answer depends on which site is selected and
  // on the caller's role in THAT site -- not on a platform-wide admin list.
  const data = await auth.api("/members");
  adminList = data.members;
  if (Array.isArray(data.roles) && data.roles.length) adminRoles = data.roles;
  renderAdmins();
  const mayEdit = data.role === "owner" || data.role === "admin" || me.staff;
  $("saveAdmins").disabled = !mayEdit;
  $("addAdmin").disabled = !mayEdit;
}

function renderAdmins() {
  const roles = adminRoles;
  const body = $("adminRows");
  body.innerHTML = "";
  adminList.forEach((a, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input value="${esc(a.email)}" data-i="${i}" data-k="email"></td>
      <td><select data-i="${i}" data-k="role">${roles.map((r) =>
        `<option value="${r}"${r === a.role ? " selected" : ""} title="${esc(ROLE_HELP[r] ?? "")}">${r}</option>`).join("")}</select></td>
      <td><input value="${esc(a.name ?? "")}" data-i="${i}" data-k="name"></td>
      <td><button class="btn danger" data-rm="${i}"${a.email === me.email ? " disabled title='You cannot remove yourself'" : ""}>Remove</button></td>`;
    body.append(tr);
  });
}

$("adminRows").addEventListener("input", (ev) => {
  const { i, k } = ev.target.dataset;
  if (i === undefined) return;
  adminList[Number(i)][k] = ev.target.value.trim();
});
$("adminRows").addEventListener("click", (ev) => {
  const rm = ev.target.dataset.rm;
  if (rm === undefined) return;
  adminList.splice(Number(rm), 1);
  renderAdmins();
});
$("addAdmin").addEventListener("click", () => {
  // New people start with the least access; promote them deliberately.
  adminList.push({ email: "", role: "viewer", name: "" });
  renderAdmins();
});
$("saveAdmins").addEventListener("click", async () => {
  err($("adminErr"), null);
  try {
    await auth.api("/members", { method: "PUT", body: JSON.stringify({ members: adminList.filter((a) => a.email) }) });
    await loadAdmins();
  } catch (e) {
    err($("adminErr"), e.message);
  }
});

// ----------------------------------------------------------------- security
// Who may READ the published site. One choice, applied with one button, because
// it republishes: the listings are rendered at this level and must be rebuilt
// to match it. The server refuses anything but "public" where the edge cannot
// enforce it, so the disabled radios here are a courtesy, not the control.
let securityCurrent = "public";

async function loadSecurity() {
  err($("securityErr"), null);
  show($("securityLog"), false);
  const data = await auth.api("/access");
  securityCurrent = data.default;
  for (const r of document.querySelectorAll('input[name="siteAccess"]')) {
    r.checked = r.value === data.default;
    r.disabled = !data.enforced && r.value !== "public";
  }
  show($("securityUnavailable"), !data.enforced);
  $("securityStatus").textContent = data.default === "public"
    ? `This site is public${data.protectedPages ? `, with ${data.protectedPages} protected page(s)` : ""}.`
    : `Only signed-in ${data.default}s and above can read this site${data.protectedPages ? `; ${data.protectedPages} page(s) set their own level` : ""}.`;
  $("applySecurity").disabled = true;
}

$("securityLevels").addEventListener("change", () => {
  const chosen = document.querySelector('input[name="siteAccess"]:checked')?.value;
  $("applySecurity").disabled = !chosen || chosen === securityCurrent;
});

$("applySecurity").addEventListener("click", async () => {
  const chosen = document.querySelector('input[name="siteAccess"]:checked')?.value;
  if (!chosen) return;
  const opening = ["public", "viewer", "editor", "admin"].indexOf(chosen) < ["public", "viewer", "editor", "admin"].indexOf(securityCurrent);
  const sure = confirm(opening
    ? `Open this site to ${chosen === "public" ? "EVERYONE" : `all ${chosen}s and above`}? This republishes the site now.`
    : `Restrict this site to signed-in ${chosen}s and above? This republishes the site now.`);
  if (!sure) return;
  const btn = $("applySecurity");
  btn.disabled = true;
  btn.textContent = "Applying...";
  err($("securityErr"), null);
  try {
    const res = await auth.api("/access", { method: "PUT", body: JSON.stringify({ default: chosen }) });
    $("securityLog").textContent = (res.logs ?? []).join("\n");
    show($("securityLog"), true);
    await loadSecurity();
    show($("securityLog"), true);
  } catch (e) {
    err($("securityErr"), e.message);
    btn.disabled = false;
  } finally {
    btn.textContent = "Apply and republish";
  }
});

// ------------------------------------------------------------------ publish
// Rebuilding a large site can outlast CloudFront's wait. The Lambda carries on
// and stamps staging when it finishes, so asking again shortly gets the list.
async function fetchChangeset(box) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await auth.api("/publish");
    } catch (e) {
      if (![502, 503, 504].includes(e.status) || attempt >= 8) throw e;
      box.textContent = `Staging is still rebuilding (HTTP ${e.status}); asking again in 15 seconds...`;
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
}

async function loadChangeset() {
  const box = $("changeset");
  box.textContent = "checking (staging is rebuilt first if it is out of date)...";
  try {
    const cs = await fetchChangeset(box);
    const total = cs.upload.length + cs.delete.length;
    const note = cs.rebuilt
      ? `<p class="muted small">Staging was rebuilt before comparing: ${esc(cs.rebuilt)}.</p>` : "";
    box.innerHTML = note + (total === 0
      ? "<span class='muted'>Live is already up to date with staging.</span>"
      : `<p><strong>${cs.upload.length}</strong> to copy, <strong>${cs.delete.length}</strong> to remove.</p>
         <ul class="small">${[...cs.upload.map((k) => `<li>+ ${esc(k)}</li>`),
           ...cs.delete.map((k) => `<li>- ${esc(k)}</li>`)].join("")}</ul>`);
  } catch (e) {
    box.innerHTML = `<span class="err">${esc(e.message)}</span>`;
  }
}

/** Poll the changeset until it is empty (true) or about a minute passes (false). */
async function waitForLive() {
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const cs = await auth.api("/publish");
    if (cs.upload.length + cs.delete.length === 0) return true;
  }
  return false;
}

$("doPublish").addEventListener("click", async () => {
  const btn = $("doPublish");
  btn.disabled = true;
  btn.textContent = "Publishing...";
  try {
    const res = await auth.api("/publish", { method: "POST" });
    const log = $("publishLog");
    show(log, true);
    log.textContent = [...res.logs,
      `copied ${res.copied}, removed ${res.removed}`,
      res.invalidation ? `invalidation ${res.invalidation}` : "no invalidation needed",
    ].join("\n");
    await loadChangeset();
  } catch (e) {
    // A gateway timeout means the reply was lost, not necessarily the publish: the
    // Lambda can run past CloudFront's wait. Publishing is a diff of staging against
    // live, so asking for the changeset tells us whether it landed.
    if (![502, 503, 504].includes(e.status)) { err($("changeset"), e.message); return; }
    btn.textContent = "Checking live...";
    const landed = await waitForLive();
    if (landed) {
      const log = $("publishLog");
      show(log, true);
      log.textContent = `The reply timed out (HTTP ${e.status}), but live now matches staging: published.`;
      await loadChangeset();
    } else {
      err($("changeset"), `The reply timed out (HTTP ${e.status}) and live still differs from staging. ` +
        "Press Publish again: it only copies what is still different.");
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Publish to live";
  }
});

// ------------------------------------------------------- local draft backup
// Belt and braces against losing work: the body is mirrored to localStorage
// every few seconds while editing. This is a crash/expiry net, not storage --
// the article itself lives in S3.
const DRAFT_KEY = "qw-admin-draft";

function saveLocalDraft() {
  if (!editor) return;
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      slug: editing?.slug ?? null,
      title: $("f-headline").value,
      dek: $("f-dek").value,
      body: editor.getData(),
      at: Date.now(),
    }));
  } catch { /* quota or private mode: the S3 copy is still the real one */ }
}

function clearLocalDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* nothing stored */ }
}

async function restoreLocalDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null"); } catch { return; }
  if (!d?.body || Date.now() - d.at > 7 * 86400000) return clearLocalDraft();
  const when = new Date(d.at).toLocaleString();
  if (!confirm(`Unsaved work from ${when} was found:

"${(d.title || "(untitled)").slice(0, 60)}"

Restore it into the editor?`)) {
    return clearLocalDraft();
  }
  const existing = d.slug ? await auth.api(`/articles/${d.slug}`).catch(() => null) : null;
  await openEditor(existing);
  $("f-headline").value = d.title ?? "";
  $("f-dek").value = d.dek;
  (await ensureEditor()).setData(d.body);
  markDirty();
}

// ------------------------------------------------------------------ design
//
// Both halves of this view are GENERATED from the active template's manifest:
// the field list, the input types, the grouping and the labels. Nothing here
// knows what a "journal" is, so a template published to the library tomorrow
// gets a working customization form with no change to this file. A per-template
// special case here is how that property gets lost.

async function loadDesign() {
  err($("designErr"), null);
  $("templateList").innerHTML = '<li class="muted">loading...</li>';
  $("themeForm").innerHTML = "";

  // Image tokens preview through the same media link the editor uses.
  const [catalog, theme] = await Promise.all([auth.api("/templates"), auth.api("/theme"), ensureMediaView()]);
  await loadStaticPages();
  const active = catalog.active ?? {};

  // An id can exist on both shelves, so "in use" is a match on id AND scope --
  // otherwise adopting your own `journal` would light up the library's too.
  const renderTemplate = (t, scope) => {
    const on = t.id === active.id && (active.scope ?? "library") === scope;
    return `<li class="tpl${on ? " is-on" : ""}">
      <div>
        <p class="tpl-name">${esc(t.name)} <span class="muted small">${esc(t.latest ?? "")}</span></p>
        <p class="muted small">${esc(t.description ?? "")}</p>
      </div>
      <span class="tpl-actions">
        <button class="btn small" data-preview="${esc(t.id)}" data-scope="${scope}">Preview</button>
        <button class="btn" data-template="${esc(t.id)}" data-scope="${scope}"${on ? " disabled" : ""}>${on ? "In use" : "Use this"}</button>
        ${scope === "site" ? `<button class="btn small danger" data-delete-template="${esc(t.id)}"${on ? " disabled" : ""}>Delete</button>` : ""}
      </span>
    </li>`;
  };

  $("templateList").innerHTML = (catalog.templates ?? []).length
    ? catalog.templates.map((t) => renderTemplate(t, "library")).join("")
    : '<li class="muted">The library is empty. Publish one with: node cli/templates.mjs publish &lt;dir&gt;</li>';

  $("siteTemplateList").innerHTML = (catalog.siteTemplates ?? []).length
    ? catalog.siteTemplates.map((t) => renderTemplate(t, "site")).join("")
    : '<li class="muted">Nothing uploaded yet.</li>';

  const fields = theme.groups.reduce((n, g) => n + g.fields.length, 0);
  $("themeFor").textContent = `${theme.template.name} ${theme.template.version} - ${fields} setting(s).`;
  $("themeForm").innerHTML = theme.groups.map(renderTokenGroup).join("");
  $("saveTheme").disabled = false;
}

const renderTokenGroup = (group) => `<fieldset class="tokens">
  <legend>${esc(group.group)}</legend>
  ${group.fields.map(renderToken).join("")}
</fieldset>`;

function renderToken(f) {
  const id = `tok-${f.key.replace(/[^a-z0-9]/gi, "-")}`;
  const value = f.value ?? "";
  let input;

  switch (f.type) {
    case "color":
      // Two controls on one value: the picker for choosing, the text box for
      // pasting the brand hex somebody was handed in an email.
      input = `<span class="colorpair">
        <input type="color" id="${id}-swatch" value="${esc(/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000")}">
        <input type="text" id="${id}" data-token="${esc(f.key)}" value="${esc(value)}" spellcheck="false">
      </span>`;
      break;
    case "boolean":
      input = `<input type="checkbox" id="${id}" data-token="${esc(f.key)}"${f.value ? " checked" : ""}>`;
      break;
    case "number":
      input = `<input type="number" id="${id}" data-token="${esc(f.key)}" value="${esc(value)}">`;
      break;
    case "select":
      input = `<select id="${id}" data-token="${esc(f.key)}">${(f.options ?? []).map((o) => {
        const v = typeof o === "string" ? o : o.value;
        const label = typeof o === "string" ? o : (o.label ?? o.value);
        return `<option value="${esc(v)}"${v === f.value ? " selected" : ""}>${esc(label)}</option>`;
      }).join("")}</select>`;
      break;
    case "image":
      input = `<span class="imagepair">
        <input type="text" id="${id}" data-token="${esc(f.key)}" value="${esc(value)}" placeholder="/media/..." spellcheck="false">
        <button class="btn small" data-upload="${esc(f.key)}">Upload</button>
        ${value ? `<img class="tok-preview" src="${esc(displaySrc(value))}" alt="">` : ""}
      </span>`;
      break;
    default:
      input = `<input type="text" id="${id}" data-token="${esc(f.key)}" value="${esc(value)}" spellcheck="false">`;
  }

  return `<label class="token">
    <span class="token-label">${esc(f.label)}${f.optional ? ' <span class="muted small">optional</span>' : ""}</span>
    ${input}
    ${f.help ? `<span class="muted small">${esc(f.help)}</span>` : ""}
  </label>`;
}

// Picker and text box stay in step, in both directions.
$("themeForm").addEventListener("input", (ev) => {
  const el = ev.target;
  if (el.type === "color" && el.id.endsWith("-swatch")) {
    const text = $(el.id.replace(/-swatch$/, ""));
    if (text) text.value = el.value;
  } else if (el.dataset.token) {
    const swatch = $(`${el.id}-swatch`);
    if (swatch && /^#[0-9a-f]{6}$/i.test(el.value)) swatch.value = el.value;
  }
});

// Image tokens reuse the media endpoint that inline article images use, so a
// logo is resized, converted and stored exactly like any other upload.
$("themeForm").addEventListener("click", (ev) => {
  const key = ev.target.dataset?.upload;
  if (!key) return;
  ev.preventDefault();
  const button = ev.target;

  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = "image/*";
  picker.addEventListener("change", async () => {
    const file = picker.files?.[0];
    if (!file) return;
    err($("designErr"), null);
    button.disabled = true;
    button.textContent = "Uploading...";
    try {
      const res = await auth.api(
        `/media?kind=image&filename=${encodeURIComponent(file.name)}`,
        { method: "POST", body: file, headers: { "content-type": file.type || "application/octet-stream" } });
      const input = document.querySelector(`[data-token="${CSS.escape(key)}"]`);
      if (input) input.value = res.url;
    } catch (e) {
      err($("designErr"), e.message);
    } finally {
      button.disabled = false;
      button.textContent = "Upload";
    }
  });
  picker.click();
});

// A preview is a short-lived signed link whose token sits in the PATH. Every
// asset inside the preview is written relative, so the browser carries the token
// to the stylesheet and the images without us doing anything -- which is the
// whole reason the renderer emits relative URLs.
async function onTemplateClick(ev) {
  const previewId = ev.target.dataset?.preview;
  if (previewId) {
    ev.target.disabled = true;
    ev.target.textContent = "Opening...";
    try {
      const res = await auth.api("/preview", {
        method: "POST",
        body: JSON.stringify({ siteId: auth.getSite(), templateId: previewId,
          templateScope: ev.target.dataset.scope }),
      });
      $("previewLabel").textContent =
        `${previewId} - live content, drafts included. Link expires in ${Math.round(res.ttlSeconds / 60)} minutes.`;
      $("previewOpen").href = res.url;
      $("previewFrame").src = res.url;
      show($("previewBox"), true);
      $("previewBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (e) {
      err($("designErr"), e.message);
    } finally {
      ev.target.disabled = false;
      ev.target.textContent = "Preview";
    }
    return;
  }

  const id = ev.target.dataset?.template;
  if (!id) return;
  if (!confirm(`Switch to the "${id}" template?\n\n` +
    "Every post and page is kept. Colours and fonts it does not offer are dropped.")) return;

  err($("designErr"), null);
  ev.target.disabled = true;
  ev.target.textContent = "Switching...";
  try {
    await auth.api("/templates", {
      method: "PUT",
      body: JSON.stringify({ id, scope: ev.target.dataset.scope }),
    });
    await loadDesign();
  } catch (e) {
    err($("designErr"), e.message);
    ev.target.disabled = false;
    ev.target.textContent = "Use this";
  }
}

// Both shelves render the same buttons, so both get the same handler. Binding
// it only to the library list is how the site's own templates end up with a
// Preview button that silently does nothing.
$("templateList").addEventListener("click", onTemplateClick);
$("siteTemplateList").addEventListener("click", onTemplateClick);

$("previewClose").addEventListener("click", () => {
  // Drop the src as well as hiding it: an iframe left loaded keeps a live
  // preview of unpublished content sitting in the page.
  $("previewFrame").src = "about:blank";
  show($("previewBox"), false);
});

$("saveTheme").addEventListener("click", async () => {
  err($("designErr"), null);
  const next = {};
  for (const el of document.querySelectorAll("#themeForm [data-token]")) {
    const key = el.dataset.token;
    if (el.type === "checkbox") next[key] = el.checked;
    else if (el.type === "number") next[key] = Number(el.value);
    // An empty text field means "fall back to the template default", which is a
    // deletion rather than an override of "".
    else if (el.value !== "") next[key] = el.value;
  }

  $("saveTheme").disabled = true;
  $("saveTheme").textContent = "Saving...";
  try {
    const res = await auth.api("/theme", { method: "PUT", body: JSON.stringify(next) });
    if (res.warnings?.length) err($("designErr"), res.warnings.join(" - "));
    await loadDesign();
  } catch (e) {
    err($("designErr"), e.message);
  } finally {
    $("saveTheme").disabled = false;
    $("saveTheme").textContent = "Save and rebuild";
  }
});

setInterval(() => { if (dirty) saveLocalDraft(); }, 5000);

boot().catch((e) => err($("gateErr"), e.message));

// ---- private templates: upload a folder into this site's own storage
//
// The folder picker gives us File objects with a webkitRelativePath like
// "mytheme/layouts/index.html". The first segment is the folder the user
// chose, so it is stripped: the package's own paths start at template.json.
//
// Text is read here and POSTed as a { path: text } map rather than an archive.
// Unpacking a zip server-side would mean either a dependency in a repo that has
// none, or hand-rolling an archive parser over uploaded bytes. The same shape is
// what a script or an MCP client posts, so the console is one client of the API
// rather than a privileged path into it.
const TEMPLATE_FILE_RE = /\.(json|html|css|txt|md)$/i;
const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024;

let pendingTemplate = null;

$("f-tplfolder").addEventListener("change", async (ev) => {
  err($("designErr"), null);
  pendingTemplate = null;
  $("uploadTemplate").disabled = true;

  const picked = [...(ev.target.files ?? [])];
  if (!picked.length) return ($("uploadMeta").textContent = "");

  // Everything under the chosen folder, minus the folder name itself.
  const strip = (f) => (f.webkitRelativePath || f.name).split("/").slice(1).join("/");
  const wanted = picked.filter((f) => TEMPLATE_FILE_RE.test(f.name) && !f.name.startsWith("."));

  if (!wanted.some((f) => strip(f) === "template.json")) {
    $("uploadMeta").textContent = "";
    return err($("designErr"),
      "No template.json at the top of that folder. Pick the folder that contains it, not its parent.");
  }

  const total = wanted.reduce((n, f) => n + f.size, 0);
  if (total > MAX_TEMPLATE_BYTES) {
    return err($("designErr"),
      `That package is ${Math.round(total / 1024)}KB. Templates are text; anything this big is ` +
      "probably a folder of images, which belong in the media library.");
  }

  const files = {};
  for (const f of wanted) files[strip(f)] = await f.text();
  pendingTemplate = files;

  const names = Object.keys(files);
  $("uploadMeta").textContent =
    `${names.length} file(s), ${Math.round(total / 1024)}KB: ${names.slice(0, 6).join(", ")}` +
    (names.length > 6 ? ", ..." : "");
  $("uploadTemplate").disabled = false;
});

$("uploadTemplate").addEventListener("click", async () => {
  if (!pendingTemplate) return;
  err($("designErr"), null);
  const btn = $("uploadTemplate");
  btn.disabled = true;
  btn.textContent = "Uploading...";
  try {
    const res = await auth.api("/templates", {
      method: "POST",
      body: JSON.stringify({ files: pendingTemplate }),
    });
    $("uploadMeta").textContent = `Uploaded ${res.id} ${res.version}.`;
    $("f-tplfolder").value = "";
    pendingTemplate = null;
    await loadDesign();
  } catch (e) {
    // The server returns the validator's findings; showing the first few with
    // their file and line is the difference between "invalid" and a fix.
    const findings = e.findings ?? e.body?.findings;
    err($("designErr"), Array.isArray(findings) && findings.length
      ? `${e.message}\n` + findings.filter((f) => f.level === "error").slice(0, 6)
          .map((f) => `  ${f.file}:${f.line}  ${f.message}`).join("\n")
      : e.message);
  } finally {
    btn.textContent = "Upload";
    btn.disabled = !pendingTemplate;
  }
});

// Delete is delegated from the same list the templates render into.
$("siteTemplateList").addEventListener("click", async (ev) => {
  const id = ev.target.dataset?.deleteTemplate;
  if (!id) return;
  if (!confirm(`Delete "${id}" and every version of it?\n\nThis cannot be undone.`)) return;
  err($("designErr"), null);
  try {
    await auth.api(`/templates/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadDesign();
  } catch (e) {
    err($("designErr"), e.message);
  }
});

// ---- static files: pages and what they load, uploaded and published verbatim
//
// The path is asked for rather than taken from the filename: where a page lands
// is a decision about the site's URLs, and a file called `Untitled (3).html`
// should not get to make it.
//
// Text goes up as text so it stays readable through the API; anything else as
// base64, because the request is JSON. The cap keeps the base64 body inside the
// Lambda's 6 MB request limit; a whole site, or bigger files, go up with
// `node cli/push-static.mjs` instead.
const STATIC_TEXT = /\.(html?|css|m?js|json|map|webmanifest|txt|xml|svg|ico)$/i;
const STATIC_MAX = 4 * 1024 * 1024;
let pendingStatic = null;

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

$("f-staticfile").addEventListener("change", async (ev) => {
  err($("designErr"), null);
  const file = ev.target.files?.[0];
  pendingStatic = null;
  $("staticMeta").textContent = "";
  if (file && file.size > STATIC_MAX) {
    err($("designErr"), `${file.name} is ${Math.round(file.size / 1048576)} MB; the console takes up to 4 MB. Use cli/push-static.mjs for bigger files.`);
  } else if (file) {
    pendingStatic = STATIC_TEXT.test(file.name)
      ? { body: await file.text() }
      : { bodyBase64: toBase64(await file.arrayBuffer()) };
    if (!$("f-staticpath").value.trim()) $("f-staticpath").value = file.name;
    $("staticMeta").textContent = `${file.name}, ${Math.round(file.size / 1024)}KB`;
  }
  $("uploadStatic").disabled = !pendingStatic;
});

$("uploadStatic").addEventListener("click", async () => {
  const path = $("f-staticpath").value.trim();
  if (!path || !pendingStatic) return;
  err($("designErr"), null);
  const btn = $("uploadStatic");
  btn.disabled = true;
  btn.textContent = "Uploading...";
  try {
    const res = await auth.api(`/static/${path.split("/").map(encodeURIComponent).join("/")}`, {
      method: "PUT",
      body: JSON.stringify(pendingStatic),
    });
    $("staticMeta").textContent = res.replaces
      ? `Uploaded ${res.path}. It replaces the template's own ${res.path}; publish to put it live.`
      : `Uploaded ${res.path}. Publish to put it live.`;
    $("f-staticfile").value = "";
    $("f-staticpath").value = "";
    pendingStatic = null;
    await loadStaticPages();
  } catch (e) {
    err($("designErr"), e.message);
  } finally {
    btn.textContent = "Upload";
    btn.disabled = !pendingStatic;
  }
});

async function loadStaticPages() {
  const { pages } = await auth.api("/static");
  $("staticList").innerHTML = pages.length
    ? pages.map((p) => `<li class="tpl">
        <div>
          <p class="tpl-name">${esc(p.path)}</p>
          <p class="muted small">${Math.round((p.size ?? 0) / 1024) || 1}KB${p.replaces
            ? " &middot; <strong>replaces the template's file</strong>" : ""}</p>
        </div>
        <span class="tpl-actions">
          <button class="btn small danger" data-delete-static="${esc(p.path)}">Delete</button>
        </span>
      </li>`).join("")
    : '<li class="muted">No static files.</li>';
}

$("staticList").addEventListener("click", async (ev) => {
  const path = ev.target.dataset?.deleteStatic;
  if (!path) return;
  if (!confirm(`Delete "${path}"?\n\nIt stays live until the next publish.`)) return;
  err($("designErr"), null);
  try {
    await auth.api(`/static/${path.split("/").map(encodeURIComponent).join("/")}`, { method: "DELETE" });
    await loadStaticPages();
  } catch (e) {
    err($("designErr"), e.message);
  }
});

// ---- Build with AI: hand the template contract to somebody else's assistant
//
// The contract is `skills/quickieweb-template/SKILL.md`, staged next to the
// console at deploy time rather than copied into admin/ui in the repo -- one
// source of truth, and no second copy to drift from the validator it describes.
//
// The clipboard is the whole interface here. Someone who wants an assistant to
// build their site should not have to find a file, and should not be asked to
// read the contract themselves: it is written for the model, not for them.
const STARTER_PROMPT = `I want you to build a template for my Quickieweb site.

The rules I just pasted are the whole contract - please follow them exactly,
especially: no JavaScript of your own, no external fonts or images, and every
{{field}} has to be one the data model actually has.

My site is: [what it is, in a sentence]
The feeling I want: [e.g. quiet and typographic / bold and loud / like a zine]
Colours: [or say "you choose"]

Give me every file as its own code block, and tell me the exact filename and
folder for each one. Use the id "mytheme" in template.json.`;

let contractText = null;

async function loadContract() {
  $("starterPrompt").textContent = STARTER_PROMPT;
  if (contractText !== null) return;
  try {
    const res = await fetch("template-contract.md", { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    contractText = await res.text();
    $("contractMeta").textContent = `${Math.round(contractText.length / 1024)}KB of rules`;
  } catch {
    // Never leave the button looking live when it cannot do anything.
    $("copyContract").disabled = true;
    $("contractMeta").textContent =
      "The rules file did not ship with this console. Redeploy the admin UI.";
  }
}

async function copyToClipboard(text, button, done = "Copied") {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = done;
  } catch {
    // Clipboard access needs a secure context and a user gesture; both hold
    // here, but a browser can still refuse. Select-to-copy is the fallback that
    // always works.
    button.textContent = "Press Ctrl+C";
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    setTimeout(() => ta.remove(), 15000);
  }
  setTimeout(() => { button.textContent = label; }, 2500);
}

$("copyContract").addEventListener("click", (ev) => {
  if (contractText) copyToClipboard(contractText, ev.target, "Copied - paste it into your assistant");
});
$("copyPrompt").addEventListener("click", (ev) => copyToClipboard(STARTER_PROMPT, ev.target));
