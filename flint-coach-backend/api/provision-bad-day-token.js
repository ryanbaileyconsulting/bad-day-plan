// Vercel serverless function: Systeme.io purchase webhook for Bad Day Plan.
// Mirrors the pattern used by One Offer Forward's api/provision-token.js —
// on a successful purchase, Systeme.io calls this endpoint, which mints a
// per-customer access token, stores it in Redis under the "bdp:" namespace
// (so api/flint-coach.js can validate it), and emails the customer their
// access link directly via Resend.
//
// We send the email ourselves rather than relying on a Systeme.io merge
// field, because Systeme.io's outbound automation webhooks are
// fire-and-forget — nothing reads this function's response back into a
// contact field for their own email templates to use.
//
// NOTE: REQUIRED_TAG below is a placeholder. Confirm the exact tag name
// Systeme.io sends for a Bad Day Plan purchase (trigger a real test webhook
// and check the payload) before relying on this in production.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { Redis } from "@upstash/redis";

const REQUIRED_TAG = "Purchased - Bad Day Plan"; // TODO: confirm exact tag name with Ryan
const PRODUCT_CODE = "bad_day_plan";

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

function secretsMatch(provided, expected) {
  if (!provided || !expected) return false;

  const providedBuffer = Buffer.from(String(provided));
  const expectedBuffer = Buffer.from(String(expected));

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

function createAccessUrl(token) {
  const pageUrl = process.env.BDP_PAGE_URL;
  if (!pageUrl) return null;

  const base = pageUrl.replace(/\/+$/, "");
  return `${base}?token=${encodeURIComponent(token)}`;
}

async function sendDeliveryEmail(email, accessUrl) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.BDP_FROM_EMAIL;

  if (!apiKey || !from || !accessUrl) {
    console.error(
      "Skipping delivery email: RESEND_API_KEY, BDP_FROM_EMAIL, or " +
        "BDP_PAGE_URL is not configured."
    );
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: "Your Bad Day Plan link",
      html: `
        <p>Here's your link to The Bad Day Plan — bookmark it, you'll want it on the day you need it:</p>
        <p><a href="${accessUrl}">${accessUrl}</a></p>
        <p>This link also unlocks Flint, the coach built into the page, if you want to talk something through.</p>
      `,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("Resend delivery email failed:", errText);
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  try {
    const expectedSecret = process.env.BDP_WEBHOOK_SECRET;

    if (!expectedSecret) {
      return res
        .status(500)
        .json({ ok: false, error: "webhook_secret_not_configured" });
    }

    const suppliedSecret = Array.isArray(req.query?.secret)
      ? req.query.secret[0]
      : req.query?.secret;

    if (!secretsMatch(suppliedSecret, expectedSecret)) {
      return res.status(401).json({ ok: false, error: "unauthorised" });
    }

    let payload = req.body;

    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        return res.status(400).json({ ok: false, error: "invalid_json" });
      }
    }

    if (payload?.type !== "contact.tag.added") {
      return res.status(400).json({ ok: false, error: "unexpected_event_type" });
    }

    const tagName = payload?.data?.tag?.name;
    const contact = payload?.data?.contact;
    const email = contact?.email?.trim().toLowerCase();
    const contactId = contact?.id;

    if (tagName !== REQUIRED_TAG) {
      return res.status(400).json({ ok: false, error: "unexpected_tag" });
    }

    if (!email || !contactId) {
      return res
        .status(400)
        .json({ ok: false, error: "missing_contact_details" });
    }

    const redis = getRedisClient();
    const contactKey = `bdp:contact:${contactId}`;

    /*
     * If Systeme sends the same event twice, return the existing token
     * without re-minting or re-emailing.
     */
    const existingToken = await redis.get(contactKey);

    if (typeof existingToken === "string") {
      const existingRecord = await redis.get(`bdp:token:${existingToken}`);

      if (existingRecord?.status === "active") {
        return res.status(200).json({
          ok: true,
          alreadyProvisioned: true,
          accessToken: existingToken,
        });
      }
    }

    const accessToken = `bdp_${randomBytes(24).toString("base64url")}`;

    const accessRecord = {
      productCode: PRODUCT_CODE,
      email,
      contactId: String(contactId),
      status: "active",
      createdAt: new Date().toISOString(),
    };

    await redis.set(`bdp:token:${accessToken}`, accessRecord);
    await redis.set(contactKey, accessToken);
    await redis.set(`bdp:email:${email}`, accessToken);

    const accessUrl = createAccessUrl(accessToken);
    await sendDeliveryEmail(email, accessUrl);

    return res.status(200).json({
      ok: true,
      alreadyProvisioned: false,
      accessToken,
    });
  } catch (error) {
    console.error("Bad Day Plan provisioning error:", error);
    return res.status(500).json({ ok: false, error: "provisioning_failed" });
  }
}
