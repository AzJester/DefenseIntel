# Private intelligence hosting adapter

This Node.js 22.13+ adapter serves the intelligence app on its configured origin, with `intel.insightfuldefense.com` as the intended production hostname. It does not change the editorial apex website or DNS. Production uses managed MySQL through the official [mysql2 package](https://sidorares.github.io/node-mysql2/docs). SQLite is retained for local development and tests. Do not store private databases, backups, passwords, or secrets under `public/` or `public/assets/`.

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

Supply configuration through the hosting platform's private secret/environment settings. There are no default accounts, passwords, session keys, database credentials, or public bypass tokens. Select one of the access modes below.

Code can be uploaded before runtime settings are entered in the hosting UI. The build reads no database or authentication secrets. Startup deliberately stops if the selected access mode's required settings are missing, before business bootstrap or collection. GoDaddy's managed database injects the five `DB_*` connection variables below. Set preview `PUBLIC_ORIGIN` to the actual app origin used by the browser; configure the production variant's own origin at cutover. Keep the preview scheduler disabled unless it is the one authoritative private collecting process.

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | Set to `production`. Production startup refuses SQLite fallback. |
| `ACCESS_MODE` | `owner-password` (default if unset), `godaddy-private-preview`, or `public`. See the access boundaries below. |
| `PUBLIC_ORIGIN` | Exactly one HTTPS browser origin. Every permitted POST must match it. Preview mode requires the actual `https://<single-label>.preview.c38.airoapp.ai` origin; production may use `https://intel.insightfuldefense.com` in owner-password or public mode. |
| `PRIVATE_PREVIEW_URL` | Optional owner-editor link returned with workspace access metadata. Must be a GoDaddy private-preview HTTPS origin. |
| `DATABASE_URL` | Full `mysql://user:encoded-password@host:3306/database` URL. Alternatively use all four `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` variables. |
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Managed MySQL connection details when `DATABASE_URL` is not supplied. |
| `DB_PORT` | Optional port, default 3306. |
| `DB_SSL_CA` | Optional private CA PEM when the provider requires its own trust chain. Remote TLS always verifies the certificate chain and hostname. |
| `DB_TLS_SERVERNAME` | Optional provider-confirmed DNS identity for verified TLS through a loopback `DB_HOST` proxy. TCP still uses the injected host/port. Refused for remote transport or disabled TLS. |
| `ADMIN_EMAIL` | Owner-password mode only: the single owner's sign-in address. |
| `ADMIN_PASSWORD_HASH` | Owner-password mode only. Preferred verifier: `scrypt$N$r$p$saltBase64url$keyBase64url`. Generate using `node hosting/password-hash.mjs` with the password entered through hidden stdin. |
| `ADMIN_PASSWORD` | Owner-password mode only. Alternative host secret of at least 16 bytes. Set this or the hash, never both. Plaintext mode intentionally invalidates sessions on each restart. |
| `SESSION_SECRET` | Owner-password mode only. At least 32 bytes of random secret material. Keep stable across ordinary restarts; rotation invalidates all sessions. |
| `PORT` | Runtime port supplied by the host. Defaults to 3000 for manual use. |
| `HOST` | Bind interface, default `0.0.0.0` in production. |
| `ENABLE_SCHEDULER` | Set exactly `false` for the public variant and every nonauthoritative preview. Enable only the one authoritative private collecting process. |
| `IMPORT_REQUIRED` | Set `true` on first deployment to prevent bootstrap, app data access and scheduling until the owner backup has imported and the server restarts. Pending public mode fails closed without an import screen. |

MySQL connections use a bounded promise pool, parameter binding, disabled multi-statements, UTF-8 and verified TLS. Remote certificate/hostname verification cannot be disabled. `DB_SSL_MODE=disable` is supported only for a loopback database in local tests. A failed connection or migration stops startup rather than falling back to a local file.

A managed database may inject `DB_HOST=localhost` while its TLS certificate identifies the provider's upstream service. In that case, set `DB_TLS_SERVERNAME` only to the DNS identity confirmed by the provider. Do not discover or accept the expected identity from an unverified peer certificate. The adapter uses mysql2's [supported connection stream factory](https://sidorares.github.io/node-mysql2/docs/documentation/extras#connecting-using-custom-stream) to connect to the original loopback host and port, while `config.host` supplies the configured DNS name for SNI and hostname verification. In pinned mysql2 3.24.6, `ssl.servername` is not used by the driver's TLS path. Certificate chain and hostname verification both remain required; no plaintext fallback is used.

GoDaddy [documents that preview and production share the app's database](https://www.godaddy.com/resources/news/deploy-a-node-js-app-to-godaddy-from-your-terminal-or-let-your-coding-agent-do-it). Treat preview as access to production data. Disable its scheduler, prevent concurrent collection/imports, and use a separate database for destructive tests. Never assume a preview is an isolated copy. Confirm the provider's TLS/CA details and run a live connection/schema smoke test before switching the production hostname.

## Access boundaries

`ACCESS_MODE=owner-password`, or an unset mode, retains the app's owner authentication. Configure `ADMIN_EMAIL`, exactly one of `ADMIN_PASSWORD_HASH` or `ADMIN_PASSWORD`, and `SESSION_SECRET`. Sessions are HMAC signed, expire after eight hours, and retain a hashed server-side identifier so sign-out revokes them. Cookies are host-only, Secure, HttpOnly and SameSite=Strict. Rotating the owner credentials or session secret invalidates old sessions.

`ACCESS_MODE=godaddy-private-preview` omits the additional app password and session-secret requirement. Its owner authority comes entirely from the existing GoDaddy account-gated private-preview gateway. `PUBLIC_ORIGIN` must be exactly one HTTPS origin whose host is a single label followed by `.preview.c38.airoapp.ai`; custom domains, deeper subdomains and ordinary public hosts are refused. The incoming Host must match that configured origin; forwarded host headers cannot override it. All owner workspace editing, collection, imports and backup routes are available behind that gateway, with exact-Origin and process-random CSRF checks on POSTs. This mode must never be exposed through a public proxy or another route that bypasses GoDaddy's account gate. The application does not independently authenticate the GoDaddy account. Verify the provider preserves the preview Host before using it.

`ACCESS_MODE=public` allows public GET access to app assets and workspace data. It denies shared-data mutations, manual collection, ingest, imports and backups. A validated `brief_snapshot` request returns an ephemeral report/presentation payload without inserting a saved snapshot or changing shared data. Existing saved snapshots can be read through `snapshot_get`; the startup `bootstrap` POST is a no-op. Public export/read POSTs require the exact configured Origin. The internal scheduler may run when explicitly configured as the one authoritative collector; public visitors cannot trigger collection. Existing records, notes, planning data and findings returned by the workspace become readable by public visitors. Review that shared content before selecting public mode.

`GET /api/workspace` includes `access: {mode,readOnly,editorUrl}`. `GET /auth/session` reports those access fields, with a CSRF token only for writable modes. The client bridge presents no app sign-in or sign-out control in managed preview or public mode.

The private-preview mode exposes a process-random CSRF token through the app's same-origin bridge. The token protects permitted POST integrity; it does not establish owner identity. Restarting the process invalidates existing page tokens, so reload the workspace after a restart. Public mode has no writable-mode CSRF token. No `ADMIN_*` or `SESSION_SECRET` values are required in these two modes.

Terminate HTTPS at the trusted host proxy. Forwarded host/protocol headers are not trusted; the configured origin is authoritative. Every permitted app data POST, including temporary public exports, requires the exact configured Origin and the applicable `X-CSRF-Token`. Password sign-in instead uses its form's CSRF challenge. Preview owner edits and public visitors may share the same managed database; public read-only access does not create a separate copy.

## Local development

Without MySQL credentials, local nonproduction mode uses `DATA_DIR/defense-intel.sqlite`. `DATA_DIR` must be an absolute private directory. SQLite runs with WAL and full synchronous commits. It is not a persistence strategy for GoDaddy production.

For local HTTP browser testing, set `ALLOW_INSECURE_LOCALHOST=true` and a `http://127.0.0.1:<port>` origin. This mode uses a distinct local cookie and permits binding only to a loopback interface. Never enable it on a public host.

## Private routes and scheduling

`GET /healthz` returns only `{"status":"ok"}`. Owner-password mode protects assets and data with sign-in; `/auth/login` supplies the form and `/auth/session` returns the session CSRF token. Private-preview mode relies on GoDaddy's account gate, and public mode serves read-only content without app sign-in. The first-party bridge supplies the correct CSRF token for the selected mode and adds it to permitted app requests. Sign-out revocation applies to app password sessions.

Owner APIs are `/api/workspace` (GET/POST), `/api/refresh` (POST), `/api/ingest` (POST), and `/api/backup` (GET). They require password-owner authentication or the restricted private-preview deployment. Public mode permits workspace GET, validated temporary `brief_snapshot` exports, saved `snapshot_get` reads and the no-op startup `bootstrap`; it denies owner backup and shared-data changes. Backups contain the ten whitelisted app tables; credentials, sessions, scheduler claims and migration ledgers are excluded. During initial `IMPORT_REQUIRED=true` mode, only owner access and `POST /api/transfer/import` are available; the private owner import screen accepts up to 20 MB. A public deployment remains unavailable and never presents this import screen. Workspace, app assets and collection remain gated until import completion and restart.

The internal scheduler calls `refresh()` directly at 07:00 and 13:00 America/Phoenix while the authoritative Node process is running. Manual refresh, ingest and scheduled collection share a process lock. Database claims prevent duplicate runs of the same scheduled slot, and the business refresh lock is acquired atomically with MySQL `SELECT ... FOR UPDATE`. Keep collection disabled in nonauthoritative deployments, including the owner preview. After cutover, the authoritative public deployment may enable the internal scheduler while public HTTP collection stays denied. Disable the old Sites schedule only when the new host is verified and becomes authoritative. The timer is unreferenced; the host must keep the app process available for its scheduled times.

## Migrations and one-time data import

Database setup reads the copied Drizzle journal and records each original SQL checksum. MySQL translations use InnoDB, case-sensitive UTF-8, `VARCHAR(250)` primary identifiers and `LONGTEXT` content. A database advisory lock serializes initialization. MySQL DDL auto-commits, so the ledger marks each migration `applying` before DDL and `applied` after completion. An interrupted migration, changed checksum, unknown newer migration, or untracked existing schema stops startup. No migration is replayed automatically. Local SQLite uses transactional migrations plus `PRAGMA user_version`.

To transfer existing data, export `/api/backup` from the owner-access source into a private file outside the repository and public asset directories. Start the destination in `IMPORT_REQUIRED=true` mode with owner-password or restricted private-preview access, then use its private import screen (20 MB maximum), or stop it and run the offline importer (100 MB maximum):

    node hosting/import-backup.mjs --input <private-backup-file>

Both import paths validate the exact format/version, ten table and column allowlists, string/JSON/date/flag types, field sizes, row limits and unique identifiers. They refuse a destination containing any application row. Emptiness checks, all transferred rows and a completion marker are committed in one transaction; an error rolls back the data import. Metadata preserves saved workshops, pursuits, capture plans and NAICS filters without interpreting or changing them. Source versions and saved report snapshots are copied intact. Restart/redeploy after import so bootstrap and the normal workspace can activate; a successful import never activates the old process's scheduler. Success output contains only imported table counts; data and secrets are never printed. Keep the original backup until production readback is verified, then apply the owner's retention policy.

`initializeDatabase()` is asynchronous and returns `{kind,database,DB,transaction,close}`. The raw database supports awaitable `prepare(sql).get/all/run`; `DB` exposes the original asynchronous D1-style `prepare().bind().first/all/run` and atomic `batch()`. `transaction(callback)` passes a connection-bound raw database, so all importer queries use the same transaction connection. Await initialization before calling business modules and await `close()` at shutdown.

## Verification

Run `node --test hosting/adapter.test.mjs hosting/mysql.test.mjs hosting/import-backup.test.mjs`. Tests use temporary private directories, real local SQLite and an asynchronous MySQL protocol fixture. The fixture verifies SQL translation, one-connection transactions, lock behavior, migrations and sessions; it does not replace a live managed MySQL/TLS smoke test. No tests deploy, change DNS, mutate the source checkout or contact the managed database.
