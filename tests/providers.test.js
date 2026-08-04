import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSettledProviders, prepareCatalogQuery, rankCatalogItems, refreshCatalogItem } from '../app/assets/js/services/catalog.js';
import { buildPokemonQuery, getPokemonCard, normalizePokemonCard, normalizeTCGDexCard, searchPokemon } from '../app/assets/js/services/providers/pokemon.js';
import { getScryfallCard, normalizeScryfallCard, searchScryfall } from '../app/assets/js/services/providers/scryfall.js';
import { getYGOCard, normalizeYGOCard, searchYGOPRODeck } from '../app/assets/js/services/providers/ygoprodeck.js';

test('Pokémon fixture normalizes finishes and market attribution', () => {
  const item = normalizePokemonCard({ id: 'base1-4', name: 'Charizard', number: '4', rarity: 'Rare Holo', set: { name: 'Base', releaseDate: '1999-01-09' }, images: { small: 'https://images.pokemontcg.io/base1/4.png', large: 'https://images.pokemontcg.io/base1/4_hires.png' }, tcgplayer: { url: 'https://example.test/card', updatedAt: '2026/07/31', prices: { holofoil: { market: 350.25 }, reverseHolofoil: { market: 60 } } } });
  assert.equal(item.id, 'pokemon:base1-4');
  assert.equal(item.price, 350.25);
  assert.equal(item.priceOptions.length, 2);
  assert.match(item.priceSource, /Pokémon/);
  assert.equal(buildPokemonQuery('Charizard 4/102'), 'name:charizard number:4');
  assert.equal(buildPokemonQuery('Mr. Mime'), 'name:"mr mime"');
});

test('TCGdex fallback normalizes stable Pokémon identifiers and image variants', () => {
  const item = normalizeTCGDexCard({ id: 'basep-1', localId: '1', name: 'Pikachu', image: 'https://assets.tcgdex.net/en/base/basep/1' });
  assert.equal(item.id, 'pokemon:basep-1');
  assert.equal(item.number, '1');
  assert.equal(item.imageSmall, 'https://assets.tcgdex.net/en/base/basep/1/low.webp');
  assert.equal(item.image, 'https://assets.tcgdex.net/en/base/basep/1/high.webp');
  assert.equal(item.price, null);
});

test('Scryfall fixture keeps a printing distinct and exposes three finish prices', () => {
  const item = normalizeScryfallCard({ id: 'abc', name: 'Sol Ring', set_name: 'Commander', collector_number: '1', rarity: 'uncommon', released_at: '2024-01-01', image_uris: { normal: 'https://cards.scryfall.io/normal/a.jpg', small: 'https://cards.scryfall.io/small/a.jpg' }, prices: { usd: '2.00', usd_foil: '5.00', usd_etched: '7.50' }, scryfall_uri: 'https://scryfall.com/card/abc' });
  assert.equal(item.id, 'scryfall:abc');
  assert.deepEqual(item.priceOptions.map((option) => option.finish), ['regular', 'foil', 'etched']);
  assert.equal(item.price, 2);
  const unpriced = normalizeScryfallCard({ id: 'unpriced', name: 'Unpriced', prices: { usd: null, usd_foil: null, usd_etched: null } });
  assert.equal(unpriced.price, null);
  assert.deepEqual(unpriced.priceOptions, []);
});

test('YGOPRODeck fixture expands every set-code printing', () => {
  const items = normalizeYGOCard({ id: 46986414, name: 'Dark Magician', card_images: [{ image_url: 'https://images.ygoprodeck.com/images/cards/46986414.jpg', image_url_small: 'https://images.ygoprodeck.com/images/cards_small/46986414.jpg' }], card_sets: [{ set_name: 'Legend', set_code: 'LOB-005', set_rarity: 'Ultra Rare', set_price: '25.20' }, { set_name: 'Starter', set_code: 'SDY-006', set_rarity: 'Ultra Rare', set_price: '6.00' }] });
  assert.equal(items.length, 2);
  assert.equal(items[0].number, 'LOB-005');
  assert.notEqual(items[0].id, items[1].id);
  const [unpriced] = normalizeYGOCard({ id: 1, name: 'Unpriced', card_sets: [{ set_code: 'NONE', set_price: null }] });
  assert.equal(unpriced.price, null);
  assert.deepEqual(unpriced.priceOptions, []);
});

test('provider search preserves punctuation required by catalog APIs', async () => {
  assert.deepEqual(prepareCatalogQuery('  Blue-Eyes White Dragon  '), {
    raw: 'Blue-Eyes White Dragon',
    normalized: 'blue eyes white dragon'
  });
  const previousFetch = globalThis.fetch;
  let requested;
  globalThis.fetch = async (url) => {
    requested = new URL(url);
    return { ok: true, json: async () => ({ data: [] }) };
  };
  try {
    await searchPokemon('Charizard 4/102');
    assert.equal(requested.searchParams.get('q'), 'name:charizard number:4');
    assert.equal(requested.searchParams.get('pageSize'), '250');
    assert.equal(requested.searchParams.get('select'), 'id,name,number,rarity,set,images,tcgplayer');
    assert.equal(requested.searchParams.has('orderBy'), false);
    await searchYGOPRODeck('Blue-Eyes White Dragon');
    assert.equal(requested.searchParams.get('fname'), 'Blue-Eyes White Dragon');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('provider-defined no-match responses are empty results, not outage warnings', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'api.scryfall.com') return {
      ok: false,
      status: 404,
      json: async () => ({ object: 'error', code: 'not_found', status: 404, details: 'No cards found' })
    };
    return {
      ok: false,
      status: 400,
      json: async () => ({ error: 'No card matching your query was found in the database.' })
    };
  };
  try {
    assert.deepEqual(await searchScryfall('Pikachu'), []);
    assert.deepEqual(await searchYGOPRODeck('Pikachu'), []);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Pokémon search tolerates several consecutive transient upstream failures', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 4) return { ok: false, status: 500, json: async () => null };
    return { ok: true, json: async () => ({ data: [], count: 0, totalCount: 0 }) };
  };
  try {
    assert.deepEqual(await searchPokemon('Pikachu'), []);
    assert.equal(calls, 4);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Pokémon search falls back to TCGdex after the primary exhausts bounded retries', async () => {
  const previousFetch = globalThis.fetch;
  let primaryCalls = 0;
  let fallbackUrl;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'api.pokemontcg.io') {
      primaryCalls++;
      return { ok: false, status: 500, json: async () => null };
    }
    fallbackUrl = parsed;
    return { ok: true, json: async () => [{ id: 'basep-1', localId: '1', name: 'Pikachu', image: 'https://assets.tcgdex.net/en/base/basep/1' }] };
  };
  try {
    const results = await searchPokemon('Pikachu 1');
    assert.equal(primaryCalls, 4);
    assert.equal(fallbackUrl.hostname, 'api.tcgdex.net');
    assert.equal(fallbackUrl.searchParams.get('name'), 'pikachu');
    assert.equal(results[0].externalId, 'basep-1');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Pokémon and Scryfall searches follow provider pagination beyond the first page', async () => {
  const previousFetch = globalThis.fetch;
  const pokemonPages = [];
  let scryfallCalls = 0;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'api.pokemontcg.io') {
      const page = Number(parsed.searchParams.get('page'));
      pokemonPages.push(page);
      const size = page === 1 ? 250 : 27;
      return {
        ok: true,
        json: async () => ({
          page,
          pageSize: 250,
          count: size,
          totalCount: 277,
          data: Array.from({ length: size }, (_, index) => ({ id: `p${page}-${index}`, name: 'Pikachu', images: {} }))
        })
      };
    }
    scryfallCalls++;
    return {
      ok: true,
      json: async () => scryfallCalls === 1
        ? { data: [{ id: 's1', name: 'Lightning Bolt', prices: {} }], has_more: true, next_page: 'https://api.scryfall.com/cards/search?page=2&q=bolt' }
        : { data: [{ id: 's2', name: 'Lightning Bolt', prices: {} }], has_more: false }
    };
  };
  try {
    assert.equal((await searchPokemon('Pikachu')).length, 277);
    assert.deepEqual(pokemonPages, [1, 2]);
    assert.deepEqual((await searchScryfall('Lightning Bolt')).map((item) => item.externalId), ['s1', 's2']);
    assert.equal(scryfallCalls, 2);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('provider refresh uses exact detail identifiers, including YGO set code', async () => {
  const previousFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    requested.push(parsed);
    let value;
    if (parsed.hostname === 'api.pokemontcg.io') value = { data: { id: 'base1-4', name: 'Charizard', images: {}, tcgplayer: { prices: {} } } };
    else if (parsed.hostname === 'api.scryfall.com') value = { id: 'scryfall-id', name: 'Black Lotus', image_uris: {}, prices: {} };
    else value = { data: [{ id: 89631139, name: 'Blue-Eyes White Dragon', card_images: [], card_sets: [{ set_code: 'CT13-EN008', set_name: '2016 Mega-Tins', set_rarity: 'Ultra Rare', set_price: '8.50' }] }] };
    return { ok: true, json: async () => value };
  };
  try {
    assert.equal((await getPokemonCard('base1-4')).externalId, 'base1-4');
    assert.equal((await getScryfallCard('scryfall-id')).externalId, 'scryfall-id');
    assert.equal((await getYGOCard('89631139:CT13-EN008')).externalId, '89631139:CT13-EN008');
    assert.equal(requested[0].pathname, '/v2/cards/base1-4');
    assert.equal(requested[1].pathname, '/cards/scryfall-id');
    assert.equal(requested[2].searchParams.get('id'), '89631139');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('provider refresh retains the holding selected finish', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ id: 'scryfall-id', name: 'Sol Ring', prices: { usd: '2.00', usd_foil: '5.25', usd_etched: null } })
  });
  try {
    const refreshed = await refreshCatalogItem({ provider: 'scryfall', externalId: 'scryfall-id', variant: 'foil' });
    assert.equal(refreshed.variant, 'foil');
    assert.equal(refreshed.price, 5.25);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('ranked merge favors name and exact number without collapsing printings', () => {
  const ranked = rankCatalogItems([
    { id: 'a', name: 'Charizard', setName: 'Base', number: '4', variant: 'Holo' },
    { id: 'b', name: 'Charizard', setName: 'Celebrations', number: '4', variant: 'Holo' },
    { id: 'c', name: 'Charmander', setName: 'Base', number: '46' }
  ], 'charizard 4');
  assert.deepEqual(ranked.slice(0, 2).map((item) => item.id).sort(), ['a', 'b']);
  assert.equal(ranked.length, 3);
});

test('provider failure isolation retains every successful provider result', () => {
  const selected = [['pokemon', { label: 'Pokémon' }], ['scryfall', { label: 'Scryfall' }], ['ygoprodeck', { label: 'YGO' }]];
  const combined = collectSettledProviders([
    { status: 'fulfilled', value: [{ id: 'pokemon:one' }] },
    { status: 'rejected', reason: new Error('offline') },
    { status: 'fulfilled', value: [{ id: 'ygo:one' }] }
  ], selected);
  assert.deepEqual(combined.results.map((item) => item.id), ['pokemon:one', 'ygo:one']);
  assert.equal(combined.warnings.length, 1);
  assert.match(combined.warnings[0], /Scryfall/);
});
