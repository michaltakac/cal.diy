# Local patches (michaltakac/cal.diy fork)

This fork tracks upstream `calcom/cal.diy`. Every divergence from upstream is
recorded here so it can be re-applied / dropped cleanly on rebase. Keep this
list minimal — prefer config/env over code changes.

## P1 — Opt the production build out of Turbopack (`--webpack`)

- **File:** `apps/web/package.json`
- **Change:** `"build": "next build && yarn sentry:release"` →
  `"build": "next build --webpack && yarn sentry:release"`
- **Why:** Next.js 16 makes **Turbopack the default for `next build`**. The
  cal.com web app's Turbopack production build crashes in the containerized
  build (`exit code: 129`, deterministic ~3s into "Creating an optimized
  production build", before any route compilation). `NEXT_TURBOPACK=0` has
  **no effect** in Next 16 — there is no env opt-out; the documented opt-out
  is the `--webpack` CLI flag (Next.js 16 upgrade guide → "Opt out to Webpack
  in package.json"). cal.com still ships full webpack config in
  `apps/web/next.config.ts`, so `--webpack` builds with the supported path.
- **Tracking issue:** AGE-18.
- **Drop when:** upstream cal.diy either pins a Turbopack-build-safe Next.js
  version or adds `--webpack` itself. Check upstream `apps/web/package.json`
  `build` script on each rebase; if it already contains `--webpack` (or
  upstream's Turbopack build is verified working), delete this patch.
- **Scope:** production `next build` only. `dev` still uses
  `next dev --turbopack` (unchanged) so local DX is unaffected.
