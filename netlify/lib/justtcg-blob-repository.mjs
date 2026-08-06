const STATE_FILE = 'state.json';

function pageFile(offset) {
  return `pages/${String(offset).padStart(8, '0')}.json`;
}

export function createJustTcgBlobRepository(store, { collectionId, queryHash }) {
  if (!store || typeof store.getWithMetadata !== 'function' || typeof store.setJSON !== 'function') {
    throw new TypeError('a Netlify Blobs store is required');
  }
  const prefix = `catalog/${collectionId}/${queryHash}`;

  return Object.freeze({
    async loadState() {
      const entry = await store.getWithMetadata(`${prefix}/${STATE_FILE}`, {
        consistency: 'strong',
        type: 'json'
      });
      return entry ? { state: entry.data, etag: entry.etag } : null;
    },

    async saveState(state, expectedEtag) {
      return store.setJSON(
        `${prefix}/${STATE_FILE}`,
        state,
        expectedEtag ? { onlyIfMatch: expectedEtag } : { onlyIfNew: true }
      );
    },

    async loadPage(offset) {
      return store.get(`${prefix}/${pageFile(offset)}`, { consistency: 'strong', type: 'json' });
    },

    async savePage(page) {
      return store.setJSON(`${prefix}/${pageFile(page.requestedOffset)}`, page, { onlyIfNew: true });
    }
  });
}
