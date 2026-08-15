const clean = (value) => String(value ?? '').normalize('NFKC').trim().toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const LANGUAGE_ALIASES = Object.freeze({
  english: 'en', japanese: 'ja', french: 'fr', german: 'de', spanish: 'es',
  italian: 'it', portuguese: 'pt', korean: 'ko', chinese: 'zh'
});

const RAW_CONDITION_ALIASES = Object.freeze({
  mint: 'near-mint', nm: 'near-mint', 'near-mint': 'near-mint',
  excellent: 'lightly-played', lp: 'lightly-played', 'lightly-played': 'lightly-played',
  good: 'moderately-played', mp: 'moderately-played', 'moderately-played': 'moderately-played',
  played: 'heavily-played', hp: 'heavily-played', 'heavily-played': 'heavily-played',
  poor: 'damaged', dmg: 'damaged', damaged: 'damaged'
});

export const RAW_MARKET_CONDITIONS = Object.freeze([
  Object.freeze({ value: 'near-mint', label: 'Near Mint' }),
  Object.freeze({ value: 'lightly-played', label: 'Lightly Played' }),
  Object.freeze({ value: 'moderately-played', label: 'Moderately Played' }),
  Object.freeze({ value: 'heavily-played', label: 'Heavily Played' }),
  Object.freeze({ value: 'damaged', label: 'Damaged' })
]);

export function canonicalMarketIdentity(value) {
  return clean(value);
}

export function canonicalMarketLanguage(value) {
  const normalized = clean(value);
  return LANGUAGE_ALIASES[normalized] || normalized;
}

export function canonicalRawMarketCondition(value) {
  const normalized = clean(value);
  return RAW_CONDITION_ALIASES[normalized] || '';
}

export function marketSeriesIdentity(input = {}) {
  const currency = String(input.currency || '').trim().toUpperCase();
  return {
    sourceId: canonicalMarketIdentity(input.sourceId),
    currency: /^[A-Z]{3}$/.test(currency) ? currency : '',
    language: canonicalMarketLanguage(input.language),
    finish: canonicalMarketIdentity(input.finish),
    conditionClass: canonicalMarketIdentity(input.conditionClass),
    marketCondition: canonicalMarketIdentity(input.marketCondition),
    priceSemantics: canonicalMarketIdentity(input.priceSemantics)
  };
}

export function holdingMarketSeriesIdentity(holding = {}, currency = 'USD') {
  const item = holding.item || {};
  const conditionClass = holding.grade
    ? 'graded'
    : canonicalMarketIdentity(holding.conditionClass || item.conditionClass || item.rawConditionClass || 'raw');
  return marketSeriesIdentity({
    currency,
    language: item.language || holding.language || 'en',
    finish: item.finish || item.variant || 'unspecified',
    conditionClass,
    marketCondition: conditionClass === 'graded'
      ? `${holding.gradeCompany || 'unknown'}-${holding.grade || 'ungraded'}`
      : canonicalRawMarketCondition(holding.marketCondition || item.marketCondition)
  });
}

export function watchlistMarketSeriesIdentity(entry = {}, currency = 'USD') {
  const ref = entry.catalogRef || {};
  return marketSeriesIdentity({
    currency,
    language: ref.language || entry.language || 'en',
    finish: ref.finish || ref.variant || 'unspecified',
    conditionClass: ref.conditionClass || entry.conditionClass || 'raw',
    marketCondition: entry.marketCondition || ref.marketCondition || ''
  });
}

export function publicationCandidates(rawPublication) {
  return (Array.isArray(rawPublication) ? rawPublication : rawPublication ? [rawPublication] : [])
    .filter((value) => value && typeof value === 'object');
}

export function selectExactPublication(rawPublication, expectedSeries = {}, { requireMarketCondition = false } = {}) {
  const expected = marketSeriesIdentity(expectedSeries);
  const required = ['currency', 'language', 'finish', 'conditionClass', ...(requireMarketCondition ? ['marketCondition'] : [])];
  if (required.some((field) => !expected[field])) return null;
  const candidates = publicationCandidates(rawPublication).filter((candidate) => {
    const actual = marketSeriesIdentity(candidate.seriesIdentity || candidate.payload?.seriesIdentity || {});
    if (!actual.sourceId || !actual.priceSemantics) return false;
    if (expected.sourceId && actual.sourceId !== expected.sourceId) return false;
    if (expected.priceSemantics && actual.priceSemantics !== expected.priceSemantics) return false;
    return required.every((field) => actual[field] && actual[field] === expected[field]);
  });
  const identities = new Set(candidates.map((candidate) => {
    const actual = marketSeriesIdentity(candidate.seriesIdentity || candidate.payload?.seriesIdentity || {});
    return [
      actual.sourceId, actual.currency, actual.language, actual.finish,
      actual.conditionClass, actual.marketCondition, actual.priceSemantics
    ].join('|');
  }));
  if (identities.size !== 1) return null;
  return candidates.sort((left, right) =>
    String(right.publishedAt || '').localeCompare(String(left.publishedAt || ''))
    || String(right.publicationId || '').localeCompare(String(left.publicationId || ''))
  )[0] || null;
}

export function selectPublicationForHolding(rawPublication, holding = {}, currency = 'USD') {
  return selectExactPublication(rawPublication, holdingMarketSeriesIdentity(holding, currency), {
    requireMarketCondition: true
  });
}

export function selectPublicationForWatchlist(rawPublication, entry = {}, currency = 'USD') {
  return selectExactPublication(rawPublication, watchlistMarketSeriesIdentity(entry, currency), {
    requireMarketCondition: true
  });
}

export function selectPublicationForCatalogItem(rawPublication, item = {}, currency = 'USD') {
  const conditionClass = canonicalMarketIdentity(
    item.conditionClass || item.rawConditionClass || 'raw'
  );
  return selectExactPublication(rawPublication, {
    currency,
    language: item.language || 'en',
    finish: item.finish || item.variant || 'unspecified',
    conditionClass,
    marketCondition: item.marketCondition || ''
  }, { requireMarketCondition: true });
}

export function expectedMarketSeriesKey(variantId, input = {}) {
  const variant = String(variantId || '').trim().toLowerCase();
  const series = marketSeriesIdentity(input);
  const required = [
    variant, series.currency, series.language, series.finish,
    series.conditionClass, series.marketCondition
  ];
  return required.every(Boolean) ? required.join('|') : '';
}

export function firstPublication(rawPublication) {
  return publicationCandidates(rawPublication)[0] || null;
}
