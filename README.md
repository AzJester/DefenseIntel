# DefenseIntel

A defense-industry competitive intelligence and capture workspace with private owner editing and optional public read-only access. The source can be reviewed independently of the owner's data and credentials. This repository contains application code, public reference material and synthetic tests, with no live workspace backup or operational secrets.

The app supports public-source competitor news, contract announcements, acquisitions and teaming; official USAspending contract actions; grouped events with configurable priorities; source history; analyst findings and cited reports; editable PowerPoint briefs and OV-1 concepts; strategy workshops and black hat and blue team reviews; pursuit comparisons with weighted bars and an assessment heatmap; the official 2022 NAICS catalog; and full capture plans with requirements, customer value, win themes, teaming, risk, gates and milestones. Analyst planning and hypotheses remain separate from cited source statements.

Insightful Defense currently uses Sites hosting. Its public read-only gateway shares the existing authoritative owner workspace, including its current intelligence and planning data. The existing owner sign-in remains the editable workspace and its collector remains authoritative. The public viewer has no separate app password and cannot edit shared data. The editorial apex website is separate.

The complete public Sites adapter is in [sites-viewer/](sites-viewer/README.md), with the canonical gateway, framework configuration, dependency lock and preparation script. It stages the root frontend assets at build time rather than duplicating authored copies. This repository also contains the portable Node/MySQL host as an alternative. No paid GoDaddy hosting purchase was made for the current Sites deployment.

## Portable Node alternative: build and test

Use Node.js 22.13 or later:

```
npm ci --omit=dev
npm run build
npm test
```

The build compiles the authored `lib/` business modules into generated `server/` files and leaves `public/`, `drizzle/` and source files in place. Generated server files and their hash manifest are included. Rebuild after source changes and review the generated changes together. The pinned TypeScript compiler is in production dependencies because GoDaddy builds after a production-only install. Runtime uses the pinned `mysql2` dependency. The public npm registry is fixed in `.npmrc`. `db/schema.ts` documents the original schema; the checked-in Drizzle SQL journal controls database creation.

## Optional portable hosting and migration

The portable Node host is an alternative deployment path, not the current Sites viewer. Its production mode requires managed MySQL, HTTPS and valid access configuration. Configure [.env.example](.env.example) through the host's private settings. A GoDaddy managed deployment can inject the database's `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` and `DB_PASSWORD`. The build reads no runtime secrets. Startup validates its database and access configuration before bootstrap. The server never loads an account or secret from a public asset. See the detailed [hosting guide](hosting/README.md) for certificate validation, migrations, APIs, backups and local SQLite testing.

`ACCESS_MODE` defines the access boundary:

- `owner-password`, also the default when unset, requires the owner's email, password verifier or password, and session secret. All app assets and data require owner sign-in.
- `godaddy-private-preview` permits owner editing without an additional app password. It relies on GoDaddy's existing account-gated preview gateway and is restricted to an exact `https://<single-label>.preview.c38.airoapp.ai` origin. It refuses custom or public hostnames. No `ADMIN_*` or `SESSION_SECRET` configuration is required in this mode; GoDaddy account access is the authentication boundary.
- `public` exposes assets and workspace data for read-only browsing. Visitors cannot change shared records, collect, ingest, import, acknowledge alerts or obtain backups. A validated brief or presentation export can be assembled temporarily without saving a shared snapshot. This mode makes the existing shared workspace readable by anyone, so choose its published content deliberately.

Every permitted POST requires the exact configured Origin. Owner edits also require a CSRF token; managed preview uses a process-random token as a request-integrity check. Use the private preview or owner-password deployment for editing and a public deployment for read-only access. Both variants can use the same managed database. An optional `PRIVATE_PREVIEW_URL` supplies a link to the owner editor and must identify a GoDaddy private-preview HTTPS origin.

If the injected database endpoint is an IP address or proxy whose TLS identity differs from its transport address, `DB_TLS_SERVERNAME` can specify the explicit trusted provider DNS identity. The connection still uses the original injected host and port, and both certificate chain and hostname verification remain enabled. This works for loopback and remote endpoints. Do not infer or automatically trust the expected identity from the certificate presented by a peer.

For the first deployment, keep `IMPORT_REQUIRED=true` and `ENABLE_SCHEDULER=false`. Owner-password mode allows sign-in to a private import screen; GoDaddy private-preview mode allows that screen only through its account-gated preview. Bootstrap, workspace data and collection remain disabled. Public mode fails closed while transfer is pending and never presents an import screen. Transfer the owner-only `/api/backup` export into the empty managed database, either through the private import screen (20 MB maximum) or the offline importer (100 MB maximum). The importer validates the ten supported tables, refuses existing data, commits all imported rows and its completion marker atomically, and reports counts only. Restart or redeploy after a successful import. Verify the restored competitor directory, planning data, source versions and saved reports before enabling the authoritative private collector and disabling the old one.

The source app's full tracked competitor directory and planning history are owner data transferred through that backup, rather than operational data embedded in this repository. New blank development installs use the public starter directory until the owner adds or restores their competitors.

GoDaddy preview and production can share one managed database. Owner changes in private preview therefore affect the workspace public visitors read. Keep previews from collecting or performing destructive tests against production data. Run one authoritative scheduled collector at 07:00 and 13:00 America/Phoenix while the host keeps the Node process available. The public variant may run that internal scheduler after cutover; public visitors cannot trigger collection. Owner-password access uses app sign-in, private-preview access uses GoDaddy's gateway, and public access is read-only. Health returns only a minimal status.

No database, backup, credential file, hosting token, private deployment identifier or source-host metadata belongs in this repository. Keep data-transfer files outside the checkout and public directories. The current test suite uses real local SQLite and asynchronous MySQL protocol fixtures; a live managed MySQL/TLS smoke test remains necessary before production cutover.
