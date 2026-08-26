import { escapeAttribute, escapeHTML } from './utils.js';

// Catalog breadcrumb (UX declutter, Kevin directive 3): "Pokémon / ME05:
// Pitch Black" style trail on product pages and the quick view, each
// segment navigating to that game or that set in Discover/browse.
//
// Id semantics verified against services/providers/tcgcsv.js and
// services/catalog-browse.js (CATALOG_GAMES) so the ids this module
// produces are exactly what app.js's existing "select-browse-game" /
// "open-browse-set" delegated handlers already expect:
//   - Flagship TCGCSV categories (Pokémon=3, Magic=1, Yu-Gi-Oh!=2) browse
//     under the fixed CATALOG_GAMES ids 'pokemon' / 'magic' / 'yugioh',
//     never the generic 'tcgcsv-category-<id>' form -- catalog-browse.js's
//     FLAGSHIP_TCGCSV_CATEGORY_IDS carve-out confirms these three ids are
//     reserved and never surfaced under their category-N label.
//   - Every other TCGCSV category browses under 'tcgcsv-category-<id>'
//     (services/providers/tcgcsv.js tcgcsvGameId()).
//   - A TCGCSV *set*'s externalId is "<categoryId>:<groupId>" (colon
//     joined -- see normalizeTCGCSVGroup in tcgcsv.js), NOT the bare
//     groupId. app.js's open-browse-set handler compares
//     action.dataset.setId against discover.sets[].externalId verbatim
//     (app.js ~line 2102), and loadCatalogSets()/loadCatalogSetProducts()
//     re-derive the same "<categoryId>:<groupId>" pair from a set's
//     externalId (catalog-browse.js groupIdentity()) -- so data-set-id
//     here must carry that same colon-joined pair, matching a TCGCSV
//     product's own externalId ("<categoryId>:<groupId>:<productId>")
//     truncated to its first two segments.
const TCGCSV_FLAGSHIP_BY_CATEGORY = Object.freeze({
  3: { id: 'pokemon', name: 'Pokémon' },
  1: { id: 'magic', name: 'Magic: The Gathering' },
  2: { id: 'yugioh', name: 'Yu-Gi-Oh!' }
});

// Labels for the fixed, non-TCGCSV "category" values a custom/manual
// collectible can carry (views/holding-form.js CATEGORIES select). Used
// only to word a game-only crumb for non-catalog items -- it is never
// wired to navigation (see catalogCrumb()'s custom-item branch below).
const CUSTOM_CATEGORY_LABELS = Object.freeze({
  pokemon: 'Pokémon', magic: 'Magic', yugioh: 'Yu-Gi-Oh!',
  sports: 'Sports', comics: 'Comics', slab: 'Graded slab', other: 'Other'
});

function trimmed(value) {
  return String(value ?? '').trim();
}

// Resolves { categoryId, groupId } for a TCGCSV item. Prefers the item's
// own categoryId/groupId (present on every full normalizeTCGCSVProduct()
// record); falls back to parsing them out of externalId
// ("<categoryId>:<groupId>:<productId>") because detail.item is sometimes
// a curated catalogRef spread (e.g. a watched-only entity reopened from
// its watch key, app.js resolveRouteContext()'s `{ ...watched.catalogRef }`
// path) that never carried the raw categoryId/groupId fields to begin
// with, even though its externalId still encodes them.
function tcgcsvIdentity(item) {
  const categoryId = Number(item.categoryId);
  const groupId = Number(item.groupId);
  if (Number.isSafeInteger(categoryId) && categoryId > 0 && Number.isSafeInteger(groupId) && groupId > 0) {
    return { categoryId, groupId };
  }
  const match = /^(\d+):(\d+)(?::\d+)?$/.exec(trimmed(item.externalId));
  if (!match) return null;
  const parsedCategoryId = Number.parseInt(match[1], 10);
  const parsedGroupId = Number.parseInt(match[2], 10);
  return Number.isSafeInteger(parsedCategoryId) && parsedCategoryId > 0 && Number.isSafeInteger(parsedGroupId) && parsedGroupId > 0
    ? { categoryId: parsedCategoryId, groupId: parsedGroupId }
    : null;
}

// "ME05: Pitch Black" -- code prefix only when there is one and the set
// name doesn't already spell it out.
function composeSetLabel(code, name) {
  if (!name) return code;
  if (!code || name.toLowerCase().includes(code.toLowerCase())) return name;
  return `${code}: ${name}`;
}

function tcgcsvCrumb(item, ref) {
  const gameLabel = trimmed(item.game || item.tcgcsvCategory?.displayName || item.tcgcsvCategory?.name || ref.game);
  const identity = tcgcsvIdentity(item);
  const flagship = identity ? TCGCSV_FLAGSHIP_BY_CATEGORY[identity.categoryId] : null;
  const resolvedGameLabel = gameLabel || flagship?.name || (identity ? `TCGCSV category ${identity.categoryId}` : '');
  if (!identity) {
    return resolvedGameLabel ? { gameId: '', gameLabel: resolvedGameLabel, setId: '', setLabel: '' } : null;
  }
  const gameId = flagship ? flagship.id : `tcgcsv-category-${identity.categoryId}`;
  const setName = trimmed(item.setName || item.tcgcsvGroup?.name || ref.setName);
  const setCode = trimmed(item.setCode || item.tcgcsvGroup?.abbreviation);
  const setLabel = composeSetLabel(setCode, setName);
  if (!setLabel) return { gameId, gameLabel: resolvedGameLabel, setId: '', setLabel: '' };
  return { gameId, gameLabel: resolvedGameLabel, setId: `${identity.categoryId}:${identity.groupId}`, setLabel };
}

// Non-TCGCSV (custom/manual, or a legacy per-game-provider) item: no
// reliable browsable catalog identity, so the crumb is a game-only label
// with both ids left blank -- crumbMarkup() renders that as plain text,
// never a button, so it never points a click at a set/game browse won't
// recognize.
function customCrumb(item, ref) {
  const rawCategory = trimmed(item.category || ref.category);
  const label = trimmed(item.game || ref.game) || CUSTOM_CATEGORY_LABELS[rawCategory] || (rawCategory !== 'other' ? rawCategory : '');
  return label ? { gameId: '', gameLabel: label, setId: '', setLabel: '' } : null;
}

// catalogCrumb(item, ref) -> { gameId, gameLabel, setId, setLabel } | null
//
// Best-effort, never throws. `item` is the raw catalog/holding item
// (detail.item); `ref` is its curated catalogReferenceForItem() output
// (core/catalog-identity.js) -- ref is used only as a fallback source for
// game/set labels when `item` itself is sparse (see tcgcsvIdentity() doc
// above), never as the primary source, since ref intentionally does not
// carry categoryId/groupId/tcgcsvGroup/tcgcsvCategory/setCode.
export function catalogCrumb(item, ref = {}) {
  const record = item || {};
  return record.provider === 'tcgcsv' ? tcgcsvCrumb(record, ref) : customCrumb(record, ref);
}

// Renders the crumb as `<nav class="catalog-crumb" aria-label="Catalog
// path">`. The game segment is a button reusing the existing global
// data-action="select-browse-game" handler when gameId is known;
// otherwise (custom items) it's plain text. The set segment (only when
// setId is present) is a button reusing data-action="open-browse-set",
// separated from the game segment by " / ".
export function crumbMarkup(crumb) {
  if (!crumb?.gameLabel) return '';
  const gameSegment = crumb.gameId
    ? `<button class="catalog-crumb-segment" type="button" data-action="select-browse-game" data-game="${escapeAttribute(crumb.gameId)}">${escapeHTML(crumb.gameLabel)}</button>`
    : `<span class="catalog-crumb-segment">${escapeHTML(crumb.gameLabel)}</span>`;
  const setSegment = crumb.setId && crumb.setLabel
    ? `<span class="catalog-crumb-sep" aria-hidden="true"> / </span><button class="catalog-crumb-segment" type="button" data-action="open-browse-set" data-game="${escapeAttribute(crumb.gameId)}" data-set-id="${escapeAttribute(crumb.setId)}">${escapeHTML(crumb.setLabel)}</button>`
    : '';
  return `<nav class="catalog-crumb" aria-label="Catalog path">${gameSegment}${setSegment}</nav>`;
}
