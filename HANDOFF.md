# HANDOFF — George deployment, for the teammate's AI agent

This file is written for an AI coding agent (Claude Code, Codex, Cursor, OpenClaw, or similar) operating the George backend on behalf of BIA's teammate in China. Read [README.md](README.md) and [CLAUDE.md](CLAUDE.md) before starting. The plan that authorized this work lives at the founder's machine and is not in this repo.

## What you are doing

George Tirebiter is BIA's bilingual AI companion for USC international students. It runs on three channels: iMessage (private beta), WeChat (planned), and web chat at uscbia.com/george/chat.

The founder Bobby has been running the whole stack on a Mac in California. The migration in this handoff moves the production backend to a **Cloudflare Container** that the teammate operates, plus a **Mac mini (or iPhone Shortcuts as interim)** in China for iMessage. After cutover, Bobby's Mac is decommissioned.

Your job is to drive this migration end to end and confirm production is healthy.

## Topology after migration

```
┌──── Cloudflare Container (teammate operates) ────┐
│   The full agent backend.                         │
│   IMESSAGE_ENABLED=false                          │
│   Reachable at a stable HTTPS URL.                │
│   Outbound API calls (Anthropic, Supabase, Maps)  │
│   go direct because Container runs on Cloudflare's│
│   anycast network outside the China firewall.     │
└──┬────────────────────────────────────────────────┘
   ▲                                                 ▲
   │ POST /chat (bearer ADMIN_TOKEN)                 │ POST /imessage/incoming (bearer ADMIN_TOKEN_PHONE)
   │ used by Mac mini bridge AND uscbia.com relay    │ used by iPhone Shortcuts only
   │                                                 │
┌──┴── Mac mini ──┐                       ┌──────────┴── Dedicated iPhone ──┐
│ (when bought)    │                       │ (US Apple ID, already owned)    │
│ IMESSAGE_ENABLED │                       │ Apple Shortcuts driving         │
│ =true            │                       │ Path B endpoints                │
│ BACKEND_RELAY_URL│                       │ Used until Mac mini arrives     │
│ Photon SDK       │                       └─────────────────────────────────┘
└──────────────────┘
```

uscbia.com (on Vercel, in California) keeps its existing `/api/george/chat` relay route. It just gets pointed at the Container's URL instead of Bobby's tunnel.

## Pre-flight checklist

Do these before touching code or deploying. Stop and report if any are not satisfied.

| Item | How to verify | Owner if missing |
|---|---|---|
| You can `gh auth status` and see a logged-in github.com account with read access to `BIBOYANG425/george` | `gh auth status` | Teammate (run `gh auth login` in terminal) |
| `wrangler login` is signed in to the Cloudflare account that holds the Container quota | `wrangler whoami` | Teammate (this is the teammate's existing Cloudflare account) |
| `pm2` is installed | `which pm2`, expect a path | `npm install -g pm2` |
| `cloudflared` is installed (needed only if you fall back to Cloudflare Tunnel) | `which cloudflared`, expect a path | `brew install cloudflared` |
| `.env` template values you need from Bobby: `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `KIMI_API_KEY`, `APIFY_TOKEN`, `GOOGLE_MAPS_API_KEY`, `ADMIN_TOKEN` | Ask Bobby in WeChat | Bobby |
| Dedicated iPhone has signed in to iMessage with the US Apple ID and the BIA George handle is verified | Open Messages.app on the iPhone, confirm BIA handle is selected as the From | Teammate (physical action) |
| Mac mini status | Either: "Mac mini ordered, ETA X days" → use Path B (iPhone Shortcuts) for v1; OR "Mac mini in hand, set up" → use Path A | Teammate |

If any item is missing, do NOT proceed. Ask the teammate in WeChat or message Bobby.

## Phase 1 — Deploy the Container (you, ~30 min)

The Container runs the same george repo with one env switch: `IMESSAGE_ENABLED=false`.

1. **Clone the repo on a machine with `wrangler`:**

```bash
git clone https://github.com/BIBOYANG425/george.git
cd george
git checkout feat/dual-mode-imessage  # the dual-mode branch; or main if PR #1 has merged
```

2. **Decide the Container name.** Default: `george-backend`. You can pick another, but match it everywhere below.

3. **Generate the bearer tokens.** Two separate tokens — do not reuse the same string. Use a CSPRNG, not a phrase.

```bash
# Run twice and save the outputs.
openssl rand -hex 32  # save as ADMIN_TOKEN
openssl rand -hex 32  # save as ADMIN_TOKEN_PHONE
```

Share `ADMIN_TOKEN` with Bobby (he needs it for the Vercel `GEORGE_ADMIN_TOKEN` env var that gates uscbia.com's relay). Keep `ADMIN_TOKEN_PHONE` for the iPhone Shortcuts only.

4. **Write a `wrangler.toml`** at the repo root (if not present in the branch). Adjust the Container resource limits to match the teammate's 40 GB CPU-time/month allowance:

```toml
name = "george-backend"
compatibility_date = "2026-05-28"

[containers]
class = "Standard"
instance_type = "production"

[env.production.vars]
NODE_ENV = "production"
IMESSAGE_ENABLED = "false"
```

5. **Set every secret via `wrangler secret put`** (one command per secret, paste the value at the prompt):

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_ANON_KEY
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put KIMI_API_KEY
wrangler secret put APIFY_TOKEN
wrangler secret put GOOGLE_MAPS_API_KEY
wrangler secret put ADMIN_TOKEN          # the one you generated in step 3
wrangler secret put ADMIN_TOKEN_PHONE    # the one you generated in step 3
wrangler secret put BIA_ROOMMATE_API_URL # value: https://uscbia.com
```

Do NOT set `BACKEND_RELAY_URL` on the Container. Empty means agent mode.

6. **Deploy:**

```bash
wrangler deploy
```

Capture the URL it prints (something like `https://george-backend.<your-cf-account>.workers.dev`). Save it. Call it `$CONTAINER_URL` in the rest of this doc.

## Phase 2 — Verify the Container (you, ~10 min)

```bash
# Health endpoint is public; this should always return 200 with the character line.
curl "$CONTAINER_URL/health"
# expect: {"status":"ok","character":"George — BIA 学长","tools":23}

# Stats endpoint is gated by ADMIN_TOKEN. Expect 401 without, 200 with.
curl "$CONTAINER_URL/stats"
# expect: {"error":"Unauthorized"}

curl -H "Authorization: Bearer $ADMIN_TOKEN" "$CONTAINER_URL/stats"
# expect: 200 with {students:{total:N},messages:{total:N},...}

# Chat endpoint smoke test.
curl -X POST "$CONTAINER_URL/chat" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"deploy-test-$(date +%s)","platform":"imessage","text":"hi 学长"}'
# expect: 200 with {"response":"<real bilingual George reply within ~10s>"}
```

If any of these fail, do NOT proceed to Phase 3. Likely causes:
- `404 Not Found` on `/health` → wrangler deploy did not finish or the wrong URL
- `500 internal_error` on `/chat` → check Container logs for `chat_endpoint_error`; usually a missing or wrong Anthropic/Supabase secret
- `401 Unauthorized` on `/chat` with the right header → ADMIN_TOKEN does not match the secret you wrote in step 5

## Phase 3 — Wire up iMessage

Pick Path A (Mac mini) OR Path B (iPhone Shortcuts) based on hardware status. The Container supports both, you do not need to redeploy when switching.

### Path A — Mac mini bridge (production-grade)

Do this when the Mac mini is in your hands and macOS is set up.

1. On the Mac mini:

```bash
git clone https://github.com/BIBOYANG425/george.git
cd george
git checkout feat/dual-mode-imessage  # or main after PR #1 merges
npm install
cp .env.example .env
```

2. Edit `.env`. The Mac mini is in BRIDGE mode, so it needs only these vars:

```
IMESSAGE_ENABLED=true
BACKEND_RELAY_URL=https://george-backend.<your-cf-account>.workers.dev   # the $CONTAINER_URL from Phase 1
ADMIN_TOKEN=<must match the ADMIN_TOKEN you wrote on the Container in Phase 1 step 5>
PORT=3001
```

Leave Anthropic, Supabase, Kimi, Apify, Maps blank. The bridge never calls them. `src/config.ts` will skip the required-checks because `BACKEND_RELAY_URL` is set.

3. Grant Full Disk Access to the node binary that `tsx` resolves to. Find it:

```bash
which node    # e.g., /opt/homebrew/bin/node
which tsx     # e.g., /opt/homebrew/bin/tsx
```

System Settings → Privacy & Security → Full Disk Access → click `+`, navigate to the path you just found, add it. You may need to do this for both `node` and `tsx` symlinks.

4. Start under pm2 so it auto-restarts on crash and survives Mac reboots:

```bash
npm install -g pm2
pm2 start npm --name george-bridge -- run dev
pm2 save
pm2 startup launchd
# pm2 prints a `sudo` command; run it once to enable launchd auto-start
```

5. Verify the bridge connected. Watch logs for these lines:

```bash
pm2 logs george-bridge --lines 30
```

You should see:
- `bridge_mode_active` with the relay URL
- `relay_ok` if the `/health` ping succeeded — this proves the Container is reachable AND `ADMIN_TOKEN` matches
- `imessage_connected` if the Photon SDK opened the iMessage watcher

If you see `relay_unauthorized`, the `ADMIN_TOKEN` on the bridge does not match the Container. Fix the env, `pm2 restart george-bridge`.

If you see `imessage_sdk_unavailable`, Full Disk Access is missing. Add it, then `pm2 restart george-bridge`.

6. Smoke test: from a phone that is NOT the dedicated BIA iPhone, send an iMessage to the BIA George handle. Expect a real bilingual reply within ~10 seconds. Check `pm2 logs` for the agent_loop log line.

### Path B — iPhone Shortcuts (no-Mac interim)

Use this until the Mac mini arrives. The iPhone runs two Apple Shortcuts that call the Container.

1. On the dedicated iPhone, open the **Shortcuts** app.

2. Build the **incoming** Shortcut. Name it `George Incoming`:
   - Action: **Get Contents of URL**
   - URL: `$CONTAINER_URL/imessage/incoming` (paste your real URL)
   - Method: POST
   - Headers:
     - `Authorization`: `Bearer <ADMIN_TOKEN_PHONE>` (the second token from Phase 1 step 3)
     - `Content-Type`: `application/json`
   - Request Body: JSON
     ```
     {
       "sender": [Shortcut Input → "Sender"],
       "text": [Shortcut Input → "Content"],
       "timestamp": [Current Date → Unix Timestamp]
     }
     ```

3. Create a **Personal Automation**:
   - When: **I receive a message** → Any sender → Any text
   - Action: Run Shortcut → `George Incoming`
   - **Turn off Ask Before Running.** This is critical; otherwise the automation pauses for confirmation and nothing flows.

4. Build the **outgoing-poll** Shortcut. Name it `George Poll`:
   - Action: **Get Contents of URL**
     - URL: `$CONTAINER_URL/imessage/outgoing`
     - Method: GET
     - Header: `Authorization`: `Bearer <ADMIN_TOKEN_PHONE>`
   - Action: **Repeat with Each** on the JSON array result
     - Inside the loop:
       - **Send Message** action: To = `recipient` field; Message = `text` field
       - **Get Contents of URL** action: POST to `$CONTAINER_URL/imessage/outgoing/<id>/ack` with body `{"status":"sent"}` and the same Bearer header

5. Create a second **Personal Automation**:
   - When: **Time of Day** → repeat every 1 minute
   - Action: Run Shortcut → `George Poll`
   - **Turn off Ask Before Running.**

6. Smoke test: send a real iMessage from another phone to the BIA George handle. Watch:
   - On the iPhone: the `George Incoming` Shortcut runs (banner appears briefly)
   - On the Container side: hit `/stats` to see `messages.today` incrementing
   - Within ~60 seconds the iPhone sends the reply back

Known limitations of Path B:
- Outgoing latency up to 60 seconds (polling cadence)
- iOS may throttle Personal Automations under low battery or Focus mode. Watch for silent failures
- Group chats and reactions may not trigger the "When I receive" event cleanly
- The iPhone must stay on; auto-lock is OK but power-off kills the automation

When the Mac mini arrives, disable both Personal Automations in iOS Shortcuts (toggle off), then proceed with Path A. The Container endpoints stay mounted but go idle.

## Phase 4 — Rotate the Vercel relay (Bobby + you, ~5 min)

uscbia.com's `/api/george/chat` route is on Vercel and currently points at Bobby's old Cloudflare quick tunnel. Bobby has to run this part because the Vercel project is in his account.

Tell Bobby in WeChat:

> Container is healthy at `<$CONTAINER_URL>`. Please rotate Vercel env vars on the bia-roommate project:
>
> ```bash
> cd ~/Documents/bia-roommate
> vercel env rm GEORGE_BACKEND_URL production -y
> vercel env rm GEORGE_BACKEND_URL development -y
> echo -n "<$CONTAINER_URL>" | vercel env add GEORGE_BACKEND_URL production
> echo -n "<$CONTAINER_URL>" | vercel env add GEORGE_BACKEND_URL development
>
> # Also rotate the bearer token to match the new Container's ADMIN_TOKEN:
> vercel env rm GEORGE_ADMIN_TOKEN production -y
> vercel env rm GEORGE_ADMIN_TOKEN development -y
> echo -n "<ADMIN_TOKEN you generated in Phase 1 step 3>" | vercel env add GEORGE_ADMIN_TOKEN production
> echo -n "<ADMIN_TOKEN>" | vercel env add GEORGE_ADMIN_TOKEN development
>
> vercel deploy --prod
> ```

After Bobby runs that, smoke test from any browser-side:

```bash
curl -X POST https://uscbia.com/api/george/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"prod smoke test from teammate","userId":"prod-smoke"}'
# expect: a real bilingual George reply, NOT the fine-tune fallback
```

If the response is the fine-tune fallback ("汪... 我现在正在调教中"), the Vercel env vars did not save or the redeploy did not pick them up. Tell Bobby to retry `vercel deploy --prod` and check the deployment in the Vercel dashboard.

## Phase 5 — Decommission Bobby's Mac (Bobby, 2 min)

Once Phase 4 smoke passes, Bobby retires the old path:

```bash
pm2 delete george-server george-tunnel 2>/dev/null
pkill -f "npm run dev"
pkill -f "cloudflared tunnel"
```

Bobby's Mac is now off the production path. Tell him.

## Smoke tests (end-to-end, do all five)

| Test | How | Expect |
|---|---|---|
| Container health (you) | `curl $CONTAINER_URL/health` | 200, `tools:23` |
| Container chat with auth (you) | `curl -X POST $CONTAINER_URL/chat -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"userId":"test","platform":"imessage","text":"测试"}'` | 200, bilingual response within 10s |
| iMessage round trip (you, from a non-paired phone) | Send a real iMessage to the BIA George handle | Reply within 10s (Path A) or up to 60s (Path B) |
| Web chat round trip (you, from a browser) | Visit https://uscbia.com/george/chat, send a message | Real George reply, not the fine-tune fallback |
| Cron jobs alive (you, after 10 min) | `curl -H "Authorization: Bearer $ADMIN_TOKEN" $CONTAINER_URL/stats` and watch `messages.today` over time | Counter increments as messages arrive; no errors in Container logs |

If all five pass, the migration is complete. Tell Bobby in WeChat.

## Rollback

If anything in Phase 1, 2, 3, or 4 breaks:

- Bobby's Mac dev server should stay running through Phase 4 verification. Do NOT have him run Phase 5 until you confirm green on the smoke tests.
- If the Container is broken, leave `GEORGE_BACKEND_URL` on Vercel pointed at Bobby's tunnel. Investigate Container logs separately.
- If Vercel cutover sends users the fine-tune fallback after redeploy, roll back the env var: `vercel env rm GEORGE_BACKEND_URL production -y && echo -n "<bobby's old tunnel URL>" | vercel env add GEORGE_BACKEND_URL production && vercel deploy --prod`. The old tunnel URL is whatever was set before; Bobby can find it in his terminal history or Vercel dashboard history.

## What you should NOT do

- Do NOT run `wrangler delete` or any destructive Cloudflare command without Bobby explicitly approving it via WeChat.
- Do NOT push commits to the `main` branch of `BIBOYANG425/george`. Use a feature branch + PR. Branch protection is on; force-push is forbidden.
- Do NOT change `personality.ts` or `bia-lore.ts` files. George's voice was distilled from Bobby's actual WeChat messages. Voice changes need Bobby's approval. See `AGENT.md` for the persona spec.
- Do NOT log secrets. Use `pm2 logs` carefully; avoid `console.log(process.env)`.
- Do NOT add new vendors or sign up for new paid services on Bobby's behalf. The teammate's Cloudflare account is the only external dependency.

## Where to ask for help

- **Bobby (founder, owns the repo + Vercel + Anthropic + Supabase secrets):** WeChat. Best for: token/secret issues, scope decisions, approving anything outside this handoff.
- **CLAUDE.md** in this repo: agent guardrails, repo identity, cross-repo coordination rules.
- **README.md** in this repo: human-friendly overview, architecture diagram, quick start.
- **AGENT.md** in this repo: George's persona spec, voice fingerprint, anti-patterns, prompt source map.
- **The plan file** at `~/.claude/plans/steady-singing-planet.md` on Bobby's machine: full review history, autoplan output, alternatives that were considered and rejected.

When you finish, report back to Bobby with:
- The `$CONTAINER_URL` you deployed
- The two bearer tokens (encrypted, e.g., via 1Password or send him the secret name and Cloudflare deployment so he can retrieve)
- Which path (A or B) is currently active
- Any deviation from this handoff document

Good luck. Be honest when something blocks you. Bobby would rather get a flag at step 2 than discover a broken production at step 5.
