// Vercel Serverless Function (Node.js 런타임)
// 응답은 항상 { "result": "..." } 형식
module.exports = async (req, res) => {
  const origin = process.env.ALLOWED_ORIGIN || req.headers.origin || "*"

  // CORS
  res.setHeader("Access-Control-Allow-Origin", origin)
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")

  if (req.method === "OPTIONS") return res.status(204).end()
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed")

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY
  const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"
  if (!OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" })

  // 요청 바디 (Vercel Node는 JSON 자동 파싱)
  const {
    text,
    style,
    length = 45,
    tone = "Neutral",
    language = "English",
    ctaInclusion = false,
    qualityMode = true // 고퀄 모드(2패스) 기본 ON. 느리면 프론트에서 false로 보내
  } = req.body || {}

  if (!text || typeof text !== "string") return res.status(400).json({ error: "`text` is required" })
  if (!style || typeof style !== "string") return res.status(400).json({ error: "`style` is required" })

  const sec = Math.max(15, Math.min(Number(length) || 45, 180))
  const wordsTarget = Math.round(sec * 2.2) // 1초≈2.2 단어(소프트캡)

  // 스타일별 짧은 예시(톤 고정용, 너무 길면 비용↑이라 1줄씩만)
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

  // 쉼표 키워드가 있으면 키워드 목록으로 취급(필수 등장 1회)
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

  // 25초 타임아웃
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25_000)

  try {
    // 1차: 초안 생성
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.6,
        top_p: 0.9,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    })

    if (!r.ok) {
      const err = await r.text()
      return res.status(r.status).json({ error: `OpenAI ${r.status}: ${err}` })
    }

    const data = await r.json()
    let draft = data?.choices?.[0]?.message?.content?.trim() || "No content generated."

    // 2차: 퀄리티 모드(자가리뷰→개선본)
    if (qualityMode) {
      const reviewMsg =
        "Review the script for: hook strength, specificity, redundancy, pacing. " +
        "Tighten generic lines, replace vague words with concrete nouns/verbs. " +
        "Ensure max one CTA line at the end. Return improved script only."

      const r2 = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          temperature: 0.6,
          top_p: 0.9,
          messages: [
            { role: "system", content: sys },
            { role: "user", content: user },
            { role: "assistant", content: draft },
            { role: "user", content: reviewMsg },
          ],
        }),
        signal: controller.signal,
      })

      if (r2.ok) {
        const d2 = await r2.json()
        draft = d2?.choices?.[0]?.message?.content?.trim() || draft
      }
    }

    return res.status(200).json({ result: draft })
  } catch (e) {
    if (e && e.name === "AbortError") return res.status(504).json({ error: "Upstream timeout" })
    return res.status(500).json({ error: (e && e.message) || "Server error" })
  } finally {
    clearTimeout(timer)
  }
}
