// The gallery lightbox.
//
// Pure: this module exports a string. No filesystem, no S3, no network.
//
// WHY THIS IS PLATFORM CODE AND NOT TEMPLATE CODE
//
// The validator forbids a template from carrying JavaScript, because the hosted
// product renders templates from a shared library in one process serving many
// tenants. So a template cannot ship a lightbox even though a gallery is
// useless without one. The split is the same one search uses: the platform
// supplies the behaviour, the template supplies the markup and the grid.
//
//   <div data-qw-gallery>
//     <figure data-qw-gallery-item>
//       <img src="..." alt="..." loading="lazy">
//       <figcaption>...</figcaption>
//     </figure>
//   </div>
//
// Everything the overlay shows is read back out of that markup -- src, alt,
// figcaption -- so there is no second manifest to fetch and nothing to keep in
// sync. With JavaScript off the grid is still a grid of real images; the
// lightbox is the enhancement, not the feature.
//
// The overlay's own CSS ships here rather than in each template. A results
// dropdown is a box a template can reasonably style; a modal image viewer is
// not, and requiring every template to get one right is how templates end up
// with subtly broken galleries. Templates style the GRID and can retune the
// overlay through the --qw-lb-* custom properties.

export const CLIENT_SOURCE = `// Quickieweb gallery lightbox. Generated -- edit shared/gallery.mjs instead.
(function () {
  "use strict";

  var grids = document.querySelectorAll("[data-qw-gallery]");
  if (!grids.length) return;

  // Collected per grid, so a page with two galleries pages within whichever one
  // was opened rather than across both.
  var groups = [];

  for (var g = 0; g < grids.length; g++) {
    var items = grids[g].querySelectorAll("[data-qw-gallery-item]");
    var shots = [];
    for (var i = 0; i < items.length; i++) {
      var img = items[i].querySelector("img");
      if (!img) continue;
      var cap = items[i].querySelector("figcaption");
      shots.push({
        src: img.getAttribute("data-full") || img.currentSrc || img.src,
        alt: img.getAttribute("alt") || "",
        caption: cap ? cap.textContent.trim() : ""
      });
      bind(items[i], groups.length, shots.length - 1);
    }
    if (shots.length) groups.push(shots);
  }
  if (!groups.length) return;

  function bind(el, group, index) {
    el.style.cursor = "zoom-in";
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
    if (!el.hasAttribute("role")) el.setAttribute("role", "button");
    el.addEventListener("click", function (e) {
      e.preventDefault();
      open(group, index);
    });
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(group, index); }
    });
  }

  // ---------------------------------------------------------------- styling
  //
  // Injected once, on first open. A install serving the public site under a
  // strict style-src CSP may drop this; the overlay still opens and still
  // works, it is just unstyled, which beats not opening.
  var STYLE = "" +
    ".qw-lb{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;" +
      "justify-content:center;background:var(--qw-lb-backdrop,rgba(0,0,0,.92));" +
      "touch-action:none;-webkit-user-select:none;user-select:none}" +
    ".qw-lb img{max-width:94vw;max-height:82vh;object-fit:contain;display:block;" +
      "box-shadow:0 10px 60px rgba(0,0,0,.6)}" +
    ".qw-lb-cap{position:absolute;left:0;right:0;bottom:0;padding:1rem 1.25rem 1.5rem;" +
      "text-align:center;color:var(--qw-lb-ink,#fff);font:inherit;font-size:.9rem;line-height:1.5;" +
      "background:linear-gradient(transparent,rgba(0,0,0,.75))}" +
    ".qw-lb-count{opacity:.65;font-variant-numeric:tabular-nums;display:block;" +
      "font-size:.8rem;margin-top:.35rem}" +
    ".qw-lb button{position:absolute;background:none;border:0;cursor:pointer;padding:.75rem;" +
      "color:var(--qw-lb-ink,#fff);font-size:2rem;line-height:1;opacity:.7;font-family:inherit}" +
    ".qw-lb button:hover,.qw-lb button:focus{opacity:1}" +
    ".qw-lb-prev{left:.5rem;top:50%;transform:translateY(-50%)}" +
    ".qw-lb-next{right:.5rem;top:50%;transform:translateY(-50%)}" +
    ".qw-lb-close{right:.5rem;top:.5rem;font-size:1.6rem}" +
    "@media (max-width:600px){.qw-lb img{max-height:74vh}.qw-lb button{font-size:1.6rem}}" +
    "@media (prefers-reduced-motion:no-preference){.qw-lb{animation:qw-lb-in .18s ease-out}}" +
    "@keyframes qw-lb-in{from{opacity:0}to{opacity:1}}";

  var styled = false;
  function ensureStyle() {
    if (styled) return;
    styled = true;
    try {
      var el = document.createElement("style");
      el.textContent = STYLE;
      document.head.appendChild(el);
    } catch (err) { /* unstyled but functional */ }
  }

  // ---------------------------------------------------------------- overlay
  var box = null, shots = null, at = 0, restore = null;

  function open(group, index) {
    ensureStyle();
    shots = groups[group];
    at = index;
    restore = document.activeElement;

    box = document.createElement("div");
    box.className = "qw-lb";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Image viewer");

    var img = document.createElement("img");
    var cap = document.createElement("div");
    cap.className = "qw-lb-cap";
    box.appendChild(img);
    box.appendChild(cap);

    if (shots.length > 1) {
      box.appendChild(button("qw-lb-prev", "\\u2039", "Previous image", function () { step(-1); }));
      box.appendChild(button("qw-lb-next", "\\u203a", "Next image", function () { step(1); }));
    }
    var closer = button("qw-lb-close", "\\u00d7", "Close", close);
    box.appendChild(closer);

    box.addEventListener("click", function (e) {
      // Only the backdrop closes. A click on the photo itself is how people
      // zoom, not how they leave.
      if (e.target === box) close();
    });

    document.body.appendChild(box);
    // Restored on close. Without this the page behind scrolls under the overlay.
    box.dataset.prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    document.addEventListener("keydown", onKey);
    box.addEventListener("touchstart", onTouchStart, { passive: true });
    box.addEventListener("touchend", onTouchEnd, { passive: true });

    show(img, cap);
    closer.focus();
  }

  function button(cls, glyph, label, fn) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.innerHTML = glyph;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", function (e) { e.stopPropagation(); fn(); });
    return b;
  }

  function show(img, cap) {
    var shot = shots[at];
    img.src = shot.src;
    img.alt = shot.alt;
    var text = shot.caption || shot.alt || "";
    cap.textContent = text;
    if (shots.length > 1) {
      var n = document.createElement("span");
      n.className = "qw-lb-count";
      n.textContent = (at + 1) + " of " + shots.length;
      cap.appendChild(n);
    }
    cap.hidden = !text && shots.length < 2;
    preload(at + 1);
    preload(at - 1);
  }

  // The next image is usually the next thing wanted. Fetching it now is the
  // difference between paging feeling instant and feeling like a page load.
  function preload(i) {
    if (i < 0 || i >= shots.length) return;
    var p = new Image();
    p.src = shots[i].src;
  }

  function step(delta) {
    if (!box) return;
    // Wraps. At the last image, "next" going nowhere reads as a broken button.
    at = (at + delta + shots.length) % shots.length;
    show(box.querySelector("img"), box.querySelector(".qw-lb-cap"));
  }

  function close() {
    if (!box) return;
    document.removeEventListener("keydown", onKey);
    document.body.style.overflow = box.dataset.prevOverflow || "";
    box.parentNode.removeChild(box);
    box = null;
    if (restore && restore.focus) restore.focus();
  }

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    else if (e.key === "Home") { e.preventDefault(); at = 0; step(0); }
    else if (e.key === "End") { e.preventDefault(); at = shots.length - 1; step(0); }
  }

  var startX = 0, startY = 0;
  function onTouchStart(e) {
    startX = e.changedTouches[0].clientX;
    startY = e.changedTouches[0].clientY;
  }
  function onTouchEnd(e) {
    var dx = e.changedTouches[0].clientX - startX;
    var dy = e.changedTouches[0].clientY - startY;
    // Horizontal intent only, or every attempt to scroll past the overlay pages
    // the gallery instead.
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
  }
})();
`;
