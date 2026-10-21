# Private intelligence hosting adapter

This Node.js 22.13+ adapter serves only the intelligence app at `intel.insightfuldefense.com`. It does not change the editorial apex website or DNS. Production uses managed MySQL through the official [mysql2 package](https://sidorares.github.io/node-mysql2/docs). SQLite is retained for local development and tests. Do not store private databases, backups, passwords, or secrets under `public/` or `public/assets/`.

## Build and start

Run `npm ci --omit=dev` and `npm run build` from this repository, matching GoDaddy's production-only installation. The pinned TypeScript compiler is in `dependencies` so it remains available during that build. The in-repository build reads authored `lib/` files, preserves `public/` and the Drizzle journal in place, and transpiles five business modules into `server/`. Generated server files and their hash manifest are included. Cloudflare database imports are redirected to `hosting/runtime.mjs`; local imports gain `.js`, and JSON seeds use Node JSON import attributes. The pinned `mysql2` runtime dependency comes from the public npm registry specified in `.npmrc`.

After building, start with `node hosting/server.mjs`. The package layout is:

    DefenseIntel/
      hosting/{server.mjs,runtime.mjs,mysql.mjs,auth.mjs,client.js,build.mjs,import-backup.mjs,password-hash.mjs}
      server/{workspace.js,intelligence-workspace.js,intelligence-feeds.js,official-awards.js,event-intelligence.js,seed-data.json,package.json}
      public/
      drizzle/{*.sql,meta/_journal.json,...}
      portable-build.json

## Production configuration

Supply configuration through the hosting platform's private secret/environment settings. There are no default accounts, passwords, session keys, database credentials, or public bypass tokens.

Code can be uploaded before owner secrets are entered in the hosting UI. The build reads no database or authentication secrets. Startup deliberately stops if required settings are missing, before business bootstrap or collection. GoDaddy's managed database injects the five `DB_*` connection variables below. Set preview `PUBLIC_ORIGIN` to the actual app origin used by the browser; switch the production variant to the intended custom origin only at cutover. Keep the preview scheduler disabled.

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | Set to `production`. Production startup refuses SQLite fallback. |
| `PUBLIC_ORIGIN` | Exactly `https://intel.insightfuldefense.com`. Every POST must match this Origin. |
| `DATABASE_URL` | Full `mysql://user:encoded-password@host:3306/database` URL. Alternatively use all four `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` variables. |
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Managed MySQL connection details when `DATABASE_URL` is not supplied. |
| `DB_PORT` | Optional port, default 3306. |
| `DB_SSL_CA` | Optional private CA PEM when the provider requires its own trust chain. Remote TLS always verifies the certificate chain and hostname. |
| `ADMIN_EMAIL` | The single owner's sign-in address. |
| `ADMIN_PASSWORD_HASH` | Preferred verifier: `scrypt$N$r$p$saltBase64url$keyBase64url`. Generate using `node hosting/password-hash.mjs` with the password entered through hidden stdin. |
| `ADMIN_PASSWORD` | Alternative host secret of at least 16 bytes. Set this or the hash, never both. Plaintext mode intentionally invalidates sessions on each restart. |
| `SESSION_SECRET` | At least 32 bytes of random secret material. Keep stable across ordinary restarts; rotation invalidates all sessions. |
| `PORT` | Runtime port supplied by the host. Defaults to 3000 for manual use. |
| `HOST` | Bind interface, default `0.0.0.0` in production. |
| `ENABLE_SCHEDULER` | Enabled by default. Set exactly `false` where collection must not run. |
| `IMPORT_REQUIRED` | Set `true` on first deployment to prevent bootstrap, app data access and scheduling until the owner backup has imported and the server restarts. |

MySQL connections use a bounded promise pool, parameter binding, disabled multi-statements, UTF-8 and verified TLS. Remote certificate/hostname verification cannot be disabled. `DB_SSL_MODE=disable` is supported only for a loopback database in local tests. A failed connection or migration stops startup rather than falling back to a local file.

GoDaddy [documents that preview and production share the app's database](https://www.godaddy.com/resources/news/deploy-a-node-js-app-to-godaddy-from-your-terminal-or-let-your-coding-agent-do-it). Treat preview as access to production data. Disable its scheduler, prevent concurrent collection/imports, and use a separate database for destructive tests. Never assume a preview is an isolated copy. Confirm the provider's TLS/CA details and run a live connection/schema smoke test before switching the production hostname.

Terminate HTTPS at the trusted host proxy. Forwarded host/protocol headers are not trusted; the configured origin is authoritative. Sessions are HMAC signed, expire after eight hours, and retain a hashed server-side identifier so sign-out revokes them. Cookies are host-only, Secure, HttpOnly and SameSite=Strict. Rotating the owner credentials or session secret invalidates old sessions.

## Local development

Without MySQL credentials, local nonproduction mode uses `DATA_DIR/defense-intel.sqlite`. `DATA_DIR` must be an absolute private directory. SQLite runs with WAL and full synchronous commits. It is not a persistence strategy for GoDaddy production.

For local HTTP browser testing, set `ALLOW_INSECURE_LOCALHOST=true` and a `http://127.0.0.1:<port>` origin. This mode uses a distinct local cookie and permits binding only to a loopback interface. Never enable it on a public host.

## Private routes and scheduling

`GET /healthz` returns only `{"status":"ok"}`. Every app asset and data route requires sign-in. `/auth/login` supplies the owner form. An authenticated `/auth/session` returns the CSRF token. A first-party bridge is injected into the HTML response to add that token to the app's existing fetch calls and provide sign-out, without changing app source files.

Authenticated APIs are `/api/workspace` (GET/POST), `/api/refresh` (POST), `/api/ingest` (POST), and `/api/backup` (GET). All POSTs require the exact configured Origin and the session's `X-CSRF-Token`. Backups contain the ten whitelisted app tables; credentials, sessions, scheduler claims and migration ledgers are excluded. During initial `IMPORT_REQUIRED=true` mode, only owner authentication and `POST /api/transfer/import` are available; the private owner import screen accepts up to 20 MB. Workspace, app assets and collection remain gated until import completion and restart.

The internal scheduler calls `refresh()` directly at 07:00 and 13:00 America/Phoenix while the Node process is running. Manual refresh, ingest and scheduled collection share a process lock. Database claims prevent duplicate runs of the same scheduled slot, and the business refresh lock is acquired atomically with MySQL `SELECT ... FOR UPDATE`. Run one authoritative collecting deployment. Disable the old Sites schedule only when the new host is verified and becomes authoritative. The timer is unreferenced; the host must keep the app process available for its scheduled times.

## Migrations and one-time data import

Database setup reads the copied Drizzle journal and records each original SQL checksum. MySQL translations use InnoDB, case-sensitive UTF-8, `VARCHAR(250)` primary identifiers and `LONGTEXT` content. A database advisory lock serializes initialization. MySQL DDL auto-commits, so the ledger marks each migration `applying` before DDL and `applied` after completion. An interrupted migration, changed checksum, unknown newer migration, or untracked existing schema stops startup. No migration is replayed automatically. Local SQLite uses transactional migrations plus `PRAGMA user_version`.

To transfer existing data, export `/api/backup` from the authenticated source into a private file outside the repository and public asset directories. Start the destination in `IMPORT_REQUIRED=true` mode and use the authenticated private import screen (20 MB maximum), or stop it and run the offline importer (100 MB maximum):

    node hosting/import-backup.mjs --input <private-backup-file>

Both import paths validate the exact format/version, ten table and column allowlists, string/JSON/date/flag types, field sizes, row limits and unique identifiers. They refuse a destination containing any application row. Emptiness checks, all transferred rows and a completion marker are committed in one transaction; an error rolls back the data import. Metadata preserves saved workshops, pursuits, capture plans and NAICS filters without interpreting or changing them. Source versions and saved report snapshots are copied intact. Restart/redeploy after import so bootstrap and the normal workspace can activate; a successful import never activates the old process's scheduler. Success output contains only imported table counts; data and secrets are never printed. Keep the original backup until production readback is verified, then apply the owner's retention policy.

`initializeDatabase()` is asynchronous and returns `{kind,database,DB,transaction,close}`. The raw database supports awaitable `prepare(sql).get/all/run`; `DB` exposes the original asynchronous D1-style `prepare().bind().first/all/run` and atomic `batch()`. `transaction(callback)` passes a connection-bound raw database, so all importer queries use the same transaction connection. Await initialization before calling business modules and await `close()` at shutdown.

## Verification

Run `node --test hosting/adapter.test.mjs hosting/mysql.test.mjs hosting/import-backup.test.mjs`. Tests use temporary private directories, real local SQLite and an asynchronous MySQL protocol fixture. The fixture verifies SQL translation, one-connection transactions, lock behavior, migrations and sessions; it does not replace a live managed MySQL/TLS smoke test. No tests deploy, change DNS, mutate the source checkout or contact the managed database.
