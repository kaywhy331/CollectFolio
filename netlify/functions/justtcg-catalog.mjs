import { getStore } from '@netlify/blobs';

import { createJustTcgBlobRepository } from '../lib/justtcg-blob-repository.mjs';
import {
  createCollectorConfig,
  runCollectorInvocation
} from '../lib/justtcg-collector.mjs';

const STORE_NAME = 'collectfolio-justtcg-private';

export default async function justTcgCatalogCollector() {
  const collectorConfig = createCollectorConfig(process.env);
  const store = getStore({ name: STORE_NAME, consistency: 'strong' });
  const repository = createJustTcgBlobRepository(store, collectorConfig);
  const result = await runCollectorInvocation({ repository, config: collectorConfig });

  // This is deliberately the only log record. It contains cursor/quota health,
  // never request headers, the API key, response bodies, or raw provider data.
  console.info('JustTCG private catalog collector', JSON.stringify({
    collectionId: collectorConfig.collectionId,
    queryHash: collectorConfig.queryHash,
    ...result
  }));
}

export const config = {
  // Keep this literal so Netlify's static function-config parser can discover it.
  schedule: '*/5 * * * *'
};
