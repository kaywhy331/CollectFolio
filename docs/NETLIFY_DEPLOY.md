# Netlify and Supabase Deployment

## 1. Apply the Supabase schema

1. Open the Supabase project `agmjgyyvhfcivbwdlvzk`.
2. Open **SQL Editor**.
3. Paste and run `supabase/migrations/0001_initial.sql`.
4. Confirm these tables exist under `public`:
   - `profiles`
   - `holdings`
   - `holding_deletions`
   - `portfolio_snapshots`
   - `scan_sessions`
5. Confirm Row Level Security is enabled on all five tables.

### Existing-project account-key migration

For an existing deployment, back up the database and deploy application `0.8.27` or later
before applying `supabase/migrations/0021_account_owned_sync_keys.sql`. The new client
tries `(user_id,id)` first and recognizes only PostgreSQL `42P10` as the temporary
pre-migration fallback. Apply 0021 during a short maintenance window because it takes
an exclusive lock on `holdings` and `scan_sessions`; it retains every row, replaces
both primary keys with `(user_id, id)`, and adds non-unique ID diagnostic indexes.
Refresh installed clients after the migration. Older cached clients will fail their
legacy ID-only upsert after 0021, retain local writes, and must be refreshed; they do
not receive a permissive compatibility path.

## 2. Obtain the public browser key

In Supabase, open **Project Settings → API Keys** and copy the publishable key (or legacy anon public key). Do not use the service-role/secret key.

## 3. Create the Netlify project

1. In Netlify, choose **Add new project → Import an existing project**.
2. Select GitHub and repository `kaywhy331/CollectFolio`.
3. Netlify should read `netlify.toml` automatically:
   - Build command: `npm run build`
   - Publish directory: `dist`
4. Add environment variables:

```text
SUPABASE_URL=https://agmjgyyvhfcivbwdlvzk.supabase.co
SUPABASE_ANON_KEY=<your Supabase publishable/anon key>
APP_VERSION=0.8.31
ENABLE_TESSERACT=true
ENABLE_WATCHLISTS=true
ENABLE_SET_BROWSING=true
TCGCSV_REFRESH_STATUS_URL=https://collectfolio-tcgcsv-refresh.kevinyang331.workers.dev/status
TCGCSV_CATALOG_URL=https://collectfolio-tcgcsv-refresh.kevinyang331.workers.dev
COLLECTCAPTURE_API_URL=
ENABLE_COLLECTCAPTURE=false
ENABLE_LOCAL_SCAN_ROLLBACK=false
JUSTTCG_API_KEY=<server-only JustTCG key>
```

`JUSTTCG_API_KEY` is consumed only by the scheduled server function and must never be added to a public runtime variable. With only that variable present, the collector expects the Free plan and stages all priced games. Optional server-only controls are `JUSTTCG_GAME=pokemon`, `JUSTTCG_EXPECTED_PLAN=Free`, and `JUSTTCG_COLLECTION_ID=catalog-v1`. Changing the collection ID starts a separate cursor and must not be done until the provider quota cycle and intended scope have been checked.

`TCGCSV_CATALOG_URL` enables the signed-in personal integration-test catalog.
The Worker must hold `SUPABASE_ANON_KEY` as a secret and validate each bearer
session; never configure a public R2 domain or place the coordinator token in
Netlify's browser runtime.

### CollectCapture recognition activation

Card recognition is deliberately disabled in the example above until a reviewed CollectCapture API has a stable HTTPS origin. To activate it:

1. Configure and deploy the CollectCapture `/v1/card-lookups` endpoint for this exact CollectFolio origin and Supabase issuer.
2. Add the exact CollectCapture origin to the `connect-src` directive in `netlify.toml`; do not use a wildcard or a broad `https:` allowance.
3. Set GitHub Actions repository variables `COLLECTCAPTURE_API_URL`, `ENABLE_COLLECTCAPTURE=true`, and `ENABLE_LOCAL_SCAN_ROLLBACK=false`. The production workflow reads these variables while building `runtime-config.js`.
4. Deploy and complete the signed-in crop-only, invalid-token, non-retention, selection, confirmation, failure, and log/persistence checks in [COLLECTCAPTURE_CARD_LOOKUP.md](COLLECTCAPTURE_CARD_LOOKUP.md).

If the service is unavailable, set `ENABLE_COLLECTCAPTURE=false` and redeploy. Keep `ENABLE_LOCAL_SCAN_ROLLBACK=false` for fail-closed operation; turn it on only as a separately approved, visibly disclosed emergency rollback. CollectCapture and CollectFolio keep separate Supabase schemas, so no CollectCapture database migration is applied here.

5. Deploy the site.

## 4. Configure Supabase Auth URLs

After Netlify assigns a URL:

1. Open **Supabase → Authentication → URL Configuration**.
2. Set **Site URL** to the production Netlify URL.
3. Add the production URL and deploy-preview pattern to allowed redirect URLs as appropriate.
4. Keep email/password enabled. Magic-link behavior depends on the configured email provider and redirect URLs.

## 5. Validation

- Open the Netlify URL in a private window.
- Confirm guest mode loads before signing in.
- Add a custom item and reload.
- Create an account and confirm the email flow if confirmation is enabled.
- Select **Profile → Sync now**.
- In Supabase Table Editor, confirm the holding row includes the authenticated user ID.
- Confirm another account cannot read that row.
- In the original browser collection, sign out and sign into a different account; confirm sync refuses the account switch and keeps local data intact.
- In a fresh private browser profile, confirm the second account can sync normally and still cannot read the first account's rows.
- Confirm `holdings_pkey` and `scan_sessions_pkey` are `(user_id, id)` after applying migration 0021.
- When CollectCapture is enabled, confirm the generated runtime URL matches the CSP's exact `connect-src` origin, an expired CollectFolio token is rejected, and one selected crop can be suggested but not added before explicit printing confirmation.
- Delete the holding on one signed-in browser, sync, then sync a second browser and confirm it remains deleted.
- Install the PWA and launch it from the home screen.
- On a published deploy, open **Functions → justtcg-catalog** and confirm it has a Scheduled badge with a five-minute UTC schedule.
- Confirm the `collectfolio-justtcg-private` Blob store contains a query-scoped `state.json` and immutable offset page after the first successful run. Logs may show offsets/counts only; they must not contain the API key or response bodies.
- Confirm the state stops outbound calls at 100 attempts in one UTC day and resumes after 00:00 UTC. Do not manually change `nextOffset` or delete only the state blob; crash recovery depends on the state/page pair.

## 6. Release discipline

When any file under `app/` changes, update the cache name in `app/sw.js` before a production release, for example:

```js
const CACHE = 'collectfolio-shell-v0.8.31';
```

This ensures installed PWAs replace the prior shell reliably.
