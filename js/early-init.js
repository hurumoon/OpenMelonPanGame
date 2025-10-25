// early-init.js
// Minimal global helper for legacy code that expects $ to be available.
// Loaded as an external script to comply with CSP (script-src 'self').
if (!window.$) window.$ = (sel, root = document) => root.querySelector(sel);
