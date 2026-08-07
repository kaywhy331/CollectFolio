// Orchestrator for the on-demand, identity-driven JustTCG refresh. Mirrors
// runCollectorInvocation's ordering and failure discipline (justtcg-collector.mjs)
// but claims work by user-held/watched card identity instead of a single
// sequential offset cursor, and never writes anything outside the private
// 'ondemand/' Blobs prefix — see justtcg-ondemand-repository.mjs for the
// storage-boundary invariant this depends on.
//
// Every code path here proves it never touches Supabase or the browser: this
// module takes identities/results purely as data (no Supabase client, no
// price display), and its ONLY effect on public.price_observations,
// external_card_mappings, catalog_mapping_candidates, or
// product_feature_flags.public_price_intelligence is that it never
// references any of them at all.
import { randomUUID } from 'node:crypto';

import { cleanString, isObject } from './justtcg-http.mjs';
import { createCollectorConfig, sha256 } from './justtcg-collector.mjs';
import {
  fetchJustTcgLookup,
  JUSTTCG_LOOKUP_BATCH_LIMIT,
  JUSTTCG_LOOKUP_NORMALIZATION_VERSION,
  JUSTTCG_LOOKUP_USER_AGENT,
  validateLookup
} from './justtcg-lookup.mjs';
import { identityShard } from './justtcg-ondemand-repository.mjs';

const CLAIM_LEASE_MS = 45 * 1_000;
const CAS_RETRY_ATTEMPTS = 3;
const CANDIDATE_PAGE_SCAN_LIMIT = 5;
export const CANDIDATE_MAPPING_VERSION = 'ondemand-candidate-v1';

// Deliberately distinct from 'approved' / 'external_card_mappings' review
// statuses used elsewhere in this codebase: a private-ledger entry here is
// never an approved canonical mapping, regardless of confidence, and must
// never be read as one by any future migration/reconciliation script.
const OPERATOR_SEEDED_STATUS = 'operator_seeded';
const UNREVIEWED_CANDIDATE_STATUS = 'unreviewed_candidate';

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

// Distinct from positiveInt: a configured 0 is a meaningful, valid value for
// the minimum-interval knob (explicitly "no minimum interval enforced"), not
// something that should silently fall back to the default.
function nonNegativeInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

export function createOnDemandConfig(env = process.env) {
  const base = createCollectorConfig(env);
  return Object.freeze({
    ...base,
    dailyRequestLimit: positiveInt(env.JUSTTCG_ONDEMAND_DAILY_REQUEST_LIMIT, 15),
    minuteLimit: positiveInt(env.JUSTTCG_ONDEMAND_MINUTE_LIMIT, 8),
    reserveFloor: nonNegativeInt(env.JUSTTCG_ONDEMAND_RESERVE_FLOOR, 50),
    userDailyLimit: positiveInt(env.JUSTTCG_ONDEMAND_USER_DAILY_LIMIT, 3),
    userMinIntervalMs: nonNegativeInt(env.JUSTTCG_ONDEMAND_USER_MIN_INTERVAL_MS, 60_000),
    stalenessHours: positiveInt(env.JUSTTCG_ONDEMAND_STALENESS_HOURS, 24)
  });
}

// identity: { provider, externalId, language?, finish?, conditionClass? } —
// the exact fields catalog-identity.js's catalogReferenceForItem() already
// encodes as its 'source:v1:...' watchKey. Returns null when there is no
// externalId at all (a fully custom/manual holding has nothing to look up).
export function computeIdentityHash(identity) {
  const provider = cleanString(identity?.provider) || 'custom';
  const externalId = cleanString(identity?.externalId);
  if (!externalId) return null;
  const language = cleanString(identity?.language) || 'en';
  const finish = cleanString(identity?.finish) || 'unspecified';
  const conditionClass = cleanString(identity?.conditionClass) || 'raw';
  return sha256({ provider, externalId, language, finish, conditionClass });
}

function utcDay(now) {
  return now.toISOString().slice(0, 10);
}

function utcMinute(now) {
  return Math.floor(now.getTime() / 60_000);
}

function emptyControl() {
  return {
    schemaVersion: 1,
    utcDay: null,
    dailyAttempts: 0,
    minuteWindow: null,
    minuteAttempts: 0,
    apiRequestsRemaining: null,
    inFlight: {},
    users: {},
    consecutiveFailures: 0,
    notBefore: null
  };
}

function pruneControl(control, now) {
  const day = utcDay(now);
  const minute = utcMinute(now);
  const nowMs = now.getTime();
  const inFlight = Object.fromEntries(
    Object.entries(control.inFlight || {}).filter(([, expiresAtMs]) => expiresAtMs > nowMs)
  );
  const users = Object.fromEntries(
    Object.entries(control.users || {}).filter(([, entry]) => entry?.day === day).slice(0, 500)
  );
  return {
    ...control,
    utcDay: day,
    dailyAttempts: control.utcDay === day ? control.dailyAttempts || 0 : 0,
    minuteWindow: minute,
    minuteAttempts: control.minuteWindow === minute ? control.minuteAttempts || 0 : 0,
    inFlight,
    users
  };
}

function retryDelayMs(consecutiveFailures, random) {
  const failures = Math.min(10, consecutiveFailures + 1);
  const exponential = Math.min(6 * 60 * 60 * 1_000, 60_000 * (2 ** (failures - 1)));
  return exponential + Math.floor(exponential * 0.25 * random());
}

// Attempts to reserve one JustTCG attempt (covering up to
// JUSTTCG_LOOKUP_BATCH_LIMIT candidateHashes) against every limit this
// feature must respect. Returns as many claims as capacity allows rather than
// failing the whole request when only some candidates are still claimable —
// see the plan's "one atomic control object" design.
function tryReserve(control, { now, userHash, candidateHashes, config }) {
  const pruned = pruneControl(control, now);
  if (pruned.notBefore && Date.parse(pruned.notBefore) > now.getTime()) {
    return { reserved: [], control: pruned, reason: 'backoff' };
  }
  if (typeof pruned.apiRequestsRemaining === 'number' && pruned.apiRequestsRemaining <= config.reserveFloor) {
    return { reserved: [], control: pruned, reason: 'provider_reserve_floor' };
  }
  const userEntry = pruned.users[userHash]?.day === pruned.utcDay
    ? pruned.users[userHash]
    : { day: pruned.utcDay, count: 0, lastAtMs: 0 };
  if (userEntry.count >= config.userDailyLimit) {
    return { reserved: [], control: pruned, reason: 'user_daily_limit' };
  }
  if (userEntry.lastAtMs && now.getTime() - userEntry.lastAtMs < config.userMinIntervalMs) {
    return { reserved: [], control: pruned, reason: 'user_min_interval' };
  }
  if (pruned.dailyAttempts >= config.dailyRequestLimit) {
    return { reserved: [], control: pruned, reason: 'daily_limit' };
  }
  if (pruned.minuteAttempts >= config.minuteLimit) {
    return { reserved: [], control: pruned, reason: 'minute_limit' };
  }
  const available = candidateHashes.filter((hash) => pruned.inFlight[hash] === undefined);
  if (!available.length) {
    return { reserved: [], control: pruned, reason: 'no_unclaimed_candidates' };
  }

  const reserved = available.slice(0, JUSTTCG_LOOKUP_BATCH_LIMIT);
  const leaseExpiresAtMs = now.getTime() + CLAIM_LEASE_MS;
  const inFlight = { ...pruned.inFlight };
  for (const hash of reserved) inFlight[hash] = leaseExpiresAtMs;

  return {
    reserved,
    control: {
      ...pruned,
      dailyAttempts: pruned.dailyAttempts + 1,
      minuteAttempts: pruned.minuteAttempts + 1,
      inFlight,
      users: { ...pruned.users, [userHash]: { day: pruned.utcDay, count: userEntry.count + 1, lastAtMs: now.getTime() } }
    },
    reason: null
  };
}

function releaseAndBackoff(control, { now, hashes, random }) {
  const pruned = pruneControl(control, now);
  const inFlight = { ...pruned.inFlight };
  for (const hash of hashes) delete inFlight[hash];
  const consecutiveFailures = (pruned.consecutiveFailures || 0) + 1;
  const delay = retryDelayMs(consecutiveFailures, random);
  return {
    ...pruned,
    inFlight,
    consecutiveFailures,
    notBefore: new Date(now.getTime() + delay).toISOString()
  };
}

function finalizeSuccess(control, { now, hashes, apiRequestsRemaining }) {
  const pruned = pruneControl(control, now);
  const inFlight = { ...pruned.inFlight };
  for (const hash of hashes) delete inFlight[hash];
  return {
    ...pruned,
    inFlight,
    apiRequestsRemaining,
    consecutiveFailures: 0,
    notBefore: null
  };
}

async function casControl(repository, mutate, args) {
  for (let attempt = 0; attempt < CAS_RETRY_ATTEMPTS; attempt += 1) {
    const entry = await repository.loadControl();
    const control = entry?.control || emptyControl();
    const result = mutate(control, args);
    const nextControl = result.control ?? result;
    const write = await repository.saveControl(nextControl, entry?.etag ?? null);
    if (write.modified) return { ...result, control: nextControl, ok: true };
    await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor((args.random?.() ?? Math.random()) * 40)));
  }
  return { ok: false };
}

function reasonToOutcome(reason) {
  return reason === 'no_unclaimed_candidates' ? 'busy' : 'quota_deferred';
}

const NAME_NORMALIZE = /[^a-z0-9]+/g;
function normalizeForMatch(value) {
  return cleanString(value).toLowerCase().replace(NAME_NORMALIZE, ' ').trim();
}

// Zero-extra-API-cost, best-effort, deliberately conservative: only ever
// proposes a candidate when exactly one already-crawled catalog card matches
// on name (+set/game when the held card has them) — an ambiguous or absent
// match produces nothing rather than a guess. This is never fetched against
// and never treated as an approved mapping; an operator reviews it by hand.
export function matchCandidate(identity, catalogCards) {
  const wantName = normalizeForMatch(identity?.name);
  if (!wantName || !Array.isArray(catalogCards)) return null;
  const wantSet = normalizeForMatch(identity?.setName);
  const wantGame = normalizeForMatch(identity?.game);
  const matches = catalogCards.filter((card) => {
    if (!isObject(card) || normalizeForMatch(card.name) !== wantName) return false;
    if (wantSet && normalizeForMatch(card.set_name || card.set) !== wantSet) return false;
    if (wantGame && card.game && normalizeForMatch(card.game) !== wantGame) return false;
    return true;
  });
  if (matches.length !== 1) return null;
  const card = matches[0];
  const identifier = card.scryfallId ? { field: 'scryfallId', value: String(card.scryfallId) }
    : card.tcgplayerId ? { field: 'tcgplayerId', value: String(card.tcgplayerId) }
    : card.mtgjsonId ? { field: 'mtgjsonId', value: String(card.mtgjsonId) }
    : { field: 'cardId', value: String(card.id) };
  return {
    externalProductId: String(card.id),
    identifierField: identifier.field,
    identifierValue: identifier.value,
    mappingConfidence: 0.5,
    mappingMethod: 'ondemand_heuristic_name_set_match',
    mappingVersion: CANDIDATE_MAPPING_VERSION,
    disposition: 'review',
    privateLedgerStatus: UNREVIEWED_CANDIDATE_STATUS,
    notAnApprovedCanonicalMapping: true
  };
}

async function generateCandidates(repository, { unmappedHashes, identityByHash, cronState, now }) {
  if (!unmappedHashes.length || !isObject(cronState) || !Number.isSafeInteger(cronState.nextOffset) || cronState.nextOffset <= 0) {
    return 0;
  }
  const pageCount = Math.min(CANDIDATE_PAGE_SCAN_LIMIT, Math.floor(cronState.nextOffset / 20));
  const offsets = Array.from({ length: pageCount }, (_, index) => cronState.nextOffset - 20 * (index + 1)).filter((offset) => offset >= 0);
  const pages = await Promise.all(offsets.map((offset) => repository.readCollectorPage(offset).catch(() => null)));
  const catalogCards = pages.filter(Boolean).flatMap((page) => (Array.isArray(page?.response?.data) ? page.response.data : []));
  if (!catalogCards.length) return 0;

  const additionsByShard = new Map();
  for (const hash of unmappedHashes) {
    const candidate = matchCandidate(identityByHash.get(hash), catalogCards);
    if (!candidate) continue;
    const shard = identityShard(hash);
    if (!additionsByShard.has(shard)) additionsByShard.set(shard, {});
    additionsByShard.get(shard)[hash] = { ...candidate, generatedAt: now.toISOString() };
  }

  let written = 0;
  for (const [shard, additions] of additionsByShard) {
    const existing = await repository.loadCandidateShard(shard);
    await repository.saveCandidateShard(shard, { ...existing, ...additions });
    written += Object.keys(additions).length;
  }
  return written;
}

function baseSummary(outcome, requestId, counts) {
  return {
    requestId,
    outcome,
    checked: 0,
    eligible: 0,
    fetched: 0,
    alreadyFresh: 0,
    needsMapping: 0,
    deferred: 0,
    ...counts
  };
}

// identities: [{ provider, externalId, language?, finish?, conditionClass?,
//                name?, setName?, game? }, ...] — already read from the
// user's own holdings + watchlist by the caller (the Netlify function), using
// that user's own forwarded, PostgREST-validated session. This module never
// talks to Supabase itself.
export async function runOnDemandRefresh({
  repository,
  config,
  userHash,
  identities,
  fetchLookup = fetchJustTcgLookup,
  now = () => new Date(),
  random = Math.random,
  requestId = randomUUID
}) {
  const instant = now();
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) {
    throw new TypeError('now must return a valid Date');
  }
  const firstRequestId = requestId();

  const identityByHash = new Map();
  for (const identity of identities || []) {
    const hash = computeIdentityHash(identity);
    if (hash && !identityByHash.has(hash)) identityByHash.set(hash, identity);
  }
  const hashes = [...identityByHash.keys()];
  if (!hashes.length) return baseSummary('no_eligible_cards', firstRequestId, { checked: 0 });

  const shards = [...new Set(hashes.map(identityShard))];
  const [mappingEntries, freshnessEntries] = await Promise.all([
    Promise.all(shards.map(async (shard) => [shard, await repository.loadMappingShard(shard)])),
    Promise.all(shards.map(async (shard) => [shard, await repository.loadFreshnessShard(shard)]))
  ]);
  const mappingByShard = new Map(mappingEntries);
  const freshnessByShard = new Map(freshnessEntries.map(([shard, entry]) => [shard, entry.map || {}]));
  const mappingFor = (hash) => mappingByShard.get(identityShard(hash))?.[hash];
  const freshnessFor = (hash) => freshnessByShard.get(identityShard(hash))?.[hash];

  const mapped = [];
  const unmapped = [];
  for (const hash of hashes) (mappingFor(hash) ? mapped : unmapped).push(hash);

  const stalenessMs = config.stalenessHours * 60 * 60 * 1_000;
  let alreadyFresh = 0;
  const staleCandidates = [];
  for (const hash of mapped) {
    const freshness = freshnessFor(hash);
    if (freshness?.nb && freshness.nb * 1_000 > instant.getTime()) continue;
    const lastFetchedMs = freshness?.t ? freshness.t * 1_000 : 0;
    if (lastFetchedMs && instant.getTime() - lastFetchedMs < stalenessMs) { alreadyFresh += 1; continue; }
    staleCandidates.push({ hash, lastFetchedMs });
  }
  staleCandidates.sort((left, right) => left.lastFetchedMs - right.lastFetchedMs);
  const eligibleHashes = staleCandidates.map((candidate) => candidate.hash);

  const counts = { checked: hashes.length, eligible: eligibleHashes.length, alreadyFresh, needsMapping: unmapped.length };

  // Best-effort, zero-extra-API-cost candidate generation for unmapped cards.
  // Deliberately run only after the reservation below (or concurrently with
  // the provider call on the success path) rather than before it: it can
  // involve several page reads, and every moment between "compute which
  // fetch-eligible cards are stale" and "actually claim them" widens the
  // window where a fully-completed concurrent request could have refreshed
  // (and released its claim on) the same card in between. Candidate
  // generation touches only unmapped identities, so it never affects which
  // cards are fetch-eligible and can safely be deferred without changing
  // the outcome of anything else in this function.
  let candidatesGenerated = 0;
  const generateCandidatesNow = async () => {
    const cronState = await repository.readCollectorState().catch(() => null);
    try {
      candidatesGenerated = await generateCandidates(repository, { unmappedHashes: unmapped, identityByHash, cronState, now: instant });
    } catch { /* candidate generation is best-effort and never fails the request */ }
    return cronState;
  };

  if (!eligibleHashes.length) {
    await generateCandidatesNow();
    return baseSummary('no_eligible_cards', firstRequestId, { ...counts, candidatesGenerated });
  }

  // Read-only reserve-floor guard against the cron's own observed quota,
  // checked before spending the on-demand feature's own reservation attempt.
  const cronState = await repository.readCollectorState().catch(() => null);
  if (cronState?.quota && typeof cronState.quota.apiRequestsRemaining === 'number' && cronState.quota.apiRequestsRemaining <= config.reserveFloor) {
    await generateCandidatesNow();
    return baseSummary('quota_deferred', firstRequestId, { ...counts, deferred: eligibleHashes.length, candidatesGenerated });
  }

  const reservation = await casControl(
    repository,
    (control, args) => tryReserve(control, args),
    { now: instant, userHash, candidateHashes: eligibleHashes, config, random }
  );
  if (!reservation.ok) {
    await generateCandidatesNow();
    return baseSummary('busy', firstRequestId, { ...counts, deferred: eligibleHashes.length, candidatesGenerated });
  }
  if (!reservation.reserved.length) {
    await generateCandidatesNow();
    return baseSummary(reasonToOutcome(reservation.reason), firstRequestId, { ...counts, deferred: eligibleHashes.length, candidatesGenerated });
  }

  const reservedHashes = reservation.reserved;
  const items = reservedHashes.map((hash) => {
    const mapping = mappingFor(hash);
    const item = { field: mapping.identifierField, value: mapping.identifierValue };
    if (mapping.condition) item.condition = mapping.condition;
    if (mapping.printing) item.printing = mapping.printing;
    return item;
  });

  let payload;
  let validated;
  try {
    // Candidate generation is independent of this fetch (it only ever
    // touches unmapped identities), so it runs concurrently with the
    // provider call rather than adding to the critical path.
    [payload] = await Promise.all([
      fetchLookup({ config, items, now: instant }),
      generateCandidatesNow()
    ]);
    validated = validateLookup(payload, { requestedCount: items.length, config });
  } catch (error) {
    await casControl(repository, (control, args) => ({ control: releaseAndBackoff(control, args) }), { now: instant, hashes: reservedHashes, random });
    return baseSummary('provider_error', firstRequestId, {
      ...counts,
      deferred: eligibleHashes.length,
      candidatesGenerated,
      errorCode: error?.code || 'unknown'
    });
  }

  await repository.saveResponse({
    requestId: firstRequestId,
    fetchedAt: instant.toISOString(),
    normalizationVersion: JUSTTCG_LOOKUP_NORMALIZATION_VERSION,
    requestedIdentifiers: reservedHashes.map((hash) => ({
      identityHash: hash,
      field: mappingFor(hash).identifierField,
      value: mappingFor(hash).identifierValue
    })),
    provenance: {
      endpoint: 'POST /cards',
      apiPlan: validated.apiPlan,
      apiRequestsRemaining: validated.apiRequestsRemaining,
      userAgent: JUSTTCG_LOOKUP_USER_AGENT,
      // Every fetch is gated on an operator-seeded private-ledger entry (see
      // the eligibility rules above) — recorded here, alongside everything
      // else needed for a future promotion review, so that fact is provable
      // from the evidence record itself, not just asserted by this comment.
      mappingSource: OPERATOR_SEEDED_STATUS,
      boundary: 'private_research_only'
    },
    dataHash: validated.dataHash,
    payloadHash: validated.payloadHash,
    response: payload
  });

  await casControl(
    repository,
    (control, args) => ({ control: finalizeSuccess(control, args) }),
    { now: instant, hashes: reservedHashes, apiRequestsRemaining: validated.apiRequestsRemaining }
  );

  const freshnessByShardToWrite = new Map();
  const nowSeconds = Math.floor(instant.getTime() / 1_000);
  for (const hash of reservedHashes) {
    const shard = identityShard(hash);
    if (!freshnessByShardToWrite.has(shard)) freshnessByShardToWrite.set(shard, { ...(freshnessByShard.get(shard) || {}) });
    freshnessByShardToWrite.get(shard)[hash] = { t: nowSeconds, f: 0, nb: null };
  }
  for (const [shard, map] of freshnessByShardToWrite) {
    await repository.saveFreshnessShard(shard, map);
  }

  return baseSummary('ok', firstRequestId, {
    ...counts,
    fetched: reservedHashes.length,
    deferred: eligibleHashes.length - reservedHashes.length,
    candidatesGenerated
  });
}
