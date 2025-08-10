// Vercel Serverless Function (Node.js 런타임)
// ✅ 항상 { result: "..." } 형식으로 응답 (폴백 없음)
module.exports = async (req, res) => {
  // ---------- CORS (화이트리스트 + 경로 제거 + 캐시 헤더) ----------
  const rawList =
    process.env.ALLOWED_ORIGINS /* "https://scripto.framer.website,https://scripto.framer.app" */ ||
    process.env.ALLOWED_ORIGIN  /* 과거 단일 키도 지원 */ ||
    ""

  const ALLOW_LIST = rawList
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(v => { try { return new URL(v).origin } catch { return v } })

  const requestOrigin = (() => {
    const o = req.headers.origin
    if (!o) return null
    try { return new URL(o).origin } catch { return o }
  })()

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
  res.setHeader("Vary", "Origin")
  res.setHeader("Access-Control-Max-Age", "600") // preflight 10분 캐시

  const allowAll = ALLOW_LIST.includes("*")
  const allowThis =
    allowAll ||
    (ALLOW_LIST.length === 0 && !!requestOrigin) ||
    (requestOrigin && ALLOW_LIST.includes(requestOrigin))

  if (allowAll) {
    res.setHeader("Access-Control-Allow-Origin", "*")
  } else if (ALLOW_LIST.length === 0) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin || "*")
  } else if (allowThis && requestOrigin) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin)
  } else {
    if (req.method === "OPTIONS") return res.status(204).end()
    return res.status(403).json({ error: "CORS: origin not allowed" })
  }

  if (req.method === "OPTIONS") return res.status(204).end()
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed")

  // ---------- 기본 설정 ----------
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY
  const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini" // ⬅️ 요청대로 '미니' 기본값
  const HARD_TIMEOUT_MS = Math.max(15_000, Math.min(Number(process.env.HARD_TIMEOUT_MS) || 30_000, 120_000)) // 프론트 30s와 맞춤

  if (!OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" })) })
  }

  // ---------- 입력 ----------
  const {
    text,
    style,
    length = 45,
    tone = "Neutral",
    language = "English",   // 프론트 라벨 그대로 받음
    ctaInclusion = false,
    qualityMode = true      // boolean 그대로 유지(기본 true)
  } = req.body || {}

  if (!text || typeof text !== "string") return res.status(400).json({ error: "`text` is required" })) })
  }
  if (!style || typeof style !== "string") return res.status(400).json({ error: "`style` is required" })) })
  }

  const sec = Math.max(15, Math.min(Number(length) || 45, 180))
  const wordsTarget = Math.round(sec * 2.2) // 1초≈2.2 단어(소프트캡)

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
  }

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

${styleExamples[(style || '').toLowerCase()] || ''}`.trim()

  // 쉼표가 있으면 키워드 리스트(필수 1회 등장)
  const keywordsCSV = String(text).includes(",") ? text : ""

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

Write the final script now.`

  // ---------- 유틸 ----------
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS)

  const callOpenAISafely = async (messages, { tMain = 0.35, tRetry = 0.25 } = {}) => {
    const url = "https://api.openai.com/v1/chat/completions"
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    }
    const body = (temperature) => JSON.stringify({
      model: OPENAI_MODEL,
      temperature,
      top_p: 0.9,
      messages,
    })

    // 1차 시도
    try {
      const r = await fetch(url, { method: "POST", headers, body: body(tMain), signal: controller.signal })
      if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text().catch(()=> "")}`)
      const j = await r.json()
      return (j?.choices?.[0]?.message?.content || "").trim()
    } catch (e1) {
      // 2차 가벼운 재시도
      try {
        const r2 = await fetch(url, { method: "POST", headers, body: body(tRetry), signal: controller.signal })
        if (!r2.ok) throw new Error(`OpenAI ${r2.status}: ${await r2.text().catch(()=> "")}`)
        const j2 = await r2.json()
        return (j2?.choices?.[0]?.message?.content || "").trim()
      } catch (e2) {
        console.error("[OpenAI retry failed]", e1?.message || e1, e2?.message || e2)
        return null
      }
    }
  }

  try {
    // 1) 초안 생성
    let draft = await callOpenAISafely(
      [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      { tMain: 0.35, tRetry: 0.25 } // 미니 안정 영역
    )

    // 2) 품질모드가 true면 짧게 리터치(실패해도 무시)
    if (qualityMode && draft) {
      const reviewMsg =
        "Tighten redundancy; ensure [HOOK] then 3–6 short lines; prefer specifics; return script only."
      const refined = await callOpenAISafely(
          [
            { role: "system", content: sys },
            { role: "user", content: user },
            { role: "assistant", content: draft },
            { role: "user", content: reviewMsg },
          ],
          { tMain: 0.3, tRetry: 0.25 }
      )
      if (refined) draft = refined
    }

    // 3) 결과 보정/확정
    if (draft && typeof draft === "string" && draft.trim().length > 0) {
      clearTimeout(timer)
      return res.status(200).json({ result: draft.trim() })
    }
    clearTimeout(timer)
    return res.status(502).json({ error: "Empty response from model" })

  } catch (e) {
    console.error("[Server error]", e?.message || e)
    if (e && e.name === "AbortError") return res.status(504).json({ error: "Upstream timeout" })
    return res.status(500).json({ error: (e && e.message) || "Server error" })
  } finally {
    clearTimeout(timer)
  }
}
