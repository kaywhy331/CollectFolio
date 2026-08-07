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
APP_VERSION=0.1.0
ENABLE_TESSERACT=true
JUSTTCG_API_KEY=<server-only JustTCG key>
```

`JUSTTCG_API_KEY` is consumed only by the scheduled server function and must never be added to a public runtime variable. With only that variable present, the collector expects the Free plan and stages all priced games. Optional server-only controls are `JUSTTCG_GAME=pokemon`, `JUSTTCG_EXPECTED_PLAN=Free`, and `JUSTTCG_COLLECTION_ID=catalog-v1`. Changing the collection ID starts a separate cursor and must not be done until the provider quota cycle and intended scope have been checked.

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
- Delete the holding on one signed-in browser, sync, then sync a second browser and confirm it remains deleted.
- Install the PWA and launch it from the home screen.
- On a published deploy, open **Functions → justtcg-catalog** and confirm it has a Scheduled badge with a five-minute UTC schedule.
- Confirm the `collectfolio-justtcg-private` Blob store contains a query-scoped `state.json` and immutable offset page after the first successful run. Logs may show offsets/counts only; they must not contain the API key or response bodies.
- Confirm the state stops outbound calls at 100 attempts in one UTC day and resumes after 00:00 UTC. Do not manually change `nextOffset` or delete only the state blob; crash recovery depends on the state/page pair.

## 6. Release discipline

When any file under `app/` changes, update the cache name in `app/sw.js` before a production release, for example:

```js
const CACHE = 'collectfolio-shell-v0.1.1';
```

This ensures installed PWAs replace the prior shell reliably.
