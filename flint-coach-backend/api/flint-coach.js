// Vercel serverless function: chat endpoint for the "Flint" coach feature
// on Bad Day Plan. Bad Day Plan is a separate static site, so this gets
// called cross-origin — CORS is handled below.
//
// Expects POST body: { token: string, message: string, history?: [{role, content}] }
// `token` is the per-customer access token issued at Bad Day Plan checkout
// (see api/provision-bad-day-token.js). Redis keys are namespaced under
// "bdp:" so they never collide with the "oof:" keys used by the separate
// One Offer Forward tool, even if both share the same Upstash database.

import { Redis } from "@upstash/redis";
import fs from "fs";
import path from "path";

const PRODUCT_CODE = "bad_day_plan";
const DAILY_LIMIT = 20;
const CLAUDE_MODEL = "claude-sonnet-5";

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(process.cwd(), "flint-system-prompt.md"),
  "utf-8"
);

// Set via ALLOWED_ORIGIN env var — the live Bad Day Plan URL.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

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

function quotaKey(token) {
  const today = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  return `bdp:quota:${token}:${today}`;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  try {
    const { token, message, history = [] } = req.body || {};

    if (!token || typeof token !== "string" || !message) {
      return res
        .status(400)
        .json({ ok: false, error: "missing_token_or_message" });
    }

    const redis = getRedisClient();

    // --- 1. Validate token belongs to a real, active Bad Day Plan customer ---
    const record = normaliseRecord(await redis.get(`bdp:token:${token}`));

    if (!record) {
      return res.status(403).json({ ok: false, error: "invalid_access_token" });
    }

    if (record.productCode && record.productCode !== PRODUCT_CODE) {
      return res.status(403).json({ ok: false, error: "wrong_product" });
    }

    if (record.status !== "active") {
      return res.status(403).json({ ok: false, error: "access_inactive" });
    }

    // --- 2. Enforce 20 questions/day, resetting at UTC midnight ---
    const key = quotaKey(token);
    const used = await redis.incr(key);
    if (used === 1) {
      const secondsUntilMidnight = Math.ceil(
        (new Date().setUTCHours(24, 0, 0, 0) - Date.now()) / 1000
      );
      await redis.expire(key, secondsUntilMidnight);
    }

    if (used > DAILY_LIMIT) {
      return res.status(429).json({
        ok: false,
        error: "daily_limit_reached",
        message:
          "That's today's 20 questions with Flint. Come back tomorrow — " +
          "and in the meantime, do the three things you already told him you would.",
        remaining: 0,
      });
    }

    // --- 3. Call the Anthropic API with the Flint persona ---
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: [...history, { role: "user", content: message }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", errText);
      return res
        .status(502)
        .json({ ok: false, error: "coach_unavailable" });
    }

    const data = await response.json();
    const reply = data.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    return res.status(200).json({
      ok: true,
      reply,
      remaining: DAILY_LIMIT - used,
    });
  } catch (error) {
    console.error("Flint coach error:", error);
    return res.status(500).json({ ok: false, error: "flint_coach_failed" });
  }
}
