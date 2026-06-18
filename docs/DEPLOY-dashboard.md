# Deploying the admin dashboard to `george.uscbia.com`

The admin dashboard (`scripts/dashboard-server.ts`) is a **standalone** Express
server that reads Supabase directly — no agent stack, no LLM. It can be deployed
independently of the george backend and pointed at its own subdomain.

> ⛔ **Security gate — non-negotiable.** This dashboard exposes student PII
> (what users asked, full conversations on drill-down). It is gated only by a
> shared `ADMIN_TOKEN`. **Do NOT put it on a public domain without a real
> identity layer in front.** With `uscbia.com` on Cloudflare, use **Cloudflare
> Access** (email allowlist / SSO) so only named admins can even load the page;
> the `ADMIN_TOKEN` then becomes a second factor. Step 3 below is required, not
> optional.

## What it needs

| Env var | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | ✅ | same project the backend uses |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | server-side only; never exposed to the browser |
| `ADMIN_TOKEN` | ✅ | the dashboard login token |
| `PORT` | — | injected by the platform; falls back to 3009 |

It does **not** need `ANTHROPIC_API_KEY` or any LLM keys (decoupled on purpose).

## ⚠️ One caveat: per-user controls are file-backed

Model / daily-limit / block settings are stored in `data/user-controls.json` on
the local filesystem. **Container filesystems are ephemeral** — these settings
reset on every redeploy/restart. The read-only monitoring (today's data, live
feed, user views) is fully fine (it reads Supabase). To make controls survive:

- **Quick fix:** attach a persistent volume mounted at `/app/data` (Railway
  Volumes, Fly volumes), or
- **Proper fix (recommended for cloud):** move controls to a Postgres
  `user_controls` table (a small follow-up — the file store was a single-host
  choice).

---

## Path A — Railway (simplest)

1. railway.app → your project → **New Service → Deploy from GitHub repo** →
   `BIBOYANG425/george`, branch `feat/admin-dashboard` (or `main` once merged).
2. Service → Settings → **Build**: set **Dockerfile Path** = `Dockerfile.dashboard`.
3. Variables → set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_TOKEN`.
   Do **not** set `PORT` (Railway injects it).
4. (Optional, for persistent controls) Settings → **Volumes** → mount at `/app/data`.
5. Settings → Networking → **Generate Domain** → note the `*.up.railway.app` URL,
   confirm `https://<url>/health` is green.

## Path B — Cloudflare Container (keeps everything on Cloudflare)

Build the same `Dockerfile.dashboard` and deploy as a Container; expose it
through a Worker. Reuse the account that holds the Container quota (see
`HANDOFF.md`). Env vars identical to Path A. This is heavier than Railway but
keeps the dashboard in the same place as the planned backend Container.

---

## Wire up `george.uscbia.com` (DNS is on Cloudflare)

1. **DNS** → Cloudflare dashboard → `uscbia.com` → DNS → **Add record**:
   - Railway: `CNAME  george  →  <your>.up.railway.app` (Proxied 🟠).
   - Container/Tunnel: `cloudflared tunnel route dns <tunnel> george.uscbia.com`.
2. If Railway, also add `george.uscbia.com` as a **Custom Domain** on the
   Railway service so its router accepts the host.

## Step 3 (REQUIRED) — lock it behind Cloudflare Access

Cloudflare **Zero Trust** → **Access → Applications → Add an application →
Self-hosted**:

- Application domain: `george.uscbia.com`
- Session duration: e.g. 24h
- **Policy**: Action = *Allow*; Include = *Emails* (you + teammates) or
  *Emails ending in* `@uscbia.com`, or your Google Workspace.

Now only authenticated admins can reach the page at all. The `ADMIN_TOKEN`
login remains as the second layer. Verify in an incognito window: you should hit
the Cloudflare Access login before ever seeing the dashboard.

## Verify

```
https://george.uscbia.com/health           # → {"ok":true,...} (after Access auth)
https://george.uscbia.com/admin/dashboard   # → login, paste ADMIN_TOKEN
```
