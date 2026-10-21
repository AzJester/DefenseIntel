# Sites viewer

Insightful Defense currently uses Sites hosting. The public viewer reads the existing authoritative owner workspace. Visitors can browse shared intelligence, charts, reports and capture plans, but cannot change shared data or trigger collection. The existing owner sign-in remains the editable workspace. The public viewer adds no app password or separate owner account.

The current hosting path requires no paid GoDaddy purchase. The repository also includes a portable Node/MySQL hosting alternative under `hosting/`; it is separate from this Sites adapter and is not the current authoritative deployment.

## Source layout

- `gateway.mjs` is the canonical read-only gateway, with synthetic tests in `gateway.test.mjs`.
- `site/` is the deployable Vinext/Sites framework adapter, including its exact dependency lock and build tooling.
- The repository's root `public/` remains the only authored frontend asset directory.
- `site/scripts/prepare-viewer.mjs` stages root `public/` into ignored `site/public/`, and stages `gateway.mjs` into ignored `site/lib/gateway.mjs`. Do not edit or commit these generated copies.

The adapter contains no deployment project identity, private source address, source credential, owner email, workspace backup, database or collection schedule. Its checked-in `.openai/hosting.json` contains only `d1: null` and `r2: null`. Persistence and automated collection stay with the original owner workspace.

## Build

Use Node.js 22.13 or later. From the complete repository:

```sh
cd sites-viewer/site
npm run install:ci
npm run build
```

The locked installation includes the framework's development and optional build dependencies. Both `npm run dev` and `npm run build` prepare the canonical frontend and gateway first. `npm run prepare:viewer` can stage them separately. Local and build state, copied assets, dependency directories and environment files are ignored.

Keep this adapter in its repository layout while building so the prepare script can find the root assets and canonical gateway. Use the Sites deployment workflow with `site/` as the app source. If that workflow binds a project locally, keep its deployment identity out of committed source. No change to the live owner workspace is needed to build this viewer.

## Server-only runtime configuration

Configure these values through private Sites hosting settings:

| Setting | Purpose |
| --- | --- |
| `SOURCE_SITE_URL` | The fixed HTTPS origin of the existing private owner workspace on Sites. The gateway accepts one origin, without path, query or credentials. |
| `SOURCE_SITE_TOKEN` | Its server-side Sites source credential. It is used only for the fixed upstream workspace endpoint and never returned to the browser. |

Do not place either value in `public/`, client code, committed manifests or an example containing real values. Builds do not need them; API requests require valid runtime configuration.

`GET /api/workspace` returns the allowlisted shared workspace fields and `access: {mode: 'public', readOnly: true, editorUrl: ...}`. The frontend uses that owner link and does not add its own sign-in form. `GET /api/auth` returns public access metadata, without credentials. The only accepted POST actions are a no-op bootstrap, validated saved-snapshot reads and validated ephemeral report exports. Ephemeral exports use canonical source evidence without saving a new shared snapshot. Editing, imports, backup access, ingest and refresh are denied. Upstream redirects are never followed with the private credential.

## Verification

From the repository root, `npm test` runs the portable-host tests, gateway tests and adapter preparation tests. The gateway fixtures check source boundaries, canonical evidence, read-only actions, redaction and failure handling. The preparation fixtures check asset staging, stale-copy cleanup, dependency-lock consistency and the identity-free hosting manifest. Tests contain no operational data and do not deploy a Site.
