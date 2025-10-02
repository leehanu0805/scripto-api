"use strict";

/* ==========================================================
   Scripto — Flexible Script Generator + Self-Judge (≤ 1분)
   + Step 3.5 AI Chat Refinement (진짜 작동하는 버전)
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
function sanitizeLine(s) {
  let out = String(s || "");
  out = out.replace(/—/g, ":");
  out = out.replace(
    /\s*(?:—|,|:)?\s*(\+?\d+%|\d+(?:\s?(?:sec|secs|seconds|min|minutes|hrs|hours|분|초|시간))|\d+배|\d+)\s*$/i,
    ""
  );
  out = out.replace(/\s{2,}/g, " ").trim();
  return out;
}
function getWPS(language){
  const L = String(language||"").toLowerCase();
  const isKo = L.includes("korean") || L.includes("한국") || L === "ko";
  return isKo ? 2.3 : 2.3;
}

// === soft-only allocator: no max cap, min slice + soft flatten ===
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
async function callOpenAI({ system, user, n = 1, temperature = 0.72 }) {
  const url = `${(process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/,"")}/v1/chat/completions`;
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);

  try {
    const res = await _fetch(url, {
      method: "POST",
      headers: { "Content-Type":"application/json", "Authorization":"Bearer "+key },
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

/* -------- 생성용 System Prompt (예시 10개) -------- */
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
 "Only today's work remains visible and actionable.",
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

/* -------- User Prompt (밀도 힌트 포함) -------- */
function buildUserPrompt({ text, language, duration, tone, style }) {
  const duration_sec = Math.max(15, Math.min(Number(duration) || 45, 180));
  const wps = getWPS(language);
  const target_words = Math.round(duration_sec * wps);
  const lines_target_hint = Math.round(duration_sec / 6);

  return JSON.stringify({
    task: "flex_script_v2_density",
    topic: text,
    tone: tone || "Casual",
    style: style || "faceless",
    language: normalizeLang(language),
    duration_sec,
    target_words,
    lines_target_hint,
    schema: { lang: "string", lines: ["string"] },
    guidance: [
      "Aim total words ≈ target_words ±10%.",
      "Prefer adding more short lines over making lines very long.",
      "Each line stays concrete: steps, settings, drills, visible effects, measured outcomes.",
      "Avoid filler or meta. No emojis. No em dash."
    ]
  });
}

/* -------- Judge (같은 모델로 2차 호출) -------- */
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
  const system = "You are a careful, deterministic scoring assistant. Strict JSON only.";
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

/* ==========================================================
   🔧 Anti-repeat Utilities for Refinement Questions
   ========================================================== */
const DIMENSIONS = [
  "audience", "goal", "methods", "structure", "count", "order", "detail",
  "hook", "tone", "length", "cta", "examples", "constraints", "platform",
  "visuals", "monetization", "risks", "data", "sources", "recording"
];
const DIMENSION_PRIORITY = [
  "goal", "methods", "count", "structure", "order", "detail", "cta",
  "tone", "platform", "visuals", "constraints", "examples", "risks",
  "data", "sources", "length", "recording", "monetization", "audience"
];

function normalize(txt){
  return String(txt||"")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[“”‘’\-—_]+/g, " ")
    .replace(/[^a-z0-9가-힣 ?:%]/g, "")
    .trim();
}

function detectDimension(text){
  const t = normalize(text);
  const has = (...arr)=>arr.some(k=>t.includes(k));
  if (has("audience","target","viewer","for who","누구를","대상","타겟")) return "audience";
  if (has("goal","objective","purpose","목표","용도","목적","cta goal")) return "goal";
  if (has("method","approach","technique","방식","방법","프레임")) return "methods";
  if (has("structure","outline","flow","구성","흐름","틀")) return "structure";
  if (has("how many","몇","count","개수","lines","points")) return "count";
  if (has("order","sequence","priority","순서","우선")) return "order";
  if (has("detail","depth","얼마나 자세","깊이")) return "detail";
  if (has("hook","opening","start","오프닝","훅")) return "hook";
  if (has("tone","vibe","style","톤","분위기","스타일")) return "tone";
  if (has("length","duration","seconds","minutes","길이","초","분")) return "length";
  if (has("cta","call to action","행동 유도","구독","가입")) return "cta";
  if (has("example","case","사례","예시")) return "examples";
  if (has("constraint","limit","제약","예산","시간 제약")) return "constraints";
  if (has("platform","tiktok","reels","shorts","플랫폼","틱톡","릴스","쇼츠")) return "platform";
  if (has("visual","broll","overlay","자막","비주얼","브롤")) return "visuals";
  if (has("monetize","sale","affiliate","수익","판매","제휴")) return "monetization";
  if (has("risk","pitfall","mistake","리스크","함정","실수")) return "risks";
  if (has("data","metric","kpi","데이터","지표")) return "data";
  if (has("source","reference","출처","근거")) return "sources";
  if (has("record","mic","camera","lighting","촬영","마이크","카메라","조명")) return "recording";
  return null;
}

const OPTION_SYNONYMS = {
  beginners: ["beginner","novice","newbie","초보","입문"],
  intermediate: ["mid","중급"],
  advanced: ["expert","experienced","고급","숙련"],
  "all levels": ["everyone","모두","전 레벨"]
};
function canonicalOption(opt){
  const o = normalize(opt);
  for (const [canon, list] of Object.entries(OPTION_SYNONYMS)){
    if (o === canon) return canon;
    if (list.some(s=>o===normalize(s))) return canon;
  }
  return o;
}
function dedupeOptions(opts){
  const seen = new Set();
  const out = [];
  for (const x of (opts||[])){
    const k = canonicalOption(x);
    if (!k || k === "all levels") continue; // ban all-levels
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  }
  return out.slice(0,4);
}

/* -------- 🔥 이미 물어본 것 명시적으로 추출 (강화 버전) -------- */
function extractAskedTopics(conversationHistory) {
  const topics = new Set();
  (conversationHistory || []).forEach(item => {
    const q = item?.question || item?.message || item?.text || item?.prompt || "";
    const a = item?.answer || item?.response || item?.message || "";
    const dimQ = detectDimension(q);
    const dimA = detectDimension(a);
    if (dimQ) topics.add(dimQ);
    if (dimA) topics.add(dimA);
  });
  return Array.from(topics);
}

/* -------- 🔥 명시적으로 차단하는 질문 생성 (강화 버전) -------- */
async function generateRefinementQuestion({ 
  baseScript, 
  conversationHistory, 
  keyword, 
  style, 
  scriptLength, 
  tone, 
  language 
}) {
  // guard: too long
  if (conversationHistory && conversationHistory.length >= 8) {
    return { question: null, options: [] };
  }

  const isFirstQuestion = !conversationHistory || conversationHistory.length === 0;
  const askedDims = new Set(extractAskedTopics(conversationHistory));
  const banned = new Set(askedDims);
  // Prevent exact same dim back-to-back: also ban the last asked dimension
  const lastEntry = (conversationHistory||[]).slice().reverse().find(x=>x?.question || x?.message);
  const lastDim = lastEntry ? detectDimension(lastEntry.question || lastEntry.message || "") : null;
  if (lastDim) banned.add(lastDim);

  const allowed = DIMENSIONS.filter(d => !banned.has(d));
  const allowedList = allowed.length ? allowed : DIMENSIONS.slice(); // fallback if everything banned

  const system = `You are a script refinement assistant. Ask ONE strategic question to improve the video script.
Return strict JSON: { "question": "...", "options": ["opt1","opt2","opt3","opt4"], "dimension": "one_of_${DIMENSIONS.join("|")}" }
Rules:
- Max 10 words for the question, 2–5 words per option.
- Options must be MECE (mutually exclusive), concrete, and UNIQUE.
- Do NOT include synonyms or duplicates like Beginners vs Novices; choose one.
- NEVER include "All levels" as an option.
- Pick a dimension from allowed_dimensions only. Avoid banned_dimensions.
- The question must clearly belong to that dimension.
- No meta language, no emojis.
`;

  function buildUser(isFirst){
    const prevQA = (conversationHistory || []).map((item, i) => {
      if (item.role === 'assistant' && item.question) {
        return `Q${Math.floor(i/2) + 1}: "${item.question}"`;
      } else if (item.role === 'user' && (item.answer || item.message)) {
        return `A${Math.floor(i/2) + 1}: "${item.answer || item.message}"`;
      }
      return null;
    }).filter(Boolean).join('\n');

    const base = {
      topic: String(keyword||"").slice(0,200),
      script_length_sec: scriptLength || 45,
      style: style || "faceless",
      tone: tone || "Casual",
      language: normalizeLang(language),
      allowed_dimensions: allowedList,
      banned_dimensions: Array.from(banned),
      previous_qa: prevQA,
      guidance: [
        isFirst ? "Ask a high-leverage framing question." : "Ask about a DIFFERENT dimension than before.",
        "Options must be unique after canonicalization (e.g., Beginners vs Novices -> pick one).",
        "Options count 3–4, no 'All levels'."
      ]
    };

    // Slight nudge examples without audience repetition
    const goodFirst = [
      'How many main points should we cover?',
      'What\'s the primary goal?',
      'Which approach should we take?',
      'How detailed should each tip be?'
    ];

    if (isFirst){
      base.examples = { good_first_questions: goodFirst };
    }
    return JSON.stringify(base);
  }

  // Try generate with validation up to 2 attempts
  const attempts = 2;
  let lastParsed = null;
  for (let i=0; i<attempts; i++){
    try {
      const outs = await callOpenAI({ 
        system, 
        user: buildUser(isFirstQuestion), 
        n: 1, 
        temperature: 0.55 // lower variance for stability
      });
      const obj = JSON.parse(outs[0] || '{}');
      lastParsed = obj;
      let q = (obj?.question||"").trim();
      let options = Array.isArray(obj?.options)? obj.options : [];
      const dim = obj?.dimension || detectDimension(q);

      // Validate dimension
      const dimOk = dim && allowedList.includes(dim) && !banned.has(dim);

      // Dedupe & sanitize options
      options = dedupeOptions(options);
      if (options.length < 3) {
        // try to repair by adding generic but distinct placeholders per dimension
        const fillersByDim = {
          audience: ["Beginners","Intermediate","Advanced","Freelancers"],
          goal: ["Action","Education","Inspiration","Case study"],
          methods: ["Step-by-step","Checklist","Story-based","Before-after"],
          structure: ["Hook→Steps→CTA","Problem→Fix→Proof","Myth→Facts→CTA","Pain→Solution→Result"],
          count: ["3","4","5","7"],
          order: ["Pain→Solution→Proof","Hook→Steps→CTA","Problem→Myth→Fix","Mistake→Fix→Result"],
          detail: ["High-level","Medium detail","Deep dive","Micro-steps"],
          hook: ["Problem-first","Shocking stat","Promise","Question"],
          tone: ["Casual","Professional","Bold","Playful"],
          length: ["30s","45s","60s","90s"],
          cta: ["Subscribe","Download guide","Join newsletter","Try free tool"],
          examples: ["Before/after","Mini case","User quote","Demo"],
          constraints: ["No face-cam","Budget gear","One take","No music"],
          platform: ["TikTok","Reels","Shorts","Cross-post"],
          visuals: ["Text overlays","B-roll heavy","Screen capture","Minimal graphics"],
          monetization: ["Affiliate","Lead magnet","Sponsorship","Product demo"],
          risks: ["Clickbait","Too long","Too vague","No proof"],
          data: ["Metric screenshot","A/B result","Benchmark","Survey"],
          sources: ["Peer review","Official docs","Internal test","Expert quote"],
          recording: ["Mic priority","Lighting first","Camera angle","Screen record"]
        };
        const fillers = fillersByDim[dim] || [];
        options = dedupeOptions([...options, ...fillers]);
      }

      const hasDup = new Set(options.map(canonicalOption)).size !== options.length;
      const looksAudienceRepeat = dim === 'audience' && (askedDims.has('audience') || lastDim === 'audience');

      if (q && options.length >= 3 && !hasDup && dimOk && !looksAudienceRepeat) {
        return { question: q, options };
      }
      // else fall-through to retry
    } catch (e) {
      // ignore and retry
    }
  }

  // Deterministic fallback: pick next unused dimension by priority
  const pick = DIMENSION_PRIORITY.find(d => !banned.has(d)) || 'goal';
  const templates = {
    audience: { q: "Who should we target?", o: ["Beginners","Intermediate","Advanced","Freelancers"] },
    goal: { q: "What's the primary goal?", o: ["Action","Education","Inspiration","Case study"] },
    methods: { q: "Which approach should we use?", o: ["Step-by-step","Checklist","Story-based","Before-after"] },
    structure: { q: "Which structure should we follow?", o: ["Hook→Steps→CTA","Problem→Fix→Proof","Myth→Facts→CTA","Pain→Solution→Result"] },
    count: { q: "How many key points?", o: ["3","4","5","7"] },
    order: { q: "What order should we use?", o: ["Pain→Solution→Proof","Hook→Steps→CTA","Problem→Myth→Fix","Mistake→Fix→Result"] },
    detail: { q: "How detailed should tips be?", o: ["High-level","Medium detail","Deep dive","Micro-steps"] },
    hook: { q: "What hook style fits best?", o: ["Problem-first","Shocking stat","Promise","Question"] },
    tone: { q: "What tone should we use?", o: ["Casual","Professional","Bold","Playful"] },
    length: { q: "Target runtime?", o: ["30s","45s","60s","90s"] },
    cta: { q: "Which CTA should we add?", o: ["Subscribe","Download guide","Join newsletter","Try free tool"] },
    examples: { q: "What example type to show?", o: ["Before/after","Mini case","User quote","Demo"] },
    constraints: { q: "Any constraints to respect?", o: ["No face-cam","Budget gear","One take","No music"] },
    platform: { q: "Which platform first?", o: ["TikTok","Reels","Shorts","Cross-post"] },
    visuals: { q: "Visual style preference?", o: ["Text overlays","B-roll heavy","Screen capture","Minimal graphics"] },
    monetization: { q: "Monetization angle?", o: ["Affiliate","Lead magnet","Sponsorship","Product demo"] },
    risks: { q: "What pitfall to avoid?", o: ["Clickbait","Too long","Too vague","No proof"] },
    data: { q: "Evidence to include?", o: ["Metric screenshot","A/B result","Benchmark","Survey"] },
    sources: { q: "Preferred source type?", o: ["Peer review","Official docs","Internal test","Expert quote"] },
    recording: { q: "Recording priority?", o: ["Mic priority","Lighting first","Camera angle","Screen record"] }
  };
  const fallback = templates[pick];
  return { question: fallback.q, options: fallback.o };
}

/* -------- Phase별 처리 로직 -------- */
async function handleInitialPhase({ text, language, duration, tone, style }) {
  const system = buildSystemPrompt(language, text);
  const user = buildUserPrompt({ text, language, duration, tone, style });

  const outs = await callOpenAI({ system, user, n: 1, temperature: 0.7 });
  if (!outs.length) throw new Error("Empty response");

  const obj = JSON.parse(outs[0]);
  let lines = Array.isArray(obj?.lines)
    ? obj.lines.map(x => typeof x === "string" ? x : String(x?.text || ""))
    : [];
  lines = lines.map(sanitizeLine).map(s => s.trim()).filter(Boolean);
  
  if (lines.length === 0) lines = ["Write something specific and concrete."];

  return { result: lines.join("\n") };
}

async function handleRefinementQuestionPhase(body) {
  const { 
    baseScript, 
    conversationHistory, 
    keyword, 
    style,
    scriptLength,
    tone,
    language 
  } = body;
  
  const result = await generateRefinementQuestion({
    baseScript,
    conversationHistory,
    keyword,
    style,
    scriptLength,
    tone,
    language
  });

  return result;
}

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

async function handleFinalPhase(body) {
  const {
    text,
    language = "English",
    length = 45,
    tone = "Casual",
    style = "faceless",
    timestamps = true,
    maxLines = 0,
    includeQuality = false,
    refinementContext = null,
    baseScript = null,
    outputType = "script"
  } = body;

  const systemBase = buildSystemPrompt(language, text);
  const refinementNote = refinementContext 
    ? `\n\nUSER PREFERENCES from refinement chat:\n${refinementContext}\n\nIncorporate these preferences naturally into the script structure and content.`
    : "";
  const system = systemBase + refinementNote;

  const user = buildUserPrompt({ text, language, duration: length, tone, style });

  const outs = await callOpenAI({ system, user, n: 5, temperature: 0.75 });
  if (!outs.length) throw new Error("Empty response");

  const candidates = outs.map((o) => {
    const obj = JSON.parse(o);
    let lines = Array.isArray(obj?.lines)
      ? obj.lines.map(x => typeof x === "string" ? x : String(x?.text || ""))
      : [];
    lines = lines.map(sanitizeLine).map(s => s.trim()).filter(Boolean);
    if (maxLines > 0 && lines.length > maxLines) lines = lines.slice(0, maxLines);
    if (lines.length === 0) lines = ["Write something specific and concrete."];
    return { lines };
  });

  let bestIdx = 0, judgeDump = null;
  try {
    const judge = await judgeCandidates(candidates, text);
    bestIdx = judge.best_index;
    judgeDump = judge;
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

  let result;
  if (outputType === "complete") {
    const scriptText = timestamps
      ? allocateDurationsByWords(best.lines, durationSec)
      : best.lines.join("\n");

    result = {
      script: scriptText,
      transitions: [
        { time: "0.0s", type: "Fade In", description: "Opening transition" },
        { time: `${(durationSec/2).toFixed(1)}s`, type: "Quick Cut", description: "Mid-point emphasis" }
      ],
      bRoll: [
        { timeRange: `0.0-${(durationSec/3).toFixed(1)}s`, content: "Relevant B-roll footage" }
      ],
      textOverlays: [
        { time: "0.5s", text: text, style: "Bold Title" }
      ],
      soundEffects: [
        { time: "0.0s", effect: "Swoosh" }
      ]
    };
  } else {
    result = timestamps
      ? allocateDurationsByWords(best.lines, durationSec)
      : best.lines.join("\n");
  }

  const payload = { result };
  if (includeQuality && judgeDump) payload.quality = judgeDump;
  
  return payload;
}

/* -------- Main Handler -------- */
module.exports = async (req, res) => {
  if (!setupCORS(req, res)) {
    if (req.method === "OPTIONS") return res.status(204).end();
    return res.status(403).json({ error: "CORS: origin not allowed" });
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  let body;
  try { 
    body = await parseRequestBody(req); 
  } catch (err) { 
    return res.status(err?.status || 400).json({ error: err.message || "Invalid request body" }); 
  }

  const { text, phase } = body || {};

  try {
    if (phase === "initial") {
      if (!text || typeof text !== "string" || text.trim().length < 3) {
        return res.status(400).json({ error: "`text` is required (≥ 3 chars)" });
      }
      const result = await handleInitialPhase(body);
      return res.status(200).json(result);
    }

    if (phase === "refinement-question" || phase === "refinement-question-only") {
      const result = await handleRefinementQuestionPhase(body);
      return res.status(200).json(result);
    }

    if (phase === "final") {
      if (!text || typeof text !== "string" || text.trim().length < 3) {
        return res.status(400).json({ error: "`text` is required (≥ 3 chars)" });
      }
      const result = await handleFinalPhase(body);
      return res.status(200).json(result);
    }

    if (!text || typeof text !== "string" || text.trim().length < 3) {
      return res.status(400).json({ error: "`text` is required (≥ 3 chars)" });
    }
    const result = await handleFinalPhase(body);
    return res.status(200).json(result);

  } catch (error) {
    const msg = String(error?.message || "Internal error");
    if (process.env.DEBUG_ERRORS === "1" || process.env.DEBUG_ERRORS === "true") {
      console.error("[API Error]", msg);
    } else {
      console.error("[API Error]");
    }
    return res.status(error?.status || 500).json({ 
      error: (process.env.DEBUG_ERRORS ? msg : "Internal server error") 
    });
  }
};
