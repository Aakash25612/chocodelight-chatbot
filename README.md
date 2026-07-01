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

## Multiple companies

The app serves more than one Business Central company (currently **Choco Delight** and **Saurabh Food**). Users pick the company from the header dropdown; every request is scoped to that company.

- Each company has its own connection settings in env (`BC_*` for Choco Delight, `BC_SAURABHFOOD_*` for Saurabh Food) — see `.env.example`.
- Mirror data is stored per company: `bc_mirror`, `bc_mirror_cache`, `bc_sync_meta`, and `bc_write_queue` all have a `company` column (see `supabase/migrations/002_multi_company.sql`).
- `npm run sync:bc` mirrors **all** configured companies in one run.

To add another company later: add an entry to `src/lib/companies.ts`, add its `BC_*` env vars, and add it to the `COMPANIES` list in `src/components/ChatInterface.tsx`.

Note: Saurabh Food reads (customers, ledger, items, etc.) work like Choco Delight. Writes/posting are disabled by default (`BC_SAURABHFOOD_WRITES_ENABLED=false`) because the Postman POST examples target a test DB; set the production OData company name and enable when confirmed.

## Supabase tables

| Table | Purpose |
|-------|---------|
| `conversations`, `messages`, `api_logs` | Chat history |
| `bc_mirror` | Synced BC read data (per company) |
| `bc_mirror_cache` | Cached dynamic queries (per company) |
| `bc_write_queue` | Pending BC write operations (per company) |
| `bc_sync_meta` | Sync status (per company) |

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
