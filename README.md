# ChocoDelight BC Assistant

AI chatbot for ChocoDelight Business Central — **works for any user via Supabase**, no VPN on their device.

## Architecture

```
Users (any device)  →  Vercel / your app  →  Supabase (mirror data + chat history)
                                                    ↑
                              Sync worker (one VPN machine, cron every 5–15 min)
                                                    ↓
                                         Business Central (10.11.29.42)
```

Supabase **cannot** reach private BC IPs directly. Instead:

1. **One machine with VPN** runs `npm run sync:bc` on a schedule
2. BC data is mirrored into Supabase (`bc_mirror` tables)
3. **All users** read from Supabase — works from anywhere
4. **Writes** (sales orders, etc.) go to a queue and are processed by the sync worker

## Setup

```bash
npm install
cp .env.example .env.local
# Set BC_DATA_SOURCE=supabase and Supabase keys
```

### 1. Initial sync (VPN machine only)

```bash
npm run vpn:connect    # macOS dev only
npm run sync:bc        # pulls BC → Supabase
```

### 2. Schedule sync (production)

On an internal PC or server with VPN, cron every 10 minutes:

```bash
*/10 * * * * cd /path/to/chocodelight-chatbot && npm run sync:bc >> /var/log/choco-sync.log 2>&1
```

Or call the HTTP endpoint:

```bash
curl -X POST "https://your-app.vercel.app/api/sync?secret=YOUR_SYNC_SECRET"
```

(Vercel still can't reach BC — run the curl **from the VPN machine**, or use the standalone `npm run sync:bc`.)

### 3. Deploy app for users

Deploy to **Vercel** (or any host). Set env vars:

- `BC_DATA_SOURCE=supabase`
- `NEXT_PUBLIC_BC_DATA_SOURCE=supabase`
- `GEMINI_API_KEY`, Supabase keys, `SYNC_SECRET`

Users open your URL — no VPN required.

## Deploy to Vercel

1. Push this repo to GitHub
2. Import at [vercel.com/new](https://vercel.com/new)
3. Add environment variables (Production + Preview):

| Variable | Value |
|----------|-------|
| `GEMINI_API_KEY` | Your Gemini key |
| `GEMINI_MODEL` | `gemini-2.5-flash` |
| `BC_DATA_SOURCE` | `supabase` |
| `NEXT_PUBLIC_BC_DATA_SOURCE` | `supabase` |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://cparkzeqiufozpjrxvii.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | From Supabase dashboard |
| `SYNC_SECRET` | Random secret for sync endpoint |
| `BC_*` | Only needed if running sync via API from VPN machine |

4. Deploy. Keep `npm run sync:bc` on a VPN machine on a schedule.

## Supabase tables

| Table | Purpose |
|-------|---------|
| `conversations`, `messages`, `api_logs` | Chat history |
| `bc_mirror` | Synced BC read data |
| `bc_mirror_cache` | Cached dynamic queries |
| `bc_write_queue` | Pending BC write operations |
| `bc_sync_meta` | Sync status |

Dashboard: https://supabase.com/dashboard/project/cparkzeqiufozpjrxvii

## Modes

| `BC_DATA_SOURCE` | Who needs VPN |
|------------------|---------------|
| `supabase` (default) | Only the sync machine |
| `direct` | App server (legacy) |

## Local dev

```bash
npm run dev
```

Open http://localhost:3000
