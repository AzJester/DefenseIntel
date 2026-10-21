# DefenseIntel

A private defense-industry competitive intelligence and capture workspace. The source can be reviewed independently of the owner's data and credentials. This repository contains application code, public reference material and synthetic tests, with no live workspace backup or operational secrets.

The app supports public-source competitor news, contract announcements, acquisitions and teaming; official USAspending contract actions; grouped events with configurable priorities; source history; analyst findings and cited reports; editable PowerPoint briefs and OV-1 concepts; strategy workshops and black hat and blue team reviews; pursuit comparisons with weighted bars and an assessment heatmap; the official 2022 NAICS catalog; and full capture plans with requirements, customer value, win themes, teaming, risk, gates and milestones. Analyst planning and hypotheses remain separate from cited source statements.

The intended private app hostname is `intel.insightfuldefense.com`. Domain connection and production migration are pending. The editorial apex website is separate and is not changed by this repository.

## Build and test

Use Node.js 22.13 or later:

```
npm ci --include=dev
npm run build
npm test
```

The build compiles the authored `lib/` business modules into generated `server/` files and leaves `public/`, `drizzle/` and source files in place. Generated server files and their hash manifest are included so `npm start` also works on a host that installs runtime dependencies only. Rebuild after source changes and review the generated changes together. A build phase must install development dependencies so the pinned TypeScript compiler is available. Runtime uses the pinned `mysql2` dependency. `db/schema.ts` documents the original schema; the checked-in Drizzle SQL journal controls database creation.

## Private hosting and migration

Production requires managed MySQL, HTTPS, an explicit owner account and session secret. Configure the values described in [.env.example](.env.example) through the host's secret store. The server never loads an account or secret from a public asset. See the detailed [hosting guide](hosting/README.md) for certificate validation, migrations, authenticated APIs, backups and local SQLite testing.

For the first deployment, keep `IMPORT_REQUIRED=true` and `ENABLE_SCHEDULER=false`. The app will allow owner sign-in and a private import screen, while bootstrap, workspace data routes and collection remain disabled. Transfer the owner-only `/api/backup` export into the empty managed database, either through the authenticated import screen (20 MB maximum) or the offline importer (100 MB maximum). The importer validates the ten supported tables, refuses existing data, commits all imported rows and its completion marker atomically, and reports counts only. Restart or redeploy after a successful import. Verify the restored competitor directory, planning data, source versions and saved reports before enabling the new scheduler and disabling the old one.

The source app's full tracked competitor directory and planning history are owner data transferred through that backup, rather than operational data embedded in this repository. New blank development installs use the public starter directory until the owner adds or restores their competitors.

GoDaddy preview and production can share one managed database. Keep previews from collecting or performing destructive tests against production data. Run one authoritative scheduled collector at 07:00 and 13:00 America/Phoenix while the host keeps the Node process available. Every application asset and data endpoint is protected by owner sign-in; state-changing requests require the exact configured Origin and session CSRF token. Health returns only a minimal status.

No database, backup, credential file, hosting token, private deployment identifier or source-host metadata belongs in this repository. Keep data-transfer files outside the checkout and public directories. The current test suite uses real local SQLite and asynchronous MySQL protocol fixtures; a live managed MySQL/TLS smoke test remains necessary before production cutover.
