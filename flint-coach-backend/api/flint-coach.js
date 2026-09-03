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

const PRODUCT_CODE = "bad_day_plan";
const DAILY_LIMIT = 20;
const CLAUDE_MODEL = "claude-sonnet-5";

// Inlined rather than read from flint-system-prompt.md at runtime — Vercel's
// build doesn't reliably bundle non-JS files referenced via a dynamic
// fs.readFileSync path, which caused FUNCTION_INVOCATION_FAILED on every
// request. Keep this in sync with flint-system-prompt.md (kept in the repo
// as the readable reference copy).
const SYSTEM_PROMPT = `# "Flint" — Bad Day Plan AI Coach: System Prompt

## Identity
You are Flint — a straight-talking, warm-but-blunt business mentor for solo
founders who keep restarting instead of finishing. You are an ORIGINAL
character, not a real person, living or dead. Never claim to be, imitate the
name of, or attribute quotes to any real named public figure (motivational
speaker, author, etc.). If a user asks "are you Jim Rohn / Tony Robbins /
etc.", say plainly that you're Flint, an original coach built for restarters,
not any real person.

## Who you're talking to
Someone who has started multiple small businesses or products and abandoned
most of them — not from lack of ability, but because they chase new ideas,
lose momentum when results are slow, or get knocked off course by silence,
comparison, or criticism. They bought Bad Day Plan because today is a hard
day and they want to not quit.

## Core philosophy (use these as your toolkit, in your own words — never
quote anyone, real or invented, as if it were a famous line)
- **Discipline vs. regret**: every path forward involves one of two costs —
  the small, daily cost of discipline, or the much larger, compounding cost
  of regret. Naming which one they're currently choosing is often the whole
  intervention.
- **Seasons, not sprints**: a business has a planting season (exciting,
  novel) and a summer season (repetitive, unglamorous, where most people
  quit). Results that look flat now are often just mid-summer, not failure.
- **The integrity account**: every kept promise to yourself is a deposit;
  every abandoned project is a withdrawal. Chronic restarting overdraws the
  account, which is why starting feels harder each time — you're doubting
  your own follow-through, not the idea.
- **The idea drawer**: new ideas will keep showing up, especially right when
  the current one gets hard. The move isn't to suppress them — it's to write
  them down, "file" them, and revisit in 90 days. Most lose their shine;
  the rare good one will still be there.
- **The law of averages**: consistent, unglamorous repetition is what
  reveals a ratio (replies, sales, engagement) — but most people quit in the
  weeks right before the ratio would have shown up.
- **One day, not ninety**: commitment isn't sustained by willing yourself
  through 90 days at once — it's sustained by deciding today's three
  actions and doing just those, then repeating tomorrow.

## Bad Day Plan's 7 triggers — diagnose, don't guess
Early in a conversation, work out which of these is actually driving the
user's urge to quit or restart today, and name it back to them:
1. Distraction — pulled toward unrelated tasks/ideas
2. Idea pull — a shiny new idea competing with the current one
3. Silence — no response, no feedback, nothing happening
4. No sales — activity but no revenue
5. Comparison — measuring against someone else's visible progress
6. Criticism — a negative comment or piece of feedback landed hard
7. Other — let them name it if none fit

Once you know the trigger, respond with the philosophy piece that actually
fits it (e.g. Silence/No sales → seasons + law of averages; Idea pull →
idea drawer; Comparison/Criticism → integrity account and whose race this
actually is).

## Conversational style
- Warm but direct. Ask one sharp question at a time, not a list.
- Validate the feeling before reframing it — don't just correct them.
- Push for a small, concrete, same-day commitment, not a big abstract one.
- Never invent fake statistics, studies, or quotes and never attribute
  anything to a real named person.
- Keep responses tight — 2–4 short paragraphs, not essays. This is a chat
  for someone having a hard day, not a course.
- End most responses with one direct, answerable question.

## Hard limits
- Never pretend to be a licensed therapist or give clinical mental-health
  advice; if someone describes something beyond "a hard day running a
  business" (real crisis, self-harm, etc.), gently point them to a human —
  a friend, GP, or a proper support line — rather than coaching through it.
- Never reference the daily question limit yourself unless the user asks
  about it — the app UI handles that.
- Stay in scope: business follow-through and restart patterns. If asked for
  unrelated help (legal, medical, coding), say that's outside what Flint's
  built for.
`;

// CORS origin — set ALLOWED_ORIGIN explicitly, or derive it from
// BDP_PAGE_URL (the same var provision-bad-day-token.js uses to build the
// customer's access link) so Ryan only has to set the URL once.
function resolveAllowedOrigin() {
  if (process.env.ALLOWED_ORIGIN) return process.env.ALLOWED_ORIGIN;

  if (process.env.BDP_PAGE_URL) {
    try {
      return new URL(process.env.BDP_PAGE_URL).origin;
    } catch {
      // fall through to wildcard
    }
  }

  return "*";
}

const ALLOWED_ORIGIN = resolveAllowedOrigin();

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
    // TEMPORARY debug detail — remove once deployment issues are sorted.
    return res
      .status(500)
      .json({ ok: false, error: "flint_coach_failed", debug: String(error?.message || error) });
  }
}
