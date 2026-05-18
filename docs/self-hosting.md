# Self-Hosting Cal.diy — Local Setup Guide

This guide covers running the forked **michaltakac/cal.diy** instance locally with Docker Compose.

---

## Prerequisites

| Tool | Minimum version |
|------|-----------------|
| Docker | 24+ |
| Docker Compose | v2.20+ |
| Git | any recent |

---

## Quick Start

```bash
# 1. Clone the fork
git clone https://github.com/michaltakac/cal.diy.git
cd cal.diy

# 2. Copy and review the env file
cp .env .env.local   # optional backup
# Edit .env — at minimum rotate NEXTAUTH_SECRET and CALENDSO_ENCRYPTION_KEY
#   openssl rand -base64 32   → NEXTAUTH_SECRET
#   openssl rand -hex 32      → CALENDSO_ENCRYPTION_KEY

# 3. Pull/build images
docker compose -f docker-compose.yml -f docker-compose.local.yml build calcom

# 4. Start services (db + redis + webapp)
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d

# 5. Watch logs until "Ready on http://0.0.0.0:3000"
docker compose logs -f calcom
```

App is then reachable at **http://localhost:3000**.

---

## First Run — Account Setup

1. Open http://localhost:3000
2. Click **Get Started** → create the first admin account.
3. Complete the onboarding wizard (name, timezone, availability).
4. Navigate to **Settings → Event Types** → create a test event type.
5. Open the public booking link and complete a test booking to verify the flow.

---

## Optional Services

### API v2

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml --profile api up -d calcom-api
```

API reachable at **http://localhost:80/api/v2**.

### Prisma Studio (database browser)

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml --profile studio up -d studio
```

Reachable at **http://localhost:5555**.

---

## Environment Variables Reference

| Variable | Purpose | Example |
|----------|---------|---------|
| `NEXT_PUBLIC_WEBAPP_URL` | Public URL the browser uses | `http://localhost:3000` |
| `NEXTAUTH_SECRET` | NextAuth session signing key | `openssl rand -base64 32` |
| `CALENDSO_ENCRYPTION_KEY` | App-level encryption key | `openssl rand -hex 32` |
| `DATABASE_URL` | Postgres connection string | set via `POSTGRES_*` vars |
| `REDIS_URL` | Redis connection string | `redis://redis:6379` |
| `CALCOM_TELEMETRY_DISABLED` | Disable cal.com telemetry | `1` |
| `STRIPE_API_KEY` | Stripe integration (future) | leave empty until AGE-6 |

---

## Upgrading

```bash
git pull origin main
docker compose -f docker-compose.yml -f docker-compose.local.yml build calcom
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

---

## Stopping / Cleanup

```bash
# Stop containers but keep data
docker compose -f docker-compose.yml -f docker-compose.local.yml down

# Full reset including database volume
docker compose -f docker-compose.yml -f docker-compose.local.yml down -v
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `database connection refused` | Wait for postgres healthcheck; run `docker compose logs database` |
| `NEXTAUTH_SECRET` error | Ensure `.env` has non-empty value |
| Port 3000 in use | Edit `.env`: `NEXT_PUBLIC_WEBAPP_URL=http://localhost:3001` and update `ports` in compose override |
| Build fails on ARM Mac | Add `--platform linux/amd64` to the build args or use the prebuilt image |
