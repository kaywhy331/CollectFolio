import { imageDifferenceHash, loadImage } from './image.js';
import { hashSimilarity } from './image-algorithms.js';

const INDEX_ROOT = '/assets/data/visual-index/pokemon-v1';
const INDEX_CACHE = 'collectfolio-visual-index-v1';
const MAX_SCAN_RESULTS = 24;
const SHARD_CONCURRENCY = 4;

function normalizeEntry(entry) {
  if (!Array.isArray(entry)) return entry;
  const [externalId, name, setName, number, rarity, imageSmall, hash] = entry;
  return { id: `pokemon:${externalId}`, externalId, name, setName, number, rarity, imageSmall, hash };
}

function candidate(entry) {
  entry = normalizeEntry(entry);
  return {
    ...entry,
    provider: 'pokemon', category: 'pokemon', game: 'Pokémon', variant: '', year: '',
    image: String(entry.imageSmall || '').replace(/\.png$/i, '_hires.png'),
    price: null, priceOptions: [], currency: 'USD', priceSource: '', priceUrl: '', priceUpdatedAt: ''
  };
}

async function fetchIndex(path) {
  const request = new Request(path, { cache: 'force-cache' });
  if (!('caches' in globalThis)) return fetch(request).then((response) => {
    if (!response.ok) throw new Error(`Visual index request failed (${response.status}).`);
    return response.json();
  });
  const cache = await caches.open(INDEX_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached.json();
  const response = await fetch(request);
  if (!response.ok) throw new Error(`Visual index request failed (${response.status}).`);
  await cache.put(request, response.clone()).catch(() => {});
  return response.json();
}

function scoreEntry(entry, cropHash) {
  entry = normalizeEntry(entry);
  return entry.hash ? { entry, score: hashSimilarity(cropHash, entry.hash) } : null;
}

async function scanShards(shards, loadShard, cropHash, {
  minimumScore, maximumResults, onProgress = () => {}
}) {
  const best = [];
  let nextIndex = 0;
  let completed = 0;
  const worker = async () => {
    while (nextIndex < shards.length) {
      const shard = shards[nextIndex++];
      const entries = await loadShard(shard);
      for (const entry of entries) {
        const result = scoreEntry(entry, cropHash);
        if (!result || result.score < minimumScore) continue;
        best.push(result);
        best.sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id));
        if (best.length > maximumResults) best.length = maximumResults;
      }
      completed++;
      onProgress({ completed, total: shards.length, candidates: best.length });
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(SHARD_CONCURRENCY, shards.length) },
    () => worker()
  ));
  return best;
}

export async function discoverVisualCandidates(cropSource, {
  onProgress = () => {}, minimumScore = 0.72, maximumResults = MAX_SCAN_RESULTS
} = {}) {
  const cropHash = imageDifferenceHash(await loadImage(cropSource));
  const manifest = await fetchIndex(`${INDEX_ROOT}/manifest.json`);
  if (manifest?.format !== 'collectfolio-visual-candidate-index' || manifest.version !== 1 || !Array.isArray(manifest.shards)) {
    throw new Error('The visual candidate index format is not supported.');
  }
  if (!manifest.fingerprintCount) return [];
  const best = await scanShards(
    manifest.shards,
    (shard) => fetchIndex(`${INDEX_ROOT}/${shard.name}.json`),
    cropHash,
    { minimumScore, maximumResults, onProgress }
  );
  return best.map(({ entry, score }) => ({ ...candidate(entry), visualScore: score, matchScore: score }));
}

export async function visualCandidatesFromHash(cropHash, {
  loadShard, manifest, minimumScore = 0.72, maximumResults = MAX_SCAN_RESULTS
} = {}) {
  if (!/^[0-9a-f]{16}$/i.test(String(cropHash))) throw new Error('Visual search requires a 64-bit hexadecimal fingerprint.');
  const index = manifest || await fetchIndex(`${INDEX_ROOT}/manifest.json`);
  if (index?.format !== 'collectfolio-visual-candidate-index' || index.version !== 1 || !Array.isArray(index.shards)) {
    throw new Error('The visual candidate index format is not supported.');
  }
  const best = await scanShards(
    index.shards,
    (shard) => loadShard ? loadShard(shard.name) : fetchIndex(`${INDEX_ROOT}/${shard.name}.json`),
    cropHash,
    { minimumScore, maximumResults }
  );
  return best.map(({ entry, score }) => ({ ...candidate(entry), visualScore: score, matchScore: score }));
}
