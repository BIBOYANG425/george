# Deploying george to Railway

One Railway service, built from this repo's Dockerfile (multi-stage: compiles TS
and native deps in the image — no pre-built `dist/` needed).

## Service setup

1. railway.app → New Project → Deploy from GitHub repo → `BIBOYANG425/george`.
2. Service → Settings → **Source → Branch**: `feat/squad-push-loop` during burn-in;
   switch to `main` after the Phase 2 PR merges.
3. Variables → **Raw Editor** → paste the env block (see checklist below).
4. Settings → Networking → Generate Domain → note the `*.up.railway.app` URL.
5. After `/health` is green: set `GEORGE_BACKEND_URL=<railway url>` on
   bia-roommate's Vercel project (web chat relay).

## Env checklist

Cloud overrides (always set exactly these values):

| Var | Value |
|---|---|
| `TRANSPORT` | `spectrum` |
| `IMESSAGE_ENABLED` | `false` |
| `NODE_ENV` | `production` |
| `BIA_ROOMMATE_API_URL` | `https://www.uscbia.com` |

Do **not** set `PORT` — Railway injects it and the server reads it.

Required secrets (copy values from the Mac `.env`): `ANTHROPIC_API_KEY`,
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_TOKEN`,
`SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`, `DEEPSEEK_API_KEY` (required
whenever `HEARTBEAT_ENABLED` isn't `false`), `KIMI_API_KEY`.

Optional (feature-gated): `KIMI_BASE_URL`, `GOOGLE_MAPS_API_KEY`, `APIFY_TOKEN`,
`ADMIN_TOKEN_PHONE`, `KV_NAMESPACE_ID`, `KV_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`HEARTBEAT_ENABLED`, `PROACTIVE_ENABLED`, `PROACTIVE_ROLLOUT_PCT`,
`ONBOARDING_PROFILE_URL_BASE`, `ONBOARDING_ASSET_BASE_URL`, `ONBOARDING_ENABLED`,
`GEORGE_IMESSAGE_PHONE`, `WECHAT_TOKEN`, `WECHAT_APP_ID`, `WECHAT_APP_SECRET`.

## Cutover rule (Spectrum shared pool)

The moment the Railway instance logs `spectrum_connected`, **stop any Mac
instance running `TRANSPORT=spectrum`**. Two live connections on the shared
pool cause the orphaned-routing inbound flakiness observed during the PR #7
burn-in. (A Mac instance in legacy/dev mode is fine.)

## Verify after deploy

```
curl https://<railway-url>/health   # → {"status":"ok", ...}
```
Then check the deploy logs for `spectrum_connected`.
