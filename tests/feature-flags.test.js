import test from 'node:test';
import assert from 'node:assert/strict';
import { getState } from '../app/assets/js/core/store.js';

// forecast-display-everywhere: trajectory-v1 forecasts are CollectFolio's
// own derived statistics under the community-free-access SourceTerms
// record, served anonymously by our own worker -- deliberately decoupled
// from the Supabase publicPriceIntelligence rights gate (which stays
// default-disabled). trajectoryForecasts must default enabled, and only a
// remote product_feature_flags row explicitly setting it false may turn it
// off (see app.js's loadFeatureFlags: `remote.trajectory_forecasts !== false`).
test('featureFlags default: trajectoryForecasts starts enabled, independent of publicPriceIntelligence', () => {
  const { featureFlags } = getState();
  assert.equal(featureFlags.trajectoryForecasts, true);
  assert.equal(featureFlags.publicPriceIntelligence, false);
  assert.equal(featureFlags.loaded, false);
});
