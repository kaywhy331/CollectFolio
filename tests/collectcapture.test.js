import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CollectCaptureLookupError,
  collectCaptureBaseUrl,
  lookupCardWithCollectCapture,
  normalizeCollectCaptureLookup
} from '../app/assets/js/services/collectcapture.js';

const imageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const imageSha256 = createHash('sha256').update(Buffer.from(imageDataUrl.split(',')[1], 'base64')).digest('hex');
const configuration = {
  ENABLE_COLLECTCAPTURE: true,
  COLLECTCAPTURE_API_URL: 'https://capture.example.test/api/'
};

function lookup(overrides = {}) {
  return {
    contentSha256: imageSha256,
    imageRetained: false,
    recognition: {
      source: 'vision',
      category: 'pokemon',
      name: 'Charizard ex',
      setName: 'Obsidian Flames',
      collectorNumber: '223/197',
      language: 'en',
      visibleText: ['Charizard ex', '223/197'],
      queries: ['Charizard ex 223/197', 'Charizard ex'],
      confidence: 0.91,
      provider: 'openai',
      model: 'gpt-5-mini'
    },
    candidates: [{
      id: 'tcgcsv:3:123:456',
      externalId: '3:123:456',
      provider: 'tcgcsv',
      category: 'tcgcsv-category-3',
      game: 'Pokemon',
      name: 'Charizard ex',
      setName: 'Obsidian Flames',
      setCode: 'OBF',
      number: '223/197',
      variant: 'Holofoil',
      rarity: 'Special Illustration Rare',
      year: '2023',
      image: 'https://images.example.test/456.jpg',
      imageSmall: 'https://images.example.test/456-small.jpg',
      price: null,
      priceOptions: [],
      currency: 'USD',
      priceSource: '',
      priceUrl: '',
      priceUpdatedAt: '',
      matchBucket: 'likely',
      matchScore: 0.99,
      categoryId: 3,
      groupId: 123,
      productId: 456
    }],
    warnings: [],
    ...overrides
  };
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

test('CollectCapture lookup forwards the bearer session and a bounded crop request', async () => {
  let request;
  const result = await lookupCardWithCollectCapture({
    imageDataUrl,
    query: '  Charizard ex 223/197  ',
    category: 'pokemon',
    limit: 100
  }, {
    configuration,
    session: { access_token: 'folio-token' },
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return jsonResponse({
        lookup: lookup({
          recognition: {
            source: 'user_query', category: 'pokemon', name: null, setName: null,
            collectorNumber: null, language: 'und', visibleText: [],
            queries: ['Charizard ex 223/197'], confidence: 1,
            provider: 'collector', model: 'manual-query'
          }
        })
      });
    }
  });

  assert.equal(request.url, 'https://capture.example.test/api/v1/card-lookups');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.cache, 'no-store');
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.init.referrerPolicy, 'no-referrer');
  assert.equal(new Headers(request.init.headers).get('authorization'), 'Bearer folio-token');
  assert.deepEqual(JSON.parse(request.init.body), {
    imageDataUrl,
    query: 'Charizard ex 223/197',
    category: 'pokemon',
    limit: 24
  });
  assert.equal(result.imageRetained, false);
  assert.deepEqual(result.candidates[0], {
    ...lookup().candidates[0],
    id: 'tcgcsv:3:123:456'
  });
});

test('CollectCapture rejects responses that do not guarantee image non-retention', () => {
  assert.throws(
    () => normalizeCollectCaptureLookup(lookup({ imageRetained: true })),
    (error) => error instanceof CollectCaptureLookupError && error.code === 'invalid_response'
  );
});

test('CollectCapture binds each successful response to the requested crop digest', async () => {
  await assert.rejects(
    lookupCardWithCollectCapture({ imageDataUrl }, {
      configuration,
      session: { access_token: 'folio-token' },
      fetchImpl: async () => jsonResponse({ lookup: lookup({ contentSha256: 'b'.repeat(64) }) })
    }),
    (error) => error instanceof CollectCaptureLookupError && error.code === 'invalid_response'
  );
});

test('CollectCapture binds a manual retry response to the normalized collector query', async () => {
  const manualRecognition = {
    source: 'user_query', category: 'pokemon', name: null, setName: null,
    collectorNumber: null, language: 'und', visibleText: [],
    queries: ['Different query'], confidence: 1,
    provider: 'collector', model: 'manual-query'
  };
  await assert.rejects(
    lookupCardWithCollectCapture({ imageDataUrl, query: 'Charizard ex' }, {
      configuration,
      session: { access_token: 'folio-token' },
      fetchImpl: async () => jsonResponse({ lookup: lookup({ recognition: manualRecognition }) })
    }),
    (error) => error instanceof CollectCaptureLookupError && error.code === 'invalid_response'
  );
});

test('CollectCapture rejects malformed catalog identities and oversized candidate lists', () => {
  const malformed = lookup();
  malformed.candidates[0] = { ...malformed.candidates[0], productId: 999 };
  assert.throws(() => normalizeCollectCaptureLookup(malformed), /invalid card lookup response/i);

  assert.throws(
    () => normalizeCollectCaptureLookup(lookup({ candidates: Array.from({ length: 25 }, () => lookup().candidates[0]) })),
    /invalid card lookup response/i
  );

  const stringId = lookup();
  stringId.candidates[0] = { ...stringId.candidates[0], productId: '456' };
  assert.throws(() => normalizeCollectCaptureLookup(stringId), /invalid card lookup response/i);

  const stringConfidence = lookup();
  stringConfidence.recognition = { ...stringConfidence.recognition, confidence: '0.91' };
  assert.throws(() => normalizeCollectCaptureLookup(stringConfidence), /invalid card lookup response/i);

  const nonStringEvidence = lookup();
  nonStringEvidence.recognition = { ...nonStringEvidence.recognition, visibleText: [42] };
  assert.throws(() => normalizeCollectCaptureLookup(nonStringEvidence), /invalid card lookup response/i);

  const pricedSuggestion = lookup();
  pricedSuggestion.candidates[0] = { ...pricedSuggestion.candidates[0], price: 999 };
  assert.throws(() => normalizeCollectCaptureLookup(pricedSuggestion), /invalid card lookup response/i);
});

test('CollectCapture rejects a response that claims a suggestion is already exact', () => {
  const autoApproved = lookup();
  autoApproved.candidates[0] = { ...autoApproved.candidates[0], matchBucket: 'exact' };
  assert.throws(() => normalizeCollectCaptureLookup(autoApproved), /invalid card lookup response/i);
});

test('CollectCapture rejects declared oversized responses before parsing JSON', async () => {
  await assert.rejects(
    lookupCardWithCollectCapture({ imageDataUrl }, {
      configuration,
      session: { access_token: 'folio-token' },
      fetchImpl: async () => jsonResponse({ lookup: lookup() }, 200, { 'content-length': String(2 * 1024 * 1024 + 1) })
    }),
    (error) => error instanceof CollectCaptureLookupError && error.code === 'response_too_large'
  );
});

test('CollectCapture stops reading an undeclared response once it exceeds the byte limit', async () => {
  let reads = 0;
  await assert.rejects(
    lookupCardWithCollectCapture({ imageDataUrl }, {
      configuration,
      session: { access_token: 'folio-token' },
      fetchImpl: async () => new Response(new ReadableStream({
        pull(controller) {
          reads += 1;
          controller.enqueue(new Uint8Array(1024 * 1024));
          if (reads === 3) controller.close();
        }
      }), { headers: { 'content-type': 'application/json' } })
    }),
    (error) => error instanceof CollectCaptureLookupError && error.code === 'response_too_large'
  );
  assert.equal(reads, 3);
});

for (const [status, code, message] of [
  [401, 'unauthorized', /sign in again/i],
  [413, 'media_too_large', /too large/i],
  [429, 'rate_limited', /lookup limit/i],
  [503, 'unavailable', /temporarily unavailable/i]
]) {
  test(`CollectCapture maps HTTP ${status} into an actionable lookup error`, async () => {
    await assert.rejects(
      lookupCardWithCollectCapture({ imageDataUrl }, {
        configuration,
        session: { access_token: 'folio-token' },
        fetchImpl: async () => jsonResponse({ error: code }, status)
      }),
      (error) => error instanceof CollectCaptureLookupError
        && error.status === status
        && error.code === code
        && message.test(error.message)
    );
  });
}

test('CollectCapture aborts a lookup that exceeds its timeout', async () => {
  await assert.rejects(
    lookupCardWithCollectCapture({ imageDataUrl }, {
      configuration,
      session: { access_token: 'folio-token' },
      timeout: 5,
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      })
    }),
    (error) => error instanceof CollectCaptureLookupError && error.code === 'timeout'
  );
});

test('CollectCapture only permits HTTPS endpoints outside local development', () => {
  assert.throws(
    () => collectCaptureBaseUrl({ ENABLE_COLLECTCAPTURE: true, COLLECTCAPTURE_API_URL: 'http://capture.example.test' }),
    /must use HTTPS/i
  );
  assert.throws(
    () => collectCaptureBaseUrl({ ENABLE_COLLECTCAPTURE: true, COLLECTCAPTURE_API_URL: 'ftp://localhost:4100' }),
    /must use HTTPS/i
  );
  assert.equal(
    collectCaptureBaseUrl({ ENABLE_COLLECTCAPTURE: true, COLLECTCAPTURE_API_URL: 'http://localhost:4100' }).href,
    'http://localhost:4100/'
  );
});

test('CollectCapture drops credential-bearing candidate images and bounds server error text', async () => {
  const candidateImages = lookup();
  candidateImages.candidates[0] = {
    ...candidateImages.candidates[0],
    image: 'https://user:secret@images.example.test/456.jpg',
    imageSmall: 'https://user:secret@images.example.test/456-small.jpg'
  };
  const normalized = normalizeCollectCaptureLookup(candidateImages);
  assert.equal(normalized.candidates[0].image, '');
  assert.equal(normalized.candidates[0].imageSmall, '');

  await assert.rejects(
    lookupCardWithCollectCapture({ imageDataUrl }, {
      configuration,
      session: { access_token: 'folio-token' },
      fetchImpl: async () => jsonResponse({ error: 'upstream_error', message: `  ${'x'.repeat(2_000)}  ` }, 502)
    }),
    (error) => error instanceof CollectCaptureLookupError
      && error.code === 'upstream_error'
      && error.message.length === 500
  );
});
