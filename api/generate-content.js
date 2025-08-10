// Vercel Serverless Function (Node.js 런타임)
// 성공 시 { result: "..." } 반환, 실패 시 상태코드와 { error: "..." } 반환 (폴백 없음)
module.exports = async (req, res) => {
  // ---------- CORS ----------
  const rawList =
    process.env.ALLOWED_ORIGINS ||
    process.env.ALLOWED_ORIGIN ||
    "";

  const ALLOW_LIST = rawList
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(v => { try { return new URL(v).origin } catch { return v } });

  const requestOrigin = (() => {
    const o = req.headers.origin;
    if (!o) return null;
    try { return new URL(o).origin } catch { return o }
  })();

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Max-Age", "600");

  const allowAll = ALLOW_LIST.includes("*");
  const allowThis =
    allowAll ||
    (ALLOW_LIST.length === 0 && !!requestOrigin) ||
    (requestOrigin && ALLOW_LIST.includes(requestOrigin));

  if (allowAll) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (ALLOW_LIST.length === 0) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin || "*");
  } else if (allowThis && requestOrigin) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
  } else {
    if (req.method === "OPTIONS") return res.status(204).end();
    return res.status(403).json({ error: "CORS: origin not allowed" });
  }

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // ---------- Config ----------
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const HARD_TIMEOUT_MS = Math.max(15_000, Math.min(Number(process.env.HARD_TIMEOUT_MS) || 30_000, 120_000));

  if (!OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

  // ---------- Input ----------
  const {
    text,
    style,
    length = 45,
    tone = "Neutral",
    language = "English",
    ctaInclusion = false,
    qualityMode = true
  } = req.body || {};

  if (!text || typeof text !== "string") return res.status(400).json({ error: "`text` is required" });
  if (!style || typeof style !== "string") return res.status(400).json({ error: "`style` is required" });

  const sec = Math.max(15, Math.min(Number(length) || 45, 180));
  const wordsTarget = Math.round(sec * 2.2);

  const styleExamples = {
    meme:
      'EXAMPLE (meme, 25s): Hook: POV you still edit 1-by-1. Setup→twist→tag. End with 1 punchline.',
    quicktip:
      'EXAMPLE (quicktip, 30s): Hook: Batch film = 3x output. 1) Script bullets only. 2) Lock exposure. 3) A-roll then B-roll. CTA: Comment "GEAR".',
    challenge:
      'EXAMPLE (challenge, 30s): Premise→rules→attempt→result. Present tense. One suspense beat.',
    storytelling:
      'EXAMPLE (storytelling, 45s): Incident→complication→turn→button. Vivid verbs, no fluff.',
    productplug:
      'EXAMPLE (productplug, 35s): Problem→product→proof→how-to→CTA. No hype words.',
    faceless:
      'EXAMPLE (faceless, 30s): Voiceover-only, crisp short lines, no camera directions.'
  };

  const sys =
`You are a short-form video scriptwriter for TikTok/Reels/Shorts.
Always write in the requested LANGUAGE. Return only the script text—no JSON/markdown/disclaimers.
Keep pacing for TARGET_DURATION_SECONDS and roughly TARGET_WORDS_SOFT_CAP words.

GLOBAL RULES
- 1-sentence hook (≤ 8 words).
- Lines short (≤ 16 words); prefer line breaks over paragraphs.
- If STYLE is "faceless", avoid camera directions; write for VO/TTS.
- If CTA=Yes, include ONE natural CTA as the last line.

STYLE PACKS
- meme: setup→twist→tag; 3–5 beats; internet slang ok.
- quicktip: 3–5 numbered tips; each ≤ 2 lines; 1-line summary.
- challenge: premise→rules→attempt→result; present tense; suspense.
- storytelling: incident→complication→turn→button; vivid verbs.
- productplug: problem→product→proof→how-to→CTA; no hype words.

${styleExamples[(style || '').toLowerCase()] || ''}`.trim();

  const keywordsCSV = String(text).includes(",") ? text : "";

  const user =
`TOPIC: ${text}
STYLE: ${style}
TONE: ${tone}
LANGUAGE: ${language}
TARGET_DURATION_SECONDS: ${sec}
TARGET_WORDS_SOFT_CAP: ${wordsTarget}
CTA: ${ctaInclusion ? "Yes" : "No"}
KEYWORDS (must appear ≥1 time): ${keywordsCSV || "N/A"}

CONSTRAINTS:
- Mention TOPIC explicitly within first 2 lines.
- Structure: 1 hook line → 3–6 body lines → (optional) CTA line.
- Avoid generic fillers ("in today’s video", "welcome back").

Write the final script now.`;

  // ---------- OpenAI Call ----------
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.4,
        top_p: 0.9,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });

    if (!r.ok) {
      const err = await r.text().catch(() => "");
      console.error("[OpenAI error]", r.status, err.slice(0,300));
      return res.status(r.status).json({ error: `OpenAI ${r.status}: ${err}` });
    }

    const data = await r.json();
    const draft = data?.choices?.[0]?.message?.content?.trim() || "";

    if (!draft) {
      clearTimeout(timer);
      return res.status(502).json({ error: "Empty response from model" });
    }

    clearTimeout(timer);
    return res.status(200).json({ result: draft });
  } catch (e) {
    console.error("[Server error]", e?.message || e);
    if (e && e.name === "AbortError") return res.status(504).json({ error: "Upstream timeout" });
    return res.status(500).json({ error: (e && e.message) || "Server error" });
  } finally {
    clearTimeout(timer);
  }
};
