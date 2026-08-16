import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const sourceDirectory = resolve(process.argv[2] || '');
const outputDirectory = resolve(process.argv[3] || 'app/assets/data/visual-index/pokemon-v1');
const setsPath = resolve(process.argv[4] || resolve(sourceDirectory, '../../sets/en.json'));
if (!process.argv[2]) throw new Error('Usage: node scripts/generate-visual-index.mjs <cards/en> [output] [sets/en.json]');

const sourceCommit = process.env.POKEMON_DATA_COMMIT || '';
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Set POKEMON_DATA_COMMIT to the exact 40-character pokemon-tcg-data commit.');

const setRecords = JSON.parse(await readFile(setsPath, 'utf8'));
const setNames = new Map(setRecords.map((set) => [String(set.id), String(set.name || '')]));
const files = (await readdir(sourceDirectory)).filter((name) => name.endsWith('.json')).sort();
const entries = [];
let providedHashCount = 0;
for (const file of files) {
  const setId = basename(file, '.json');
  const cards = JSON.parse(await readFile(resolve(sourceDirectory, file), 'utf8'));
  for (const card of cards) {
    const externalId = String(card.id || '').trim();
    const imageSmall = String(card.images?.small || '').trim();
    if (!externalId || !imageSmall) continue;
    entries.push({
      id: `pokemon:${externalId}`,
      externalId,
      name: String(card.name || 'Unnamed Pokémon card'),
      setName: setNames.get(setId) || '',
      number: String(card.number || ''),
      rarity: String(card.rarity || ''),
      imageSmall,
      ...(typeof card.visualHash === 'string' && /^[0-9a-f]{16}$/i.test(card.visualHash)
        ? { hash: card.visualHash.toLowerCase() }
        : {})
    });
    if (typeof card.visualHash === 'string' && /^[0-9a-f]{16}$/i.test(card.visualHash)) providedHashCount++;
  }
}
entries.sort((left, right) => left.externalId.localeCompare(right.externalId));

const shardCount = 16;
const shards = Array.from({ length: shardCount }, () => []);
for (const entry of entries) {
  const prefix = createHash('sha256').update(entry.externalId).digest()[0] % shardCount;
  shards[prefix].push(entry);
}

await mkdir(outputDirectory, { recursive: true });
for (const name of await readdir(outputDirectory)) {
  if (name.endsWith('.json')) await unlink(resolve(outputDirectory, name));
}
const shardRecords = [];
for (let index = 0; index < shardCount; index++) {
  const name = index.toString(16);
  const body = `${JSON.stringify(shards[index].map((entry) => [
    entry.externalId, entry.name, entry.setName, entry.number, entry.rarity, entry.imageSmall, entry.hash || ''
  ]))}\n`;
  await writeFile(resolve(outputDirectory, `${name}.json`), body);
  shardRecords.push({ name, count: shards[index].length, sha256: createHash('sha256').update(body).digest('hex') });
}

const manifest = {
  format: 'collectfolio-visual-candidate-index',
  version: 1,
  provider: 'pokemon',
  source: 'PokemonTCG/pokemon-tcg-data',
  sourceCommit,
  entryCount: entries.length,
  fingerprintCount: providedHashCount,
  fingerprint: '64-bit difference hash of the normalized card image',
  entryFields: ['externalId', 'name', 'setName', 'number', 'rarity', 'imageSmall', 'hash'],
  shardAlgorithm: 'sha256(externalId)[0] modulo 16',
  shards: shardRecords
};
await writeFile(resolve(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
console.log(`Generated ${entries.length} Pokémon visual-candidate entries in ${shardCount} shards.`);
