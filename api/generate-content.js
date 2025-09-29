"use strict";

/* ==========================================================
   Scripto — Flexible Script Generator (단일콜, ≤ 1분)
   - 줄 갯수 고정 안함: "아이디어 바뀔 때마다" 라인 끊기
   - 프롬프트에 예시 박제, em dash 금지, 최소 후처리
   - 타임스탬프는 라인 길이(단어수) 비율로 가변 할당
   ========================================================== */

const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_BODY_BYTES = Math.max(
  256_000,
  Math.min(Number(process.env.MAX_BODY_BYTES) || 1_000_000, 5_000_000)
);
const HARD_TIMEOUT_MS = Math.max(
  20000,
  Math.min(Number(process.env.HARD_TIMEOUT_MS) || 45000, 90000)
);

/* -------- fetch polyfill -------- */
const _fetch =
  typeof fetch === "function"
    ? fetch
    : (...args) => import("node-fetch").then(({ default: f }) => f(...args));

/* -------- CORS -------- */
function setupCORS(req, res) {
  const allow = process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "";
  const origin = (req.headers && req.headers.origin) || "";
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("Vary", "Origin");
  if (!allow) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    return true;
  }
  const list = allow.split(",").map((s) => s.trim()).filter(Boolean);
  const allowed = list.includes("*") || list.includes(origin);
  res.setHeader("Access-Control-Allow-Origin", allowed ? origin || "*" : "*");
  return true;
}

/* -------- body parse -------- */
function readRawBody(req, limitBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0,
      raw = "";
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
function wordsArray(s){ return String(s||"").trim().split(/\s+/).filter(Boolean); }
function sanitizeLine(s) {
  let out = String(s || "");
  // em dash 금지 → 콜론으로 치환
  out = out.replace(/—/g, ":");
  // 줄 끝 맨숫자 제거(%, 시간, 배, plain number)
  out = out.replace(
    /\s*(?:—|,|:)?\s*(\+?\d+%|\d+(?:\s?(?:sec|secs|seconds|min|minutes|hrs|hours|분|초|시간))|\d+배|\d+)\s*$/i,
    ""
  );
  // 중복 공백 정리
  out = out.replace(/\s{2,}/g, " ").trim();
  return out;
}
function allocateDurationsByWords(lines, totalSec) {
  const dur = Math.max(1, Number(totalSec) || 45);
  const MIN_SLICE = 0.4;
  const counts = lines.map((t) => Math.max(1, wordsArray(t).length));
  let sum = counts.reduce((a,b) => a+b, 0);
  if (!sum) sum = lines.length || 1;
  // 1차 배분
  let slices = counts.map(c => (c/sum)*dur);
  // 최소 보장
  const deficit = slices.reduce((d,x)=> d + Math.max(0, MIN_SLICE - x), 0);
  if (deficit > 0) {
    const poolIdx = slices.map((x,i)=>[x,i]).filter(([x])=>x>MIN_SLICE).map(([,i])=>i);
    let pool = poolIdx.reduce((s,i)=> s + (slices[i]-MIN_SLICE), 0);
    if (pool > 0) {
      for (const i of poolIdx) {
        const give = Math.min(slices[i]-MIN_SLICE, deficit * ((slices[i]-MIN_SLICE)/pool));
        slices[i] -= give;
      }
    }
    // 다시 최소로 채우기
    for (let i=0;i<slices.length;i++) slices[i] = Math.max(MIN_SLICE, slices[i]);
    // 총합 재정규화
    const sum2 = slices.reduce((a,b)=>a+b,0);
    if (sum2 !== dur) {
      const scale = dur / sum2;
      slices = slices.map(x => x*scale);
    }
  }
  // 누적 타임스탬프 생성
  let t = 0;
  const out = [];
  for (let i=0;i<lines.length;i++) {
    const start = t; t += slices[i];
    const end = (i === lines.length-1) ? dur : t;
    out.push(`[${start.toFixed(1)}-${end.toFixed(1)}] ${lines[i]}`);
  }
  return out.join("\n");
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
        max_tokens: 1200,
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

/* -------- prompts (예시 박제 + em dash 금지 + 자유 줄바꿈) -------- */
function buildSystemPrompt(language, topic) {
  const lang = normalizeLang(language);
  return `You are a short-form scriptwriter who writes sharp, concrete scripts.

LANGUAGE: ${lang} ONLY
RETURN: JSON with { lang, lines: [string] } ONLY. No extra text.

LINE-BREAK PHILOSOPHY:
- Do NOT fix the number of lines.
- Break a line whenever the micro-idea changes.
- Prefer more line breaks over fewer; short lines are fine.

MICRO-RULES:
- NO EM DASH. Do not use "—". Use commas or colons instead.
- Keep each line roughly 7–12 words, but do not force it.
- HOOK: mention the TOPIC, include ONE number, end with a question mark.
- Keep numbers minimal overall, avoid spam; never end a line with a bare number.
- Avoid meta or filler: no "in this video", no emojis.

TOPIC: ${topic}

EXAMPLES (STYLE ANCHORS, DO NOT COPY VERBATIM; counts vary naturally):

// 1) Valorant aim
[
 "Valorant aim in 10 minutes, ready to level up?",
 "Crosshair keeps slipping off heads every duel, right?",
 "Here is the pro secret, commit to one sensitivity.",
 "Lock one sensitivity and run three tracking drills.",
 "Shake stabilizes, first bullet hits the same dot.",
 "Raise headshot rate by twenty percent, rounds feel easier.",
 "Talent matters less than repeating the same routine daily."
]

// 2) Ten-minute abs
[
 "Abs in ten minutes, think it is actually possible?",
 "Lower back hurts and your form keeps collapsing, right?",
 "No magic, start here and stay consistent.",
 "Hold a thirty second plank, then two dead bug sets.",
 "Core braces better, shoulder tremble fades as breathing steadies.",
 "Four weeks consistent, waistline firms and stamina improves.",
 "Perfect form beats calorie counting for faster definition."
]

// 3) iPhone battery
[
 "iPhone battery all day, want a five minute setup?",
 "Charging anxiety ruins your commute and evenings, right?",
 "Change it once, then forget battery stress.",
 "Enable optimized charging, limit background refresh to essentials.",
 "Heat drops and standby drain becomes barely noticeable.",
 "One charge now covers work, gym, and dinner.",
 "Endurance comes from settings, not from babying the phone."
]
`;
}

function buildUserPrompt({ text, language, duration, ctaInclusion, tone, style }) {
  return JSON.stringify({
    task: "flex_script_v1",
    topic: text,
    tone: tone || "Casual",
    style: style || "faceless",
    language: normalizeLang(language),
    duration_sec: Math.max(15, Math.min(Number(duration) || 45, 180)),
    cta: !!ctaInclusion,
    // schema 안내만, 실제 라인 수는 자유
    schema: {
      lang: "string",
      lines: ["string"]
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
    tone = "Casual",
    style = "faceless",
    timestamps = true,    // true면 [start-end] 붙여줌
    maxLines = 0          // 0이면 제한 없음, 과도할 때만 컷
  } = body || {};

  if (!text || typeof text !== "string" || text.trim().length < 3) {
    return res.status(400).json({ error: "`text` is required (≥ 3 chars)" });
  }

  try {
    const system = buildSystemPrompt(language, text);
    const user = buildUserPrompt({ text, language, duration: length, tone, style });

    const outs = await callOpenAI({ system, user, n: 1, temperature: 0.72 });
    if (!outs.length) return res.status(500).json({ error: "Empty response" });

    const obj = JSON.parse(outs[0]);
    let lines = Array.isArray(obj?.lines)
      ? obj.lines.map((x) => (typeof x === "string" ? x : String(x?.text || "")))
      : [];

    // 비어있는 라인 제거 + 최소 후처리
    lines = lines.map(sanitizeLine).map(s => s.trim()).filter(Boolean);

    // 너무 길면 안전하게 컷(원하면 maxLines=0로 해제)
    const HARD_MAX = maxLines > 0 ? maxLines : 0;
    if (HARD_MAX > 0 && lines.length > HARD_MAX) {
      lines = lines.slice(0, HARD_MAX);
    }
    if (lines.length === 0) lines = ["Write something specific and concrete."];

    const script = timestamps
      ? allocateDurationsByWords(lines, Math.max(15, Math.min(Number(length) || 45, 180)))
      : lines.join("\n");

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
