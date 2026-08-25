#!/usr/bin/env node
// scripts/text-census.mjs
//
// DCL-VER-01 (docs/UX_DECLUTTER_PRD.md, WS-11) -- renders fixed state
// fixtures through the five densest surfaces named in the PRD and counts
// the visible text each one produces. Used four ways:
//
//   node scripts/text-census.mjs                 -- prints current counts
//   node scripts/text-census.mjs --write-baseline -- (re)writes the
//                                                     checked-in baseline
//   node scripts/text-census.mjs --check          -- compares current
//                                                     counts to the
//                                                     checked-in baseline
//                                                     against the PRD's
//                                                     reduction targets
//   node scripts/text-census.mjs --root <path>    -- import the view
//                                                     modules from another
//                                                     checkout root instead
//                                                     of this repo (e.g. a
//                                                     `git worktree` of a
//                                                     pre-removal commit),
//                                                     so a baseline can be
//                                                     regenerated apples-
//                                                     to-apples with the
//                                                     CURRENT script/method
//                                                     version against the
//                                                     ORIGINAL views.
//
// This script only reads app view modules; it never edits them. As of
// v0.8.33 every view module under app/assets/js/views/ (and everything it
// transitively imports) reads browser globals defensively (`window?.x`,
// `navigator?.x`) and only reaches `document`/`location` on code paths this
// script's fixtures never exercise, so no shim is required today. If a
// future view import throws on a bare browser-global reference, add the
// narrowest possible fix inside installBrowserGlobalShims() below rather
// than touching app code.
//
// Zero new dependencies; Node >=22 ESM only (matches package.json).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI args are parsed up front (before the view-module imports below) so
// --root can redirect where those imports come from.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const flags = { writeBaseline: false, check: false, strict: false, asOf: null, commit: null, root: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--write-baseline') flags.writeBaseline = true;
    else if (arg === '--check') flags.check = true;
    else if (arg === '--strict') flags.strict = true;
    else if (arg === '--as-of') { flags.asOf = argv[index + 1] || null; index++; }
    else if (arg.startsWith('--as-of=')) flags.asOf = arg.slice('--as-of='.length);
    else if (arg === '--commit') { flags.commit = argv[index + 1] || null; index++; }
    else if (arg.startsWith('--commit=')) flags.commit = arg.slice('--commit='.length);
    else if (arg === '--root') { flags.root = argv[index + 1] || null; index++; }
    else if (arg.startsWith('--root=')) flags.root = arg.slice('--root='.length);
  }
  return flags;
}

const cliFlags = parseArgs(process.argv.slice(2));

// Root the view-module imports either at this repo (default) or at
// --root <path> (e.g. a `git worktree` checked out at a prior commit).
// packageVersion() below reads from the same root, so a baseline written
// with --root always describes the tree it actually imported.
const importRoot = cliFlags.root ? path.resolve(process.cwd(), cliFlags.root) : repoRoot;

function importFrom(relativePath) {
  return import(pathToFileURL(path.join(importRoot, relativePath)).href);
}

function installBrowserGlobalShims() {
  // Defensive only -- see the header comment above. `window` aliased to
  // `globalThis` mirrors the browser's own `window === globalThis` so any
  // future `globalThis.window?.X` read still resolves the way it would in
  // a real page (to `undefined`, absent explicit runtime config).
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
}
installBrowserGlobalShims();

const { renderHome } = await importFrom('app/assets/js/views/home.js');
const { renderSearch } = await importFrom('app/assets/js/views/search.js');
const { renderPortfolio } = await importFrom('app/assets/js/views/portfolio.js');
const { renderPriceIntelligenceDetail } = await importFrom('app/assets/js/views/price-intelligence-detail.js');
const { renderAdd } = await importFrom('app/assets/js/views/add.js');
const { getState } = await importFrom('app/assets/js/core/store.js');
const { catalogReferenceForItem } = await importFrom('app/assets/js/core/catalog-identity.js');

const BASELINE_PATH = path.join(__dirname, 'text-census-baseline.json');

// Bumped whenever the visible-text extraction method changes in a way that
// moves the numbers (DCL-VER-01 "honest census" upgrade). A baseline JSON's
// `method` field records which version produced it; --check compares
// current counts against the baseline's numbers regardless of method, but
// prints a loud warning if the methods differ, since that comparison would
// not be apples-to-apples.
const METHOD_VERSION = 'v2-details-excluded';

// Reduction targets from docs/UX_DECLUTTER_PRD.md DCL-VER-01 (percent
// reduction in visible characters vs the v0.8.33 baseline).
const REDUCTION_TARGETS = Object.freeze({
  home: 40,
  discover: 60,
  watchlist: 50,
  detail: 50,
  add: 40
});

const SURFACE_ORDER = Object.freeze(['home', 'discover', 'watchlist', 'detail', 'add']);

// ---------------------------------------------------------------------------
// Fixture state -- a pristine clone of the app's real initial store shape
// (core/store.js), so every field a view reads defaults exactly the way it
// does in the running app. Each surface only overrides the slices it needs.
// ---------------------------------------------------------------------------
function pristineState() {
  return structuredClone(getState());
}

function demoItem(overrides = {}) {
  return {
    id: '', externalId: '', provider: 'custom', category: 'other', game: '',
    name: '', setName: '', number: '', variant: '', rarity: '', year: '',
    image: '', imageSmall: '', price: null, priceOptions: [], currency: 'USD',
    priceSource: '', priceUrl: '', priceUpdatedAt: '',
    ...overrides
  };
}

function demoHolding(overrides = {}) {
  return {
    id: '', catalogId: '', item: demoItem(), quantity: 1, condition: 'Near Mint',
    purchasePrice: '', fees: 0, manualMarketPrice: '', manualMarketCurrency: 'USD',
    folder: 'Main collection', notes: '', tags: [],
    createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides
  };
}

// --- Home: ~4 holdings (mix of manual values + one unpriced), snapshots
// for a chart, USD settings. Modeled on app.js's loadDemo() fixture set. ---
function homeState() {
  const base = pristineState();
  const holdings = [
    demoHolding({
      id: '00000000-0000-4000-8000-100000000001', catalogId: 'census:black-lotus',
      item: demoItem({
        id: 'census:black-lotus', externalId: 'census-1', category: 'magic', game: 'Magic',
        name: 'Black Lotus — Proxy Demo', setName: 'Demo catalog', number: '#233',
        variant: 'Display only', rarity: 'Rare', year: '1993'
      }),
      condition: 'Near Mint', purchasePrice: 500, fees: 0, manualMarketPrice: 720,
      folder: 'Main collection', notes: 'Demonstration record; not a genuine appraisal.',
      createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z'
    }),
    demoHolding({
      id: '00000000-0000-4000-8000-100000000002', catalogId: 'census:charizard',
      item: demoItem({
        id: 'census:charizard', externalId: 'census-2', category: 'pokemon', game: 'Pokémon',
        name: 'Charizard — Base Set', setName: 'Base Set', number: '4/102',
        variant: 'Holo', rarity: 'Rare Holo', year: '1999'
      }),
      condition: 'Good', purchasePrice: 250, fees: 20, manualMarketPrice: 385,
      folder: 'Main collection', createdAt: '2026-06-05T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z'
    }),
    demoHolding({
      id: '00000000-0000-4000-8000-100000000003', catalogId: 'census:sports',
      item: demoItem({
        id: 'census:sports', externalId: 'census-3', category: 'sports', game: 'Basketball',
        name: 'Census Test Sports Card', setName: 'Rookie showcase', number: '23',
        variant: 'Base', year: '1996'
      }),
      condition: 'Graded', purchasePrice: 75, fees: 5, manualMarketPrice: 142,
      folder: 'Slabs', createdAt: '2026-06-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z'
    }),
    demoHolding({
      id: '00000000-0000-4000-8000-100000000004', catalogId: 'census:unpriced',
      item: demoItem({
        id: 'census:unpriced', externalId: 'census-4', category: 'comics', game: 'Comic',
        name: 'Unpriced Demo Comic', setName: 'Collector issue', number: '1',
        variant: 'Cover B', year: '2024'
      }),
      condition: 'Near Mint', purchasePrice: 10, fees: 0, manualMarketPrice: '',
      folder: 'Comics', createdAt: '2026-06-12T00:00:00.000Z', updatedAt: '2026-08-05T00:00:00.000Z'
    })
  ];
  const snapshots = [4, 3, 2, 1].map((weeksAgo) => {
    const date = new Date('2026-08-25T00:00:00.000Z');
    date.setUTCDate(date.getUTCDate() - weeksAgo * 20);
    const factor = 1 - weeksAgo * 0.06;
    return {
      id: `census-snapshot-${weeksAgo}`,
      date: date.toISOString().slice(0, 10),
      pricingPolicyVersion: 'rights-aware-v2-private-test',
      currency: 'USD',
      marketValue: 1332 * factor,
      costBasis: weeksAgo > 2 ? 585 : 860,
      uniqueItems: weeksAgo > 2 ? 3 : 4,
      totalQuantity: weeksAgo > 2 ? 3 : 4,
      updatedAt: date.toISOString()
    };
  });
  return {
    ...base,
    settings: { ...base.settings, currency: 'USD' },
    overview: { range: '3M' },
    holdings,
    snapshots,
    scanDraftCount: 0
  };
}

// --- Discover: renderSearch with state.search.results containing exactly
// 1 priced item (gallery view, query set so results render). The item also
// carries a canonicalVariantId with a matching tier-4 intelligence
// publication (observed + 30/60/90/180/365d forecasts) so the ORIGINAL
// (pre-P0) view's outlook <dl> actually renders when this fixture is
// replayed through the pre-removal worktree -- without this, DCL-DISC-02's
// "outlook deleted from result cards" removal would be invisible to the
// census (the baseline count wouldn't reflect what was actually removed).
// The current tree ignores this extra data (the outlook markup no longer
// exists to consume it), so it's a no-op there.
const DISCOVER_FORECAST_VARIANT_ID = '9f1e4567-e89b-42d3-a456-426614174099';

function discoverState() {
  const base = pristineState();
  const item = demoItem({
    id: 'census:discover-umbreon', externalId: 'census-discover-1', category: 'pokemon', game: 'Pokémon',
    name: 'Umbreon — Neo Discovery', setName: 'Neo Discovery', number: '13',
    variant: 'Holo', rarity: 'Rare Holo', year: '2000',
    price: 210, priceSource: 'Census market fixture', priceUpdatedAt: '2026-08-20T00:00:00.000Z',
    matchBucket: 'exact', canonicalVariantId: DISCOVER_FORECAST_VARIANT_ID, marketCondition: 'near-mint'
  });
  const publication = {
    variantId: DISCOVER_FORECAST_VARIANT_ID, supportTier: 4, publishedAt: '2026-08-14T00:00:00.000Z',
    seriesIdentity: {
      sourceId: 'licensed', currency: 'USD', language: 'en', finish: 'Holo',
      conditionClass: 'raw', marketCondition: 'near-mint', priceSemantics: 'market'
    },
    payload: {
      observed: { price: 210, currency: 'USD', source: 'Licensed', observedAt: '2026-08-14T00:00:00.000Z' },
      trend: { return30d: 0.08, status: 'rise', volatility: 0.03, confidence: 80, historyDensity: 0.9 },
      forecasts: {
        30: { q10: 190, q25: 200, q50: 215, q75: 230, q90: 245, probabilityUp: 0.6 },
        60: { q10: 185, q25: 200, q50: 220, q75: 240, q90: 260, probabilityUp: 0.61 },
        90: { q10: 180, q25: 200, q50: 225, q75: 250, q90: 275, probabilityUp: 0.62 },
        180: { q10: 165, q25: 200, q50: 235, q75: 270, q90: 305, probabilityUp: 0.64 },
        365: { q10: 150, q25: 200, q50: 250, q75: 300, q90: 350, probabilityUp: 0.65 }
      }
    }
  };
  return {
    ...base,
    settings: { ...base.settings, currency: 'USD' },
    featureFlags: { ...base.featureFlags, publicPriceIntelligence: true },
    intelligence: { byVariant: { [DISCOVER_FORECAST_VARIANT_ID]: publication }, loading: false, error: '' },
    discover: { ...base.discover, mode: 'search' },
    search: {
      ...base.search,
      query: 'Umbreon', category: 'pokemon', provider: 'all', filters: {},
      view: 'gallery', sort: 'newest', page: 1, limit: 48,
      loading: false, cached: false, warnings: [], results: [item]
    }
  };
}

// --- Watchlist: renderPortfolio with portfolio.section='watchlist' and
// exactly 1 watchlist item (with catalogRef, target price). ---
function watchlistState() {
  const base = pristineState();
  const item = demoItem({
    id: 'census:watch-umbreon', externalId: 'census-watch-1', category: 'pokemon', game: 'Pokémon',
    name: 'Umbreon — Neo Discovery', setName: 'Neo Discovery', number: '13',
    variant: 'Holo', rarity: 'Rare Holo', year: '2000',
    price: 210, priceSource: 'Census market fixture', priceUpdatedAt: '2026-08-18T00:00:00.000Z'
  });
  const catalogRef = catalogReferenceForItem(item);
  const entry = {
    id: catalogRef.watchKey, watchKey: catalogRef.watchKey, canonicalVariantId: catalogRef.canonicalVariantId,
    catalogRef, marketCondition: catalogRef.marketCondition,
    targetPrice: 180, targetCurrency: 'USD',
    alertPercentChange: '', alertTrendChange: false, alertRangeChange: false, alertForecastChange: false,
    intelligenceBaseline: null, notes: '',
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z'
  };
  return {
    ...base,
    settings: { ...base.settings, currency: 'USD' },
    portfolio: { ...base.portfolio, section: 'watchlist' },
    watchlistItems: [entry]
  };
}

// --- Detail: renderPriceIntelligenceDetail for an item/catalogRef with NO
// intelligence publication (the unsupported path), with a holding. ---
function detailFixture() {
  const base = pristineState();
  const item = demoItem({
    id: 'census:detail-moxsapphire', externalId: 'census-detail-1', category: 'magic', game: 'Magic',
    name: 'Mox Sapphire — Proxy Demo', setName: 'Demo catalog', number: '#212',
    variant: 'Display only', rarity: 'Rare', year: '1993'
  });
  const holding = demoHolding({
    id: 'census-holding-detail-1', catalogId: item.id, item,
    condition: 'Near Mint', purchasePrice: 300, fees: 0, manualMarketPrice: '',
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z'
  });
  const catalogRef = catalogReferenceForItem(item, { canonicalVariantId: holding.canonicalVariantId });
  const detail = { origin: 'portfolio', item, holding, catalogRef };
  const state = {
    ...base,
    settings: { ...base.settings, currency: 'USD' },
    holdings: [holding]
  };
  return { detail, state };
}

// --- Add: renderAdd with empty scan drafts. ---
function addState() {
  const base = pristineState();
  return {
    ...base,
    scanDrafts: [],
    scanDraftCount: 0
  };
}

function renderSurfaces() {
  const detailInput = detailFixture();
  return {
    home: renderHome(homeState()),
    discover: renderSearch(discoverState()),
    watchlist: renderPortfolio(watchlistState()),
    detail: renderPriceIntelligenceDetail(detailInput.detail, detailInput.state),
    add: renderAdd(addState())
  };
}

// ---------------------------------------------------------------------------
// Text extraction: strip tags, decode a basic entity set, collapse
// whitespace, count remaining visible characters.
// ---------------------------------------------------------------------------
const NAMED_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', middot: '·', mdash: '—', ndash: '–', hellip: '…',
  times: '×', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“'
});

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const code = isHex ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, entity) ? NAMED_ENTITIES[entity] : match;
  });
}

// Void elements never get a closing tag, so they never open a stack frame.
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

// METHOD_VERSION 'v2-details-excluded': a collapsed <details> (no `open`
// attribute) is not visible on a real page -- only its own direct
// <summary> stays visible as the clickable disclosure header, per browser
// behavior. Earlier method versions counted every character regardless of
// disclosure state, which overcounted every collapsed disclosure (the
// Methodology panel, "How photos are handled", per-crop acquisition
// groups, filter panels, etc.) and made the census dishonest about what a
// collector actually sees before opening anything.
//
// This is a small hand-rolled tokenizer, not a general HTML parser: it
// trusts that this app's own template output is well-formed (every
// generated string already round-trips through the browser in the real
// app), and only needs to track two things structurally -- element
// nesting (for void-element handling and mismatched-tag recovery) and the
// <details>/<summary> visibility rule. Nested <details> (e.g. the
// Purchase & organization/Grading disclosures nested inside a crop's own
// Purchase details disclosure in scan.js) cascade correctly: a frame's
// visible flag is always derived from its parent's, so a <summary> inside
// a *collapsed* outer <details> is still hidden, exactly as a browser
// would render it.
function visibleTextFromHTML(html) {
  const tokens = String(html || '').match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || [];
  const frames = []; // stack of { tag, visible, detailsParentVisible? }
  const currentVisible = () => (frames.length ? frames[frames.length - 1].visible : true);
  const out = [];

  for (const token of tokens) {
    if (token.startsWith('<!--')) continue;
    if (token[0] !== '<') {
      if (currentVisible()) out.push(token);
      continue;
    }
    const closing = token[1] === '/';
    const nameMatch = token.match(/^<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/);
    const tag = nameMatch ? nameMatch[1].toLowerCase() : '';
    if (!tag) continue;
    if (closing) {
      for (let index = frames.length - 1; index >= 0; index--) {
        if (frames[index].tag === tag) { frames.length = index; break; }
      }
      continue;
    }
    const selfClosing = /\/>\s*$/.test(token) || VOID_ELEMENTS.has(tag);
    if (tag === 'details') {
      const open = /(^|[\s"'])open(\s|=|>|\/|$)/i.test(token);
      const parentVisible = currentVisible();
      if (!selfClosing) frames.push({ tag, visible: parentVisible && open, detailsParentVisible: parentVisible });
      continue;
    }
    if (tag === 'summary' && frames.length && frames[frames.length - 1].tag === 'details') {
      // A <details>'s own first <summary> stays visible whenever its
      // ancestors are visible, regardless of that details' own open state
      // -- it's the always-shown disclosure header/toggle.
      const detailsParentVisible = frames[frames.length - 1].detailsParentVisible;
      if (!selfClosing) frames.push({ tag, visible: detailsParentVisible });
      continue;
    }
    if (!selfClosing) frames.push({ tag, visible: currentVisible() });
  }

  const decoded = decodeEntities(out.join(' '));
  return decoded.replace(/\s+/g, ' ').trim();
}

function countVisibleCharacters(html) {
  return visibleTextFromHTML(html).length;
}

function computeCounts() {
  const rendered = renderSurfaces();
  const counts = {};
  for (const surface of SURFACE_ORDER) counts[surface] = countVisibleCharacters(rendered[surface]);
  return counts;
}

// ---------------------------------------------------------------------------
// CLI (argument parsing itself happens above, before the view imports --
// see cliFlags/importRoot)
// ---------------------------------------------------------------------------
function packageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(importRoot, 'package.json'), 'utf8'));
    return pkg.version || '';
  } catch {
    return '';
  }
}

function writeBaseline(counts, asOf, commit) {
  const baseline = {
    version: packageVersion(),
    method: METHOD_VERSION,
    targets: { ...REDUCTION_TARGETS },
    surfaces: counts
  };
  if (commit) baseline.commit = commit;
  if (asOf) baseline.generatedAt = asOf;
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  return baseline;
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function printCounts(counts, label = 'Text census (current)') {
  console.log(`${label}:`);
  for (const surface of SURFACE_ORDER) {
    console.log(`  ${surface.padEnd(10)} ${String(counts[surface]).padStart(6)} visible characters`);
  }
}

function printCheckTable(baseline, current) {
  const header = ['surface', 'baseline', 'current', 'reduction', 'target'];
  const rows = SURFACE_ORDER.map((surface) => {
    const baselineCount = Number(baseline.surfaces?.[surface]);
    const currentCount = Number(current[surface]);
    const target = REDUCTION_TARGETS[surface];
    const hasBaseline = Number.isFinite(baselineCount) && baselineCount > 0;
    const reduction = hasBaseline ? ((baselineCount - currentCount) / baselineCount) * 100 : null;
    return {
      surface,
      baseline: hasBaseline ? String(baselineCount) : 'n/a',
      current: String(currentCount),
      reduction: reduction === null ? 'n/a' : `${reduction.toFixed(1)}%`,
      target: `${target}%`,
      met: reduction !== null && reduction >= target
    };
  });
  const widths = header.map((key, index) => Math.max(
    key.length,
    ...rows.map((row) => String(row[Object.keys(row)[index]] ?? '').length)
  ));
  const formatRow = (values) => values.map((value, index) => String(value).padEnd(widths[index])).join('  ');
  console.log(formatRow(header));
  console.log(formatRow(widths.map((width) => '-'.repeat(width))));
  rows.forEach((row) => {
    console.log(formatRow([row.surface, row.baseline, row.current, row.reduction, row.target]));
  });
  return rows;
}

async function main() {
  const flags = cliFlags;
  const counts = computeCounts();

  if (flags.root) console.log(`Importing views from --root ${importRoot}`);

  if (flags.writeBaseline) {
    const baseline = writeBaseline(counts, flags.asOf, flags.commit);
    console.log(`Wrote baseline to ${path.relative(repoRoot, BASELINE_PATH)}`);
    printCounts(baseline.surfaces, 'Baseline counts written');
    return;
  }

  if (flags.check) {
    const baseline = readBaseline();
    if (!baseline) {
      console.error(`No baseline found at ${path.relative(repoRoot, BASELINE_PATH)}. Run with --write-baseline first.`);
      process.exitCode = 1;
      return;
    }
    if (baseline.method && baseline.method !== METHOD_VERSION) {
      console.warn(`Warning: baseline was produced with method "${baseline.method}", current script is "${METHOD_VERSION}". Reductions below are not apples-to-apples -- regenerate the baseline (see --root) before trusting this table.\n`);
    }
    const rows = printCheckTable(baseline, counts);
    const unmet = rows.filter((row) => !row.met);
    if (unmet.length) {
      console.log(`\n${unmet.length} of ${rows.length} surfaces have not yet met their reduction target.`);
    } else {
      console.log(`\nAll ${rows.length} surfaces meet their reduction target.`);
    }
    if (flags.strict && unmet.length) process.exitCode = 1;
    return;
  }

  printCounts(counts);
}

await main();
