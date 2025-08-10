// api/generate-content.js — Vercel Serverless Function (Node.js, CommonJS)
// 성공 시 { result: "..." } 반환, 실패 시 상태코드와 { error: "..." } 반환 (풀백 없음)

module.exports = async (req, res) => {
  // ensure fetch exists on older Node runtimes (Node <18)
  if (typeof fetch !== "function") {
    const { default: fetchFn } = await import("node-fetch");
    globalThis.fetch = fetchFn;
  }
  console.log("[dbg] node", process.version);
  // ---------- CORS (화이트리스트 + 경로 제거 + 캐시 헤더) ----------
  const rawList =
    process.env.ALLOWED_ORIGINS /* "https://scripto.framer.website,https://scripto.framer.app" */ ||
    process.env.ALLOWED_ORIGIN  /* 과거 단일 키도 지원 */ ||
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
  res.setHeader("Access-Control-Max-Age", "600"); // preflight 10분 캐시

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
  const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // 기본 미니
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
  } = req.body || {};

  if (!text || typeof text !== "string") return res.status(400).json({ error: "`text` is required" });
  if (!style || typeof style !== "string") return res.status(400).json({ error: "`style` is required" });

  const sec = Math.max(15, Math.min(Number(length) || 45, 180));
  const wordsTarget = Math.round(sec * 2.2);

  // ---------- Style examples & safe hint ----------
  const styleExamples = {
    meme:
      'EXAMPLE (meme, 25s): [HOOK] POV you still edit 1-by-1
setup→twist→tag. 3–5 beats. One punchline.',
    quicktip:
      'EXAMPLE (quicktip, 30s): [HOOK] Batch film = 3x output
1) Script bullets only.
2) Lock exposure.
3) A-roll then B-roll.
[CTA] Comment "GEAR".',
    challenge:
      'EXAMPLE (challenge, 30s): [HOOK] 10 pushups every missed beat
premise→rules→attempt→result. Present tense. One suspense beat.',
    storytelling:
      'EXAMPLE (storytelling, 45s): [HOOK] Missed the midnight train
incident→complication→turn→button. Vivid verbs.',
    productplug:
      'EXAMPLE (productplug, 35s): [HOOK] Editing took me 3 hours
problem→product→proof→how-to→CTA. No hype words.',
    faceless:
      'EXAMPLE (faceless, 30s): [HOOK] Stop wasting your B-roll
voiceover-only, short lines, no camera directions.'
  };
  const styleKey = String(style || "").toLowerCase();
  const styleHint = styleExamples[styleKey] || "";

  // ---------- Prompt with timing + HOOK ----------
  const sys =
`You are a short-form video scriptwriter for TikTok/Reels/Shorts.
Always write in the requested LANGUAGE. Return only the script text—no JSON/markdown/disclaimers.
Keep pacing for TARGET_DURATION_SECONDS and roughly TARGET_WORDS_SOFT_CAP words.

OUTPUT FORMAT (STRICT)
- Prefix EVERY line with a time range in seconds using ONE decimal place: [start-end] (e.g., [0.0-1.2]).
- First line is the hook: [0.0-H] [HOOK] <≤ 8 words> (H ≈ 12–20% of total duration).
- Then 3–6 body lines, each with its own [start-end]; ≤ 16 words per line; one idea per line.
- If CTA=Yes, end with: [C1-C2] [CTA] <one short line>.
- Do not include any other text, labels, or explanations.

TIMING RULES
- Time ranges must be contiguous and non-overlapping: next start == previous end.
- The final end must be ≤ TARGET_DURATION_SECONDS.
- Suggested allocation: HOOK ≈ 12–20% of total; split the remainder evenly across body lines; CTA ≤ 10% if present.

STYLE PACKS
- meme: setup→twist→tag; 3–5 beats; internet slang ok.
- quicktip: 3–5 numbered tips; each ≤ 2 lines; 1-line summary.
- challenge: premise→rules→attempt→result; present tense; suspense.
- storytelling: incident→complication→turn→button; vivid verbs.
- productplug: problem→product→proof→how-to→CTA; no hype words.
- faceless: voiceover-only; short lines; no camera directions.

${styleHint}`.trim();

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
- Structure: [HOOK] → 3–6 body lines → optional [CTA].
- Prefer specifics over adjectives.

Write the final script now.`;

  // ---------- OpenAI Call ----------
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);

  // 디버그 로그 (필요시 확인)
  console.log("[dbg] model:", OPENAI_MODEL, "hasKey:", !!OPENAI_API_KEY);
  console.log("[dbg] inputs:", { text: String(text).slice(0, 80), style, sec });

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
        max_tokens: 512, // 과출력 방지 및 안정성
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });

    if (!r.ok) {
      const err = await r.text().catch(() => "");
      console.error("[OpenAI error]", r.status, err.slice(0, 300));
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
