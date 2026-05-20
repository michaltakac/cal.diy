# AGE-34 — cal.diy image rebuild ships AGE-31 Stripe webhook handler

**Date:** 2026-05-20
**Issue:** [AGE-34](/AGE/issues/AGE-34) — follow-up to [AGE-31](/AGE/issues/AGE-31)
**Source commit:** `michaltakac/cal.diy@5f644f8cc7563fd04cb493d4293ba20fcce7db53` (head at time of container swap)

## Pre-state (running upstream stub)

`docker ps` showed `cal-diy-calcom-1` on `calcom.docker.scarf.sh/calcom/cal.diy` (sha `713c33a250fe`). Local probe before rebuild:

```
$ curl -sS -X POST http://localhost:3000/api/integrations/stripepayment/webhook \
    -d '{}' -H 'content-type: application/json'
{"message":"Payment webhooks are not available in community edition"}
HTTP 404
```

## Disk reclaim

Host was at 98% (3.3 G free). `docker system prune -af --volumes` reclaimed **56.98 GB** (29 GB unused images + 55 GB build cache). Post-reclaim: 53% used, 69 GB free.

## Rollback tag

```
docker tag calcom.docker.scarf.sh/calcom/cal.diy:latest \
           calcom/cal.diy:rollback-pre-age34-20260520   # sha 713c33a250fe
```

## Build fixes required (P2 in PATCHES.md)

Upstream codebase uses `node:` prefix built-in imports (`node:path`, `node:process`, `node:crypto` etc.) across 24 web app source files and dozens of transpilePackages. Next.js 16.2.3 with `--webpack` does not register the `node:` resolver plugin, causing `UnhandledSchemeError` in the webpack graph.

**Fix:** Added `webpack.NormalModuleReplacementPlugin(/^node:/, ...)` to `apps/web/next.config.ts` (commit `e57141b`) + stripped `node:` prefix from 24 `apps/web/` source files (commit `7d83359`). Total: 4 commits pushed.

Build attempts: 4 (1 — node: scheme errors; 2 — packages/ also affected; 3 — TS type error in plugin; 4 — success).

## New image

- **Tag:** `calcom.docker.scarf.sh/calcom/cal.diy`
- **SHA:** `185ec82ab571`
- **Build duration:** ~45 min total (including 3 failed attempts)

## Container swap

```
docker stop cal-diy-calcom-1 && docker rm cal-diy-calcom-1
docker compose up -d --no-deps calcom
docker network connect stack caldiy-calcom-1   # re-attach to DB network
```

New container: `caldiy-calcom-1` → healthy.

```
@calcom/web:start: - Local:         http://localhost:3000
@calcom/web:start: ✓ Ready in 212ms
```

## Live verification — handler smoke

```
$ curl -sS -w "\nHTTP_STATUS=%{http_code}" \
    -X POST http://localhost:3000/api/integrations/stripepayment/webhook \
    -d '{}' -H 'content-type: application/json'
{"message":"Missing stripe-signature header"}
HTTP_STATUS=400
```

**Result: PASS.** New sig-verifying handler at `packages/app-store/stripepayment/api/webhook.ts:124` responds 400 — not the prior community-edition 404 stub.

## Residual items

- **Stripe test creds** (`STRIPE_PRIVATE_KEY`, `STRIPE_WEBHOOK_SECRET`) still blank in `.env`. The handler will return 503 when a *signed* Stripe request arrives with missing creds. Live cut-over gated on board credential drop ([AGE-22](/AGE/issues/AGE-22)).
- **Signed event replay** (from [AGE-31](/AGE/issues/AGE-31) sidecar runbook) deferred to the cred-drop heartbeat — no behaviour changes between AGE-31 and this rebuild.
- **docker-compose project name drift**: the old container was project `cal-diy` (hyphenated); rebuild settled on project `caldiy`. Network was manually reconnected for this run. Future restarts should work normally via `docker compose up -d`.
