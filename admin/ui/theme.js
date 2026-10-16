// Light / dark / auto, the same behaviour as airbrx.ai's lib/theme.js.
//
// A classic script, loaded first in <head> before any stylesheet, so the class
// is on <html> before first paint and a dark-mode reader never sees a white
// flash. admin.css keys its dark tokens on html.dark-mode, and also on the
// system preference when this script has not run, so the page is still right
// with scripts off.
//
// Any element with data-action="theme-toggle" becomes a toggle. The choice is
// remembered per browser; "auto" (the default) follows the system setting and
// keeps following it if that changes.

(function () {
  "use strict";

  var KEY = "qw_theme_preference";
  var VALID = ["auto", "light", "dark"];
  var dark = window.matchMedia("(prefers-color-scheme: dark)");

  // Storage can be refused outright (blocked site data, some private windows).
  // Then the theme follows the system and the toggle lasts for this page only;
  // say so in the console rather than pretend it was saved.
  var memory = "auto";
  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return VALID.indexOf(v) >= 0 ? v : "auto";
    } catch (e) {
      console.warn("theme: browser storage unavailable, preference will not persist", e);
      return memory;
    }
  }
  function store(pref) {
    memory = pref;
    try {
      localStorage.setItem(KEY, pref);
    } catch (e) {
      console.warn("theme: browser storage unavailable, preference will not persist", e);
    }
  }

  function effective(pref) {
    return pref === "auto" ? (dark.matches ? "dark" : "light") : pref;
  }

  function apply(theme) {
    var html = document.documentElement;
    html.classList.remove("dark-mode", "light-mode");
    html.classList.add(theme === "dark" ? "dark-mode" : "light-mode");
    // Native controls (scrollbars, selects, date pickers) follow this.
    html.style.colorScheme = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = theme === "dark" ? "#15161a" : "#f6f5f2";
    var label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
    var buttons = document.querySelectorAll('[data-action="theme-toggle"]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-label", label);
      buttons[i].title = label;
    }
  }

  apply(effective(stored()));

  dark.addEventListener("change", function () {
    if (stored() === "auto") apply(effective("auto"));
  });

  window.QwTheme = {
    preference: stored,
    effective: function () { return effective(stored()); },
    set: function (pref) {
      if (VALID.indexOf(pref) < 0) throw new Error("Invalid theme preference: " + pref);
      store(pref);
      apply(effective(pref));
    },
    toggle: function () {
      this.set(effective(stored()) === "dark" ? "light" : "dark");
    },
  };

  function wire() {
    var buttons = document.querySelectorAll('[data-action="theme-toggle"]');
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].dataset.themeWired) continue;
      buttons[i].dataset.themeWired = "1";
      buttons[i].addEventListener("click", function () { window.QwTheme.toggle(); });
    }
    apply(effective(stored()));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
