# ARRR DataBridge

Migrate, verify and inspect Roblox DataStores over the official Open Cloud API.

| Part | Folder | Stack | Deploy |
|---|---|---|---|
| Web | `web/` | Next.js 16 · Tailwind 4 · pnpm | Vercel → `https://databridge.arrrstudio.com` |
| API + worker | `api/` | Node 22 · Hono · Drizzle · BullMQ | Railway → `https://databridge-be.up.railway.app` |
| Database | — | PostgreSQL | Railway Postgres |
| Queue | — | Redis | Railway Redis |

The web proxies `/api/v1/*` to the API (`next.config.ts` rewrites), so the session cookie belongs to the web domain and no CORS is needed. Users never see the Railway URL.

## Deploy

### 1. Railway (API)
1. Create a service from the `api/` folder. It builds with the `Dockerfile`, and `railway.json` sets the `/health` healthcheck.
2. Add the **PostgreSQL** and **Redis** plugins.
3. Set the variables below. Database migrations run automatically on start.

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` |
| `APP_URL` | `https://databridge.arrrstudio.com` |
| `COOKIE_SECURE` | `true` |
| `ENCRYPTION_KEY` | 32 random bytes, base64. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Never change it later**: it encrypts the stored Roblox keys and tokens. To rotate, move the old key to `ENCRYPTION_KEYS_PREVIOUS`. |
| `ROBLOX_OAUTH_CLIENT_ID` | From Creator Dashboard → OAuth 2.0 Apps |
| `ROBLOX_OAUTH_CLIENT_SECRET` | Same app |
| `ADMIN_EMAIL` | Admin login email (the account is created on API start) |
| `ADMIN_PASSWORD` | Admin password, at least 12 characters. Changing it changes the password on the next start and signs out old admin sessions. |
| `ADMIN_EMAILS` | Optional extra admins (comma-separated). They register normally with that email and password. |
| `QRIS_IMAGE_URL` | `https://databridge.arrrstudio.com/brand/qris.png` (put the QRIS image in `web/public/brand/qris.png`) |
| `QRIS_MERCHANT_NAME` | `ARRR Studio` |
| `RUN_WORKER` | `true` (the migration worker runs inside the API service) |
| `OC_RPS_PER_UNIVERSE` | `4` (Open Cloud requests per second per universe; the budget is shared with live servers) |
| `MIGRATION_CONCURRENCY` | `4` |

Do **not** set `OC_BASE_URL` in production. It is only for the local mock and is ignored when `NODE_ENV=production`.

### 2. Vercel (web)
- Root directory: `web`. Install command: `pnpm install --frozen-lockfile`.
- Variable: `API_URL=https://databridge-be.up.railway.app`. This is also the production default, so it can be left unset.
- Domain: add `databridge.arrrstudio.com`, then create a DNS record `CNAME databridge → cname.vercel-dns.com`.

### 3. Roblox OAuth app
Redirect URLs:
- `https://databridge.arrrstudio.com/api/v1/auth/roblox/callback`
- `http://localhost:3000/api/v1/auth/roblox/callback` (local)

Scopes:
- `openid`, `profile`
- `universe-datastores.control:list`
- `universe-datastores.objects:list` / `read` / `create` / `update`

If Roblox names a scope differently, adjust `ROBLOX_OAUTH_CONNECT_SCOPES`. An unreviewed app is limited to 10 users; submit it for review before launch.

## Admin
- On every API start, an admin account is created or updated from `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Sign in at `/login` with that **email and password**. The **Admin** menu then appears in the sidebar at `/admin`. Every other account gets a 404.
- Admin access is **email and password only**. An admin account can't be linked to Roblox. Accounts created through "Continue with Roblox" have no email, so they can never become admin. Any Roblox link on an admin account is removed on start.
- Workspaces owned by an admin are **Enterprise** automatically.
- Admin → System → **Reset all data** (type `RESET ALL DATA`) deletes every user except admins, plus all workspaces, connections, projects, migrations and orders. The admin keeps a fresh Enterprise workspace.

## Local development
```bash
# terminal 1 — fake Roblox Open Cloud + OAuth with seeded data (port 8090)
cd api && npm install && npm run mock:roblox
# terminal 2 — API (port 8080); api/.env: OC_BASE_URL=http://localhost:8090, ADMIN_EMAILS=you@example.com
cd api && npm run dev
# terminal 3 — web (port 3000); web/.env.local: API_URL=http://localhost:8080
cd web && pnpm install && pnpm dev
```
Tests: `cd api && npm test` (25 integration tests: auth, tenant isolation, OAuth, migration engine, billing/admin).
