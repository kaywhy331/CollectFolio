import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const app = resolve(root, 'app');
const errors = [];
const placeholderPattern = new RegExp(`\\b(?:${['TO' + 'DO', 'FIX' + 'ME', 'CHANGE' + 'ME', 'YOUR_' + '[A-Z_]+' ].join('|')})\\b`);
const required = [
  'package.json', 'netlify.toml', 'README.md', 'app/index.html', 'app/manifest.webmanifest', 'app/sw.js',
  'app/assets/css/app.css', 'app/assets/js/app.js', 'app/assets/js/core/db.js', 'app/assets/js/core/calculations.js',
  'app/assets/js/services/catalog.js', 'app/assets/js/services/image-algorithms.js', 'app/assets/js/services/image.js',
  'app/assets/js/services/scan-workbench.js', 'app/assets/js/services/scan-review.js', 'app/assets/js/services/supabase.js',
  'app/assets/js/services/watchlist.js', 'app/assets/js/services/price-intelligence.js',
  'app/assets/js/services/justtcg-refresh.js',
  'app/assets/js/core/catalog-identity.js', 'app/assets/js/core/intelligence-contract.js',
  'app/assets/js/core/intelligence-alerts.js',
  'analytics/pyproject.toml', 'analytics/README.md',
  'analytics/src/collectfolio_analytics/observations.py', 'analytics/src/collectfolio_analytics/trends.py',
  'analytics/src/collectfolio_analytics/catalog_mapping.py',
  'analytics/src/collectfolio_analytics/market_pipeline.py',
  'analytics/src/collectfolio_analytics/tcgcsv.py',
  'analytics/src/collectfolio_analytics/operator_cli.py',
  'analytics/src/collectfolio_analytics/monitoring.py',
  'analytics/src/collectfolio_analytics/publication.py',
  'analytics/src/collectfolio_analytics/forecasting.py',
  'analytics/src/collectfolio_analytics/qualification.py',
  'analytics/src/collectfolio_analytics/private_sql.py',
  'analytics/src/collectfolio_analytics/private_sql_cli.py',
  'analytics/src/collectfolio_analytics/walk_forward.py',
  'analytics/src/collectfolio_analytics/walk_forward_cli.py',
  'analytics/src/collectfolio_analytics/walk_forward_sql.py',
  'analytics/src/collectfolio_analytics/walk_forward_sql_cli.py',
  'analytics/src/collectfolio_analytics/baselines.py', 'analytics/src/collectfolio_analytics/quantiles.py',
  'analytics/src/collectfolio_analytics/scarcity.py', 'analytics/src/collectfolio_analytics/evaluation.py',
  'analytics/src/collectfolio_analytics/video_model_v0.py',
  'netlify/functions/justtcg-catalog.mjs',
  'netlify/lib/justtcg-collector.mjs',
  'netlify/lib/justtcg-blob-repository.mjs',
  'netlify/lib/justtcg-http.mjs',
  'netlify/lib/justtcg-lookup.mjs',
  'netlify/lib/justtcg-ondemand-repository.mjs',
  'netlify/lib/justtcg-ondemand-collector.mjs',
  'netlify/functions/justtcg-refresh.mjs',
  '.github/workflows/analytics-check.yml',
  '.github/workflows/price-intelligence-research.yml',
  'analytics/manifests/tcgcsv-surging-sparks-research.json',
  'supabase/migrations/0001_initial.sql', 'supabase/migrations/0002_price_intelligence_foundation.sql',
  'supabase/migrations/0003_price_intelligence_research_pipeline.sql',
  'supabase/migrations/0004_price_intelligence_function_acl_hardening.sql',
  'supabase/migrations/0005_private_forecast_research_ledgers.sql',
  'supabase/migrations/0006_price_intelligence_governance_hardening.sql',
  'docs/PRD.md', 'docs/TECHNICAL_SPEC.md', 'docs/NETLIFY_DEPLOY.md',
  'docs/PRICE_INTELLIGENCE_FOUNDATION.md', 'docs/PRICE_INTELLIGENCE_RUNBOOK.md',
  'docs/JUSTTCG_CATALOG_COLLECTOR.md', 'docs/JUSTTCG_ONDEMAND_REFRESH.md',
  'docs/source-reviews/TCGCSV_RESEARCH_ONLY.md',
  'docs/mapping-reviews/TCGCSV_590027_HOLOFOIL.md'
];

async function filesUnder(directory) {
  const result = [];
  for (const name of await readdir(directory)) {
    const path = resolve(directory, name);
    if ((await stat(path)).isDirectory()) result.push(...await filesUnder(path)); else result.push(path);
  }
  return result;
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

for (const name of required) if (!await exists(resolve(root, name))) errors.push(`Missing required file: ${name}`);

const packageJSON = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const dependencies = packageJSON.dependencies || {};
if (Object.keys(dependencies).join(',') !== '@netlify/blobs' || dependencies['@netlify/blobs'] !== '10.7.12') {
  errors.push('The only runtime package must be the pinned @netlify/blobs 10.7.12 server dependency.');
}
if (Object.keys(packageJSON.devDependencies || {}).length) errors.push('package.json must have zero devDependencies.');
for (const script of ['dev', 'build', 'test', 'test:analytics', 'qualify:research', 'check']) if (!packageJSON.scripts?.[script]) errors.push(`Missing npm script: ${script}`);

const researchManifest = JSON.parse(await readFile(resolve(root, 'analytics/manifests/tcgcsv-surging-sparks-research.json'), 'utf8'));
const researchReview = await readFile(resolve(root, 'docs/source-reviews/TCGCSV_RESEARCH_ONLY.md'));
const researchReviewHash = createHash('sha256').update(researchReview).digest('hex');
const mappingReview = await readFile(resolve(root, 'docs/mapping-reviews/TCGCSV_590027_HOLOFOIL.md'));
const mappingReviewHash = createHash('sha256').update(mappingReview).digest('hex');
if (researchManifest.mode !== 'research_only' || researchManifest.source?.decision !== 'research_only') errors.push('TCGCSV manifest must remain research-only.');
for (const capability of ['commercialUseAllowed', 'catalogMetadataAllowed', 'publicRawDisplayAllowed', 'publicDerivedDisplayAllowed']) {
  if (researchManifest.source?.[capability] !== false) errors.push(`TCGCSV manifest must deny ${capability}.`);
}
if (researchManifest.source?.documentHash !== researchReviewHash) errors.push('TCGCSV manifest source-review hash is stale.');
if (researchManifest.mappingReview?.scope !== 'research_only' || researchManifest.mappingReview?.decision !== 'approved') errors.push('TCGCSV mapping review must be approved for research scope only.');
if (researchManifest.mappingReview?.documentHash !== mappingReviewHash) errors.push('TCGCSV manifest mapping-review hash is stale.');
if (researchManifest.approvedMappings?.length !== 1 || researchManifest.approvedMappings[0]?.mappingConfidence !== 1) errors.push('TCGCSV qualification must contain exactly one reviewed exact mapping.');
if (researchManifest.historicalResearch?.expectedIntervalDays !== 7 || researchManifest.historicalResearch?.maxReferenceLagDays !== 7) errors.push('TCGCSV history and endpoint-reference intervals must remain exact-weekly.');
if (researchManifest.historicalResearch?.availabilityLagDays !== 1) errors.push('TCGCSV history must retain the conservative one-day availability lag.');
if (researchManifest.historicalResearch?.model?.family !== 'damped_momentum_baseline') errors.push('TCGCSV qualification must use a supported research baseline.');
if (researchManifest.historicalResearch?.model?.allowedHorizons?.join(',') !== '7,30,90,180,365') errors.push('TCGCSV qualification must retain the five declared research horizons.');
if (researchManifest.retrospectiveResearch?.expectedIntervalDays !== 7 || researchManifest.retrospectiveResearch?.maxReferenceLagDays !== 7) errors.push('TCGCSV retrospective evaluation must retain exact-weekly point-in-time intervals.');
if (researchManifest.retrospectiveResearch?.model?.family !== 'damped_momentum_baseline') errors.push('TCGCSV retrospective evaluation must use the declared research baseline.');
if (researchManifest.retrospectiveResearch?.model?.allowedHorizons?.join(',') !== '7,30,90,180,365') errors.push('TCGCSV retrospective evaluation must retain the five declared horizons.');
if (!researchManifest.retrospectiveResearch?.model?.version?.includes('retrospective')) errors.push('TCGCSV retrospective evaluation must use a separate explicit model version.');
if (researchManifest.retrospectiveResearch?.originSpacingDays !== 30) errors.push('TCGCSV retrospective origins must use the preregistered 30-day spacing.');
if (researchManifest.retrospectiveResearch?.cohortKey !== 'tcgcsv_30d_origins_accepted_research_only_v2') errors.push('TCGCSV retrospective cohort must use the versioned 30-day-origin identity.');
const requiredBaselines = ['no_change', 'damped_momentum', 'market_index', 'lifecycle_cohort', 'structural_convergence'];
if (researchManifest.retrospectiveResearch?.promotionPolicy?.requiredBaselines?.join(',') !== requiredBaselines.join(',')) errors.push('TCGCSV promotion policy must require all five PRD baselines.');

const walkForward = await readFile(resolve(root, 'analytics/src/collectfolio_analytics/walk_forward.py'), 'utf8');
for (const contract of [
  'retrospective_walk_forward', 'not_prospectively_generated',
  'source_rights_checked_at_generation', 'latest_training_label_maturity=None',
  'outliersPreservedAndExcludedFromFeatures', 'promotionReviewRows', 'publicCandidateRows',
  'evaluation_status', 'unscorable_reason', 'scorecardEvaluationRows',
  'promotion_policy_hash', 'evaluation_membership_hash', 'feature_dataset_hash',
  'unscorableMaturedTargets', 'excludedMaturedTargets', 'model_artifact_hash'
]) {
  if (!walkForward.includes(contract)) errors.push(`Walk-forward builder missing safety contract ${contract}.`);
}
const walkForwardSQL = await readFile(resolve(root, 'analytics/src/collectfolio_analytics/walk_forward_sql.py'), 'utf8');
for (const contract of [
  "review.expires_at > greatest", 'model created_at must equal the honest generation time',
  'retrospective prediction origin must precede generation',
  'retrospective export must not create a promotion review',
  'public_price_intelligence must remain disabled', "'commit;' if commit else 'rollback;'",
  'model code-artifact lineage is inconsistent', 'scorecard membership is not the exact horizon/origin cohort',
  'walk-forward packet hash is inconsistent'
]) {
  if (!walkForwardSQL.includes(contract)) errors.push(`Walk-forward SQL exporter missing safety contract ${contract}.`);
}

const appFiles = await filesUnder(app);
const netlifyFiles = await filesUnder(resolve(root, 'netlify'));
const sourceFiles = [...appFiles, ...await filesUnder(resolve(root, 'scripts')), ...netlifyFiles, resolve(root, 'netlify.toml'), ...await filesUnder(resolve(root, 'supabase/migrations'))];
for (const file of sourceFiles) {
  const extension = extname(file);
  if (!['.js', '.mjs', '.html', '.css', '.toml', '.sql', '.webmanifest'].includes(extension)) continue;
  const source = await readFile(file, 'utf8');
  if (placeholderPattern.test(source)) errors.push(`Unsafe placeholder in ${relative(root, file)}`);
  if (file !== resolve(root, 'scripts/dev.mjs') && /http:\/\//i.test(source)) errors.push(`Insecure URL in ${relative(root, file)}`);
}

const index = await readFile(resolve(app, 'index.html'), 'utf8');
for (const reference of ['./manifest.webmanifest', './runtime-config.js', './assets/css/app.css', './assets/js/app.js']) if (!index.includes(reference)) errors.push(`index.html does not reference ${reference}`);
for (const view of ['home', 'search', 'add', 'portfolio', 'profile']) if (!index.includes(`data-view="${view}"`)) errors.push(`index.html is missing ${view} navigation.`);

const serviceWorker = await readFile(resolve(app, 'sw.js'), 'utf8');
if (!serviceWorker.includes("const CACHE = 'collectfolio-shell-v0.2.6'")) errors.push('Service worker cache name must be collectfolio-shell-v0.2.6.');
if (!serviceWorker.includes('Promise.allSettled') && !(await readFile(resolve(app, 'assets/js/services/catalog.js'), 'utf8')).includes('Promise.allSettled')) errors.push('Catalog provider fan-out must use Promise.allSettled.');
for (const file of appFiles) {
  const name = `./${relative(app, file).replaceAll('\\', '/')}`;
  if (file === resolve(app, 'sw.js')) continue;
  if (!serviceWorker.includes(name)) errors.push(`Service-worker shell does not reference ${name}`);
}

const javascript = appFiles.filter((file) => extname(file) === '.js');
for (const file of javascript) {
  const source = await readFile(file, 'utf8');
  for (const tag of source.matchAll(/<img\b[^>]*>/g)) if (!/referrerpolicy=["']no-referrer["']/.test(tag[0])) errors.push(`External-capable image lacks no-referrer policy in ${relative(root, file)}`);
  for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*['"](\.[^'"]+)['"]/g)) {
    const target = resolve(dirname(file), match[1]);
    if (!await exists(target)) errors.push(`Unresolved import ${match[1]} in ${relative(root, file)}`);
  }
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (checked.status !== 0) errors.push(`JavaScript syntax error in ${relative(root, file)}: ${checked.stderr.trim()}`);
}
for (const file of (await filesUnder(resolve(root, 'scripts'))).filter((path) => extname(path) === '.mjs')) {
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (checked.status !== 0) errors.push(`JavaScript syntax error in ${relative(root, file)}: ${checked.stderr.trim()}`);
}
for (const file of netlifyFiles.filter((path) => extname(path) === '.mjs')) {
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (checked.status !== 0) errors.push(`JavaScript syntax error in ${relative(root, file)}: ${checked.stderr.trim()}`);
}

const justTcgCollector = await readFile(resolve(root, 'netlify/lib/justtcg-collector.mjs'), 'utf8');
for (const contract of [
  'JUSTTCG_PAGE_LIMIT = 20', 'JUSTTCG_DAILY_REQUEST_LIMIT = 100',
  'JUSTTCG_COLLECTION_REQUEST_LIMIT = 1_000', "JUSTTCG_SCHEDULE = '*/5 * * * *'",
  "include_price_history: true", "priceHistoryDuration: '1y'",
  "response.headers?.get?.('retry-after')", 'EXCESSIVE_FREE_TIER_USAGE',
  "redirect: 'error'", "'X-API-Key': config.apiKey"
]) {
  if (!justTcgCollector.includes(contract)) errors.push(`JustTCG collector missing safety contract ${contract}.`);
}
const justTcgFunction = await readFile(resolve(root, 'netlify/functions/justtcg-catalog.mjs'), 'utf8');
for (const contract of ['getStore', 'collectfolio-justtcg-private', 'runCollectorInvocation', "schedule: '*/5 * * * *'"]) {
  if (!justTcgFunction.includes(contract)) errors.push(`JustTCG scheduled function missing contract ${contract}.`);
}

const justTcgOndemandFunction = await readFile(resolve(root, 'netlify/functions/justtcg-refresh.mjs'), 'utf8');
const justTcgOndemandRepository = await readFile(resolve(root, 'netlify/lib/justtcg-ondemand-repository.mjs'), 'utf8');
const justTcgOndemandCollector = await readFile(resolve(root, 'netlify/lib/justtcg-ondemand-collector.mjs'), 'utf8');
const justTcgLookup = await readFile(resolve(root, 'netlify/lib/justtcg-lookup.mjs'), 'utf8');
for (const contract of ["method: ['POST']", 'getStore', 'collectfolio-justtcg-private', 'runOnDemandRefresh']) {
  if (!justTcgOndemandFunction.includes(contract)) errors.push(`JustTCG on-demand function missing contract ${contract}.`);
}
if (justTcgOndemandFunction.includes('schedule:')) errors.push('JustTCG on-demand function must not be scheduled; it is user-triggered only.');
for (const [name, source] of [
  ['on-demand function', justTcgOndemandFunction],
  ['on-demand repository', justTcgOndemandRepository],
  ['on-demand collector', justTcgOndemandCollector],
  ['lookup adapter', justTcgLookup]
]) {
  if (/SUPABASE_SERVICE_ROLE_KEY|service_role/i.test(source)) {
    errors.push(`JustTCG ${name} must never reference the Supabase service-role key or role.`);
  }
}
for (const contract of ["'X-API-Key'", "redirect: 'error'"]) {
  if (!justTcgLookup.includes(contract)) errors.push(`JustTCG lookup adapter missing safety contract ${contract}.`);
}
if (!justTcgOndemandRepository.includes('HEX_HASH') || !justTcgOndemandRepository.includes('assertMatches')) {
  errors.push('JustTCG on-demand repository must validate identity hashes before building any Blobs key.');
}
if (!justTcgOndemandRepository.includes('catalog/')) {
  errors.push('JustTCG on-demand repository must retain its read-only cross-read of the scheduled crawl state.');
}
if (justTcgOndemandRepository.includes('setJSON(`catalog') || justTcgOndemandRepository.includes('setJSON(\'catalog')) {
  errors.push('JustTCG on-demand repository must never write to the catalog/ prefix.');
}
if (!justTcgOndemandCollector.includes('notAnApprovedCanonicalMapping')) {
  errors.push('JustTCG on-demand candidates must be explicitly marked as not an approved canonical mapping.');
}
for (const file of appFiles.filter((path) => ['.js', '.html'].includes(extname(path)))) {
  const source = await readFile(file, 'utf8');
  if (/JUSTTCG_API_KEY|api\.justtcg\.com/i.test(source)) {
    errors.push(`JustTCG credential/provider access must not enter browser source: ${relative(root, file)}`);
  }
}

const migration = await readFile(resolve(root, 'supabase/migrations/0001_initial.sql'), 'utf8');
for (const table of ['profiles', 'holdings', 'holding_deletions', 'portfolio_snapshots', 'scan_sessions']) {
  if (!migration.includes(`create table if not exists public.${table}`)) errors.push(`Migration missing ${table}.`);
  if (!migration.includes(`alter table public.${table} enable row level security`)) errors.push(`Migration missing RLS for ${table}.`);
}

const intelligenceMigration = await readFile(resolve(root, 'supabase/migrations/0002_price_intelligence_foundation.sql'), 'utf8');
for (const table of ['data_sources', 'source_terms_reviews', 'catalog_variants', 'watchlists', 'watchlist_items', 'watchlist_deletions', 'card_intelligence_publications', 'product_feature_flags']) {
  if (!intelligenceMigration.includes(`create table public.${table}`)) errors.push(`Price-intelligence migration missing ${table}.`);
  if (!intelligenceMigration.includes(`alter table public.${table} enable row level security`)) errors.push(`Price-intelligence migration missing RLS for ${table}.`);
}
for (const contract of ['intelligence_publication_is_permitted', 'get_or_create_default_watchlist', 'watchlist_deletions_update_own', 'public_derived_display_allowed']) {
  if (!intelligenceMigration.includes(contract)) errors.push(`Price-intelligence migration missing security contract ${contract}.`);
}

const researchMigration = await readFile(resolve(root, 'supabase/migrations/0003_price_intelligence_research_pipeline.sql'), 'utf8');
for (const table of [
  'catalog_mapping_candidates', 'catalog_mapping_review_events', 'price_observations',
  'data_quality_events', 'analytics_runs', 'analytics_run_sources', 'trend_feature_snapshots',
  'intelligence_publication_candidates', 'intelligence_candidate_sources',
  'intelligence_candidate_reviews', 'intelligence_publication_promotions'
]) {
  if (!researchMigration.includes(`create table public.${table}`)) errors.push(`Research-pipeline migration missing ${table}.`);
  if (!researchMigration.includes(`alter table public.${table} enable row level security`)) errors.push(`Research-pipeline migration missing RLS for ${table}.`);
}
for (const contract of [
  'validate_price_observation_lineage', 'publish_descriptive_intelligence',
  'reject_append_only_mutation', 'protect_terminal_analytics_run',
  "candidate.publication_status <> 'published'", "candidate.support_tier > 2",
  "not (payload ? 'fairValue')", "not (payload ? 'forecasts')",
  'to service_role', 'from anon, authenticated'
]) {
  if (!researchMigration.includes(contract)) errors.push(`Research-pipeline migration missing security contract ${contract}.`);
}
if (/update\s+public\.product_feature_flags[\s\S]*public_price_intelligence/i.test(researchMigration)) {
  errors.push('Research-pipeline migration must not enable or mutate the public price-intelligence flag.');
}

const aclMigration = await readFile(resolve(root, 'supabase/migrations/0004_price_intelligence_function_acl_hardening.sql'), 'utf8');
for (const contract of [
  'from public, anon', 'from public, anon, authenticated, service_role',
  "has_function_privilege('anon', 'public.get_or_create_default_watchlist()', 'EXECUTE')",
  "has_function_privilege('authenticated', 'public.publish_descriptive_intelligence(uuid)', 'EXECUTE')",
  "has_function_privilege('service_role', 'public.publish_descriptive_intelligence(uuid)', 'EXECUTE')",
  'Trigger helpers must not be browser-executable'
]) {
  if (!aclMigration.includes(contract)) errors.push(`Function-ACL migration missing contract ${contract}.`);
}

const forecastMigration = await readFile(resolve(root, 'supabase/migrations/0005_private_forecast_research_ledgers.sql'), 'utf8');
for (const table of [
  'model_versions', 'card_forecast_predictions', 'forecast_evaluations',
  'model_scorecards', 'model_promotion_reviews'
]) {
  if (!forecastMigration.includes(`create table public.${table}`)) errors.push(`Forecast-research migration missing ${table}.`);
  if (!forecastMigration.includes(`alter table public.${table} enable row level security`)) errors.push(`Forecast-research migration missing RLS for ${table}.`);
}
for (const contract of [
  'research_only boolean not null default true check (research_only)',
  "prediction_status in ('research_only','quarantined')",
  'q10 <= q25 and q25 <= q50 and q50 <= q75 and q75 <= q90',
  'source_rights_attested', 'eligible_for_operator_review',
  'validate_forecast_evaluation_lineage',
  'from public, anon, authenticated, service_role',
  'to service_role', 'Forecast trigger helper must not be browser-executable'
]) {
  if (!forecastMigration.includes(contract)) errors.push(`Forecast-research migration missing security contract ${contract}.`);
}
if (/update\s+public\.product_feature_flags[\s\S]*public_price_intelligence/i.test(forecastMigration)) {
  errors.push('Forecast-research migration must not enable or mutate the public price-intelligence flag.');
}

const governanceMigration = await readFile(resolve(root, 'supabase/migrations/0006_price_intelligence_governance_hardening.sql'), 'utf8');
for (const table of ['model_scorecard_evaluations', 'intelligence_publication_control_events']) {
  if (!governanceMigration.includes(`create table public.${table}`)) errors.push(`Governance migration missing ${table}.`);
  if (!governanceMigration.includes(`alter table public.${table} enable row level security`)) errors.push(`Governance migration missing RLS for ${table}.`);
}
for (const contract of [
  "flag.key = 'public_price_intelligence'", 'source_terms_reviews_append_only',
  'supersede_external_card_mapping', 'external_card_mappings_current_external_key',
  'external_card_mappings_single_successor', 'validate_external_mapping_supersession',
  "evaluation_status in ('scored','unscorable')", 'forecast_evaluations_outcome_check',
  'model_versions_training_lineage_check', "when config->>'trainingMode' = 'none_static_baseline' then null",
  'model_scorecards_evidence_contract_check',
  'promotion_policy_hash', 'evaluation_membership_hash',
  'validate_scorecard_evaluation_membership', 'validate_model_promotion_review_integrity',
  'review_model_promotion', 'price_intelligence_operator',
  'Publication is missing required source attribution', 'disable_public_intelligence',
  'Service role must publish only through the guarded RPC',
  'Model reviews must be submitted by an authenticated operator RPC'
]) {
  if (!governanceMigration.includes(contract)) errors.push(`Governance migration missing contract ${contract}.`);
}
if (!/revoke insert, update, delete on public\.card_intelligence_publications\s+from service_role/i.test(governanceMigration)) errors.push('Governance migration must make the publication RPC the exclusive service-role writer.');
if (!/revoke insert on public\.model_promotion_reviews from service_role/i.test(governanceMigration)) errors.push('Governance migration must make the authenticated review RPC the exclusive promotion-review writer.');
if (/update\s+public\.product_feature_flags[\s\S]*public_price_intelligence/i.test(governanceMigration)) errors.push('Governance migration must not enable or mutate the public price-intelligence flag.');

const netlify = await readFile(resolve(root, 'netlify.toml'), 'utf8');
for (const text of ['command = "npm run build"', 'publish = "dist"', 'NODE_VERSION = "22"', 'to = "/index.html"', 'for = "/sw.js"']) if (!netlify.includes(text)) errors.push(`netlify.toml missing ${text}`);
if (netlify.includes("'unsafe-eval'")) errors.push('Content Security Policy must not allow unsafe-eval.');
if (!netlify.includes("'wasm-unsafe-eval'")) errors.push('Content Security Policy must allow WebAssembly compilation for configured OCR.');
for (const host of ['https://images.pokemontcg.io', 'https://images.scrydex.com', 'https://assets.tcgdex.net', 'https://cards.scryfall.io', 'https://images.ygoprodeck.com']) {
  if (netlify.split(host).length < 3) errors.push(`Content Security Policy must allow ${host} for both provider images and service-worker fetches.`);
}

if (errors.length) {
  console.error(`Validation failed:\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(`Validation passed: ${required.length} required files, ${javascript.length} browser modules, one pinned server-only npm package.`);
