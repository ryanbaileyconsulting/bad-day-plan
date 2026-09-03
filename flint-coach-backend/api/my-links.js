// Vercel serverless function: aggregates a customer's purchased tools into
// one page, keyed by email. Built so a single Systeme.io Membership Site
// can act as one dashboard for the whole sales ladder (OOF, Bad Day Plan,
// future upsells) without embedding any of the tools' custom HTML/JS
// inside Systeme's page/lesson editor — each product still lives on its
// own Vercel deployment exactly as before; this just looks up and links
// to the customer's personal access URL for each one they've bought.
//
// Intended use: a "Launch my tools" button inside the logged-in Systeme
// membership area, linking to /api/my-links?email={{contact.email}} (or
// whatever Systeme's merge-tag syntax turns out to be for a member's own
// email — confirm this once you're in the Membership editor).
//
// Security note: this endpoint trusts the email it's given — it doesn't
// re-verify who's asking. That's fine as long as this URL is only ever
// reached via a link generated for the logged-in member's own email
// inside Systeme's authenticated membership area (Systeme's login is the
// actual access boundary). Never link this URL anywhere public, and never
// let a customer edit the email in it and expect it to stay secure —
// anyone who knows another customer's email could look up their links.
// Same trust-by-obscurity tradeoff as the rest of this project's access
// tokens, not enterprise-grade auth.

import { Redis } from "@upstash/redis";

const OOF_PRODUCT_CODE = "one_offer_forward";
const BDP_PRODUCT_CODE = "bad_day_plan";

const OOF_BASE_URL =
  process.env.OOF_BASE_URL ||
  process.env.TOOL_BASE_URL ||
  "https://one-offer-forward-product.vercel.app";

function getRedisClient() {
  const url =
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;

  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error("Redis environment variables are missing");
  }

  return new Redis({ url, token });
}

function normaliseRecord(value) {
  if (!value) return null;
  if (typeof value === "object") return value;

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  return null;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function findOofLink(redis, email) {
  const token = await redis.get(`oof:email:${email}`);
  if (typeof token !== "string") return null;

  const record = normaliseRecord(await redis.get(`oof:token:${token}`));
  if (!record || record.status !== "active") return null;
  if (record.productCode && record.productCode !== OOF_PRODUCT_CODE) return null;

  const expiryTime = Date.parse(record.expiresAt);
  if (Number.isFinite(expiryTime) && expiryTime <= Date.now()) return null;

  return {
    name: "One Offer Forward",
    description: "Your 24-hour offer launch tool",
    url: `${OOF_BASE_URL}/?access=${encodeURIComponent(token)}`,
  };
}

async function findBdpLink(redis, email) {
  if (!process.env.BDP_PAGE_URL) return null;

  const token = await redis.get(`bdp:email:${email}`);
  if (typeof token !== "string") return null;

  const record = normaliseRecord(await redis.get(`bdp:token:${token}`));
  if (!record || record.status !== "active") return null;
  if (record.productCode && record.productCode !== BDP_PRODUCT_CODE) return null;

  const base = process.env.BDP_PAGE_URL.replace(/\/+$/, "");
  return {
    name: "The Bad Day Plan",
    description: "Your plan, and Flint your restart coach",
    url: `${base}?token=${encodeURIComponent(token)}`,
  };
}

function renderPage(email, products) {
  const items = products.length
    ? products
        .map(
          (p) => `
        <a class="tool-card" href="${p.url}">
          <span class="tool-name">${escapeHtml(p.name)}</span>
          <span class="tool-desc">${escapeHtml(p.description)}</span>
          <span class="tool-cta">Launch →</span>
        </a>`
        )
        .join("\n")
    : `<p class="empty">No active products found for ${escapeHtml(
        email
      )} yet. If you just purchased, check back in a minute, or contact support if this doesn't update.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Your tools</title>
<style>
  body{ margin:0; background:#E9DFCC; color:#2E2417; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  .wrap{ max-width:520px; margin:0 auto; padding:48px 20px; }
  h1{ font-size:22px; margin-bottom:24px; }
  .tool-card{
    display:block; background:#fff; border-radius:12px; padding:20px;
    margin-bottom:14px; text-decoration:none; color:#2E2417;
    box-shadow:0 4px 16px rgba(43,33,23,0.08);
  }
  .tool-name{ display:block; font-weight:600; font-size:16px; margin-bottom:4px; }
  .tool-desc{ display:block; font-size:13px; color:#8C7E68; margin-bottom:10px; }
  .tool-cta{ display:inline-block; font-size:13px; font-weight:600; color:#C9A66B; }
  .empty{ font-size:14px; color:#8C7E68; line-height:1.6; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Your tools</h1>
    ${items}
  </div>
</body>
</html>`;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const emailParam = Array.isArray(req.query?.email)
    ? req.query.email[0]
    : req.query?.email;
  const email = (emailParam || "").trim().toLowerCase();

  if (!email) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(400).send("Missing email.");
  }

  try {
    const redis = getRedisClient();

    const [oof, bdp] = await Promise.all([
      findOofLink(redis, email),
      findBdpLink(redis, email),
    ]);

    const products = [oof, bdp].filter(Boolean);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(renderPage(email, products));
  } catch (error) {
    console.error("my-links error:", error);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(500).send("Something went wrong loading your tools.");
  }
}
