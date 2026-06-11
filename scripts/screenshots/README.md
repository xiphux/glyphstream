# README screenshot pipeline

Reproducible captures for the images in `docs/images/`. Everything runs
against a **sealed demo environment** (own SQLite file, media dir, config,
mock upstream) under `scripts/screenshots/.demo-data/` — it never touches
the real `./data/` directory, so there's nothing to back up first.

The pieces:

- `mock-upstream.mjs` — OpenAI-compatible mock serving realistic model
  catalogs (three endpoints by path prefix) so the picker, favorites, and
  fan-out labels look like a real deployment.
- `config.toml` — endpoint config pointing at the mock.
- `seed.ts` — migrates a fresh demo DB and inserts crafted conversations
  (markdown rendered through the app's real server renderer), a parked
  image fan-out, procedural gradient-art media for the gallery, and a
  pre-authenticated session for Playwright.
- `capture.ts` — drives Chromium over the seeded pages and writes
  `docs/images/*.jpg` (captured at 2× scale, downscaled to 1640px wide
  and JPEG-encoded so the README loads fast).

## The dance

```bash
pnpm build                                          # production server build
pnpm exec tsx scripts/screenshots/seed.ts           # fresh demo data
node scripts/screenshots/mock-upstream.mjs &        # port 3002

HOST=127.0.0.1 PORT=3010 \
DB_PATH=./scripts/screenshots/.demo-data/demo.db \
MEDIA_DIR=./scripts/screenshots/.demo-data/media \
AUTH_SECRET=demo-screenshots-secret-not-used-32ch \
GITHUB_OAUTH_CLIENT_ID=demo-stub GITHUB_OAUTH_CLIENT_SECRET=demo-stub \
EXTERNAL_BASE_URL=http://localhost:3010 \
CONFIG_PATH=./scripts/screenshots/config.toml \
LOG_LEVEL=warn node build/index.js &                # port 3010

pnpm exec tsx scripts/screenshots/capture.ts        # writes docs/images/
```

Gotcha: re-running `seed.ts` recreates the DB file, so restart the app
server afterwards — the running process keeps an fd to the deleted file
and serves stale data.

## Git LFS

`docs/images/*` is tracked via **Git LFS** (see `.gitattributes`), so
re-captures don't bloat the repo history. Two consequences:

- **Fresh clones need `git-lfs` installed** (`brew install git-lfs` /
  distro package, then `git lfs install` once per machine). Without it the
  images check out as small text pointer files. GitHub's web UI renders
  the README images either way.
- **CI doesn't fetch LFS content by default** — `actions/checkout` leaves
  pointer files unless given `lfs: true`. No current workflow consumes
  `docs/images/`, so nothing needs to change today; set the flag if one
  ever does.
