# AGENTS.md — grid-apps

## What this repo is

Monorepo for three browser apps sharing one codebase and one dev server:

| App | Purpose | Entry | Source |
| --- | --- | --- | --- |
| kiri:moto | CNC / FDM / SLA / laser slicer (mature) | `src/main/kiri.js` | `src/kiri/` |
| mesh:tool | 3D mesh editor & repair | `src/main/mesh.js` | `src/mesh/` |
| void:form | Parametric CAD (active dev) | `src/main/void.js` | `src/void/` |

- Shared infra lives in `src/moto/` (viewport `space.js`, event bus `broker.js`, camera `orbit.js`), `src/geo/` (math/geometry), `src/load/` (file-format loaders), `src/ext/` (vendored/generated libs). Changes in `src/moto/` affect all three apps.
- `web/` holds each app's static shell (HTML, fonts, icons); app logic is bundled into `src/pack/*.js` (gitignored, generated).
- `app.js` + `@gridspace/app-server` (`gs-app-server`) is the Node server. Routes: `/kiri/`, `/mesh/`, `/void/` (alias `/form/`) on port 8080. It rewrites `/lib/main/*.js` requests to the generated `/lib/pack/*.js` bundles.

## Commands

There is **no test suite, linter, or typechecker for `src/`**. Verification = successful build + loading the app in a browser.

```bash
npm run setup     # REQUIRED after clone and after dependency changes
npm run dev       # bundle (dev) + start server on :8080  → open http://localhost:8080/kiri
npm run pack-dev  # bundle only: esbuild apps + dryrun + dev bundles (fast sanity check)
npm run start     # full prebuild + Electron desktop app
npm run prod      # production bundle + server
```

Gotchas:

- `npm run setup` runs `clean` first: it **deletes** `alt/ build/ data/ dist/ src/pack/ tmp/` and more. Don't keep uncommitted work there.
- `src/ext/three.js`, `src/ext/jszip-esm.js`, `src/ext/quickjs.js`, `src/void/solver/`, and `web/boot/bundle*` are **generated and gitignored** — a fresh clone cannot bundle until `npm run setup` runs (`webpack-ext` copies them out of `node_modules` and webpacks them).
- `npm run webpack-src` is **esbuild**, not webpack (`bin/esbuild.config.mjs`); it emits `src/pack/{kiri,mesh,void}-main.js`. Actual webpack is used only for the `webpack-ext` sub-bundles (`bin/webpack-*-esm.js`).
- Engines say Node >= 22, but CI runs Node 20 — don't rely on Node-22-only features.
- Docs (Docusaurus, `docs/`): `npm run docs-dev` to preview, `npm run docs-check` for the Prettier check (`conf/prettier.config.js`). CI workflows ignore `docs/**` changes except the (currently no-op) Prettier check.

## CI / release

- Pushes (non-docs) trigger `npm run setup && npm run dryrun-prod` and an Electron `build-nopublish` on ubuntu/windows — these are the de-facto "tests".
- Releases are cut by pushing a `v*` tag (`.github/workflows/build.yml`); version bumps go through `bin/update-version.sh <version>` (updates `package.json`, `src/moto/license.js`, `web/kiri/manifest.json` together). Release notes live in `docs/release.md`.
- Default branch: `master`.

## In-repo agent documentation

`docs/agents.md` is a long, detailed agent guide (per-app architecture, void:form worklog, Three.js rules). Useful, but treat its **paths and git/branch claims as stale** (hard-coded `/Users/stewart/...`, old branch names) — trust the code over it. Its still-valid critical rules, worth keeping in mind:

- Never `SCENE.add()` — use `space.world.add()`.
- `depthWrite: false` on transparent materials; dispose Three.js geometry/materials you remove.
- Heavy computation goes in workers (`src/kiri/run/`, `src/mesh/work.js`), never the main thread.
- Use the `src/moto/broker.js` event pattern in kiri:moto / mesh:tool; void:form uses direct module calls instead.
- Never modify shared `src/moto/` code without checking all three apps.

## void:form specifics (active development area)

- `docs/void/plan-geomgraph.md` and `docs/void/plan-derived.md` track the in-flight geometry refactor; `docs/agents.md` carries a long running status log — read the relevant section before touching `src/void/`.
- Canonical entity ids (`surface:*`, `segment:*`, `boundary:*`) flow through `src/void/interact/selection_resolver.js`; sketch profile targets use `region_id`.
- Sketch constraints use the planegcs solver (`@salusoft89/planegcs`, wasm copied into `src/void/solver/` by `npm run setup`) with a legacy fallback solver in `src/void/sketch/constraints_fallback.js`.
- Terminology used consistently in code/docs: `segment` (boundary edge), `chain` (open polyline), `loop` (closed polyline), `surface` (face patch), `region` (enclosed 2D sketch profile).
