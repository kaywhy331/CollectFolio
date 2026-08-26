// DCL-LEX-01 (UX Declutter PRD, WS-1): the single shared registry for
// user-facing strings that repeat across views -- unknown-value labels,
// match-state labels, badge labels, negation-style clarifiers, and toast
// templates. Views import from here; per RULE-1 ("say it once") no view
// re-declares any of these strings locally. This stage only builds the
// registry -- it does not rewire any view. Later arms swap each view's
// hardcoded copy for an import from this module.

// RULE-5 / DCL-LEX-03: exactly four approved forms for an unknown value.
// Nothing else may render in their place.
export const UNKNOWN = Object.freeze({
  unpriced: 'Unpriced',
  notRecorded: 'Not recorded',
  dash: '—',
  noVerifiedPrice: 'No verified market price'
});

// DCL-LEX-04: one match-state vocabulary everywhere. Badges carry status
// only -- verbs (e.g. "Confirm exact item") live on buttons, never here.
export const MATCH_STATES = Object.freeze({
  exact: 'Exact match',
  likely: 'Likely match',
  possible: 'Possible match',
  unmatched: 'No match',
  confirmed: 'Confirmed by you'
});

// DCL-LEX-08: badge sweep -- the support-tier ladder as short (<=2 word)
// status badges (RULE-6), indexed by supportTier (0-5). Replaces the
// sentence-style SUPPORT_LABELS / COVERAGE_NAMES arrays; tier explanations
// belong in the Data & Methodology disclosure, not the badge itself.
export const SUPPORT_BADGES = Object.freeze([
  'Identified',
  'Priced',
  'History available',
  'Modeled',
  'Forecast ready',
  'Forecast scored'
]);

// DCL-LEX-10: negation budget -- these two are the ONLY negation-style
// ("is / is not") clarifiers allowed to render outside
// core/methodology.js, which remains RULE-1's canonical home for every
// other guarantee (Appendix B).
export const CLARIFIERS = Object.freeze({
  scenario: 'Scenarios are estimates from your assumptions, not market data.',
  manualValue: 'Your manual value stays separate from market prices.'
});

// DCL-LEX-07 / RULE-8: toast templates for the common results -- past
// tense, <=6 words where possible, no internals.
export const TOASTS = Object.freeze({
  backupImported: 'Backup imported',
  localDataCleared: 'Local data cleared',
  magicLinkSent: 'Magic link sent',
  itemUpdated: 'Item updated',
  itemDeleted: 'Item deleted',
  addedToWatchlist: 'Added to Watchlist',
  removedFromWatchlist: 'Removed from Watchlist',
  watchPreferencesSaved: 'Watch preferences saved',
  demoCollectionLoaded: 'Demo collection loaded'
});

// RULE-2: the one page-level line covering every absent market section.
export const ABSENCE = 'More market data appears here as it’s verified.';
