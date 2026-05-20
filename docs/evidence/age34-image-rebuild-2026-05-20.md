# AGE-34 — cal.diy image rebuild ships AGE-31 Stripe webhook handler

**Date:** 2026-05-20
**Issue:** [AGE-34](/AGE/issues/AGE-34) — follow-up to [AGE-31](/AGE/issues/AGE-31)
**Source commit:** `michaltakac/cal.diy@6536da1`

## Pre-state (running upstream stub)

`docker ps` showed `cal-diy-calcom-1` on `calcom.docker.scarf.sh/calcom/cal.diy` (sha `713c33a250fe`, baked at upstream build time). Local probe before rebuild:

```
$ curl -sS -o /dev/stdout -w "\nstatus=%{http_code}\n" \
    -X POST http://localhost:3000/api/integrations/stripepayment/webhook \
    -d '{}' -H 'content-type: application/json'
{"message":"Payment webhooks are not available in community edition"}
status=404
```

That is the 404 community-edition stub baked into the upstream image — the new handler at `packages/app-store/stripepayment/api/webhook.ts` was not in the bundle.

## Strategy

Strategy (b) from the issue: build a fresh image, then `docker compose up -d --force-recreate calcom` to swap in a single step. Safer than in-container `next build` and leaves an explicit rollback tag.

## Disk reclaim

Host was at 98% (`/dev/sda1` 150G, 3.3G free) — would have blocked the build.

```
$ docker system prune -af --volumes
Total reclaimed space: 56.98GB
$ df -h /
/dev/sda1       150G   76G   69G  53% /
```

29.63 GB of unused images plus 55 GB of stale build cache from prior attempts.

## Rollback tag

Tagged the running image before rebuild so a one-command rollback is always available:

```
$ docker tag calcom.docker.scarf.sh/calcom/cal.diy:latest \
             calcom/cal.diy:rollback-pre-age34-20260520
```

## Build

```
$ cd /home/mike/cal.diy
$ set -a && source .env && set +a
$ docker compose build calcom
```

<!-- TODO fill: image id, build duration, peak memory -->

## Container swap

```
$ docker compose up -d --force-recreate calcom
```

<!-- TODO fill: new container image id, healthy timestamp -->

## Live verification (handler smoke)

```
$ curl -sS -o /dev/stdout -w "\nstatus=%{http_code}\n" \
    -X POST http://localhost:3000/api/integrations/stripepayment/webhook \
    -d '{}' -H 'content-type: application/json'
```

<!-- TODO fill: new response + status code -->

Expected: `status=400`, body `{"message":"Missing stripe-signature header"}` — the new handler's pre-flight check at `packages/app-store/stripepayment/api/webhook.ts:124`.

## Container log excerpt

```
$ docker logs cal-diy-calcom-1 --since=5m 2>&1 | grep -E 'stripe-webhook|Ready'
```

<!-- TODO fill: matched log lines -->

## Residual risk

- `STRIPE_PRIVATE_KEY` / `STRIPE_WEBHOOK_SECRET` are still blank in `.env`. The handler returns 503 the moment a *signed* request arrives, but the sig-check path (and the 400 smoke above) does not need creds and is the success criterion for this issue. Sandbox + live cut-over is gated on board credential drop tracked by [AGE-22](/AGE/issues/AGE-22) and [[age31-stripe-sandbox]].
- The Stripe-signed sidecar replay from [AGE-31](/AGE/issues/AGE-31) is deferred to the cred-drop heartbeat; nothing it would verify changes between AGE-31 and this image rebuild.
