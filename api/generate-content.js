// Vercel Serverless Function (Node.js 런타임)
// 응답은 항상 { "result": "..." }
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

  const {
    text,
    style,
    length = 45,
    tone = "Neutral",
    language = "English",
    ctaInclusion = false,
  } = req.body || {}

  if (!text || typeof text !== "string") return res.status(400).json({ error: "`text` is required" })
  if (!style || typeof style !== "string") return res.status(400).json({ error: "`style` is required" })

  const sec = Math.max(15, Math.min(Number(length) || 45, 180))

  const sys =
    "You write tight, high-retention short-form video scripts. " +
    "Always match the requested language exactly. " +
    "Keep pacing for the given target duration in seconds. " +
    "If style is 'faceless', avoid camera directions; write for voiceover/TTS. " +
    "If CTA is requested, include ONE natural CTA at the end."

  const user =
    `TOPIC: ${text}\nSTYLE: ${style}\nTONE: ${tone}\nLANGUAGE: ${language}\n` +
    `TARGET_DURATION_SECONDS: ${sec}\nCTA: ${ctaInclusion ? "Yes" : "No"}\n\n` +
    "Return only the script text. No JSON, no markdown fences."

  // 25초 타임아웃
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25_000)

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.7,
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
    const result = data?.choices?.[0]?.message?.content?.trim() || "No content generated."

    return res.status(200).json({ result })
  } catch (e) {
    if (e?.name === "AbortError") return res.status(504).json({ error: "Upstream timeout" })
    return res.status(500).json({ error: e?.message || "Server error" })
  } finally {
    clearTimeout(timer)
  }
}
