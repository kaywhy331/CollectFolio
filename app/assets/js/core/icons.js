// DCL-VIS-01 (UX Declutter PRD, WS-10): the shared inline-SVG icon set that
// replaces unicode glyph icons (▦ ☷ ▣ ⌕ ↥ ◇ ••• ☑ ☐ ★ ☆ ↻ ⇣ +) across
// views/*.js and core/components.js.
//
// Every icon matches the visual language of the shell nav icons in
// app/index.html: stroke-based, no fill, round caps/joins, stroke-width 2,
// currentColor -- and, unlike the shell icons (which are sized by
// `.nav-item svg` / `.shell-search svg` in app.css), each icon here carries
// its own width/height attributes so it renders correctly with zero CSS.
//
// Icons are always decorative: the returned <svg> is aria-hidden="true".
// The control that hosts an icon keeps its own aria-label (icon-only
// buttons) or visible text (icon + label buttons) for the accessible name
// -- icons.js never supplies one itself.

const ICONS = Object.freeze({
  // ▦ grid view
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  // ☷ list view
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  // ▣ search-from-image
  imageSearch: '<path d="M3 5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v6"/><path d="m3 14 3.5-3.5a2 2 0 0 1 2.8 0L13 14"/><circle cx="17" cy="17" r="4"/><path d="m20.3 20.3 2 2"/>',
  // ⌕ search
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/>',
  // ⇣ import
  importArrow: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/>',
  // ↥ resume a saved draft
  resume: '<path d="M12 20V6"/><path d="m6 11 6-6 6 6"/><path d="M4 20h16"/>',
  // + create / capture
  plus: '<path d="M12 5v14M5 12h14"/>',
  // ◇ empty state / privacy
  diamond: '<path d="M12 3 21 12 12 21 3 12Z"/>',
  // ••• overflow menu
  overflow: '<circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  // ☆ watch (unwatched)
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26"/>',
  // ★ watch (watching)
  starFilled: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26" fill="currentColor" stroke="none"/>',
  // ↻ refresh
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  // ☑ compare (selected)
  compareCheck: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 6-6"/>',
  // ☐ compare (not selected)
  compareBox: '<rect x="3" y="3" width="18" height="18" rx="3"/>'
});

// icon(name, { size }) -> a self-contained inline <svg> markup string.
// `size` sets both width and height (default 18, matching the smallest
// shell nav icons); pass a larger size to fill a bigger icon slot -- the
// icon never depends on a CSS rule to be legible.
export function icon(name, { size = 18 } = {}) {
  const body = ICONS[name];
  if (!body) throw new Error(`icons.js: unknown icon "${name}"`);
  return `<svg aria-hidden="true" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}
