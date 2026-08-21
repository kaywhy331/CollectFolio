import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const app = resolve(root, 'app');
const errors = [];
const placeholderPattern = new RegExp(`\\b(?:${['TO' + 'DO', 'FIX' + 'ME', 'CHANGE' + 'ME', 'YOUR_' + '[A-Z_]+' ].join('|')})\\b`);
const required = [
  'package.json', 'package-lock.json', 'playwright.config.js', 'netlify.toml', 'README.md',
  'app/index.html', 'app/manifest.webmanifest', 'app/runtime-config.js', 'app/sw.js',
  'app/assets/css/app.css', 'app/assets/js/app.js', 'app/assets/js/core/db.js', 'app/assets/js/core/calculations.js',
  'app/assets/js/core/router.js', 'app/assets/js/core/view-models.js', 'app/assets/js/core/settings.js',
  'app/assets/js/core/portfolio-sets.js',
  'app/assets/js/services/catalog.js', 'app/assets/js/services/image-algorithms.js', 'app/assets/js/services/image.js',
  'app/assets/js/services/catalog-browse.js',
  'app/assets/js/services/providers/tcgcsv.js',
  'app/assets/js/services/scan-workbench.js', 'app/assets/js/services/scan-review.js', 'app/assets/js/services/supabase.js',
  'app/assets/js/services/visual-index.js', 'app/assets/data/visual-index/pokemon-v1/manifest.json',
  'app/assets/js/services/watchlist.js', 'app/assets/js/services/price-intelligence.js',
  'app/assets/js/services/justtcg-refresh.js',
  'app/assets/js/services/tcgcsv-refresh-status.js',
  'app/assets/js/core/catalog-identity.js', 'app/assets/js/core/intelligence-contract.js',
  'app/assets/js/core/intelligence-alerts.js', 'app/assets/js/core/insights.js', 'app/assets/js/core/local-scenarios.js',
  'app/assets/js/core/data-freshness.js', 'app/assets/js/core/scenario-lab.js',
  'app/assets/js/services/scan-detection-worker.js',
  'app/assets/js/views/insights.js', 'app/assets/js/views/onboarding.js', 'app/assets/js/views/profile.js',
  'analytics/pyproject.toml', 'analytics/README.md',
  'analytics/src/collectfolio_analytics/observations.py', 'analytics/src/collectfolio_analytics/trends.py',
  'analytics/src/collectfolio_analytics/catalog_mapping.py',
  'analytics/src/collectfolio_analytics/market_pipeline.py',
  'analytics/src/collectfolio_analytics/tcgcsv.py',
  'analytics/src/collectfolio_analytics/tcgcsv_universe.py',
  'analytics/src/collectfolio_analytics/tcgcsv_universe_io.py',
  'analytics/src/collectfolio_analytics/tcgcsv_universe_cli.py',
  'analytics/src/collectfolio_analytics/structural_gap.py',
  'analytics/src/collectfolio_analytics/structural_gap_cli.py',
  'analytics/src/collectfolio_analytics/operator_cli.py',
  'analytics/src/collectfolio_analytics/monitoring.py',
  'analytics/src/collectfolio_analytics/publication.py',
  'analytics/src/collectfolio_analytics/prospective.py',
  'analytics/src/collectfolio_analytics/forecasting.py',
  'analytics/src/collectfolio_analytics/qualification.py',
  'analytics/src/collectfolio_analytics/private_sql.py',
  'analytics/src/collectfolio_analytics/private_sql_cli.py',
  'analytics/src/collectfolio_analytics/walk_forward.py',
  'analytics/src/collectfolio_analytics/walk_forward_cli.py',
  'analytics/src/collectfolio_analytics/walk_forward_sql.py',
  'analytics/src/collectfolio_analytics/walk_forward_sql_cli.py',
  'analytics/src/collectfolio_analytics/historical_import.py',
  'analytics/src/collectfolio_analytics/historical_import_cli.py',
  'analytics/src/collectfolio_analytics/historical_import_sql.py',
  'analytics/src/collectfolio_analytics/cardbase.py',
  'analytics/src/collectfolio_analytics/cardbase_history.py',
  'analytics/src/collectfolio_analytics/cardbase_history_cli.py',
  'analytics/src/collectfolio_analytics/baselines.py', 'analytics/src/collectfolio_analytics/quantiles.py',
  'analytics/src/collectfolio_analytics/scarcity.py', 'analytics/src/collectfolio_analytics/evaluation.py',
  'analytics/src/collectfolio_analytics/video_model_v0.py',
  'analytics/src/collectfolio_analytics/pull_rates.py',
  'analytics/src/collectfolio_analytics/pull_rate_curation.py',
  'analytics/src/collectfolio_analytics/pull_rate_curation_cli.py',
  'analytics/src/collectfolio_analytics/pull_rate_source_verify.py',
  'analytics/src/collectfolio_analytics/pull_rate_sql.py',
  'analytics/src/collectfolio_analytics/pull_rate_sql_cli.py',
  'analytics/src/collectfolio_analytics/mapping_supersession_sql.py',
  'analytics/src/collectfolio_analytics/mapping_supersession_sql_cli.py',
  'netlify/functions/justtcg-catalog.mjs',
  'netlify/lib/justtcg-collector.mjs',
  'netlify/lib/justtcg-blob-repository.mjs',
  'netlify/lib/justtcg-http.mjs',
  'netlify/lib/justtcg-lookup.mjs',
  'netlify/lib/justtcg-ondemand-repository.mjs',
  'netlify/lib/justtcg-ondemand-collector.mjs',
  'netlify/functions/justtcg-refresh.mjs',
  'cloudflare/tcgcsv-refresh/src/index.js',
  'cloudflare/tcgcsv-refresh/src/catalog.js',
  'cloudflare/tcgcsv-refresh/wrangler.jsonc',
  'cloudflare/tcgcsv-refresh/worker-configuration.d.ts',
  'scripts/tcgcsv-r2-refresh-client.mjs',
  '.github/workflows/analytics-check.yml',
  '.github/workflows/price-intelligence-research.yml',
  '.github/workflows/tcgcsv-market-universe.yml',
  '.github/workflows/tcgcsv-r2-refresh.yml',
  '.github/workflows/cardbase-mtg-history.yml',
  '.github/workflows/pull-rate-integrity.yml',
  'analytics/manifests/tcgcsv-surging-sparks-research.json',
  'analytics/manifests/tcgcsv-surging-sparks-current-v2.json',
  'analytics/manifests/tcgcsv-surging-sparks-mapping-supersession-v2.json',
  'analytics/manifests/tcgplayer-sv-me-pull-rates.json',
  'supabase/migrations/0001_initial.sql', 'supabase/migrations/0002_price_intelligence_foundation.sql',
  'supabase/migrations/0003_price_intelligence_research_pipeline.sql',
  'supabase/migrations/0004_price_intelligence_function_acl_hardening.sql',
  'supabase/migrations/0005_private_forecast_research_ledgers.sql',
  'supabase/migrations/0006_price_intelligence_governance_hardening.sql',
  'supabase/migrations/0009_pull_rate_registry.sql',
  'supabase/migrations/0014_pull_rate_unavailability_registry.sql',
  'supabase/migrations/0015_remove_my_cloud_data.sql',
  'supabase/migrations/0016_forecast_engine_v1.sql',
  'supabase/migrations/0017_private_prospective_forecast_ledger.sql',
  'supabase/migrations/0018_forecast_execution_and_scorecards.sql',
  'supabase/migrations/0019_centralized_historical_price_imports.sql',
  'supabase/migrations/0020_tcgcsv_market_universe.sql',
  'PRD/redesign.md', 'PRD/CollectFolio Premium UX Redesign — PRD & UI-UX Specification.md',
  'docs/PRD.md', 'docs/TECHNICAL_SPEC.md', 'docs/NETLIFY_DEPLOY.md',
  'docs/PREMIUM_UX_DESIGN_SYSTEM.md', 'docs/PREMIUM_UX_ACCEPTANCE.md',
  'docs/REDESIGN_COMPATIBILITY.md', 'docs/REDESIGN_FOUNDATION.md', 'docs/REDESIGN_CORE_VERTICAL_SLICE.md',
  'docs/REDESIGN_INTAKE_COLLECTION_MANAGEMENT.md', 'docs/REDESIGN_FORECASTING_INSIGHTS.md',
  'docs/REDESIGN_ACCOUNT_SYNC_RELEASE.md', 'docs/REDESIGN_FINAL_ACCEPTANCE.md',
  'docs/PRICE_INTELLIGENCE_FOUNDATION.md', 'docs/PRICE_INTELLIGENCE_RUNBOOK.md',
  'docs/TCGCSV_MARKET_UNIVERSE.md',
  'docs/CARDBASE_MTG_RESEARCH.md',
  'docs/JUSTTCG_CATALOG_COLLECTOR.md', 'docs/JUSTTCG_ONDEMAND_REFRESH.md',
  'docs/PULL_RATE_REGISTRY.md',
  'docs/source-reviews/TCGCSV_RESEARCH_ONLY.md',
  'docs/source-reviews/TCGCSV_FULL_COHORT_PRIVATE_RESEARCH.md',
  'docs/source-reviews/TCGCSV_RECURRING_PRIVATE_ROLLING.md',
  'docs/source-reviews/TCGCSV_AUTHENTICATED_FULL_CATALOG_TEST.md',
  'docs/source-reviews/CARDBASE_MTG_RESEARCH_CANDIDATE.md',
  'docs/source-reviews/TCGPLAYER_PULL_RATES_RESEARCH_ONLY.md',
  'docs/mapping-reviews/TCGCSV_590027_HOLOFOIL.md',
  'docs/mapping-reviews/TCGCSV_590027_HOLOFOIL_V2.md',
  'docs/receipts/TCGCSV_SURGING_SPARKS_MAPPING_V2.md',
  'docs/receipts/TCGCSV_FULL_COHORT_R2_2026_08_15.md',
  'docs/receipts/TCGCSV_ROLLING_R2_2026_08_15.md',
  'tests/redesign-protection.test.js',
  'tests/local-scenarios.test.js', 'tests/data-freshness.test.js', 'tests/scenario-lab.test.js',
  'tests/router.test.js', 'tests/view-models.test.js', 'tests/overview.test.js',
  'tests/discover.test.js', 'tests/catalog-browse.test.js', 'tests/portfolio-redesign.test.js', 'tests/portfolio-sets.test.js',
  'tests/intake-management.test.js', 'tests/watchlist-management.test.js', 'tests/insights.test.js',
  'tests/settings.test.js', 'tests/phase5-migration.test.js', 'tests/phase5-ui.test.js',
  'tests/forecast-engine-migration.test.js',
  'tests/historical-price-import-migration.test.js',
  'tests/tcgcsv-market-universe-migration.test.js',
  'tests/tcgcsv-r2-refresh-worker.test.js', 'tests/tcgcsv-refresh-status.test.js',
  'tests/postgres/run_forecast_runtime.py',
  'tests/postgres/run_tcgcsv_universe_runtime.py',
  'tests/postgres/forecast-runtime-fixture.sql',
  'tests/postgres/forecast-scorecard-fixture.sql',
  'tests/fixtures/redesign/indexeddb-v4-backup-v2.json',
  'tests/fixtures/redesign/cloud-sync.json',
  'tests/fixtures/redesign/legacy-routes.json',
  'tests/e2e/catalog-pagination.spec.js', 'tests/e2e/browse-sets.spec.js', 'tests/e2e/portfolio-sets.spec.js', 'tests/e2e/protection-baseline.spec.js',
  'tests/e2e/premium-ux-acceptance.spec.js',
  'tests/e2e/phase5.spec.js', 'tests/e2e/service-worker.spec.js',
  'tests/e2e/protection-baseline.spec.js-snapshots/legacy-overview-empty-chromium-linux.png',
  'tests/e2e/protection-baseline.spec.js-snapshots/core-slice-overview-empty-chromium-linux.png'
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
const packageLock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
if (packageJSON.version !== '0.8.26' || packageLock.version !== '0.8.26' || packageLock.packages?.['']?.version !== '0.8.26') {
  errors.push('Application and lockfile versions must agree on 0.8.26.');
}
const dependencies = packageJSON.dependencies || {};
if (Object.keys(dependencies).join(',') !== '@netlify/blobs' || dependencies['@netlify/blobs'] !== '9.1.5') {
  errors.push('The only runtime package must be the audit-safe pinned @netlify/blobs 9.1.5 server dependency.');
}
const approvedDevDependencies = {
  '@axe-core/playwright': '4.12.1',
  '@fontsource-variable/inter': '5.3.0',
  '@playwright/test': '1.62.1',
  wrangler: '4.123.0'
};
const devDependencies = packageJSON.devDependencies || {};
if (JSON.stringify(Object.keys(devDependencies).sort()) !== JSON.stringify(Object.keys(approvedDevDependencies).sort())
    || Object.entries(approvedDevDependencies).some(([name, version]) => devDependencies[name] !== version)) {
  errors.push('Dev dependencies must be exactly the pinned Playwright, axe, snapshot-font, and Wrangler packages.');
}
for (const script of ['dev', 'build', 'test', 'test:analytics', 'test:forecast-db', 'test:tcgcsv-db', 'test:tcgcsv-refresh', 'test:browser', 'test:browser:update', 'check:all', 'qualify:research', 'qualify:research:current', 'forecast:lab', 'history:import', 'cardbase:history', 'tcgcsv:universe', 'worker:tcgcsv:types', 'worker:tcgcsv:dry-run', 'check']) if (!packageJSON.scripts?.[script]) errors.push(`Missing npm script: ${script}`);

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
const historicalVariant = researchManifest.canonicalVariants?.[0];
const historicalMapping = researchManifest.approvedMappings?.[0];
if (historicalVariant?.setCode !== 'sv08' || historicalVariant?.number !== '238/191') errors.push('Historical TCGCSV v1 manifest must retain its original sv08 / 238/191 identity.');
if (historicalMapping?.mappingId !== '874f918c-8988-59f5-93ba-ff1ea961bd5a' || historicalMapping?.variantId !== '80b4934a-96db-5f4c-8641-f7c74e0eb949' || researchManifest.mappingVersion !== 'tcgcsv-research-mapping-v1') errors.push('Historical TCGCSV v1 mapping lineage must remain immutable.');

const currentResearchManifest = JSON.parse(await readFile(resolve(root, 'analytics/manifests/tcgcsv-surging-sparks-current-v2.json'), 'utf8'));
const correctedMappingReview = await readFile(resolve(root, 'docs/mapping-reviews/TCGCSV_590027_HOLOFOIL_V2.md'));
const correctedMappingReviewHash = createHash('sha256').update(correctedMappingReview).digest('hex');
if (currentResearchManifest.mode !== 'research_only' || currentResearchManifest.source?.decision !== 'research_only') errors.push('Current TCGCSV v2 manifest must remain research-only.');
for (const capability of ['commercialUseAllowed', 'catalogMetadataAllowed', 'publicRawDisplayAllowed', 'publicDerivedDisplayAllowed']) {
  if (currentResearchManifest.source?.[capability] !== false) errors.push(`Current TCGCSV v2 manifest must deny ${capability}.`);
}
if (currentResearchManifest.source?.documentHash !== researchReviewHash) errors.push('Current TCGCSV v2 source-review hash is stale.');
if (currentResearchManifest.mappingReview?.documentHash !== correctedMappingReviewHash || currentResearchManifest.mappingReview?.scope !== 'research_only') errors.push('Current TCGCSV v2 mapping review is stale or exceeds research scope.');
if ('historicalResearch' in currentResearchManifest || 'retrospectiveResearch' in currentResearchManifest || 'ingestedAt' in currentResearchManifest) errors.push('Current TCGCSV v2 manifest must remain current-snapshot-only.');
const currentVariant = currentResearchManifest.canonicalVariants?.[0];
const currentMapping = currentResearchManifest.approvedMappings?.[0];
if (currentResearchManifest.canonicalVariants?.length !== 1 || currentVariant?.setCode !== 'sv8' || currentVariant?.number !== '238') errors.push('Current TCGCSV v2 manifest must use canonical sv8 card 238.');
if (currentResearchManifest.approvedMappings?.length !== 1 || currentMapping?.mappingId !== '649be0ee-0893-459a-bad6-331a218e069b' || currentMapping?.variantId !== 'af796afb-d8d3-5b4b-a95a-417e39e77b0a' || currentMapping?.mappingConfidence !== 1 || currentResearchManifest.mappingVersion !== 'tcgcsv-research-mapping-v2') errors.push('Current TCGCSV v2 manifest must use the approved hosted successor mapping.');

const supersessionManifestPath = resolve(root, 'analytics/manifests/tcgcsv-surging-sparks-mapping-supersession-v2.json');
const supersessionManifest = JSON.parse(await readFile(supersessionManifestPath, 'utf8'));
if (supersessionManifest.review?.document_sha256 !== correctedMappingReviewHash) errors.push('Mapping supersession manifest review hash is stale.');
if (supersessionManifest.old_mapping?.id !== historicalMapping?.mappingId || supersessionManifest.replacement?.variant_id !== currentMapping?.variantId) errors.push('Mapping supersession manifest does not bridge the immutable v1 and current v2 identities.');
const supersessionValidation = spawnSync('python3', ['-c', `import json\nfrom pathlib import Path\nfrom collectfolio_analytics.mapping_supersession_sql import validate_mapping_supersession_manifest\nvalidate_mapping_supersession_manifest(json.loads(Path(${JSON.stringify(supersessionManifestPath)}).read_text(encoding="utf-8")))`], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, PYTHONPATH: resolve(root, 'analytics/src') },
});
if (supersessionValidation.status !== 0) errors.push(`Mapping supersession manifest validation failed: ${supersessionValidation.stderr || supersessionValidation.stdout}`);

const researchWorkflow = await readFile(resolve(root, '.github/workflows/price-intelligence-research.yml'), 'utf8');
if (!researchWorkflow.includes('analytics/manifests/tcgcsv-surging-sparks-current-v2.json --pretty') || !researchWorkflow.includes('--skip-history')) errors.push('Manual TCGCSV research must use the current-only v2 manifest with --skip-history.');
if (researchWorkflow.includes('analytics/manifests/tcgcsv-surging-sparks-research.json --pretty')) errors.push('Manual TCGCSV research must not route through the historical v1 manifest.');
if (!researchWorkflow.includes("TCGCSV_FULL_UNIVERSE_RESEARCH_ENABLED != 'true'")) errors.push('Bounded TCGCSV qualification must stop when the full-universe workflow is active.');
if (/(^|\n)\s*schedule:/.test(researchWorkflow)) errors.push('TCGCSV qualification must remain a manually dispatched static batch.');

const universeWorkflow = await readFile(resolve(root, '.github/workflows/tcgcsv-market-universe.yml'), 'utf8');
for (const contract of [
  'TCGCSV_FULL_UNIVERSE_RESEARCH_ENABLED', 'workflow_dispatch:', 'schedule:',
  "cron: '41 6 * * *'", 'concurrency:',
  "analytics[market-universe]", 'last-updated.txt', 'prepare-archive',
  'archive_date=', 'prices.parquet', 'ingest-archive', 'sync-catalog',
  '--use-database-state --ingest', 'retention-days: 30'
]) {
  if (!universeWorkflow.includes(contract)) errors.push(`TCGCSV market-universe workflow lacks contract ${contract}.`);
}
if (!/permissions:\s*\n\s+contents: read/.test(universeWorkflow)) errors.push('TCGCSV market-universe workflow must keep GitHub permissions contents-read-only.');
if (/service_role|SUPABASE_SERVICE_ROLE/i.test(universeWorkflow)) errors.push('TCGCSV market-universe workflow must use the dedicated ingest credential, not a broad service-role secret.');
if (/update\s+public\.product_feature_flags/i.test(universeWorkflow)) errors.push('TCGCSV market-universe workflow must not enable public forecasting.');
if (!/(^|\n)\s*schedule:\s*\n\s*-\s*cron:\s*['"]41 6 \* \* \*['"]/.test(universeWorkflow)) errors.push('TCGCSV market-universe acquisition must retain its daily 06:41 UTC schedule.');

const rollingWorkflow = await readFile(resolve(root, '.github/workflows/tcgcsv-r2-refresh.yml'), 'utf8');
for (const contract of [
  "cron: '5 * * * *'", 'TCGCSV_R2_REFRESH_ENABLED', 'concurrency:',
  "node-version: '22'",
  'tcgcsv-r2-refresh-client.mjs claim', 'download-if-present',
  '--source-available-at', 'sync-catalog', 'catalog.partial !== false',
  'gzip -n -9', 'raw_archive', 'prices_parquet', 'market_features_gzip',
  'set_features', 'archive_packet', 'catalog_packet_gzip',
  'catalog-status', 'catalog-plan', 'catalog-upload-all', 'catalog-complete',
  'github_workflow_failed', 'retention-days: 30'
]) {
  if (!rollingWorkflow.includes(contract)) errors.push(`TCGCSV rolling R2 workflow lacks contract ${contract}.`);
}
if (!/permissions:\s*\n\s+contents: read/.test(rollingWorkflow)) errors.push('TCGCSV rolling R2 workflow must keep GitHub permissions contents-read-only.');
if (/DATABASE_URL|SUPABASE_|--use-database-state|--ingest\b|structural[_ -]gap|price[_ -]intelligence/i.test(rollingWorkflow)) {
  errors.push('TCGCSV rolling R2 workflow must not ingest a database, train, or publish price intelligence.');
}
if (!rollingWorkflow.includes('3775d954-f0ce-4abc-97fb-a7a6938c134a')) errors.push('TCGCSV rolling R2 workflow must bind the approved recurring review ID.');
if (!rollingWorkflow.includes('386a917b-85b5-4028-8fef-d873c2d39988')) errors.push('TCGCSV catalog publication must bind the authenticated test review ID.');

const rollingReview = await readFile(resolve(root, 'docs/source-reviews/TCGCSV_RECURRING_PRIVATE_ROLLING.md'), 'utf8');
for (const contract of [
  '3775d954-f0ce-4abc-97fb-a7a6938c134a', 'private_rolling_research',
  'latest and previous successful cohorts', '90-minute lease',
  'No LLM', 'Historical accumulation or backfill | No',
  'PostgreSQL migration or ingestion | No', 'Commercial use | No'
]) {
  if (!rollingReview.includes(contract)) errors.push(`TCGCSV rolling source review lacks contract ${contract}.`);
}

const catalogTestReview = await readFile(resolve(root, 'docs/source-reviews/TCGCSV_AUTHENTICATED_FULL_CATALOG_TEST.md'), 'utf8');
for (const contract of [
  '386a917b-85b5-4028-8fef-d873c2d39988', 'authenticated_private_integration_test',
  'all products, including products with no current price',
  'marketPrice`, `midPrice`, `lowPrice`, `directLowPrice`, then `highPrice',
  'Anonymous requests fail closed', 'No LLM', 'Public or commercial availability remains blocked'
]) {
  if (!catalogTestReview.includes(contract)) errors.push(`TCGCSV catalog test review lacks contract ${contract}.`);
}

const catalogWorker = await readFile(resolve(root, 'cloudflare/tcgcsv-refresh/src/catalog.js'), 'utf8');
for (const contract of [
  'collectfolio-tcgcsv-web-catalog-v2', 'catalog/pointer.json',
  'coordination/catalog-publication-claim.json', 'MAX_SEARCH_PAGE_BYTES = 128 * 1024',
  'authenticateCatalogUser', 'CATALOG_AUTHENTICATED_TEST_ACCESS',
  'verifyPublicationObjectSet', 'cleanupStaleCatalogPublications'
]) {
  if (!catalogWorker.includes(contract)) errors.push(`TCGCSV catalog Worker lacks contract ${contract}.`);
}

const refreshWorker = await readFile(resolve(root, 'cloudflare/tcgcsv-refresh/src/index.js'), 'utf8');
for (const contract of [
  'tcgcsv-r2-refresh-v1', 'coordination/claim.json', 'DEFAULT_LEASE_MINUTES = 90',
  "return `runs/${runId}/slot-${slot}/${artifact.path}`", 'onlyIf:',
  'TCGCSV changed before completion', 'Published artifact does not match its marker',
  'cleanupStaleRunArtifacts', 'crypto.subtle.timingSafeEqual',
  'lastSuccessfulSourceBuild', "url.pathname === '/status'"
]) {
  if (!refreshWorker.includes(contract)) errors.push(`TCGCSV refresh Worker lacks contract ${contract}.`);
}
const publicStatusBody = refreshWorker.match(/function publicRefreshStatus\(state\) \{([\s\S]*?)\n\}/)?.[1] || '';
if (/artifact|runId|key/i.test(publicStatusBody)) errors.push('Public TCGCSV refresh status must not expose artifacts, run IDs, or R2 keys.');
const refreshConfig = await readFile(resolve(root, 'cloudflare/tcgcsv-refresh/wrangler.jsonc'), 'utf8');
for (const contract of ['collectfolio-tcgcsv-current', 'collectfolio-staging.netlify.app', '"crons": ["0 * * * *"]', '"enabled": true']) {
  if (!refreshConfig.includes(contract)) errors.push(`TCGCSV refresh Worker config lacks contract ${contract}.`);
}
const universeRunbook = await readFile(resolve(root, 'docs/TCGCSV_MARKET_UNIVERSE.md'), 'utf8');
for (const contract of [
  'TCGCSV is the authoritative', 'broad-market history baseline',
  'Portfolio and search activity never determine ingestion coverage',
  'Every daily\nrun processes every price series',
  'Cardbase and other APIs may supplement selected series with targeted'
]) {
  if (!universeRunbook.includes(contract)) errors.push(`TCGCSV market-universe runbook lacks architecture contract ${contract}.`);
}

const cardbaseWorkflow = await readFile(resolve(root, '.github/workflows/cardbase-mtg-history.yml'), 'utf8');
for (const contract of [
  'CARDBASE_MTG_RESEARCH_ENABLED', 'schedule:', 'concurrency:',
  'CARDBASE_API_KEY', 'CARDBASE_MTG_MANIFEST_S3_URI',
  'CARDBASE_MTG_ARCHIVE_S3_URI', 'cardbase_history_cli',
  'first-seen-ledger.json', '--state .cardbase-run/prior-state.json',
  'persist-credentials: false', 'single-key-paced-retry-after',
  'source.documentHash', 'redacted-receipt.json', 'retention-days: 30'
]) {
  if (!cardbaseWorkflow.includes(contract)) errors.push(`Cardbase MTG workflow lacks contract ${contract}.`);
}
if (!/permissions:\s*\n\s+contents: read/.test(cardbaseWorkflow)) errors.push('Cardbase MTG workflow must keep GitHub permissions contents-read-only.');
if (/service_role|SUPABASE_|DATABASE_URL|update\s+public\.product_feature_flags/i.test(cardbaseWorkflow)) errors.push('Cardbase MTG workflow must have no database credential or feature-flag write path.');
if (/apiKeys|keyRotation|rotateKeys/.test(cardbaseWorkflow)) errors.push('Cardbase MTG workflow must never pool or rotate API keys.');
if (cardbaseWorkflow.includes('state_args')) errors.push('Cardbase MTG workflow must fail closed when canonical first-seen state cannot be restored.');
if (!cardbaseWorkflow.includes('path: .cardbase-run/redacted-receipt.json') || cardbaseWorkflow.includes('path: .cardbase-run/import-packet.json')) errors.push('Cardbase CI artifacts must expose only the redacted receipt.');
const cardbaseReview = await readFile(resolve(root, 'docs/source-reviews/CARDBASE_MTG_RESEARCH_CANDIDATE.md'), 'utf8');
for (const contract of [
  '**Decision:** `research_only`', 'Public raw display:** no',
  'Public derived display / predictive use:** no', 'one server-side key',
  'provider-aggregate', 'operator_first_seen', 'No Cardbase key is configured'
]) {
  if (!cardbaseReview.includes(contract)) errors.push(`Cardbase source review lacks contract ${contract}.`);
}

const pullRateIntegrityWorkflow = await readFile(resolve(root, '.github/workflows/pull-rate-integrity.yml'), 'utf8');
for (const contract of [
  'schedule:', '--verify-sources', 'tcgplayer-sv-me-pull-rates.json',
  'cfbf261e3986429bed4fe15877309f9783bde584ca11022f0a33f0aa6beadeb6',
  'pull_rate_sql_cli', 'rollback; -- rehearsal by default', 'retention-days: 30'
]) {
  if (!pullRateIntegrityWorkflow.includes(contract)) errors.push(`Pull-rate integrity workflow lacks contract ${contract}.`);
}
if (!/permissions:\s*\n\s+contents: read/.test(pullRateIntegrityWorkflow)) errors.push('Pull-rate integrity workflow must remain contents-read-only.');
if (/SUPABASE_|db query|--commit/i.test(pullRateIntegrityWorkflow)) errors.push('Pull-rate integrity workflow must have no database credential or write path.');

const pullRateManifest = JSON.parse(await readFile(resolve(root, 'analytics/manifests/tcgplayer-sv-me-pull-rates.json'), 'utf8'));
const pullRateReview = await readFile(resolve(root, 'docs/source-reviews/TCGPLAYER_PULL_RATES_RESEARCH_ONLY.md'));
const pullRateReviewHash = createHash('sha256').update(pullRateReview).digest('hex');
if (pullRateManifest.mode !== 'research_only_pull_rate_curation') errors.push('Pull-rate manifest must remain research-only curation.');
if (pullRateManifest.source_review?.decision !== 'research_only') errors.push('Pull-rate source review must remain research-only.');
if (pullRateManifest.source_review?.document_sha256 !== pullRateReviewHash) errors.push('Pull-rate manifest source-review hash is stale.');
if (pullRateManifest.target_sets?.length !== 22) errors.push('Pull-rate manifest must retain all 22 canonical SV/ME target sets.');
if (pullRateManifest.studies?.length !== 19) errors.push('Pull-rate manifest must retain the 19 reviewed primary studies.');
const pullRateEntryCount = (pullRateManifest.studies || []).reduce((count, study) => count + (study.entries?.length || 0), 0);
if (pullRateEntryCount !== 112) errors.push('Pull-rate manifest must retain exactly 112 curated rarity rows.');
if (pullRateManifest.unavailable?.length !== 4) errors.push('Pull-rate manifest must retain two unavailable sets and two unknown BWR slots.');
for (const study of pullRateManifest.studies || []) {
  if (!/^[0-9a-f]{64}$/.test(study.source?.article_body_sha256 || '')) errors.push(`Pull-rate source ${study.source?.article_id || 'unknown'} lacks an immutable body hash.`);
  if (study.source?.sample_size_kind && study.source.sample_size_kind !== 'reported_lower_bound') errors.push('Per-source pull-rate sample semantics may not override the reviewed lower-bound policy.');
}

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

const forecastExecution = await readFile(resolve(
  root, 'supabase/migrations/0018_forecast_execution_and_scorecards.sql'
), 'utf8');
for (const contract of [
  'prospective_complete_cost_fields_present_check',
  'create table public.forecast_executor_keys',
  'create table public.prospective_scorecard_plans',
  'create table public.forecast_execution_challenges',
  'create table public.forecast_execution_receipts',
  'canonical_prospective_candidate_output_hash',
  'record_challenged_prospective_forecast_run',
  'create_prospective_model_scorecard',
  'originClusteredBaselineLiftLower95',
  'hmac_executor_principal_v1',
  'artifactExecutionVerified',
  'Forecast Engine v1 unconditional public-promotion block must remain intact'
]) {
  if (!forecastExecution.includes(contract)) errors.push(`Forecast execution migration missing safety contract ${contract}.`);
}
if (/update\s+public\.product_feature_flags/i.test(forecastExecution)) errors.push('Forecast execution migration must not mutate public feature flags.');
if (/create or replace function public\.publish_forecast_intelligence/i.test(forecastExecution)) errors.push('Forecast execution migration must not add a public publisher.');

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
for (const reference of ['/manifest.webmanifest', '/runtime-config.js', '/assets/css/app.css', '/assets/js/app.js']) if (!index.includes(reference)) errors.push(`index.html does not reference ${reference}`);
for (const destination of ['home', 'discover', 'scan', 'collection', 'insights']) if (!index.includes(`data-nav="${destination}"`)) errors.push(`index.html is missing ${destination} navigation.`);
for (const action of ['search', 'settings']) if (!index.includes(`data-shell-action="${action}"`)) errors.push(`index.html is missing the supported ${action} shell control.`);
for (const unsupported of ['notifications', 'switch-portfolio']) if (index.includes(`data-shell-action="${unsupported}"`)) errors.push(`index.html must not expose unsupported ${unsupported} shell controls.`);

const application = await readFile(resolve(app, 'assets/js/app.js'), 'utf8');
if (!application.includes("serviceWorker.register('/sw.js')")) errors.push('Service-worker registration must remain root-relative for deep links.');
const runtimeConfig = await readFile(resolve(app, 'runtime-config.js'), 'utf8');
const buildScript = await readFile(resolve(root, 'scripts/build.mjs'), 'utf8');
if (!runtimeConfig.includes("APP_VERSION: '0.8.26-dev'")) errors.push('Local runtime config must identify the 0.8.26 development build.');
if (!buildScript.includes("process.env.APP_VERSION || '0.8.26'")) errors.push('Production builds must default APP_VERSION to 0.8.26.');
if (!runtimeConfig.includes("TCGCSV_REFRESH_STATUS_URL: ''") || !buildScript.includes("process.env.TCGCSV_REFRESH_STATUS_URL || ''")) {
  errors.push('TCGCSV refresh status URL must remain an explicit, fail-closed runtime setting.');
}
if (!runtimeConfig.includes("TCGCSV_CATALOG_URL: ''") || !buildScript.includes("process.env.TCGCSV_CATALOG_URL || ''")) {
  errors.push('TCGCSV catalog URL must remain an explicit, fail-closed runtime setting.');
}

const ordinaryUiFiles = [
  resolve(app, 'index.html'), resolve(app, 'assets/js/app.js'),
  resolve(app, 'assets/js/core/components.js'), resolve(app, 'assets/js/core/view-models.js'),
  resolve(app, 'assets/js/core/settings.js'),
  ...(await filesUnder(resolve(app, 'assets/js/views'))).filter((path) => extname(path) === '.js')
];
const forbiddenUiTerms = [
  ['Supabase', /\bsupabase\b/i], ['public key', /\bpublic\s+key\b/i],
  ['Tier 0', /\btier\s*0\b/i], ['canonical', /\bcanonical\b/i],
  ['provider price', /\bprovider\s+price\b/i], ['Demand analytics', /\bdemand\s+analytics\b/i],
  ['Local mode', /\blocal\s+mode\b/i]
];
for (const file of ordinaryUiFiles) {
  const source = (await readFile(file, 'utf8'))
    .replace(/(?:from\s+|import\s*\()\s*(['"])[^'"]+\1/g, '');
  for (const [term, pattern] of forbiddenUiTerms) {
    if (pattern.test(source)) errors.push(`Ordinary UI source contains backend terminology ${term}: ${relative(root, file)}`);
  }
}

const stylesheet = await readFile(resolve(app, 'assets/css/app.css'), 'utf8');
const semanticTokens = [
  'canvas', 'workspace', 'surface', 'interactive', 'selected', 'border', 'border-strong',
  'text-primary', 'text-secondary', 'text-muted', 'action', 'action-hover', 'action-ink',
  'positive', 'negative', 'forecast', 'warning', 'warning-ink', 'error', 'focus'
];
for (const token of semanticTokens) if (!stylesheet.includes(`--color-${token}:`)) errors.push(`Design system is missing semantic token --color-${token}.`);
for (const token of ['space-1', 'space-2', 'space-3', 'space-4', 'space-6', 'space-8', 'space-12', 'radius-control', 'radius-panel', 'radius-dialog']) {
  if (!stylesheet.includes(`--${token}:`)) errors.push(`Design system is missing layout token --${token}.`);
}
const tokenValue = (token) => stylesheet.match(new RegExp(`--color-${token}:\\s*([^;]+);`))?.[1].trim();
if (tokenValue('action') === tokenValue('positive')) errors.push('Primary action and positive movement must use distinct token values.');
if (!stylesheet.includes('.positive { color: var(--positive); }')) errors.push('Positive movement must consume the positive semantic token.');
if (!stylesheet.includes('.negative { color: var(--color-negative); }')) errors.push('Negative movement must consume the negative semantic token.');
if ((stylesheet.match(/--color-warning-ink:\s*[^;]+;/g) || []).length < 3) errors.push('Warning ink must be defined for dark, light, and system-light themes.');
if (!stylesheet.includes('--warning-ink: var(--color-warning-ink);')) errors.push('Warning ink must expose the shared semantic alias.');
const warningStatusRule = stylesheet.match(/\.account-status-card\[data-account-status="pending"\]\s+\.account-status-icon,\s*\.account-status-card\[data-account-status="syncing"\]\s+\.account-status-icon\s*\{([^}]*)\}/)?.[1];
if (!warningStatusRule?.includes('color: var(--warning-ink);')) errors.push('Pending and syncing account status must consume the warning-ink semantic token.');
for (const match of stylesheet.matchAll(/\.account-status-card\[data-account-status="([^"]+)"\][^{]*\{([^}]*)\}/g)) {
  if (/#[0-9a-f]{3,8}\b/i.test(match[2])) errors.push(`Account status ${match[1]} must not use a hard-coded color.`);
}

const foundationDoc = await readFile(resolve(root, 'docs/REDESIGN_FOUNDATION.md'), 'utf8');
for (const contract of ['Supported route map', 'Normalized view-model contracts', 'Semantic token reference', 'Component inventory', 'Deferred capabilities']) {
  if (!foundationDoc.includes(contract)) errors.push(`Redesign foundation documentation is missing ${contract}.`);
}
const verticalSliceDoc = await readFile(resolve(root, 'docs/REDESIGN_CORE_VERTICAL_SLICE.md'), 'utf8');
for (const contract of ['Completed slice', 'Overview contract', 'Discover and inspector contract', 'Portfolio and detail contract', 'Compatibility and safety', 'Deferred capabilities']) {
  if (!verticalSliceDoc.includes(contract)) errors.push(`Core vertical-slice documentation is missing ${contract}.`);
}
const intakeManagementDoc = await readFile(resolve(root, 'docs/REDESIGN_INTAKE_COLLECTION_MANAGEMENT.md'), 'utf8');
for (const contract of ['Completed tranche', 'Unified intake and review contract', 'Acquisition and submission contract', 'Watchlist contract', 'Collection management and portability', 'Compatibility and safety', 'Deferred capabilities']) {
  if (!intakeManagementDoc.includes(contract)) errors.push(`Intake and collection-management documentation is missing ${contract}.`);
}
const forecastingInsightsDoc = await readFile(resolve(root, 'docs/REDESIGN_FORECASTING_INSIGHTS.md'), 'utf8');
for (const contract of ['Completed tranche', 'Performance contract', 'Forecast summary and availability contract', 'Forecast Ribbon and explanation contract', 'Immutable history and Track Record contract', 'Alerts contract', 'Compatibility and safety', 'Deferred capabilities']) {
  if (!forecastingInsightsDoc.includes(contract)) errors.push(`Forecasting and Insights documentation is missing ${contract}.`);
}
const accountSyncReleaseDoc = await readFile(resolve(root, 'docs/REDESIGN_ACCOUNT_SYNC_RELEASE.md'), 'utf8');
for (const contract of ['Completed tranche', 'Settings and synchronization contract', 'Onboarding contract', 'Data portability and deletion contract', 'Migration and compatibility', 'Performance, motion, and accessibility acceptance', 'Release procedure', 'Rollback plan', 'Qualification receipt', 'Deferred hosted work']) {
  if (!accountSyncReleaseDoc.includes(contract)) errors.push(`Account, sync, and release documentation is missing ${contract}.`);
}
const finalAcceptanceDoc = await readFile(resolve(root, 'docs/REDESIGN_FINAL_ACCEPTANCE.md'), 'utf8');
for (const contract of ['Repository-qualified candidate', 'Global Definition of Done evidence', 'Open product decision dispositions', 'Final release acceptance matrix', 'Production promotion blockers', 'Qualification receipt']) {
  if (!finalAcceptanceDoc.includes(contract)) errors.push(`Final acceptance documentation is missing ${contract}.`);
}
for (const decision of ['Watchlist stays inside Portfolio', 'Add remains hybrid', 'Single portfolio only', 'Tier 4+', 'Tier 5 scorecard', 'Fair value remains optional', 'Sold remains deferred', 'Custom items cannot receive manual forecasts', 'Card Aura remains deferred']) {
  if (!finalAcceptanceDoc.includes(decision)) errors.push(`Final acceptance documentation is missing product disposition ${decision}.`);
}
for (const disposition of [
  "release owner's authorization to promote the safe",
  'immutable candidate `6a7bf73c1c0748c0e87115bf`',
  '`ENABLE_CLOUD_DATA_REMOVAL=false`',
  'Migration 0015 remains unapplied'
]) {
  if (!finalAcceptanceDoc.includes(disposition)) errors.push(`Final acceptance documentation is missing release disposition ${disposition}.`);
}
const implementationPlan = await readFile(resolve(root, 'docs/IMPLEMENTATION_PLAN.md'), 'utf8');
for (const contract of ['Redesign account, sync, polish, and release qualification', '126 required files', '206 Node tests', '194 Python analytics tests', '13 Chromium tests', 'Service-worker shell v0.7.0']) {
  if (!implementationPlan.includes(contract)) errors.push(`Phase 5 qualification receipt is missing ${contract}.`);
}
for (const contract of ['Redesign final acceptance disposition', '127 required files', 'Repository-qualified candidate', 'docs/REDESIGN_FINAL_ACCEPTANCE.md']) {
  if (!implementationPlan.includes(contract)) errors.push(`Final acceptance implementation-plan receipt is missing ${contract}.`);
}
const readme = await readFile(resolve(root, 'README.md'), 'utf8');
if (!readme.includes('[docs/REDESIGN_FINAL_ACCEPTANCE.md](docs/REDESIGN_FINAL_ACCEPTANCE.md)')) errors.push('README must link the final acceptance receipt.');

const settingsModule = await readFile(resolve(app, 'assets/js/core/settings.js'), 'utf8');
for (const contract of ['SETTINGS_SCHEMA_VERSION = 1', 'migrateSettingsRecords', 'pendingSyncChanges', 'appendSyncHistory', 'syncDiagnosticReference', 'friendlyCloudError', 'formatStorageBytes']) {
  if (!settingsModule.includes(contract)) errors.push(`Phase 5 settings module is missing ${contract}.`);
}
if (!application.includes("await persistSettings({ currency, onboardingStep: 'add' }")) errors.push('Onboarding currency submission must await durable settings persistence.');
if (!runtimeConfig.includes('ENABLE_WATCHLISTS: true') || !runtimeConfig.includes('ENABLE_SET_BROWSING: true') || !runtimeConfig.includes('ENABLE_PRICE_INTELLIGENCE: false') || !runtimeConfig.includes('ENABLE_CLOUD_DATA_REMOVAL: false')) {
  errors.push('Runtime defaults must keep Watchlist independent and unqualified hosted capabilities fail-closed.');
}
if (!buildScript.includes("ENABLE_WATCHLISTS ?? 'true'") || !buildScript.includes("ENABLE_SET_BROWSING ?? 'true'") || !buildScript.includes("ENABLE_PRICE_INTELLIGENCE ?? 'false'") || !buildScript.includes("ENABLE_CLOUD_DATA_REMOVAL ?? 'false'")) {
  errors.push('Build-time feature defaults must keep Watchlist independent and unqualified hosted capabilities fail-closed.');
}
const database = await readFile(resolve(app, 'assets/js/core/db.js'), 'utf8');
for (const contract of ['export function validateBackup', 'const plan = validateBackup(backup)', "db.transaction(plan.map(([name]) => name), 'readwrite')"]) {
  if (!database.includes(contract)) errors.push(`Portable-backup import is missing atomic preflight contract ${contract}.`);
}

const serviceWorker = await readFile(resolve(app, 'sw.js'), 'utf8');
if (!serviceWorker.includes("const CACHE = 'collectfolio-shell-v0.8.26'")) errors.push('Service worker cache name must be collectfolio-shell-v0.8.26.');
if (!serviceWorker.includes('Promise.allSettled') && !(await readFile(resolve(app, 'assets/js/services/catalog.js'), 'utf8')).includes('Promise.allSettled')) errors.push('Catalog provider fan-out must use Promise.allSettled.');
for (const file of appFiles) {
  const name = `./${relative(app, file).replaceAll('\\', '/')}`;
  if (file === resolve(app, 'sw.js')) continue;
  if (name.startsWith('./assets/data/visual-index/') && !name.endsWith('/manifest.json')) continue;
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

const forecastEngineMigration = await readFile(resolve(root, 'supabase/migrations/0016_forecast_engine_v1.sql'), 'utf8');
for (const table of ['market_series', 'forecast_evaluation_observations']) {
  if (!forecastEngineMigration.includes(`create table public.${table}`)) errors.push(`Forecast Engine v1 migration missing ${table}.`);
  if (!forecastEngineMigration.includes(`alter table public.${table} enable row level security`)) errors.push(`Forecast Engine v1 migration missing RLS for ${table}.`);
}
for (const contract of [
  'validate_market_series_lineage', 'validate_forecast_prediction_series',
  'validate_forecast_evaluation_observation', 'record_scored_forecast_evaluation',
  'Prediction and evaluation evidence modes differ',
  'Retrospective evidence cannot authorize model promotion',
  'Realized outcome fields are derived by the database, not supplied by callers',
  "to_regprocedure('public.publish_forecast_intelligence(uuid)') is not null"
]) {
  if (!forecastEngineMigration.includes(contract)) errors.push(`Forecast Engine v1 migration missing security contract ${contract}.`);
}
if (/update\s+public\.product_feature_flags/i.test(forecastEngineMigration)) errors.push('Forecast Engine v1 migration must not mutate public feature flags.');
if (/create or replace function public\.publish_forecast_intelligence/i.test(forecastEngineMigration)) errors.push('Forecast Engine v1 must not install a public forecast publisher.');

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

const pullRateMissingMigration = await readFile(resolve(root, 'supabase/migrations/0014_pull_rate_unavailability_registry.sql'), 'utf8');
for (const contract of [
  'create table public.pull_rate_unavailability',
  'pull_rate_unavailability_append_only',
  'alter table public.pull_rate_unavailability enable row level security',
  'revoke all on public.pull_rate_unavailability from anon, authenticated',
  'grant select, insert on public.pull_rate_unavailability to service_role',
  'revoke update, delete on public.pull_rate_unavailability from service_role'
]) {
  if (!pullRateMissingMigration.includes(contract)) errors.push(`Pull-rate missing-data migration lacks contract ${contract}.`);
}

const cloudRemovalMigration = await readFile(resolve(root, 'supabase/migrations/0015_remove_my_cloud_data.sql'), 'utf8');
for (const contract of [
  'Intentionally checked in but not applied',
  'create or replace function public.remove_my_cloud_data()',
  'security definer', 'current_user_id uuid := auth.uid()',
  'revoke all on function public.remove_my_cloud_data() from public, anon, authenticated, service_role',
  'grant execute on function public.remove_my_cloud_data() to authenticated'
]) {
  if (!cloudRemovalMigration.includes(contract)) errors.push(`Cloud-data removal migration lacks contract ${contract}.`);
}
for (const table of ['holdings', 'holding_deletions', 'portfolio_snapshots', 'scan_sessions', 'watchlists', 'watchlist_items', 'watchlist_deletions', 'demand_events']) {
  if (!cloudRemovalMigration.includes(`delete from public.${table} where user_id = current_user_id`)) errors.push(`Cloud-data removal migration must scope ${table} deletion to auth.uid().`);
}
if (/delete\s+from\s+(?:auth\.users|public\.profiles)/i.test(cloudRemovalMigration)) errors.push('Cloud-data removal must retain the authentication account and profile.');
if (!/^begin;/m.test(cloudRemovalMigration) || !/commit;\s*$/.test(cloudRemovalMigration)) errors.push('Cloud-data removal migration must install its RPC transactionally.');

const netlify = await readFile(resolve(root, 'netlify.toml'), 'utf8');
for (const text of ['command = "npm run build"', 'publish = "dist"', 'NODE_VERSION = "22"', 'to = "/index.html"', 'for = "/sw.js"']) if (!netlify.includes(text)) errors.push(`netlify.toml missing ${text}`);
if (netlify.includes("'unsafe-eval'")) errors.push('Content Security Policy must not allow unsafe-eval.');
if (!netlify.includes("'wasm-unsafe-eval'")) errors.push('Content Security Policy must allow WebAssembly compilation for configured OCR.');
for (const host of ['https://images.pokemontcg.io', 'https://images.scrydex.com', 'https://assets.tcgdex.net', 'https://cards.scryfall.io', 'https://svgs.scryfall.io', 'https://images.ygoprodeck.com', 'https://tcgplayer-cdn.tcgplayer.com']) {
  if (netlify.split(host).length < 3) errors.push(`Content Security Policy must allow ${host} for both provider images and service-worker fetches.`);
}
if (!netlify.includes('https://collectfolio-tcgcsv-refresh.kevinyang331.workers.dev')) {
  errors.push('Content Security Policy must allow the public TCGCSV refresh-status Worker.');
}

if (errors.length) {
  console.error(`Validation failed:\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(`Validation passed: ${required.length} required files, ${javascript.length} browser modules, one pinned server-only package, and four pinned development packages.`);
