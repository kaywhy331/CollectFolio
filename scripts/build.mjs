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

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
await writeFile(resolve(output, 'runtime-config.js'), `window.COLLECTFOLIO_CONFIG = Object.freeze({
  SUPABASE_URL: ${string(process.env.SUPABASE_URL || 'https://agmjgyyvhfcivbwdlvzk.supabase.co')},
  SUPABASE_ANON_KEY: ${string(process.env.SUPABASE_ANON_KEY || '')},
  APP_VERSION: ${string(process.env.APP_VERSION || '0.8.23')},
  TCGCSV_REFRESH_STATUS_URL: ${string(process.env.TCGCSV_REFRESH_STATUS_URL || '')},
  TCGCSV_CATALOG_URL: ${string(process.env.TCGCSV_CATALOG_URL || '')},
  ENABLE_TESSERACT: ${enabled},
  ENABLE_WATCHLISTS: ${watchlistsEnabled},
  ENABLE_SET_BROWSING: ${setBrowsingEnabled},
  ENABLE_PRICE_INTELLIGENCE: ${priceIntelligenceEnabled},
  ENABLE_CLOUD_DATA_REMOVAL: ${cloudDataRemovalEnabled}
});\n`);
console.log(`Built CollectFolio into ${output}`);
