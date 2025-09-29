"use strict";

/* =====================================================================
   Ultra High Quality (UHQ) Script Generator — 1-Minute Tuned
   - Best-of-6(병렬 2콜 × n=3) → 상위 2개 에디터 리라이트(병렬)
   - 로컬 Booster로 HOOK/숫자/질문/2인칭/단어수/CTA 강제
   - 다중 평가지표(훅/타이밍/구조/참여도/명료도/신규성) 리랭크
   - JSON 출력 강제, v1 API 완전 호환 (result), 상위 K개 옵션(alternatives)
   - 모델/BASE_URL/KEY 는 ENV로 주입 (모델 기본값: gpt-4o-mini)
   ===================================================================== */

/* ============================== 유틸 상수 ============================== */
const DEFAULT_MODEL = "gpt-4o-mini";       // 모델은 그대로
const MAX_BODY_BYTES = Math.max(256_000, Math.min(Number(process.env.MAX_BODY_BYTES) || 1_000_000, 5_000_000));
const MIN_DURATION = 15;
const MAX_DURATION = 180;
const MIN_SLICE = 0.4;
const DEC = (n) => Math.round(n * 10) / 10;

// 품질/샘플 관련
const QUALITY_THRESHOLD = 82;
const WORDS_MIN = 10;
const WORDS_MAX = 14;

// 금지/약화 표현(클리셰 제거)
const BAN_PHRASES = [
  "핵심 포인트 준비 중","알려줄게","보여줄게","이 영상에서","지금부터","끝까지 봐",
  "시작해보자","자","여러분","시청자 여러분","꼭 봐","봐봐"
];
const STRONG_NUM_FILLERS = ["97%","30초","2분","150","3스텝","2배","10배"];

/* ============================== fetch 폴리필 ============================== */
const _fetch = (typeof fetch === "function")
  ? fetch
  : (...args) => import("node-fetch").then(({ default: f }) => f(...args));

/* ============================== CORS ============================== */
function setupCORS(req, res) {
  var allowOrigins = process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "";
  var origin = req && req.headers ? (req.headers.origin || "") : "";

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("Vary", "Origin");

  var list = [];
  if (allowOrigins) {
    var parts = allowOrigins.split(",");
    for (var i = 0; i < parts.length; i++) {
      var s = (parts[i] || "").trim();
      if (s) list.push(s);
    }
  }
  var allowAll = list.indexOf("*") !== -1 || list.length === 0;
  var allowed = allowAll || (origin && list.indexOf(origin) !== -1);
  res.setHeader("Access-Control-Allow-Origin", allowed ? (origin || "*") : "*");
  return true;
}

/* ============================== 설정 ============================== */
function getConfig() {
  return {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL || DEFAULT_MODEL,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || "https://api.openai.com",
    HARD_TIMEOUT_MS: Math.max(20000, Math.min(Number(process.env.HARD_TIMEOUT_MS) || 45000, 90000)),
    DEBUG_ERRORS: process.env.DEBUG_ERRORS === "1" || process.env.DEBUG_ERRORS === "true",
    ENABLE_QUALITY_CHECK: process.env.ENABLE_QUALITY_CHECK !== "false"
  };
}

/* ============================== 바디 파싱 ============================== */
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

/* ============================== 언어/속도 ============================== */
function normalizeLanguageKey(language) {
  const L0 = String(language || "").trim().toLowerCase();
  const L = L0.replace(/[_-]([a-z]{2})$/i, "");
  if (L.includes("korean") || L.includes("한국") || L === "ko") return "ko";
  if (L.includes("english") || L === "en") return "en";
  if (L.includes("spanish") || L === "es") return "es";
  if (L.includes("french") || L === "fr") return "fr";
  if (L.includes("german") || L === "de") return "de";
  if (L.includes("italian") || L === "it") return "it";
  if (L.includes("portuguese") || L === "pt") return "pt";
  if (L.includes("dutch") || L === "nl") return "nl";
  if (L.includes("russian") || L === "ru") return "ru";
  if (L.includes("japanese") || L.includes("日本") || L === "ja") return "ja";
  if (L.includes("chinese") || L.includes("中文") || L === "zh") return "zh";
  if (L.includes("arabic") || L === "ar") return "ar";
  return "en";
}
function getWordsPerSecond(language) {
  const WPS_TABLE = { en:2.3, ko:2.3, es:2.6, fr:2.4, de:2.2, it:2.4, pt:2.4, nl:2.2, ru:2.3, ja:2.7, zh:2.7, ar:2.2 };
  const langKey = normalizeLanguageKey(language);
  return WPS_TABLE[langKey] || 2.3;
}

/* ============================== 문자열 유틸 ============================== */
function normalizeNewlines(text) {
  const str = String(text || ""); let out = "", LF = "\n";
  for (let i=0;i<str.length;i++){ const code=str.charCodeAt(i); if(code===13){ if(str.charCodeAt(i+1)===10) i++; out+=LF; } else out+=str[i]; }
  return out;
}
function splitLines(text) {
  const n = normalizeNewlines(text); const lines=[]; let buf="";
  for (let i=0;i<n.length;i++){ const code=n.charCodeAt(i); if(code===10){ const t=buf.trim(); if(t) lines.push(t); buf=""; } else buf+=n[i]; }
  if (buf.trim()) lines.push(buf.trim()); return lines;
}
function stripTimePrefix(line) {
  const text = String(line || "").trim();
  if (text.length > 2 && text[0] === "[") {
    const j = text.indexOf("]");
    if (j > 1) return text.slice(j+1).trim();
  }
  return text;
}

/* ============================== 카테고리/후크 템플릿 ============================== */
function detectCategory(idea) {
  const s = String(idea || "").toLowerCase();
  if (/\b(valorant|제트|jett|game|gaming|fps|league|lol|fortnite|minecraft|apex|warzone)\b/.test(s)) return "gaming";
  if (/\b(workout|exercise|gym|fitness|muscle|weight|cardio|yoga)\b/.test(s)) return "fitness";
  if (/\b(iphone|app|tech|ai|software|code|programming|gadget)\b/.test(s)) return "tech";
  if (/\b(recipe|cook|food|meal|kitchen|bake|ingredient)\b/.test(s)) return "cooking";
  if (/\b(money|invest|crypto|stock|rich|wealth|business|startup)\b/.test(s)) return "money";
  if (/\b(relationship|dating|love|breakup|crush|marriage)\b/.test(s)) return "relationship";
  return "general";
}
function getUltraViralHooks(category) {
  const hooks = {
    gaming: [
      "Stop playing [GAME] if you don't know this",
      "This is why you're still hardstuck in [RANK]",
      "[GAME] pros have been lying to you",
      "The [FEATURE] exploit that got me banned",
      "I hit [RANK] using only THIS trick",
      "Why 90% of [GAME] players quit after seeing this"
    ],
    general: [
      "You've been doing [TOPIC] wrong this whole time",
      "97% of people don't know this about [TOPIC]",
      "The [TOPIC] trick that went viral for a reason",
      "Stop [ACTION] immediately (scientists explain why)"
    ]
  };
  return hooks[category] || hooks.general;
}

/* ============================== 프롬프트 ============================== */
function buildWriterSystem(style, tone, language, videoIdea) {
  const category = detectCategory(videoIdea);
  const hooks = getUltraViralHooks(category);
  return `You are the best short-form viral SCRIPT WRITER.

LANGUAGE: Write ONLY in ${language}
FORMAT: Return a single JSON object with keys: lang, duration_sec, lines[].
LINES: 6 lines if no CTA, 7 if CTA=true (HOOK, ESCALATION, FACT, PROOF, PAYOFF, TWIST, CTA?)

HARD RULES:
- First line must be HOOK with >=2 power-words, includes a number, a contrast word (but/actually/instead), and ends with '?'.
- Use direct second person (target language) >=4 times total.
- Put specific numbers in at least 2 lines (percentages, $, seconds, counts).
- Each line must be 10–14 words.
- No meta/filler: no "in this video", "let me show you", etc.
- Concrete, testable, measurable statements.

CATEGORY: ${category.toUpperCase()}
Try hooks like:
${hooks.map(h => `- ${h}`).join('\n')}
`;
}
function buildEditorSystem(language) {
  return `You are a ruthless SHORT-FORM SCRIPT EDITOR.
LANGUAGE: Write ONLY in ${language}
TASK: Given a JSON script draft, rewrite it into a sharper JSON following the schema.
Focus on punchy verbs, concrete numbers, direct second-person, 10–14 words per line.
Preserve tag order. No commentary.`;
}
function buildUserPromptJSON(params, improvementHints = [], pass = 1) {
  const { text, style, tone, language, duration, wordsTarget, ctaInclusion } = params;
  const base = {
    task: pass === 1 ? "Draft" : `Refine-Pass-${pass}`,
    topic: text,
    style,
    tone: `${tone} but intense`,
    language,
    duration_sec: duration,
    words_target: wordsTarget,
    cta: !!ctaInclusion,
    schema: {
      lang: "string",
      duration_sec: "number",
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
  };
  if (improvementHints?.length) base.retry_guidance = improvementHints;
  return JSON.stringify(base);
}

/* ============================== JSON 파서 ============================== */
function safeJsonParse(input){ try{ return JSON.parse(input); }catch{ return null; } }
function extractJsonBlock(text){
  if(!text) return null;
  const m = text.match(/\{[\s\S]*\}$/);
  if (m){ const o=safeJsonParse(m[0]); if(o) return o; }
  const i=text.indexOf("{"), j=text.lastIndexOf("}"); if(i>=0&&j>i) return safeJsonParse(text.slice(i,j+1));
  return null;
}

/* ============================== Booster & 규칙 보정 ============================== */
function ensureHookCompliance(text) {
  let t = String(text || "").trim();
  const isKo = /[가-힣]/.test(t);
  while (t && /[?!.\s]$/.test(t)) t = t.slice(0, -1);
  if (!/[0-9]/.test(t)) t += " 97%";
  const lower = t.toLowerCase();
  const hasContrastEn = /\b(but|actually|instead|however)\b/.test(lower);
  const hasContrastKo = /(하지만|근데|사실|반대로)/.test(t);
  if (!hasContrastEn && !hasContrastKo) t += (isKo ? " 사실" : " actually");
  if (isKo) { if (!/^(멈춰|그만|절대|진짜)/.test(t)) t = "멈춰 " + t; }
  else { if (!lower.startsWith("stop")) t = "Stop " + t; }
  return t + "?";
}
function clipWordsToRange(txt, min = WORDS_MIN, max = WORDS_MAX) {
  const words = String(txt || "").trim().split(/\s+/).filter(Boolean);
  if (words.length < min) {
    const need = min - words.length;
    for (let i=0;i<need;i++){ words.push(STRONG_NUM_FILLERS[i % STRONG_NUM_FILLERS.length]); }
    return words.join(" ");
  }
  if (words.length > max) {
    let s = words.join(" ");
    BAN_PHRASES.forEach(p => { s = s.replace(new RegExp(p, "g"), ""); });
    const arr = s.trim().split(/\s+/).filter(Boolean);
    if (arr.length <= max) return arr.join(" ");
    return arr.slice(0, max - 1).concat([arr[arr.length - 1].replace(/[?.!]*$/,"") + (/\?$/.test(s) ? "?" : "")]).join(" ");
  }
  return words.join(" ");
}
function enforceLineWordRange(lines) {
  return lines.map(x => ({ ...x, text: clipWordsToRange(x.text, WORDS_MIN, WORDS_MAX) }));
}
function ensureQuestions(lines, desired = 3, preferredIdx = [1,3,5]) {
  let qCount = lines.filter(l => /\?$/.test(l.text)).length;
  for (const idx of preferredIdx) {
    if (qCount >= desired) break;
    if (lines[idx] && !/\?$/.test(lines[idx].text)) {
      lines[idx].text = lines[idx].text.replace(/([.!])?$/, "?");
      qCount++;
    }
  }
}
function ensureNumbers(lines) {
  const targets = ["FACT","PAYOFF"];
  for (const tag of targets) {
    const i = lines.findIndex(l => l.tag === tag);
    if (i >= 0 && !/[0-9]/.test(lines[i].text)) {
      lines[i].text += ` — ${STRONG_NUM_FILLERS[(i + 1) % STRONG_NUM_FILLERS.length]}`;
    }
  }
}
function ensureSecondPerson(lines, language) {
  const lang = normalizeLanguageKey(language);
  if (lang === "ko") {
    let count = (lines.map(l => l.text).join(" ").match(/너|당신|네가|니가|너의|당신의|해|해라|하세요|해봐|하지마|해야 해|저장해|팔로우해|댓글/g) || []).length;
    let need = 4 - count;
    for (let i=1;i<lines.length-1 && need>0;i++){
      if (!/(너|당신)/.test(lines[i].text)) { lines[i].text = (lines[i].text.startsWith("너") ? lines[i].text : ("너 " + lines[i].text)); need--; }
    }
  } else {
    let joined = lines.map(l => l.text).join(" ").toLowerCase();
    let count = (joined.match(/\byou\b|\byour\b/g) || []).length;
    let need = 4 - count;
    for (let i=1;i<lines.length-1 && need>0;i++){
      if (!/\byou\b|\byour\b/i.test(lines[i].text)) { lines[i].text += (/\?$/.test(lines[i].text) ? " you" : ". you"); need--; }
    }
  }
}
function ensureCTA(lines, ctaInclusion) {
  if (!ctaInclusion) return;
  const last = lines[lines.length - 1];
  if (!last || last.tag !== "CTA") return;
  if (!/(follow|save|comment|share|like|구독|저장|댓글|공유)/i.test(last.text)) last.text += " — 도움 됐으면 저장/팔로우";
}
function normalizeLineCountForCTA(lines, ctaInclusion) {
  const target = ctaInclusion ? 7 : 6;
  const TAG_ORDER = ["HOOK","ESCALATION","FACT","PROOF","PAYOFF","TWIST", ...(ctaInclusion ? ["CTA"] : [])];
  const map = new Map(lines.map(l => [String(l.tag||"").toUpperCase(), {tag:String(l.tag||"").toUpperCase(), text:String(l.text||"").trim()}]));
  const rebuilt = TAG_ORDER.map(tag => map.get(tag) || { tag, text: (tag==="HOOK" ? "멈춰 — 97%가 놓치는 진짜 이유?" : "구체적 팁으로 채워라") });
  if (rebuilt.length > target) {
    if (ctaInclusion) { rebuilt[4].text += ". " + rebuilt[5].text; rebuilt.splice(5,1); }
    else { rebuilt[3].text += ". " + rebuilt[4].text; rebuilt.splice(4,1); }
  } else if (rebuilt.length < target) {
    rebuilt.push({ tag: ctaInclusion ? "CTA" : "TWIST", text: "지금 저장해 — 나중에 써먹어" });
  }
  return rebuilt;
}
function booster(jsonObj, params) {
  try {
    if (!jsonObj || !Array.isArray(jsonObj.lines)) return jsonObj;
    const { language, ctaInclusion } = params;
    let lines = jsonObj.lines.map(x => ({ tag: (x.tag || '').toUpperCase(), text: (x.text || '').trim() }));
    lines = normalizeLineCountForCTA(lines, ctaInclusion);
    lines[0].text = ensureHookCompliance(lines[0].text);
    lines = lines.map(l => { let t=l.text; BAN_PHRASES.forEach(p=>{ t=t.replace(new RegExp(p,"g"),""); }); return { ...l, text: clipWordsToRange(t, WORDS_MIN, WORDS_MAX) }; });
    ensureQuestions(lines, 3, [1,3,5]); ensureNumbers(lines); ensureSecondPerson(lines, language); ensureCTA(lines, ctaInclusion);
    return { ...jsonObj, lines };
  } catch (e) {
    console.error("Booster error", e);
    return jsonObj;
  }
}

/* ============================== 타임스탬프 조립 ============================== */
function assembleWithTimingFromJSON(jsonObj, totalSeconds) {
  try {
    const duration = Math.max(1, DEC(Number(totalSeconds)||0));
    const items = (jsonObj?.lines || []).map(it => ({...it}));
    if (!items.length) return "";
    const weights = items.map((it)=>{ const words=String(it.text||'').split(/\s+/).filter(Boolean).length; if(it.tag==='HOOK') return Math.max(1,words*0.8); if(it.tag==='CTA')return Math.max(1,words*0.7); return Math.max(1,words); });
    let sum = weights.reduce((a,b)=>a+b,0)||1; const durations = weights.map(w => (w/sum)*duration);
    const h = items.findIndex(it=>it.tag==='HOOK'); if(h>=0) durations[h]=Math.min(4, Math.max(2, durations[h]));
    const c = items.findIndex(it=>it.tag==='CTA'); if(c>=0) durations[c]=Math.min(3, Math.max(2, durations[c]));
    const frozen = new Set(); if(h>=0) frozen.add(h); if(c>=0) frozen.add(c);
    const frozenSum = Array.from(frozen).reduce((s,i)=>s+durations[i],0);
    const freeIdx = durations.map((_,i)=>i).filter(i=>!frozen.has(i));
    const freeSum = freeIdx.reduce((s,i)=>s+durations[i],0) || 1;
    const targetFree = Math.max(0.1, duration - frozenSum);
    const scale = targetFree / freeSum; freeIdx.forEach(i => { durations[i] = Math.max(MIN_SLICE, durations[i] * scale); });
    const out = []; let t = 0;
    for (let i=0;i<items.length;i++){ const start=DEC(t), end=i===items.length-1?DEC(duration):DEC(t+durations[i]); const tagPrefix = items[i].tag==='HOOK'?'[HOOK] ':(items[i].tag==='CTA'?'[CTA] ':''); out.push(`[${start.toFixed(1)}-${end.toFixed(1)}] ${tagPrefix}${items[i].text}`); t=end; }
    return out.join("\n");
  } catch (e) {
    console.error("Assemble error", e);
    return "";
  }
}

/* ============================== 비주얼 요소 (옵션) ============================== */
function generateSmartVisualElements(script, videoIdea, style) {
  try {
    const lines = splitLines(script);
    const transitions = [], bRoll = [], textOverlays = [], soundEffects = [];
    const transitionTypes = {
      meme: ["Jump cut", "Zoom punch", "Glitch", "Speed ramp", "Shake"],
      quicktip: ["Number pop", "Slide", "Highlight", "Circle zoom"],
      challenge: ["Whip pan", "Crash zoom", "Impact frame", "Flash"],
      storytelling: ["Cross fade", "Time lapse", "Match cut", "Reveal"],
      productplug: ["Product reveal", "Comparison split", "Before/after"],
      faceless: ["Text slam", "Motion blur", "Kinetic type"]
    };
    const styleTransitions = transitionTypes[style] || transitionTypes.faceless;
    lines.forEach((line, index) => {
      const m = line.match(/\[\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*\]/);
      if (!m) return;
      const start = parseFloat(m[1]); const end = parseFloat(m[2]);
      const content = line.substring(m[0].length).trim();
      const isHook = /\[HOOK\]/i.test(content); const isCTA = /\[CTA\]/i.test(content);
      if (index > 0) transitions.push({ time: `${start.toFixed(1)}s`, type: styleTransitions[index % styleTransitions.length], intensity: isHook ? "Maximum" : "Medium" });
      if (!isHook && !isCTA) {
        const category = detectCategory(videoIdea);
        let suggestion = "Relevant stock footage, animated graphics";
        if (category === "gaming") suggestion = "Gameplay highlight, rank-up animation";
        else if (category === "fitness") suggestion = "Exercise demo, timer overlay";
        else if (category === "tech") suggestion = "Screen recording, feature demo";
        else if (category === "money") suggestion = "Chart animation, metric counters";
        bRoll.push({ timeRange: `${start.toFixed(1)}-${end.toFixed(1)}s`, content: suggestion });
      }
      if (isHook) { textOverlays.push({ time: `${start.toFixed(1)}s`, text: "⚠️ " + content.replace(/\[HOOK\]/i,"").trim().toUpperCase(), style: "Massive bold with shake" }); soundEffects.push({ time: `${start.toFixed(1)}s`, effect: "Bass drop + whoosh" }); }
      else if (/\d+/.test(content)) {
        const numbers = content.match(/\d+[%$]?|\$\d+/g);
        if (numbers) textOverlays.push({ time: `${start.toFixed(1)}s`, text: numbers[0], style: "Giant number glow" });
      }
      if (/stop|never|wrong|멈춰|절대|잘못/i.test(content)) soundEffects.push({ time: `${start.toFixed(1)}s`, effect: "Alert/Error" });
      if (isCTA) soundEffects.push({ time: `${start.toFixed(1)}s`, effect: "Success chime/Subscribe" });
    });
    return { transitions, bRoll, textOverlays, soundEffects };
  } catch (e) {
    console.error("Visual generation error", e);
    return { transitions: [], bRoll: [], textOverlays: [], soundEffects: [] };
  }
}

/* ============================== 줄바꿈 함수(중요: 구문오류 방지) ============================== */
function applyViralLineBreaksToScript(script) {
  // 분석기 혼동 방지: 원문 그대로 반환
  return String(script || "");
}

/* ============================== OpenAI 호출 ============================== */
async function callOpenAI(systemPrompt, userPrompt, config, opts) {
  const { OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL, HARD_TIMEOUT_MS } = config;
  const { temperature = 0.8, top_p = 0.92, n = 3, presence_penalty = 0.2, frequency_penalty = 0.2 } = opts || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);
  const url = `${(process.env.OPENAI_BASE_URL || OPENAI_BASE_URL).replace(/\/+$/,"")}/v1/chat/completions`;

  try {
    const response = await _fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.OPENAI_API_KEY || OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: (process.env.OPENAI_MODEL || OPENAI_MODEL),
        temperature, top_p, n,
        max_tokens: 1500,
        presence_penalty, frequency_penalty,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      }),
      signal: controller.signal
    });

    clearTimeout(timer);
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const brief = (errorText || "").slice(0, 512);
      throw Object.assign(new Error(`OpenAI API ${response.status}: ${brief}`), { status: response.status });
    }
    const data = await response.json();
    const choices = data?.choices || [];
    return choices.map(c => c?.message?.content?.trim()).filter(Boolean);
  } catch (error) {
    clearTimeout(timer);
    if (error.name === "AbortError") throw new Error("Request timeout");
    throw error;
  }
}

/* ============================== 평가(기본) ============================== */
function evaluateScriptQuality(script, params) {
  try {
    const { duration, language, ctaInclusion } = params;
    const langKey = normalizeLanguageKey(language);
    const lines = splitLines(script);
    if (!lines.length) return { total: 0, breakdown: {} };

    // HOOK (30)
    const firstLine = stripTimePrefix(lines[0] || "").toLowerCase();
    const ultra = ["stop","wrong","never","always","nobody","everyone","mistake","secret","truth","actually","insane","crazy","shocking","viral","failed","멈춰","그만","잘못","비밀","진짜","사실","충격","망함","실패","금지","필독"];
    const hookWordCount = ultra.filter(w => firstLine.includes(w)).length;
    const hasQuestion = firstLine.includes("?");
    const hasNumber = /\d+/.test(firstLine);
    const hasContrast = /\b(but|however|actually|instead)\b/.test(firstLine) || /(하지만|근데|사실|반대로)/.test(firstLine);
    let hookScore = Math.min(30, hookWordCount*8 + (hasQuestion?6:0) + (hasNumber?5:0) + (hasContrast?6:0));

    // 타이밍 (20)
    const expectedWords = Math.round(duration * getWordsPerSecond(language));
    const actualWords = script.replace(/\[[\d.-]+\]/g,"").split(/\s+/).filter(Boolean).length;
    const timingDiff = Math.abs(actualWords - expectedWords) / Math.max(1, expectedWords);
    const timingScore = Math.max(0, Math.round((1 - timingDiff * 1.5) * 20));

    // 구조 (25)
    let structureScore = 0;
    if (/\[HOOK\]/i.test(script)) structureScore += 8;
    if (lines.length >= 6 && lines.length <= 8) structureScore += 10; else if (lines.length >= 5 && lines.length <= 10) structureScore += 5;
    if (ctaInclusion) {
      if (/\[CTA\]/i.test(script) && /follow|comment|share|save|like|구독|저장|댓글|공유/i.test(script)) structureScore += 7;
    } else { structureScore += 7; }
    const validTimestamps = lines.filter(line => /^\[\d+(?:\.\d+)?-\d+(?:\.\d+)?\]/.test(line)).length;
    if (validTimestamps === lines.length) structureScore += 5;

    // 참여도 (25)
    let engagementScore = 0;
    const questions = (script.match(/\?/g) || []).length;
    engagementScore += Math.min(10, questions * 4);
    let secondPersonCount = 0;
    if (langKey === "ko") {
      const koP = /(너|당신|네가|니가|너의|당신의|님)/g; const koI = /(해라|하세요|해요|해봐|하지마|해야 해|해|저장해|팔로우해|댓글)/g;
      secondPersonCount = ((script.match(koP)||[]).length) + ((script.match(koI)||[]).length);
    } else {
      secondPersonCount = (script.toLowerCase().match(/\b(you|your|you're|you've)\b/g) || []).length;
    }
    engagementScore += Math.min(8, secondPersonCount * 2.0);
    const actWords = ["stop","try","wait","look","check","remember","notice","see","멈춰","확인","기억","봐","체크"];
    const actionCount = actWords.filter(w => new RegExp(`\\b${w}\\b`,"i").test(script)).length;
    engagementScore += Math.min(7, actionCount * 3.5);

    const total = Math.min(100, hookScore + timingScore + structureScore + engagementScore);
    return { total, breakdown: { hook: hookScore, timing: timingScore, structure: structureScore, engagement: engagementScore } };
  } catch { return { total: 0, breakdown: {} }; }
}

/* ============================== 평가(확장: 명료도/신규성/패널티) ============================== */
function evaluateScriptQualityCore(script, params) {
  const base = evaluateScriptQuality(script, params);
  const lines = splitLines(script);
  // 명료도(0~20): 10~14 단어 적합도
  let clarity = 0;
  if (lines.length) {
    const scores = lines.map(l => {
      const text = stripTimePrefix(l).replace(/\[HOOK\]|\[CTA\]/gi,"").trim();
      const w = text.split(/\s+/).filter(Boolean).length;
      const diff = Math.abs(w - ((WORDS_MIN + WORDS_MAX)/2));
      return Math.max(0, 1 - diff / 6);
    });
    clarity = Math.round((scores.reduce((a,b)=>a+b,0)/scores.length) * 20);
  }
  // 신규성(0~20): 유니크 단어 비율
  const all = script.toLowerCase().replace(/\[[^\]]+\]/g,"").replace(/[^\w가-힣\s%$]/g,"").split(/\s+/).filter(Boolean);
  const uniq = new Set(all).size;
  const novelty = Math.min(20, Math.round((uniq / Math.max(1, all.length)) * 40));

  // 클리셰 패널티
  let penalty = 0;
  BAN_PHRASES.forEach(p => { if (script.includes(p)) penalty += 3; });

  const total = Math.max(0, Math.min(100, base.total + clarity + novelty - penalty));
  return { total, breakdown: { ...base.breakdown, clarity, novelty, penalty } };
}

/* ============================== 샘플 조립 ============================== */
function assembleCandidateFromLLM(raw, params) {
  const obj = (typeof raw === "string") ? (safeJsonParse(raw) || extractJsonBlock(raw)) : raw;
  if (!obj) return null;
  const boosted = booster(obj, params);
  const script = assembleWithTimingFromJSON(boosted, params.duration);
  return { json: boosted, script };
}

/* ============================== 개선 힌트 ============================== */
function generateImprovementHints(evaluation) {
  const hints = [];
  const { breakdown } = evaluation || { breakdown: {} };
  if (!breakdown) return hints;
  if ((breakdown.hook || 0) < 22) hints.push("- Sharpen HOOK: 2+ power words, include a number, and a contrast word, end with '?'");
  if ((breakdown.timing || 0) < 15) hints.push("- Match total word count to duration within ±10%");
  if ((breakdown.structure || 0) < 20) hints.push("- Keep exactly 6–8 lines, include [HOOK], add [CTA] only if cta=true");
  if ((breakdown.engagement || 0) < 18) hints.push("- Add 2–3 mid-line questions and direct second person 4+ times");
  hints.push("- Remove clichés and meta phrases, keep verbs strong and specific");
  hints.push("- Put concrete numbers in FACT and PAYOFF lines");
  return hints;
}

/* ============================== 1-Minute 튜닝 파이프라인 ============================== */
async function generateWithQualityAssurance(params, config, numCandidatesWanted) {
  const { text, styleKey, tone, language, duration, wordsTarget, ctaInclusion, enableQA } = params;

  // 1) 초안: 온도 0.8/0.7 병렬 생성 (각 n=3 => 최대 6개)
  const systemPrompt = buildWriterSystem(styleKey, tone, language, text);
  const userPrompt   = buildUserPromptJSON(params, [], 1);

  const draftCalls = [
    callOpenAI(systemPrompt, userPrompt, config, { temperature: 0.8, n: 3 }),
    callOpenAI(systemPrompt, userPrompt, config, { temperature: 0.7, n: 3 })
  ];

  const draftResults = await Promise.allSettled(draftCalls);
  let allRaw = [];
  for (const r of draftResults) {
    if (r.status === "fulfilled") allRaw = allRaw.concat(r.value);
  }
  if (!allRaw.length) throw new Error("No drafts returned from model");

  // 2) 조립+확장평가
  let candidates = allRaw
    .map(r => assembleCandidateFromLLM(r, params))
    .filter(Boolean)
    .map(c => {
      const ev = evaluateScriptQualityCore(c.script, params);
      return { ...c, score: ev.total, eval: ev };
    })
    .sort((a,b)=> b.score - a.score);

  // 3) 상위 2개만 에디터 리라이트(병렬, 저온 0.6)
  const topForEdit = candidates.slice(0, Math.min(2, candidates.length));
  if (topForEdit.length) {
    const editorSystem = buildEditorSystem(language);
    const editCalls = topForEdit.map(item => {
      const editorUser = JSON.stringify({
        schema: "same-as-writer",
        improve: [
          "keep 10–14 words/line",
          "make numbers concrete (%, seconds, exact counts)",
          "add direct second person",
          "remove clichés"
        ],
        original: item.json
      });
      return callOpenAI(editorSystem, editorUser, config, { temperature: 0.6, n: 1 })
        .then(out => {
          const edited = assembleCandidateFromLLM(out[0], params);
          if (!edited) return item;
          const ev2 = evaluateScriptQualityCore(edited.script, params);
          return (ev2.total > item.score)
            ? { json: edited.json, script: edited.script, score: ev2.total, eval: ev2 }
            : item;
        })
        .catch(() => item);
    });

    const edited = await Promise.all(editCalls);
    // 기존 상위 2개를 교체(간단 구분) + 재정렬
    const originalSet = new Set(topForEdit.map(x => x.script));
    candidates = candidates
      .filter(x => !originalSet.has(x.script))
      .concat(edited)
      .sort((a,b)=> b.score - a.score);
  }

  // 4) 임계치 미달 시 추가 생성 1회(저온 0.65, n=2)만
  if (enableQA && (candidates[0]?.score || 0) < QUALITY_THRESHOLD) {
    const hintUser = buildUserPromptJSON(params, generateImprovementHints(candidates[0].eval || { breakdown: {} }), 2);
    const extraRaw = await callOpenAI(systemPrompt, hintUser, config, { temperature: 0.65, n: 2 });
    const extra = extraRaw
      .map(r => assembleCandidateFromLLM(r, params))
      .filter(Boolean)
      .map(c => {
        const ev = evaluateScriptQualityCore(c.script, params);
        return { ...c, score: ev.total, eval: ev };
      });
    candidates = candidates.concat(extra).sort((a,b)=> b.score - a.score);
  }

  // 5) 반환
  const topN = candidates.slice(0, Math.max(1, numCandidatesWanted || 1));
  const best = topN[0];
  return {
    script: applyViralLineBreaksToScript(best.script),
    bestEval: best.eval,
    bestScore: best.score,
    attempts: 2, // 병렬 2세트
    status: best.score >= QUALITY_THRESHOLD ? "PASSED" : (best.score >= 70 ? "ACCEPTABLE" : "BELOW_TARGET"),
    alternatives: topN.map(x => x.script),
    alternativesEval: topN.map(x => x.eval),
  };
}

/* ============================== 입력 검증 ============================== */
function validateInputs({ text, style, length, tone, language, ctaInclusion, outputType, numCandidates }) {
  if (!text || typeof text !== "string" || text.trim().length < 3) {
    const e = new Error("`text` is required and must be a string with length ≥ 3");
    e.status = 400; throw e;
  }
  const allowedStyles = ["meme","quicktip","challenge","storytelling","productplug","faceless"];
  let styleKey = String(style || "").toLowerCase();
  if (!allowedStyles.includes(styleKey)) styleKey = "faceless";

  const dur = Math.max(MIN_DURATION, Math.min(Number(length) || 45, MAX_DURATION));
  const toneKey = String(tone || "Casual");
  const langKey = language || "English";
  const cta = !!ctaInclusion;
  const out = String(outputType || "script").toLowerCase();
  const cand = Math.max(1, Math.min(Number(numCandidates) || 1, 5)); // 상위 최대 5개

  return { styleKey, duration: dur, tone: toneKey, language: langKey, cta, output: out, cand };
}

/* ============================== 메인 핸들러 ============================== */
module.exports = async (req, res) => {
  if (!setupCORS(req, res)) {
    if (req.method === "OPTIONS") return res.status(204).end();
    return res.status(403).json({ error: "CORS: origin not allowed" });
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const config = getConfig();
  if (!config.OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

  let body;
  try { body = await parseRequestBody(req); }
  catch (err) { return res.status(err?.status || 400).json({ error: err.message || "Invalid request body" }); }

  try {
    const {
      text, style, length, tone = "Casual",
      language = "English", ctaInclusion = false,
      outputType = "script",
      enableQualityCheck = true,
      includeQualityScore = false,
      numCandidates
    } = body;

    const { styleKey, duration, tone: toneKey, language: langInput, cta, output, cand } =
      validateInputs({ text, style, length, tone, language, ctaInclusion, outputType, numCandidates });

    const wps = getWordsPerSecond(langInput);
    const wordsTarget = Math.round(duration * wps);

    const result = await generateWithQualityAssurance({
      text,
      styleKey,
      tone: toneKey,
      language: langInput,
      duration,
      wordsTarget,
      ctaInclusion: cta,
      enableQA: config.ENABLE_QUALITY_CHECK && enableQualityCheck
    }, config, cand);

    let visualElements = null;
    if (output === "complete") {
      visualElements = generateSmartVisualElements(result.script, text, styleKey);
    }

    const finalScript = applyViralLineBreaksToScript(result.script);

    const response = {
      result: output === "complete" ? { script: finalScript, ...visualElements } : finalScript
    };

    if (cand > 1) {
      response.alternatives = result.alternatives;
    }

    if (includeQualityScore && result.bestScore !== null) {
      response.quality = {
        score: result.bestScore,
        breakdown: result.bestEval?.breakdown || {},
        attempts: result.attempts,
        status: result.status
      };
      if (cand > 1) {
        response.alternativesQuality = result.alternativesEval;
      }
    }

    return res.status(200).json(response);

  } catch (error) {
    const msg = String(error?.message || "Internal error");
    if (config.DEBUG_ERRORS) console.error("[API Error]", msg);
    else console.error("[API Error]");
    return res.status(error?.status || 500).json({ error: config.DEBUG_ERRORS ? msg : "Internal server error" });
  }
};

/* --- vercel.json (선택, 루트에 생성하면 CORS 기본 헤더 보장) ---
{
  "functions": { "api/*.js": { "runtime": "nodejs18.x" } },
  "headers": [
    {
      "source": "/api/(.*)",
      "headers": [
        { "key": "Access-Control-Allow-Origin", "value": "*" },
        { "key": "Access-Control-Allow-Methods", "value": "GET, POST, OPTIONS" },
        { "key": "Access-Control-Allow-Headers", "value": "Content-Type, Authorization, X-Requested-With" },
        { "key": "Access-Control-Max-Age", "value": "600" }
      ]
    }
  ]
}
--- end vercel.json --- */
