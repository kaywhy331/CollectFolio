# CollectCapture card lookup

## Product boundary

CollectFolio owns capture and approval. CollectCapture is the authenticated card-recognition server.

```text
camera or file
  -> browser-only source image and editable boundaries
  -> straightened, metadata-free crop
  -> CollectCapture recognition and TCGCSV lookup
  -> unselected lookup suggestions
  -> collector selects and confirms one catalog printing
```

The server result is evidence for review, not an approval. CollectFolio never automatically selects a suggestion, never labels a server suggestion as exact, and never adds it to the collection until the collector separately selects and confirms a catalog printing. A custom holding remains available when no supported catalog identity is appropriate.

The previous browser OCR, visual-index, and public-provider search pipeline remains in the repository as an explicit rollback. It is not a silent fallback when CollectCapture fails.

## Data and privacy contract

- The selected full source photo is decoded into one bounded browser working image. It is neither persisted nor sent to CollectCapture. The working image may remain only in memory for boundary re-editing during the open review and is released on navigation, explicit release, discard, completion, or page exit.
- Canvas creates at most 900 px-wide JPEG crops. Re-encoding through Canvas removes source-file metadata, including EXIF, before any network request.
- Active scan drafts retain their compressed crops in local IndexedDB so they can be resumed and so a confirmed crop can become the collector's holding image.
- Remote lookup sends only the selected crop, an optional collector-entered query, category hint, result limit, and the collector's CollectFolio Supabase bearer token.
- The browser request uses HTTPS outside localhost, `credentials: omit`, `referrerPolicy: no-referrer`, and `cache: no-store`. Requests time out after 30 seconds.
- CollectCapture verifies the crop's declared and actual media type, enforces a 2 MiB decoded-image limit, and computes a SHA-256 digest. CollectFolio independently hashes the crop and rejects a response whose digest does not match. The endpoint does not write the crop to its database, object storage, cache, or application logs and returns `imageRetained: false`.
- For image recognition, CollectCapture sends the crop to its configured OpenAI model with Responses API storage disabled (`store: false`). OpenAI provider handling is still governed by the account's configured data controls and applicable abuse-monitoring retention; CollectFolio must not describe that provider processing as zero retention. See [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data#default-usage-policies-by-endpoint).
- A collector-entered retry query bypasses image recognition, but the request still uses the authenticated CollectCapture/catalog path.
- The response contains identity suggestions only. Prices are deliberately absent, and only an exact TCGCSV `(categoryId, groupId, productId)` tuple selected by the collector can satisfy CollectFolio's catalog-identity approval gate.

Do not add request-body logging, body capture in error telemetry, or an image persistence layer to `/v1/card-lookups`. Any such change requires a new privacy review and updated in-product disclosure before deployment.

## Authentication and trust boundaries

CollectFolio and CollectCapture may use different Supabase projects. The lookup endpoint therefore uses a dedicated CollectFolio JWKS verifier; it never falls back to CollectCapture's normal application token verifier. CollectCapture forwards the same signed-in bearer token to CollectFolio's private TCGCSV catalog so that catalog authorization remains account-bound. Authorization headers and request bodies are redacted from API logs.

CORS limits which browser origins may call the endpoint, but it is not an authentication control. The endpoint additionally requires a valid CollectFolio token and applies a 30-lookups-per-hour rate limit.

Do not apply CollectCapture's Supabase migrations to CollectFolio. The applications retain independent schemas and new-user triggers; the integration is HTTP/JWKS-based and requires no shared database migration.

## Runtime modes

| CollectCapture URL and enable flag | Local rollback flag | Behavior |
| --- | --- | --- |
| Valid and enabled | Either value | Use authenticated CollectCapture lookup |
| Missing or disabled | `true` | Use the legacy browser recognizer and show rollback disclosure |
| Missing or disabled | `false` | Identification is visibly unavailable; manual/custom collection workflows remain usable |

Production defaults fail closed. `ENABLE_LOCAL_SCAN_ROLLBACK` must remain `false` during normal operation. A CollectCapture outage produces a retryable error and cannot silently send the crop to another recognition route.

## Server configuration

Configure these variables together in the CollectCapture API environment:

```text
COLLECTFOLIO_APP_URL=https://<exact-collectfolio-origin>
COLLECTFOLIO_SUPABASE_URL=https://<collectfolio-project>.supabase.co
COLLECTFOLIO_SUPABASE_JWKS_URL=             # optional custom discovery URL
COLLECTFOLIO_CATALOG_URL=https://<private-tcgcsv-catalog-origin>
OPENAI_API_KEY=<server-only secret>
OPENAI_MODEL=<reviewed vision-capable model>
```

The origin, Supabase issuer, and catalog URL are an all-or-none group. Partial configuration fails startup; absent configuration omits the route entirely. CollectCapture's existing production requirements still apply. Never place `OPENAI_API_KEY` in CollectFolio runtime configuration.

## CollectFolio deployment

Activation requires a known deployed CollectCapture HTTPS origin. Before enabling the browser flag:

1. Deploy CollectCapture with the server configuration above and verify its health endpoint.
2. Add that exact origin to `connect-src` in `netlify.toml`. Do not broaden the policy to all HTTPS origins.
3. Set GitHub Actions repository variables:

   ```text
   COLLECTCAPTURE_API_URL=https://<exact-collectcapture-origin>
   ENABLE_COLLECTCAPTURE=true
   ENABLE_LOCAL_SCAN_ROLLBACK=false
   ```

4. Build and deploy CollectFolio, then verify the generated `runtime-config.js` and response Content Security Policy.
5. Sign in as a CollectFolio collector and complete the production qualification below.

Leaving the URL or enable variable unset keeps production lookup disabled. The repository intentionally does not guess a production API hostname, and the current static CSP must not be changed until that hostname is known.

## Qualification and rollback

Run the focused contract and browser gates before the complete repository gates:

```sh
# CollectCapture
pnpm --filter @localclear/api exec vitest run test/card-lookups.test.ts test/auth-config.test.ts --maxWorkers=1
pnpm --filter @localclear/api typecheck

# CollectFolio
node --test tests/collectcapture.test.js tests/intake-management.test.js
npx playwright test tests/e2e/image-search.spec.js --project=chromium
npm run check
```

Production qualification must confirm that only the crop is sent, the bearer belongs to the signed-in CollectFolio user, an invalid/expired token is rejected, a suggestion remains unselected, selecting and confirming a TCGCSV printing succeeds, provider failure is retryable, and no source image or request body appears in persistence or logs.

For an incident rollback, set `ENABLE_COLLECTCAPTURE=false`. Leave `ENABLE_LOCAL_SCAN_ROLLBACK=false` to fail closed, or set it to `true` only for an explicitly approved temporary return to browser recognition. Rebuild and redeploy because these are build-time runtime values. Restore normal service by setting CollectCapture enabled and local rollback disabled, then repeat production qualification.
