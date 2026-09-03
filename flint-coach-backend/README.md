# Flint Coach Backend

Vercel serverless backend for the "Flint" AI coach feature on Bad Day Plan
(`../bad-day-plan.html`). Matches the pattern used by the One Offer Forward
project (Vercel functions + Upstash Redis), with all Redis keys namespaced
under `bdp:` so this can safely share the same Upstash database as OOF
(`oof:*`) without key collisions.

## Endpoints

- `POST /api/flint-coach` — chat endpoint. Validates the customer's token,
  enforces 20 messages/day (UTC reset), calls the Anthropic API with the
  Flint system prompt, returns the reply.
- `POST /api/provision-bad-day-token` — Systeme.io purchase webhook. Mints a
  `bdp_...` access token on purchase and stores it in Redis. The
  `REQUIRED_TAG` constant is a placeholder — confirm the exact Systeme.io
  tag name before relying on this in production.

## Required environment variables

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Calls the Anthropic Messages API for Flint's replies |
| `UPSTASH_REDIS_REST_URL` / `KV_REST_API_URL` | Upstash Redis (either name works, matching OOF) |
| `UPSTASH_REDIS_REST_TOKEN` / `KV_REST_API_TOKEN` | Upstash Redis (either name works, matching OOF) |
| `ALLOWED_ORIGIN` | The live Bad Day Plan URL, for CORS |
| `BDP_WEBHOOK_SECRET` | Shared secret Systeme.io must pass as `?secret=` on the provisioning webhook |

## Deploy

```bash
cd flint-coach-backend
vercel link
vercel env add ANTHROPIC_API_KEY production
vercel env add UPSTASH_REDIS_REST_URL production
vercel env add UPSTASH_REDIS_REST_TOKEN production
vercel env add ALLOWED_ORIGIN production
vercel env add BDP_WEBHOOK_SECRET production
vercel --prod
```

After deploying, update `FLINT_API_URL` in `../bad-day-plan.html` to point
at `https://<your-deployment>.vercel.app/api/flint-coach`, and configure the
Systeme.io purchase webhook to POST to
`https://<your-deployment>.vercel.app/api/provision-bad-day-token?secret=<BDP_WEBHOOK_SECRET>`.

Still needs a decision from Ryan: how the customer actually receives their
access token/link after purchase (thank-you page redirect, confirmation
email, etc.) — this webhook mints the token but doesn't deliver it anywhere
yet.
