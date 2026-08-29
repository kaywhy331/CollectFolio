import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'app');
const output = resolve(root, 'dist');
const string = (value) => JSON.stringify(String(value));
const enabled = !/^(0|false|no)$/i.test(process.env.ENABLE_TESSERACT ?? 'true');
const watchlistsEnabled = !/^(0|false|no)$/i.test(process.env.ENABLE_WATCHLISTS ?? 'true');
const setBrowsingEnabled = !/^(0|false|no)$/i.test(process.env.ENABLE_SET_BROWSING ?? 'true');
const priceIntelligenceEnabled = /^(1|true|yes)$/i.test(process.env.ENABLE_PRICE_INTELLIGENCE ?? 'false');
const cloudDataRemovalEnabled = /^(1|true|yes)$/i.test(process.env.ENABLE_CLOUD_DATA_REMOVAL ?? 'false');
const collectCaptureApiUrl = String(process.env.COLLECTCAPTURE_API_URL || '').trim();
const collectCaptureEnabled = /^(1|true|yes)$/i.test(
  process.env.ENABLE_COLLECTCAPTURE ?? (collectCaptureApiUrl ? 'true' : 'false')
);
const localScanRollbackEnabled = /^(1|true|yes)$/i.test(process.env.ENABLE_LOCAL_SCAN_ROLLBACK ?? 'false');
if (collectCaptureEnabled && !collectCaptureApiUrl) {
  throw new Error('ENABLE_COLLECTCAPTURE requires COLLECTCAPTURE_API_URL.');
}
if (collectCaptureEnabled) {
  let endpoint;
  try {
    endpoint = new URL(collectCaptureApiUrl);
  } catch {
    throw new Error('COLLECTCAPTURE_API_URL must be a valid URL.');
  }
  if (endpoint.protocol !== 'https:') {
    throw new Error('The production CollectCapture API URL must use HTTPS.');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('COLLECTCAPTURE_API_URL must not contain credentials, a query, or a fragment.');
  }
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
await writeFile(resolve(output, 'runtime-config.js'), `window.COLLECTFOLIO_CONFIG = Object.freeze({
  SUPABASE_URL: ${string(process.env.SUPABASE_URL || 'https://agmjgyyvhfcivbwdlvzk.supabase.co')},
  SUPABASE_ANON_KEY: ${string(process.env.SUPABASE_ANON_KEY || '')},
  APP_VERSION: ${string(process.env.APP_VERSION || '0.8.37')},
  TCGCSV_REFRESH_STATUS_URL: ${string(process.env.TCGCSV_REFRESH_STATUS_URL || '')},
  TCGCSV_CATALOG_URL: ${string(process.env.TCGCSV_CATALOG_URL || '')},
  COLLECTCAPTURE_API_URL: ${string(collectCaptureApiUrl)},
  ENABLE_COLLECTCAPTURE: ${collectCaptureEnabled},
  ENABLE_LOCAL_SCAN_ROLLBACK: ${localScanRollbackEnabled},
  ENABLE_TESSERACT: ${enabled},
  ENABLE_WATCHLISTS: ${watchlistsEnabled},
  ENABLE_SET_BROWSING: ${setBrowsingEnabled},
  ENABLE_PRICE_INTELLIGENCE: ${priceIntelligenceEnabled},
  ENABLE_CLOUD_DATA_REMOVAL: ${cloudDataRemovalEnabled}
});\n`);
console.log(`Built CollectFolio into ${output}`);
