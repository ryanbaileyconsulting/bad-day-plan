# Flint Coach Backend

Vercel serverless backend for the "Flint" AI coach feature on Bad Day Plan
(`../bad-day-plan.html`). Matches the pattern used by the One Offer Forward
project (Vercel functions + Upstash Redis), reusing the **same Upstash
database and the same style of quota tracking**, with all keys namespaced
under `bdp:` so they never collide with OOF's `oof:*` keys even though they
share one database.

Note: this is a separate quota from OOF's — Bad Day Plan tracks its own
20-messages/day Flint quota per customer, not shared with OOF's per-purchase
generation credits. Sharing the database is safe; sharing the counters
themselves would mean a customer's Bad Day Plan chats could eat into their
OOF generation runs (or vice versa), which isn't what "same credit pool"
should mean here. Say if you actually want the two products' usage to draw
from one merged pool instead — that'd need a different design.

## Endpoints

- `POST /api/flint-coach` — chat endpoint. Validates the customer's token,
  enforces 20 messages/day (UTC reset), calls the Anthropic API with the
  Flint system prompt, returns the reply.
- `POST /api/provision-bad-day-token` — Systeme.io purchase webhook. Mints a
  `bdp_...` access token on purchase, stores it in Redis, and **emails the
  customer their link directly via Resend** (see "Why we email it
  ourselves" below).
- `GET /api/my-links?email=...` — looks up every product an email has
  active access to (OOF + Bad Day Plan today, more as the ladder grows) and
  renders a simple page of "Launch" links. Built for a Systeme.io Membership
  Site to use as a single logged-in dashboard, without embedding any tool's
  actual HTML/JS inside Systeme's editor — see "The membership dashboard"
  below.

## Required environment variables

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Calls the Anthropic Messages API for Flint's replies |
| `UPSTASH_REDIS_REST_URL` / `KV_REST_API_URL` | Same Upstash database as OOF |
| `UPSTASH_REDIS_REST_TOKEN` / `KV_REST_API_TOKEN` | Same Upstash database as OOF |
| `BDP_PAGE_URL` | The live Bad Day Plan URL, e.g. `https://ryan.github.io/bad-day-plan/bad-day-plan.html` — used both to build the customer's access link and (unless `ALLOWED_ORIGIN` is also set) to derive CORS |
| `ALLOWED_ORIGIN` | Optional. Overrides the CORS origin if it should differ from `BDP_PAGE_URL`'s origin |
| `BDP_WEBHOOK_SECRET` | Shared secret Systeme.io must pass as `?secret=` on the provisioning webhook |
| `RESEND_API_KEY` | Sends the delivery email (resend.com) |
| `BDP_FROM_EMAIL` | The verified "from" address/name, e.g. `Bad Day Plan <hello@yourdomain.com>` |

## Why we email it ourselves

Systeme.io's outbound automation webhooks are fire-and-forget — Systeme.io
doesn't read this function's response back into a contact field for its own
email templates to use. So instead of trying to get the per-buyer link into
a Systeme.io merge tag, `provision-bad-day-token.js` sends the delivery
email itself (via Resend) the moment it mints the token, straight to the
email address in the purchase webhook payload.

## What you need to do in Systeme.io

1. **Tag the purchase.** On the Bad Day Plan product/order settings, under
   "Actions on purchase" (or your funnel's post-purchase automation), add
   the tag `Purchased - Bad Day Plan` to the contact. (If you already use a
   different tag name for this product, tell me — `REQUIRED_TAG` in
   `api/provision-bad-day-token.js` has to match exactly, case-sensitive.)
2. **Add an automation rule:** Trigger = "Tag added" → `Purchased - Bad Day
   Plan`. Action = "Webhook" (POST) → 
   `https://<your-deployment>.vercel.app/api/provision-bad-day-token?secret=<BDP_WEBHOOK_SECRET>`.
   This is the same shape OOF already uses for `provision-token.js`, so if
   you've set that up before this will look familiar.
3. **Turn off (or don't add) a separate Systeme.io delivery email** for Bad
   Day Plan's access link specifically — sending that is now this backend's
   job, so a second one would double-send the link. Any other purchase
   emails (receipt, upsell, etc.) are unaffected.
4. **Trigger a real test purchase** and confirm: the tag gets applied, the
   webhook fires, and the email arrives with a working link.

## Deploy

```bash
cd flint-coach-backend
vercel link
vercel env add ANTHROPIC_API_KEY production
vercel env add UPSTASH_REDIS_REST_URL production
vercel env add UPSTASH_REDIS_REST_TOKEN production
vercel env add BDP_PAGE_URL production
vercel env add BDP_WEBHOOK_SECRET production
vercel env add RESEND_API_KEY production
vercel env add BDP_FROM_EMAIL production
vercel --prod
```

After deploying, update `FLINT_API_URL` in `../bad-day-plan.html` to point
at `https://<your-deployment>.vercel.app/api/flint-coach`.

## The membership dashboard

As the sales ladder grows (OOF → Bad Day Plan bump → upsell → future
products), customers shouldn't have to dig through separate confirmation
emails to find each tool. Rather than rebuilding login/accounts from
scratch, or embedding the actual custom-HTML tools inside Systeme's
page/lesson editor (real risk of it mangling the layout, same reasoning as
choosing GitHub Pages over Systeme for hosting Bad Day Plan itself), the
plan is:

1. A Systeme.io **Membership Site** is the single login/dashboard.
   Sections unlock per product using the same purchase tags already driving
   Redis provisioning (`Purchased - One Offer Forward`, `Purchased - Bad Day
   Plan`, etc.).
2. Each unlocked section just has a **"Launch" button** linking to
   `/api/my-links?email={{contact.email}}` (or whatever Systeme's actual
   merge-tag syntax is for the logged-in member's own email — confirm this
   in the Membership editor, it wasn't verifiable from here).
3. `my-links` looks up that email's tokens via the `oof:email:*` /
   `bdp:email:*` reverse-lookup keys (already written by each product's
   provisioning webhook) and renders direct links to each tool, each still
   hosted exactly where it already is (Vercel / GitHub Pages) — nothing
   about the tools themselves changes.

**Security note:** this endpoint trusts whatever email it's given — it
doesn't independently verify the requester. That's fine as long as the URL
is only ever reached via a link Systeme generates for the logged-in
member's own email inside the authenticated membership area (Systeme's
login is the actual access boundary here). Don't link this URL anywhere
public. Same trust-by-obscurity tradeoff as the access tokens elsewhere in
this project, not enterprise-grade auth — acceptable for now, worth
revisiting if this grows into something handling more sensitive access.

Add `OOF_BASE_URL` as an optional env var if OOF's tool ever moves off
`https://one-offer-forward-product.vercel.app` (defaults to that, matching
`provision-token.js`'s own default).

## Still open

- Confirm the exact Systeme.io tag name for a Bad Day Plan purchase
  (`REQUIRED_TAG` is currently a placeholder guess).
- A Resend account + verified sending domain, if you don't already have one
  from another project.
