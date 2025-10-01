"use strict";

/* ==========================================================
   Scripto — Script Generator API (V2 for IdeaGeneratorV2)
   - 유지: n=5 후보 생성 → 같은 모델로 채점(JSON) → 1등 채택
   - 유지: 자유 줄바꿈, em dash 금지, 최소 후처리, soft timestamp
   - 추가: phase=initial/final, refinementContext/baseScript/previousScript
   - 추가: outputType = "script" | "complete" (extras 동봉)
   - 추가: CTA 포함 옵션(ctaInclusion)
   ========================================================== */

const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_BODY_BYTES = Math.max(
  256_000,
  Math.min(Number(process.env.MAX_BODY_BYTES) || 1_000_000, 5_000_000)
);
const HARD_TIMEOUT_MS = Math.max(
  20_000,
  Math.min(Number(process.env.HARD_TIMEOUT_MS) || 45_000, 90_000)
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
const LANG_MAP = new Map([
  ["ko", "Korean"], ["korean", "Korean"], ["한국어", "Korean"],
  ["en", "English"], ["english", "English"],
  ["ja", "Japanese"], ["japanese", "Japanese"], ["日本語", "Japanese"],
  ["zh", "Chinese"], ["chinese", "Chinese"], ["中文", "Chinese"],
  ["es", "Spanish"], ["spanish", "Spanish"],
  ["fr", "French"], ["french", "French"],
  ["de", "German"], ["german", "German"],
  ["it", "Italian"], ["italian", "Italian"],
  ["pt", "Portuguese"], ["portuguese", "Portuguese"],
  ["nl", "Dutch"], ["dutch", "Dutch"],
  ["ru", "Russian"], ["russian", "Russian"],
  ["ar", "Arabic"], ["arabic", "Arabic"],
]);
function normalizeLang(language) {
  const L = String(language || "").trim();
  if (!L) return "Korean";
  const key = L.toLowerCase();
  return LANG_MAP.get(key) || L; // 이름 그대로 들어오면 존중
}
function wordsArray(s){ return String(s||"").trim().split(/\s+/).filter(Boolean); }
function sanitizeLine(s) {
  let out = String(s || "");
  out = out.replace(/—/g, ":"); // em dash 금지
  // 줄 끝 맨숫자 제거(%, 시간, 배, plain number)
  out = out.replace(
    /\s*(?:—|,|:)?\s*(\+?\d+%|\d+(?:\s?(?:sec|secs|seconds|min|minutes|hrs|hours|분|초|시간))|\d+배|\d+)\s*$/i,
    ""
  );
  out = out.replace(/\s{2,}/g, " ").trim();
  return out;
}
function getWPS(language){
  // 보수적 평균 발화 속도(언어 상관 동일 적용)
  return 2.3;
}

// === soft-only allocator: no max cap, min slice + soft flatten ===
function allocateDurationsByWords(lines, totalSec, opts = {}) {
  const dur = Math.max(15, Math.min(Number(totalSec) || 45, 180));
  const MIN_SLICE = opts.minSlice ?? 0.5;
  const ALPHA = (() => {
    const env = Number(process.env.SLICE_ALPHA);
    if (!Number.isNaN(env) && env > 0 && env < 1) return env;
    return opts.alpha ?? 0.82;
  })();

  const words = lines.map(s => Math.max(1, String(s||"").trim().split(/\s+/).filter(Boolean).length));
  let weights = words.map(w => Math.pow(w, ALPHA));
  let sumW = weights.reduce((a,b)=>a+b, 0);
  if (!sumW) { weights = words.map(_=>1); sumW = weights.length; }

  let slices = weights.map(w => (w / sumW) * dur);

  let deficit = 0;
  const spare = slices.map(x => {
    if (x < MIN_SLICE) deficit += (MIN_SLICE - x);
    return Math.max(0, x - MIN_SLICE);
  });
  const pool = spare.reduce((a,b)=>a+b, 0);

  if (deficit > 0 && pool > 0) {
    const poolSafe = pool || 1;
    slices = slices.map((x, i) => {
      if (x <= MIN_SLICE) return MIN_SLICE;
      const give = (spare[i] / poolSafe) * deficit;
      return Math.max(MIN_SLICE, x - Math.min(spare[i], give));
    });
    const sum2 = slices.reduce((a,b)=>a+b, 0) || 1;
    const scale = dur / sum2;
    slices = slices.map(x => x * scale);
  }

  let t = 0;
  return lines.map((line, i) => {
    const start = t; t += slices[i];
    const end = (i === lines.length - 1) ? dur : t;
    return `[${start.toFixed(1)}-${end.toFixed(1)}] ${line}`;
  }).join("\n");
}

/* -------- OpenAI 공통 호출 -------- */
async function callOpenAI({ system, user, n = 1, temperature = 0.72, max_tokens = 1400 }) {
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
        max_tokens,
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

/* -------- Prompt builders -------- */
function buildSystemPrompt(language, topic, tone, style) {
  const lang = normalizeLang(language);
  // 기존 철학 유지 + style/tone 힌트만 추가
  return `You are a short-form scriptwriter who writes sharp, concrete scripts.

LANGUAGE: ${lang} ONLY
RETURN: JSON with { lang, lines: [string] } ONLY. No extra text.

TONE: ${tone || "Casual"}
STYLE: ${style || "faceless"}

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

(You may rephrase the topic inline for naturalness.)`;
}

function buildUserPrompt({ text, language, duration, tone, style, ctaInclusion }) {
  const duration_sec = Math.max(15, Math.min(Number(duration) || 45, 180));
  const wps = getWPS(language);
  const target_words = Math.round(duration_sec * wps);
  const lines_target_hint = Math.round(duration_sec / 6);

  const guide = [
    "Aim total words ≈ target_words ±10%.",
    "Prefer adding more short lines over making lines very long.",
    "Each line stays concrete: steps, settings, drills, visible effects, measured outcomes.",
    "Avoid filler or meta. No emojis. No em dash."
  ];
  if (ctaInclusion) guide.push("Include ONE concise CTA line near the end (no emojis).");

  return JSON.stringify({
    task: "flex_script_v2_density",
    topic: text,
    tone: tone || "Casual",
    style: style || "faceless",
    language: normalizeLang(language),
    duration_sec,
    target_words,
    lines_target_hint,
    cta: !!ctaInclusion,
    schema: { lang: "string", lines: ["string"] },
    guidance: guide
  });
}

function buildJudgePrompt(topic){
  return `You are a strict script judge. Score short-form scripts by a rubric and pick the best.

TASK: Given multiple candidates, score each on a 0–100 scale and return JSON:
{
  "candidates":[
    {"index":0,"score":{"total":90,"breakdown":{"hook":..,"action":..,"proof":..,"numbers":..,"rhythm":..,"clean":..}},"reasons":["...","..."]},
    ...
  ],
  "best_index": <int>
}

RUBRIC (max points):
- HOOK impact (25): ends with "?", includes ONE number, mentions TOPIC keyword, ~7–12 words.
- Actionability (20): concrete, executable steps or settings in ≥1–3 lines.
- Evidence & Outcome (20): at least one visible effect line and one measurable outcome line.
- Number discipline (10): 1–3 numeric lines total besides the hook is ideal; more is penalized.
- Rhythm & Readability (15): average 7–12 words; avoid many overly short (<4) or long (>16) lines.
- Cleanliness (10): no meta fluff ("in this video"), no emojis, low repetition of starting words.

RULES:
- Do NOT rewrite lines. Only judge.
- Scores must be integers. Sum breakdown to total.
- If two scripts tie, pick fewer lines; if still tied, fewer total words.

TOPIC: ${topic}`;
}

async function judgeCandidates(candidates, topic){
  const user = JSON.stringify({
    topic,
    candidates: candidates.map((c, i) => ({ index: i, lines: c.lines }))
  });
  const outs = await callOpenAI({
    system: buildJudgePrompt(topic),
    user,
    n: 1,
    temperature: 0.3
  });
  const obj = JSON.parse(outs[0]);
  if (!obj || typeof obj.best_index !== "number") throw new Error("Judge failed");
  return obj;
}

/* -------- Densify -------- */
async function densifyLines(lines, { topic, language, durationSec, tone, style, ctaInclusion }) {
  const target_words = Math.round(getWPS(language) * durationSec);
  const system = "You expand scripts without fluff. Return JSON { lines: [string] } only.";
  const user = JSON.stringify({
    topic,
    language: normalizeLang(language),
    tone, style, cta: !!ctaInclusion,
    duration_sec: durationSec,
    target_words,
    current_words: lines.join(" ").trim().split(/\s+/).filter(Boolean).length,
    lines,
    rules: [
      "Keep tone and style. No meta. No emojis. No em dash.",
      "Increase total words to ~target_words ±10% by adding concise micro-steps, examples, effects.",
      "Prefer adding new short lines over lengthening existing lines too much.",
      "Keep numbers useful and minimal. Never end a line with a bare number.",
      ctaInclusion ? "Add one concise CTA line near the end." : "No CTA unless natural."
    ]
  });

  const outs = await callOpenAI({ system, user, n: 1, temperature: 0.55 });
  const obj = JSON.parse(outs[0]);
  let outLines = Array.isArray(obj?.lines) ? obj.lines : [];
  outLines = outLines.map(sanitizeLine).map(s => s.trim()).filter(Boolean);
  return outLines.length ? outLines : lines;
}

/* -------- Refinement / Edit -------- */
async function refineExistingScript(previousLines, { topic, language, durationSec, tone, style, refineHints, ctaInclusion }) {
  const system = "You carefully revise scripts to match constraints. Return JSON { lines: [string] } only.";
  const user = JSON.stringify({
    topic,
    language: normalizeLang(language),
    tone, style, cta: !!ctaInclusion,
    duration_sec: durationSec,
    lines: previousLines,
    refine_hints: refineHints || "",
    rules: [
      "Preserve strengths of original lines; rewrite minimally to apply hints.",
      "Keep line-break philosophy and micro-rules.",
      ctaInclusion ? "Ensure exactly one concise CTA near the end." : "Do not force a CTA."
    ]
  });
  const outs = await callOpenAI({ system, user, n: 1, temperature: 0.6 });
  const obj = JSON.parse(outs[0]);
  let outLines = Array.isArray(obj?.lines) ? obj.lines : [];
  outLines = outLines.map(sanitizeLine).map(s => s.trim()).filter(Boolean);
  return outLines.length ? outLines : previousLines;
}

/* -------- Extras builder (for outputType=complete) -------- */
function parseStamped(script) {
  // returns [{start,end,text}]
  const rows = String(script).split(/\n+/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const r of rows) {
    const m = r.match(/^\[(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\]\s*(.*)$/);
    if (m) {
      out.push({ start: parseFloat(m[1]), end: parseFloat(m[2]), text: m[3] || "" });
    }
  }
  return out;
}
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

function buildExtrasFromScript(script) {
  const rows = parseStamped(script);
  if (!rows.length) return { transitions: [], bRoll: [], textOverlays: [], soundEffects: [] };

  // Transitions: cut/wipe/whip/zoom based on beat position
  const transitions = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const t = rows[i].end;
    const pick = (i % 4 === 0) ? "cut" : (i % 4 === 1) ? "swipe-left" : (i % 4 === 2) ? "whip-pan" : "zoom-in";
    transitions.push({ time: `${t.toFixed(1)}s`, type: pick, description: `Transition on line change (${pick}).` });
  }

  // B-roll: key nouns from each line (very light heuristic)
  const bRoll = rows.map(({ start, end, text }) => {
    const words = text.split(/\W+/).filter(Boolean);
    const nouns = words.filter(w => w.length > 3).slice(0, 3).join(", ");
    return { timeRange: `${start.toFixed(1)}-${end.toFixed(1)}s`, content: nouns ? `B-roll: ${nouns}` : "B-roll: contextual visual" };
  });

  // Text overlays: first 5–8 words
  const textOverlays = rows.map(({ start, text }) => {
    const words = text.split(/\s+/).slice(0, 8).join(" ");
    return { time: `${start.toFixed(1)}s`, text: words, style: "bold lower-third" };
  });

  // SFX: hook + transitions emphasis
  const soundEffects = [];
  if (rows.length) soundEffects.push({ time: `${rows[0].start.toFixed(1)}s`, effect: "whoosh-in (hook emphasis)" });
  transitions.forEach(tr => soundEffects.push({ time: tr.time, effect: "light whoosh" }));

  return { transitions, bRoll, textOverlays, soundEffects };
}

/* -------- main handler -------- */
module.exports = async (req, res) => {
  if (!setupCORS(req, res)) {
    if (req.method === "OPTIONS") return res.status(204).end();
    return res.status(403).json({ error: "CORS: origin not allowed" });
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  let body;
  try { body = await parseRequestBody(req); }
  catch (err) { return res.status(err?.status || 400).json({ error: err?.message || "Invalid request body" }); }

  const {
    text,                 // 주제(필수)
    style = "faceless",
    length = 45,
    tone = "Casual",
    language = "Korean",
    ctaInclusion = false,
    outputType = "script",     // "script" | "complete"
    phase = "initial",         // "initial" | "final"
    refinementContext = null,  // 3.5 수집 답변 요약
    baseScript = "",           // initial 결과(Refine 전 base)
    previousScript = ""        // 재생성/수정 시 전달
  } = body || {};

  if (!text || typeof text !== "string" || text.trim().length < 3) {
    return res.status(400).json({ error: "`text` is required (≥ 3 chars)" });
  }

  // 내부 공통
  const langN = normalizeLang(language);
  const durationSec = Math.max(15, Math.min(Number(length) || 45, 180));

  try {
    // ===== 1) 후보 생성 공통 로직 (이전 틀 유지) =====
    async function generateBestLines(topic, seedLines) {
      if (Array.isArray(seedLines) && seedLines.length) {
        // seedLines가 있으면 미세 수정만 요구
        return await refineExistingScript(seedLines, {
          topic,
          language: langN,
          durationSec,
          tone, style,
          refineHints: refinementContext || "",
          ctaInclusion
        });
      }

      const system = buildSystemPrompt(langN, topic, tone, style);
      const user = buildUserPrompt({ text: topic, language: langN, duration: durationSec, tone, style, ctaInclusion });

      const outs = await callOpenAI({ system, user, n: 5, temperature: 0.75 });
      if (!outs.length) throw new Error("Empty response");
      const candidates = outs.map((o) => {
        const obj = JSON.parse(o);
        let lines = Array.isArray(obj?.lines)
          ? obj.lines.map(x => typeof x === "string" ? x : String(x?.text || ""))
          : [];
        lines = lines.map(sanitizeLine).map(s => s.trim()).filter(Boolean);
        if (!lines.length) lines = ["Write something specific and concrete."];
        return { lines };
      });

      let bestIdx = 0; let judgeDump = null;
      try {
        const judge = await judgeCandidates(candidates, topic);
        bestIdx = judge.best_index;
        judgeDump = judge;
      } catch (e) {
        // 폴백: 첫 후보
        bestIdx = 0;
      }
      let best = candidates[bestIdx].lines;

      // 길이 대비 밀도 보정
      const targetWords = Math.round(getWPS(langN) * durationSec);
      const currentWords = best.join(" ").trim().split(/\s+/).filter(Boolean).length;
      if (durationSec >= 60 && currentWords < targetWords * 0.85) {
        try {
          best = await densifyLines(best, { topic, language: langN, durationSec, tone, style, ctaInclusion });
        } catch {}
      }
      return best;
    }

    // ===== 2) phase 분기 =====
    let lines;
    if (phase === "initial") {
      // 초기 스크립트 생성
      lines = await generateBestLines(text);
      const scriptStr = allocateDurationsByWords(lines, durationSec);
      // 프론트는 result 문자열을 바로 읽음
      return res.status(200).json({ result: scriptStr });
    }

    // final 또는 수정/재생성
    if (phase === "final") {
      let seed = [];
      if (previousScript) {
        // previousScript(str 또는 타임스탬프 포함 문자열) → 라인화
        const raw = String(previousScript || "").split(/\n+/).map(s => s.replace(/\[[^\]]+\]\s*/, "").trim()).filter(Boolean);
        if (raw.length) seed = raw;
      } else if (baseScript) {
        const raw = String(baseScript || "").split(/\n+/).map(s => s.replace(/\[[^\]]+\]\s*/, "").trim()).filter(Boolean);
        if (raw.length) seed = raw;
      }

      lines = await generateBestLines(text, seed.length ? seed : undefined);
      const stamped = allocateDurationsByWords(lines, durationSec);

      if (outputType === "complete") {
        const extras = buildExtrasFromScript(stamped);
        return res.status(200).json({
          script: stamped,
          ...extras
        });
      } else {
        return res.status(200).json({ script: stamped });
      }
    }

    // 알 수 없는 phase면 initial처럼 동작
    const fallbackLines = await generateBestLines(text);
    const fallbackScript = allocateDurationsByWords(fallbackLines, durationSec);
    return res.status(200).json({ script: fallbackScript });

  } catch (error) {
    const msg = String(error?.message || "Internal error");
    if (process.env.DEBUG_ERRORS === "1" || process.env.DEBUG_ERRORS === "true") {
      console.error("[API Error]", msg);
    } else {
      console.error("[API Error]");
    }
    return res.status(error?.status || 500).json({ error: process.env.DEBUG_ERRORS ? msg : "Internal server error" });
  }
};
