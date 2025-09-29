"use strict";

/* ==========================================================
   Scripto — Simple Script Generator (단일콜, ≤ 1분)
   - 6줄 고정(CTA 옵션 시 7줄)
   - 복잡한 후처리 없음: 프롬프트로만 간단 규칙 강제
   - 숫자: 최대 2줄에서만, 줄 끝 숫자 금지
   ========================================================== */

const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_BODY_BYTES = Math.max(256_000, Math.min(Number(process.env.MAX_BODY_BYTES) || 1_000_000, 5_000_000));
const HARD_TIMEOUT_MS = Math.max(20000, Math.min(Number(process.env.HARD_TIMEOUT_MS) || 45000, 90000));

/* -------- fetch polyfill -------- */
const _fetch = (typeof fetch === "function")
  ? fetch
  : (...args) => import("node-fetch").then(({ default: f }) => f(...args));

/* -------- CORS -------- */
function setupCORS(req, res) {
  const allow = process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "";
  const origin = (req.headers && req.headers.origin) || "";
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("Vary", "Origin");
  if (!allow) { res.setHeader("Access-Control-Allow-Origin", origin || "*"); return true; }
  const list = allow.split(",").map(s => s.trim()).filter(Boolean);
  const allowed = list.includes("*") || list.includes(origin);
  res.setHeader("Access-Control-Allow-Origin", allowed ? (origin || "*") : "*");
  return true;
}

/* -------- body parse -------- */
function readRawBody(req, limitBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0, raw = "";
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error("Payload too large"), { status: 413 }));
        try { req.destroy(); } catch (e) {}
        return;
      }
      raw += c;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}
async function parseRequestBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const ctype = (req.headers["content-type"] || "").toLowerCase();
  if (!ctype.includes("application/json")) return {};
  const raw = await readRawBody(req).catch((err) => { throw err; });
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

/* -------- utils -------- */
function normalizeLang(language) {
  const L = String(language || "").toLowerCase();
  if (L.includes("korean") || L.includes("한국") || L === "ko") return "Korean";
  return "English";
}
function detectCategory(idea) {
  const s = String(idea || "").toLowerCase();
  if (/\b(valorant|제트|jett|game|gaming|fps|league|lol|fortnite|minecraft|apex|warzone)\b/.test(s)) return "gaming";
  if (/\b(workout|exercise|gym|fitness|muscle|weight|cardio|yoga)\b/.test(s)) return "fitness";
  if (/\b(iphone|app|tech|ai|software|code|programming|gadget)\b/.test(s)) return "tech";
  if (/\b(money|invest|crypto|stock|wealth|startup)\b/.test(s)) return "money";
  return "general";
}
function equalTimedLines(lines, totalSec) {
  const n = lines.length || 1;
  const dur = Math.max(1, Number(totalSec) || 45);
  const slice = +(dur / n).toFixed(1);
  let t = 0;
  return lines.map((txt, i) => {
    const start = t.toFixed(1);
    t = +(t + slice).toFixed(1);
    const end = (i === n - 1 ? dur.toFixed(1) : t.toFixed(1));
    return `[${start}-${end}] ${txt}`;
  }).join("\n");
}

/* -------- OpenAI -------- */
async function callOpenAI({ system, user, n = 1, temperature = 0.72 }) {
  const url = `${(process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/,"")}/v1/chat/completions`;
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);

  try {
    const res = await _fetch(url, {
      method: "POST",
      headers: { "Content-Type":"application/json", "Authorization":`Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
        temperature,
        top_p: 0.92,
        n,
        max_tokens: 1000,
        presence_penalty: 0.1,
        frequency_penalty: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) {
      const msg = await res.text().catch(()=> "");
      throw Object.assign(new Error(`OpenAI ${res.status}: ${msg.slice(0,300)}`), { status: res.status });
    }
    const data = await res.json();
    return (data.choices || []).map(c => c?.message?.content?.trim()).filter(Boolean);
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error("Request timeout");
    throw e;
  }
}

/* -------- prompts (심플 규칙) -------- */
function buildSystemPrompt(language, topic) {
  const lang = normalizeLang(language);
  const category = detectCategory(topic);
  return `You are a concise short-form scriptwriter.

LANGUAGE: ${lang} ONLY
OUTPUT: Return JSON with { lang, lines: [{tag,text}] }.

LINES (CTA optional):
- HOOK
- ESCALATION
- FACT
- PROOF
- PAYOFF
- TWIST
- CTA (only if cta=true)

SIMPLE RULES:
- Keep it simple and natural. No fluff, no meta.
- HOOK must end with '?' and include ONE clear number (not a percentage).
- Use numbers in AT MOST two lines total; at most one number per line.
- Never end a line with a number. Numbers must be inside the sentence.
- Do NOT start any line with '사실' or '너'.
- 8–12 words per line.
- No emojis.`;
}
function buildUserPrompt({ text, language, duration, ctaInclusion, tone, style }) {
  return JSON.stringify({
    task: "simple_script",
    topic: text,
    tone: tone || "Casual",
    style: style || "faceless",
    language: normalizeLang(language),
    duration_sec: Math.max(15, Math.min(Number(duration)||45, 180)),
    cta: !!ctaInclusion,
    schema: {
      lang: "string",
      lines: [
        { tag: "HOOK", text: "string" },
        { tag: "ESCALATION", text: "string" },
        { tag: "FACT", text: "string" },
        { tag: "PROOF", text: "string" },
        { tag: "PAYOFF", text: "string" },
        { tag: "TWIST", text: "string" },
        ...(ctaInclusion ? [{ tag: "CTA", text: "string" }] : [])
      ]
    }
  });
}

/* -------- handler -------- */
module.exports = async (req, res) => {
  if (!setupCORS(req, res)) {
    if (req.method === "OPTIONS") return res.status(204).end();
    return res.status(403).json({ error: "CORS: origin not allowed" });
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  let body;
  try { body = await parseRequestBody(req); }
  catch (err) { return res.status(err?.status || 400).json({ error: err.message || "Invalid request body" }); }

  const {
    text,                 // 주제(필수)
    language = "Korean",
    length = 45,
    ctaInclusion = false,
    tone = "Casual",
    style = "faceless",
    timestamps = true     // true면 [start-end] 붙여줌
  } = body || {};

  if (!text || typeof text !== "string" || text.trim().length < 3) {
    return res.status(400).json({ error: "`text` is required (≥ 3 chars)" });
  }

  try {
    const system = buildSystemPrompt(language, text);
    const user = buildUserPrompt({ text, language, duration: length, ctaInclusion, tone, style });

    const outs = await callOpenAI({ system, user, n: 1, temperature: 0.72 });
    if (!outs.length) return res.status(500).json({ error: "Empty response" });

    const obj = JSON.parse(outs[0]);
    const lines = (obj?.lines || []).map(l => String(l.text || "").trim()).filter(Boolean);
    const clean = lines.map(s => {
      // 아주 최소한의 정리만 (줄 끝 숫자 제거)
      return s.replace(/\s*(\d+[%]?)\s*$/,"").trim();
    });

    const script = timestamps
      ? equalTimedLines(clean, Math.max(15, Math.min(Number(length)||45, 180)))
      : clean.join("\n");

    return res.status(200).json({ result: script });

  } catch (error) {
    const msg = String(error?.message || "Internal error");
    if (process.env.DEBUG_ERRORS === "1" || process.env.DEBUG_ERRORS === "true") {
      console.error("[API Error]", msg);
    } else {
      console.error("[API Error]");
    }
    return res.status(error?.status || 500).json({ error: (process.env.DEBUG_ERRORS ? msg : "Internal server error") });
  }
};
