"use strict";

/* ==========================================================
   Scripto — Flexible Script Generator + Q&A + Self-Judge
   - phase: "initial" → 초안 1개(빠르게)
   - phase: "refinement-question" → 1개 질문/옵션(반복), 종료 시 {question:null}
   - phase: "final" → n=5 후보 → 같은 모델로 채점 → 베스트, 필요 시 densify
   - phase 생략 → 기존 원샷 루트 (n=5 → 채점 → 베스트)
   - 줄수 고정 안 함, em dash 금지, 타임스탬프 = soft-alloc(min-slice 보장)
   - regenerateWithEdit: previousScript 반영
   - outputType="complete"면 transitions/bRoll/textOverlays/soundEffects 포함
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

const _fetch =
  typeof fetch === "function"
    ? fetch
    : (...args) => import("node-fetch").then(({ default: f }) => f(...args));

/* ---------------- CORS ---------------- */
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
  const list = allow.split(",").map(s => s.trim()).filter(Boolean);
  const allowed = list.includes("*") || list.includes(origin);
  res.setHeader("Access-Control-Allow-Origin", allowed ? origin || "*" : "*");
  return true;
}

/* --------------- body parse --------------- */
function readRawBody(req, limitBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0, raw = "";
    req.on("data", c => {
      size += c.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error("Payload too large"), { status: 413 }));
        try { req.destroy(); } catch {}
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
  const raw = await readRawBody(req).catch(e => { throw e; });
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

/* ---------------- utils ---------------- */
function normalizeLang(language) {
  const L = String(language || "").toLowerCase();
  if (L.includes("korean") || L.includes("한국") || L === "ko") return "Korean";
  return "English";
}
function sanitizeLine(s) {
  let out = String(s || "");
  out = out.replace(/—/g, ":"); // em dash 금지
  out = out.replace(
    /\s*(?:—|,|:)?\s*(\+?\d+%|\d+(?:\s?(?:sec|secs|seconds|min|minutes|hrs|hours|분|초|시간))|\d+배|\d+)\s*$/i,
    ""
  );
  out = out.replace(/\s{2,}/g, " ").trim();
  return out;
}
function getWPS(language) {
  const L = String(language || "").toLowerCase();
  const isKo = L.includes("korean") || L.includes("한국") || L === "ko";
  return isKo ? 2.3 : 2.3;
}

/** soft-only allocator: min slice 보장 + soft flatten, 하드 max 없음 */
function allocateDurationsByWords(lines, totalSec, opts = {}) {
  const dur = Math.max(1, Number(totalSec) || 45);
  const MIN_SLICE = opts.minSlice ?? 0.5;
  const ALPHA = (() => {
    const env = Number(process.env.SLICE_ALPHA);
    if (!Number.isNaN(env) && env > 0 && env < 1) return env;
    return opts.alpha ?? 0.82;
  })();

  const words = lines.map(s => Math.max(1, String(s||"").trim().split(/\s+/).filter(Boolean).length));
  let weights = words.map(w => Math.pow(w, ALPHA));
  let sumW = weights.reduce((a,b)=>a+b,0);
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

/* -------------- OpenAI call -------------- */
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
        max_tokens: 1400,
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

/* -------- 생성용 System Prompt (예시 10개 박제) -------- */
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

// 4) Ramen upgrades
[
 "Ramen upgrade in three tweaks, want a better bowl?",
 "Flat salty punch keeps feeling boring, right?",
 "Finish with a small splash of milk for body.",
 "Add one spoon garlic oil for aroma, remove funk.",
 "Single egg keeps broth clear while tasting richer.",
 "Cook noodles seventy percent first, then season for balance.",
 "Order beats ingredients when flavor keeps falling flat."
]

// 5) Three-account budgeting
[
 "Paycheck control in three accounts, ready to keep more?",
 "Bills and spending collide and keep stressing you, right?",
 "Move fixed costs automatically on payday, every month.",
 "Auto transfer to bills first, then see only leftovers.",
 "Impulse buys stand out when the balance is honest.",
 "Save twenty percent monthly automatically, card stabilizes.",
 "Design beats willpower, structure quietly controls behavior."
]

// 6) Dating text timing
[
 "Text timing rules in three moments, want smoother chats?",
 "Left on read and momentum keeps collapsing, right?",
 "No games, cool emotions before you reply.",
 "Answer within five minutes, keep it concise and clear.",
 "Pressure drops, rhythm syncs, threads finally stay alive.",
 "A week later, date invitations often double in frequency.",
 "Consistency builds attraction more than mystery ever does."
]

// 7) Notion five-minute planning
[
 "Daily plan in five minutes, want calm on screen?",
 "Tasks stare back and you cannot begin, right?",
 "Use three tags only to set priority today.",
 "Important, Quick, Low energy, tag and collapse clutter.",
 "Only today’s work remains visible and actionable.",
 "Context switching drops thirty percent, completions pop.",
 "Tools help, but your rules make the tool useful."
]

// 8) English pronunciation routine
[
 "Pronunciation in ten minutes, want quicker clean speech?",
 "You know phrases, your tongue freezes at endings, right?",
 "Record five minimal pairs and shadow them back.",
 "Repeat immediately while watching waveform and stress.",
 "Final consonants sharpen and stress finally clicks.",
 "One week later, phone calls feel twenty percent clearer.",
 "Repetition grows muscle, not new vocabulary lists."
]

// 9) Travel packing lists
[
 "Pack lighter with three lists, want room in your bag?",
 "Missing items abroad keep draining cash, right?",
 "Make three columns and add checkboxes now.",
 "Clothing, toiletries, electronics, tick each before zipping.",
 "Final check finishes relaxed in five minutes.",
 "Unnecessary purchases drop thirty percent, moving feels lighter.",
 "Pack completely, not heavily, that is the advantage."
]

// 10) Interview STAR in thirty seconds
[
 "Interview answers in thirty seconds, want a clear frame?",
 "Stories ramble and your point keeps getting buried?",
 "Use STAR, then keep every line crisp.",
 "Situation one line, Task one, Action two lines.",
 "Interviewers note faster and follow ups get predictable.",
 "Answer length halves while impact finally lands.",
 "Structure guides attention more than credentials do."
]
`;
}

/* -------- User Prompt (refine/previousScript 반영 가능) -------- */
function buildUserPrompt({ text, language, duration, tone, style, refinementContext, baseScript, previousScript }) {
  const duration_sec = Math.max(15, Math.min(Number(duration) || 45, 180));
  const wps = getWPS(language);
  const target_words = Math.round(duration_sec * wps);
  const lines_target_hint = Math.round(duration_sec / 6);

  const guidance = [
    "Aim total words ≈ target_words ±10%.",
    "Prefer adding more short lines over making lines very long.",
    "Each line stays concrete: steps, settings, drills, visible effects, measured outcomes.",
    "Avoid filler or meta. No emojis. No em dash."
  ];
  if (refinementContext) guidance.push(`Reflect these user preferences: ${refinementContext}`);
  if (baseScript) guidance.push("Respect the useful ideas in baseScript but rewrite cleanly.");
  if (previousScript) guidance.push("Use previousScript as guidance and improve clarity, rhythm, and concreteness.");

  return JSON.stringify({
    task: "flex_script_v2_density",
    topic: text,
    tone: tone || "Casual",
    style: style || "faceless",
    language: normalizeLang(language),
    duration_sec,
    target_words,
    lines_target_hint,
    baseScript: baseScript || null,
    previousScript: previousScript || null,
    schema: { lang: "string", lines: ["string"] },
    guidance
  });
}

/* -------- Judge (셀프 채점) -------- */
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

/* -------- Densify (부족 시 1회 확장) -------- */
async function densifyLines(lines, { topic, language, durationSec }) {
  const target_words = Math.round(getWPS(language) * durationSec);
  const system = "You expand scripts without fluff. Return JSON { lines: [string] } only.";
  const user = JSON.stringify({
    topic,
    language: normalizeLang(language),
    duration_sec: durationSec,
    target_words,
    current_words: lines.join(" ").trim().split(/\s+/).filter(Boolean).length,
    lines,
    rules: [
      "Keep tone and style. No meta. No emojis. No em dash.",
      "Increase total words to ~target_words ±10% by adding concise micro-steps, examples, effects.",
      "Prefer adding new short lines over lengthening existing lines too much.",
      "Keep numbers useful and minimal. Never end a line with a bare number."
    ]
  });

  const outs = await callOpenAI({ system, user, n: 1, temperature: 0.55 });
  const obj = JSON.parse(outs[0]);
  let outLines = Array.isArray(obj?.lines) ? obj.lines : [];
  outLines = outLines.map(sanitizeLine).map(s => s.trim()).filter(Boolean);
  return outLines.length ? outLines : lines;
}

/* -------- 비주얼 요소(complete 모드) -------- */
function generateSmartVisualElements(script, topic, style) {
  const lines = String(script || "").split("\n").filter(Boolean);
  const transitions = [];
  const bRoll = [];
  const textOverlays = [];
  const soundEffects = [];

  const transPool = {
    meme: ["Jump cut","Zoom punch","Glitch","Speed ramp","Shake"],
    quicktip: ["Number pop","Slide","Highlight","Circle zoom"],
    challenge: ["Whip pan","Crash zoom","Impact frame","Flash"],
    storytelling: ["Cross fade","Time lapse","Match cut","Reveal"],
    productplug: ["Product reveal","Comparison split","Before/after"],
    faceless: ["Text slam","Motion blur","Kinetic type"]
  }[style] || ["Text slam","Motion blur","Kinetic type"];

  lines.forEach((line, i) => {
    const m = line.match(/^\[(\d+(?:\.\d+)?)\-(\d+(?:\.\d+)?)\]\s*(.*)$/);
    if (!m) return;
    const start = parseFloat(m[1]); const end = parseFloat(m[2]);
    const content = m[3];
    if (i > 0) transitions.push({ time: `${start.toFixed(1)}s`, type: transPool[i % transPool.length], description: "Pace change" });
    if (!/\[HOOK\]|\[CTA\]/i.test(content)) {
      bRoll.push({ timeRange: `${start.toFixed(1)}-${end.toFixed(1)}s`, content: "Relevant stock footage or UI demo" });
    }
    if (/\d/.test(content)) {
      const num = content.match(/\d+%?|\$\d+/)?.[0];
      if (num) textOverlays.push({ time: `${start.toFixed(1)}s`, text: num, style: "Giant number glow" });
    }
    if (/stop|never|wrong|멈춰|절대|잘못/.test(content.toLowerCase())) {
      soundEffects.push({ time: `${start.toFixed(1)}s`, effect: "Alert/Error" });
    }
  });
  return { transitions, bRoll, textOverlays, soundEffects };
}

/* -------- Refinement Question (3.5단계) -------- */
function buildQuestionSystemPrompt(language, topic){
  const lang = normalizeLang(language);
  return `You ask ONE sharp refinement question to improve a short-form script.

LANGUAGE: ${lang} ONLY
RETURN: strict JSON { "question": string, "options": string[] }.

RULES:
- One question only, concise, concrete, about the user's intent or constraints.
- Provide up to 4 short options if applicable (may be empty).
- No meta like "in this video". No emojis.
TOPIC: ${topic}`;
}
function buildQuestionUserPrompt({ baseScript, conversationHistory, keyword, style, language }) {
  return JSON.stringify({
    task: "ask_refinement_question",
    topic: keyword,
    language: normalizeLang(language),
    style: style || "",
    baseScript: baseScript || "",
    conversationHistory: Array.isArray(conversationHistory) ? conversationHistory.slice(-8) : []
  });
}
async function askRefinementQuestion({ text, language, baseScript, conversationHistory, keyword, style }) {
  // 대화가 충분히 쌓였으면 종료 신호
  if (Array.isArray(conversationHistory) && conversationHistory.length >= 3) {
    return { question: null, options: [] };
  }
  const system = buildQuestionSystemPrompt(language, text);
  const user = buildQuestionUserPrompt({ baseScript, conversationHistory, keyword: keyword || text, style, language });
  try {
    const outs = await callOpenAI({ system, user, n: 1, temperature: 0.6 });
    const obj = JSON.parse(outs[0] || "{}");
    const q = typeof obj.question === "string" ? obj.question.trim() : null;
    const options = Array.isArray(obj.options) ? obj.options.filter(Boolean).slice(0,4) : [];
    return { question: q || null, options };
  } catch {
    return { question: null, options: [] };
  }
}

/* ---------------- handler ---------------- */
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
    text,                            // topic (필수)
    language = "Korean",
    length = 45,
    tone = "Casual",
    style = "faceless",
    timestamps = true,
    maxLines = 0,
    includeQuality = false,
    outputType = "script",           // "script" | "complete"

    // Q&A phases
    phase,                           // "initial" | "refinement-question" | "final" | undefined
    baseScript,                      // 초기 스크립트(문자열)
    conversationHistory,             // 사용자가 답했던 배열
    refinementContext,               // 최종 생성 시 반영
    // regenerateWithEdit (원샷/기본 루트에서 사용)
    previousScript
  } = body || {};

  if (!text || typeof text !== "string" || text.trim().length < 3) {
    return res.status(400).json({ error: "`text` is required (≥ 3 chars)" });
  }

  try {
    /* ---------- Phase: initial ---------- */
    if (phase === "initial") {
      const system = buildSystemPrompt(language, text);
      const user = buildUserPrompt({ text, language, duration: length, tone, style });
      const outs = await callOpenAI({ system, user, n: 1, temperature: 0.7 });
      const obj = JSON.parse(outs[0]);
      let lines = Array.isArray(obj?.lines)
        ? obj.lines.map(x => typeof x === "string" ? x : String(x?.text || ""))
        : [];
      lines = lines.map(sanitizeLine).map(s => s.trim()).filter(Boolean);
      if (maxLines > 0 && lines.length > maxLines) lines = lines.slice(0, maxLines);
      if (!lines.length) lines = ["Write something specific and concrete."];

      const durationSec = Math.max(15, Math.min(Number(length) || 45, 180));
      const script = timestamps ? allocateDurationsByWords(lines, durationSec) : lines.join("\n");
      return res.status(200).json({ result: script });
    }

    /* ----- Phase: refinement-question ----- */
    if (phase === "refinement-question") {
      const q = await askRefinementQuestion({
        text,
        language,
        baseScript,
        conversationHistory: Array.isArray(conversationHistory) ? conversationHistory : [],
        keyword: body.keyword,
        style
      });
      // { question: string|null, options: [] }
      return res.status(200).json(q);
    }

    /* ------------- Phase: final ------------- */
    if (phase === "final") {
      const system = buildSystemPrompt(language, text);
      const user = buildUserPrompt({
        text,
        language,
        duration: length,
        tone,
        style,
        refinementContext,
        baseScript
      });

      const outs = await callOpenAI({ system, user, n: 5, temperature: 0.75 });
      if (!outs.length) return res.status(500).json({ error: "Empty response" });

      const candidates = outs.map(o => {
        const obj = JSON.parse(o);
        let lines = Array.isArray(obj?.lines)
          ? obj.lines.map(x => typeof x === "string" ? x : String(x?.text || ""))
          : [];
        lines = lines.map(sanitizeLine).map(s => s.trim()).filter(Boolean);
        if (maxLines > 0 && lines.length > maxLines) lines = lines.slice(0, maxLines);
        if (!lines.length) lines = ["Write something specific and concrete."];
        return { lines };
      });

      let bestIdx = 0, judgeDump = null;
      try {
        const judge = await judgeCandidates(candidates, text);
        bestIdx = judge.best_index; judgeDump = judge;
      } catch (e) {
        console.error("[Judge Error]", e?.message || e);
        bestIdx = 0;
      }
      const best = candidates[bestIdx];

      const durationSec = Math.max(15, Math.min(Number(length) || 45, 180));
      const targetWords = Math.round(getWPS(language) * durationSec);
      const currentWords = best.lines.join(" ").trim().split(/\s+/).filter(Boolean).length;

      if (durationSec >= 60 && currentWords < targetWords * 0.85) {
        try {
          const expanded = await densifyLines(best.lines, { topic: text, language, durationSec });
          const newWords = expanded.join(" ").split(/\s+/).filter(Boolean).length;
          if (newWords > currentWords) best.lines = expanded;
        } catch (e) {
          console.error("[Densify Error]", e?.message || e);
        }
      }

      const script = timestamps
        ? allocateDurationsByWords(best.lines, durationSec)
        : best.lines.join("\n");

      if (outputType === "complete") {
        const extras = generateSmartVisualElements(script, text, style);
        const payload = { result: { script, ...extras } };
        if (includeQuality && judgeDump) payload.quality = judgeDump;
        return res.status(200).json(payload);
      } else {
        const payload = { result: script };
        if (includeQuality && judgeDump) payload.quality = judgeDump;
        return res.status(200).json(payload);
      }
    }

    /* ----------- Default: 원샷 루트 ----------- */
    const system = buildSystemPrompt(language, text);
    const user = buildUserPrompt({
      text,
      language,
      duration: length,
      tone,
      style,
      previousScript // regenerateWithEdit 대응
    });

    const outs = await callOpenAI({ system, user, n: 5, temperature: 0.75 });
    if (!outs.length) return res.status(500).json({ error: "Empty response" });

    const candidates = outs.map(o => {
      const obj = JSON.parse(o);
      let lines = Array.isArray(obj?.lines)
        ? obj.lines.map(x => typeof x === "string" ? x : String(x?.text || ""))
        : [];
      lines = lines.map(sanitizeLine).map(s => s.trim()).filter(Boolean);
      if (maxLines > 0 && lines.length > maxLines) lines = lines.slice(0, maxLines);
      if (!lines.length) lines = ["Write something specific and concrete."];
      return { lines };
    });

    let bestIdx = 0, judgeDump = null;
    try {
      const judge = await judgeCandidates(candidates, text);
      bestIdx = judge.best_index; judgeDump = judge;
    } catch (e) {
      console.error("[Judge Error]", e?.message || e);
      bestIdx = 0;
    }
    const best = candidates[bestIdx];

    const durationSec = Math.max(15, Math.min(Number(length) || 45, 180));
    const targetWords = Math.round(getWPS(language) * durationSec);
    const currentWords = best.lines.join(" ").trim().split(/\s+/).filter(Boolean).length;

    if (durationSec >= 60 && currentWords < targetWords * 0.85) {
      try {
        const expanded = await densifyLines(best.lines, { topic: text, language, durationSec });
        const newWords = expanded.join(" ").split(/\s+/).filter(Boolean).length;
        if (newWords > currentWords) best.lines = expanded;
      } catch (e) {
        console.error("[Densify Error]", e?.message || e);
      }
    }

    const script = timestamps
      ? allocateDurationsByWords(best.lines, durationSec)
      : best.lines.join("\n");

    if (outputType === "complete") {
      const extras = generateSmartVisualElements(script, text, style);
      const payload = { result: { script, ...extras } };
      if (includeQuality && judgeDump) payload.quality = judgeDump;
      return res.status(200).json(payload);
    } else {
      const payload = { result: script };
      if (includeQuality && judgeDump) payload.quality = judgeDump;
      return res.status(200).json(payload);
    }

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
