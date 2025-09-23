// api/generate-content.js — 하이엔드 최종판 (항상 VIRAL 모드)
// ✅ 모델 버전 고정: 기본 gpt-4o-mini (환경변수 OPENAI_MODEL로만 변경 가능)
// ✅ 목표: 어떤 상황에서도 때려 박는 바이럴 톤 + 깔끔한 줄바꿈
// ✅ 포함: 보안/안정성(바디 제한, CORS), 고품질 프롬프트, 타이밍 엔진, 비주얼 가이드
"use strict";

/* ============================== 유틸 상수 ============================== */
const DEFAULT_MODEL = "gpt-4o-mini"; // (변경 금지, 환경변수로만 오버라이드)
const MAX_BODY_BYTES = Math.max(256_000, Math.min(Number(process.env.MAX_BODY_BYTES) || 1_000_000, 5_000_000)); // 256KB~5MB
const MIN_DURATION = 15;
const MAX_DURATION = 180;
const MIN_SLICE = 0.4; // 각 세그 최소 길이(초)
const DEC = (n) => Math.round(n * 10) / 10;

/* ============================== CORS 설정 ============================== */
function setupCORS(req, res) {
  const rawList = process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "";
  const allowServerNoOrigin = (process.env.ALLOW_SERVER_NO_ORIGIN === "1" || process.env.ALLOW_SERVER_NO_ORIGIN === "true");
  const ALLOW_LIST = rawList
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((v) => { try { return new URL(v).origin; } catch { return v; } });

  const requestOrigin = (() => {
    const o = req.headers.origin;
    if (!o) return null;
    try { return new URL(o).origin; } catch { return o; }
  })();

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Max-Age", "600");

  const allowAll = ALLOW_LIST.includes("*");
  const hasOrigin = !!requestOrigin;
  const listEmpty = ALLOW_LIST.length === 0;

  if (!hasOrigin && !allowServerNoOrigin && !allowAll && !listEmpty) {
    return false;
  }

  const allowThis =
    allowAll ||
    (listEmpty && (hasOrigin || allowServerNoOrigin)) ||
    (hasOrigin && ALLOW_LIST.includes(requestOrigin));

  if (allowAll) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (listEmpty) {
    if (hasOrigin) {
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    } else if (allowServerNoOrigin) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else {
      return false;
    }
  } else if (allowThis && hasOrigin) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
  } else {
    return false;
  }
  return true;
}

/* ============================== 환경 설정 ============================== */
function getConfig() {
  return {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL || DEFAULT_MODEL, // gpt-4o-mini 유지
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || "https://api.openai.com",
    HARD_TIMEOUT_MS: Math.max(15000, Math.min(Number(process.env.HARD_TIMEOUT_MS) || 30000, 120000)),
    DEBUG_ERRORS: process.env.DEBUG_ERRORS === "1" || process.env.DEBUG_ERRORS === "true"
  };
}

/* ============================== 바디 파싱(사이즈 제한) ============================== */
function readRawBody(req, limitBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0; let raw = "";
    req.on("data", (c) => {
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
  const raw = await readRawBody(req).catch((err) => { throw err; });
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

/* ============================== 언어/속도 ============================== */
function normalizeLanguageKey(language) {
  const L0 = String(language || "").trim().toLowerCase();
  const L = L0.replace(/[_-]([a-z]{2})$/i, ""); // ko-KR -> ko
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
  const WPS_TABLE = {
    en: 2.3, ko: 2.5, es: 2.6, fr: 2.4, de: 2.2, it: 2.4, pt: 2.4,
    nl: 2.2, ru: 2.3, ja: 2.8, zh: 2.8, ar: 2.2
  };
  const langKey = normalizeLanguageKey(language);
  return WPS_TABLE[langKey] || 2.3;
}

/* ============================== 문자열 유틸 ============================== */
function normalizeNewlines(text) {
  const str = String(text || "");
  let out = "";
  const LF = "\n";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 13) { // CR
      if (str.charCodeAt(i + 1) === 10) i++;
      out += LF;
    } else {
      out += str[i];
    }
  }
  return out;
}

function splitLines(text) {
  const n = normalizeNewlines(text);
  const lines = [];
  let buf = "";
  for (let i = 0; i < n.length; i++) {
    const code = n.charCodeAt(i);
    if (code === 10) {
      const t = buf.trim();
      if (t) lines.push(t);
      buf = "";
    } else {
      buf += n[i];
    }
  }
  if (buf.trim()) lines.push(buf.trim());
  return lines;
}

function stripTimePrefix(line) {
  const text = String(line || "").trim();
  if (text.length > 2 && text[0] === "[") {
    const closeBracket = text.indexOf("]");
    if (closeBracket > 1) return text.slice(closeBracket + 1).trim();
  }
  return text;
}

/* ============================== 카테고리/후크 데이터 ============================== */
function detectCategory(idea) {
  const s = String(idea || "").toLowerCase();
  if (/\bvalorant\b/.test(s) || /\bgame\b/.test(s) || /\bleague of legends\b/.test(s) || /\blol\b(?!\w)/.test(s)) return "gaming";
  if (/\bworkout\b|\bexercise\b/.test(s)) return "fitness";
  if (/\biphone\b|\bapp\b|\btech\b/.test(s)) return "tech";
  if (/\brecipe\b|\bcook\b/.test(s)) return "cooking";
  return "general";
}

function getViralHookFormulasByCategory(category) {
  const base = {
    gaming: [
      "This [GAME] update broke the internet",
      "[GAME] players are quitting because of THIS",
      "The [FEATURE] that's making everyone reinstall [GAME]",
      "I can't believe [GAME] actually added this",
      "[GAME] secretly changed [FEATURE] and nobody noticed",
      "Pro players hate this one [GAME] trick"
    ],
    fitness: [
      "Why everyone's doing [EXERCISE] wrong",
      "The [TIME] routine that changed my life",
      "Doctors don't want you to know this [BODY_PART] exercise",
      "I did [EXERCISE] for [TIME] and this happened",
      "Stop [BAD_HABIT] immediately (here's why)"
    ],
    tech: [
      "Your [DEVICE] can do THIS?",
      "The [APP] feature 99% of people don't know",
      "[COMPANY] doesn't want you to see this",
      "This [PRICE] gadget beats the [EXPENSIVE_VERSION]",
      "I've been using [PRODUCT] wrong this whole time"
    ],
    cooking: [
      "[FOOD] recipe using only [NUMBER] ingredients",
      "I've been cooking [FOOD] wrong my whole life",
      "The [COUNTRY] secret to perfect [DISH]",
      "[TIME] [MEAL] that actually tastes good",
      "Why restaurants don't want you to know this trick"
    ],
    general: [
      "The truth about [TOPIC] nobody talks about",
      "I was today years old when I learned [FACT]",
      "This changes everything about [TOPIC]",
      "[NUMBER]% of people don't know this about [TOPIC]",
      "Stop doing [ACTION] (do this instead)"
    ]
  };
  return base[category] || base.general;
}

/* ============================== 프롬프트(항상 VIRAL) ============================== */
function keywordsFromText(text) {
  const arr = String(text || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3 && !["this", "that", "make", "making", "video", "people"].includes(w));
  return arr.length ? arr : ["topic"];
}

function createViralSystemPrompt(style, tone, outputType, language, videoIdea) {
  const category = detectCategory(videoIdea);
  const hooks = getViralHookFormulasByCategory(category);

  return `You are a viral content strategist who has analyzed 10,000+ viral videos.
Your scripts drive extreme retention on short-form platforms.

MANDATORY LANGUAGE: ${language} — Write ONLY in this language.

VIRAL HOOK FORMULAS FOR THIS VIDEO:
${hooks.map((h, i) => `${i + 1}. ${h}`).join("\n")}

ALWAYS VIRAL MODE — OVERRIDES:
- Open with a punchy, polarizing hook (strong POV) in ≤12 words.
- Use vivid specifics, cultural references, and internet-native phrasing (emoji OK).
- Pattern interrupts every ~5 seconds: contrasts, questions, twist reveals.
- Prefer short, punchy sentences. Cut filler. Keep it fast.
- Accept tasteful hyperbole and humor. Avoid harmful misinformation.
- If a stat is uncertain, imply source type (e.g., "patch notes", "creator reports").

STYLE GUIDE (as flexible references, remix allowed):
- MEME: Relatable → Escalate absurdity → Twist → Self-aware punchline
- QUICKTIP: Pain → 3–4 ultra-specific fixes → Outcome
- CHALLENGE: Bold challenge → Stakes → Attempts → Outcome
- STORYTELLING: Start at climax → Flashback → Turning point → Lesson
- PRODUCTPLUG: Pain → Failed tries → Discovery → Demo → Result
- FACELESS: Spicy claim → Evidence → Counter-intuitive insight → CTA

CRITICAL REQUIREMENTS:
1) Hook creates curiosity gap within 3 seconds
2) Use specific numbers or named entities when real
3) End with an open loop or compelling CTA when requested

TIMING RULES:
- Hook: ~10–15% of duration
- Each line: ≤4 seconds
- Include micro-pauses (reader will add line breaks)`;
}

function createViralUserPrompt(params) {
  const { text, style, tone, language, duration, wordsTarget, ctaInclusion } = params;
  const keywords = keywordsFromText(text);
  return `VIDEO BRIEF: ${text}

STRICT OUTPUT RULES:
- Language: ${language}
- Duration: EXACTLY ${duration} seconds
- Word count: ~${wordsTarget} words
- Include CTA: ${ctaInclusion ? "Yes (organic, strong)" : "No"}

MUST INCLUDE:
- Reference to "${keywords[0]}" in the first line
- Current/recent information only (2024–2025)
- Pattern interrupt every 5–7 seconds
- One surprising fact or stat
- Clear value proposition within 10 seconds

STRUCTURE:
- Total lines: 6–8 (including [HOOK] and optional [CTA])
- Format per line: [start-end] text (one decimal place)
- Keep sentences SHORT. Prefer bold, fast punches.

DO NOT:
- Invent fake updates
- Be generic or vague
- Add filler words

Create the timestamped script now:`;
}

/* ============================== 타이밍 재분배 ============================== */
function retimeScript(script, totalSeconds) {
  try {
    const duration = Math.max(1, DEC(Number(totalSeconds) || 0));
    if (!script) return script;

    const rawLines = splitLines(script);
    if (!rawLines.length) return script;

    const items = rawLines.map(line => {
      const m = line.match(/\[\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*\]/);
      const textOnly = stripTimePrefix(line);
      return {
        text: textOnly,
        isHook: /\[HOOK\]/i.test(textOnly),
        isCTA: /\[CTA\]/i.test(textOnly),
        hasTime: !!m
      };
    });

    // 첫 줄은 반드시 [HOOK]
    if (!items[0].isHook && items[0].text) {
      items[0].text = "[HOOK] " + items[0].text;
    }

    // 가중치(단어 수)
    const weights = items.map(item => {
      const t = item.text.replace(/\[HOOK\]|\[CTA\]/gi, "").trim();
      const words = t.split(/\s+/).filter(Boolean).length;
      return Math.max(1, words);
    });

    let totalWeight = weights.reduce((a, b) => a + b, 0);
    if (totalWeight <= 0) {
      weights.fill(1);
      totalWeight = weights.length;
    }

    // 분배
    const durations = weights.map(w => (w / totalWeight) * duration);

    // Hook 10~15%
    const minHook = duration * 0.10;
    const maxHook = duration * 0.15;
    durations[0] = Math.min(maxHook, Math.max(minHook, durations[0]));

    // CTA 5~8%
    const ctaIndex = items.findIndex(i => i.isCTA);
    if (ctaIndex >= 0) {
      durations[ctaIndex] = Math.min(duration * 0.08, Math.max(MIN_SLICE, durations[ctaIndex]));
    }

    // 최소 세그 보장
    for (let i = 0; i < durations.length; i++) {
      if (i !== 0 && i !== ctaIndex) durations[i] = Math.max(MIN_SLICE, durations[i]);
    }

    // 총합 보정
    const frozen = new Set([0]); if (ctaIndex >= 0) frozen.add(ctaIndex);
    const frozenSum = Array.from(frozen).reduce((s, i) => s + durations[i], 0);
    const freeIdx = durations.map((_, i) => i).filter(i => !frozen.has(i));
    const freeSum = freeIdx.reduce((s, i) => s + durations[i], 0);
    const targetFree = Math.max(0.1, duration - frozenSum);
    if (freeSum > 0) {
      const scale = targetFree / freeSum;
      freeIdx.forEach(i => durations[i] = Math.max(MIN_SLICE, durations[i] * scale));
    }

    // 타임스탬프 생성
    const result = [];
    let t = 0;
    for (let i = 0; i < items.length; i++) {
      const start = DEC(t);
      if (i === items.length - 1) {
        result.push(`[${start.toFixed(1)}-${DEC(duration).toFixed(1)}] ${items[i].text}`);
      } else {
        let end = DEC(t + durations[i]);
        if (end > duration - 0.1) end = DEC(duration - 0.1);
        if (end - start < MIN_SLICE) end = DEC(start + MIN_SLICE);
        result.push(`[${start.toFixed(1)}-${end.toFixed(1)}] ${items[i].text}`);
        t = end;
      }
    }
    return result.join("\n");
  } catch (e) {
    console.error("Retiming error:", e);
    return script;
  }
}

/* ============================== 비주얼 요소 ============================== */
function generateSmartVisualElements(script, videoIdea, style) {
  try {
    const lines = splitLines(script);
    const transitions = [];
    const bRoll = [];
    const textOverlays = [];
    const soundEffects = [];

    const transitionTypes = {
      meme: ["Jump cut", "Zoom punch", "Glitch", "Speed ramp"],
      quicktip: ["Slide", "Pop", "Wipe", "Fade"],
      challenge: ["Whip pan", "Quick cut", "Crash zoom", "Match cut"],
      storytelling: ["Cross fade", "J-cut", "L-cut", "Dissolve"],
      productplug: ["Reveal", "Comparison wipe", "Focus pull", "Smooth"],
      faceless: ["Cut", "Fade", "Morph", "Slide"]
    };
    const styleTransitions = transitionTypes[style] || transitionTypes.faceless;
    const ideaLower = String(videoIdea || "").toLowerCase();

    lines.forEach((line, index) => {
      const match = line.match(/\[\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*\]/);
      if (!match) return;
      const start = parseFloat(match[1]);
      const end = parseFloat(match[2]);
      const content = line.substring(match[0].length).trim();
      const isHook = /\[HOOK\]/i.test(content);
      const isCTA = /\[CTA\]/i.test(content);

      if (index > 0) {
        transitions.push({
          time: `${start.toFixed(1)}s`,
          type: styleTransitions[index % styleTransitions.length],
          description: `Transition for beat ${index + 1}`
        });
      }

      if (!isHook && !isCTA) {
        let bRollSuggestion = "Supporting footage";
        if (/\bvalorant\b/.test(ideaLower)) {
          if (/agent|요원/i.test(content)) {
            bRollSuggestion = "Agent ability showcase, ultimate animations, gameplay highlights";
          } else if (/\bmap\b|맵/i.test(content)) {
            bRollSuggestion = "Map flythrough, callout locations, angle demonstrations";
          } else {
            bRollSuggestion = "Ranked gameplay, clutch moments, pro player clips";
          }
        } else if (/fitness/.test(ideaLower)) {
          bRollSuggestion = "Exercise form demo, multiple angles, common mistakes comparison";
        } else if (/tech|app|iphone/.test(ideaLower)) {
          bRollSuggestion = "Screen recording, UI navigation, feature demo, before/after";
        }
        bRoll.push({ timeRange: `${start.toFixed(1)}-${end.toFixed(1)}s`, content: bRollSuggestion });
      }

      if (isHook) {
        const hookText = content.replace(/\[HOOK\]/i, "").trim().split(/\s+/).slice(0, 5).join(" ");
        textOverlays.push({ time: `${start.toFixed(1)}s`, text: hookText, style: "Bold animated entrance - scale up with glow" });
      } else if (style === "quicktip" && index > 0 && index < 6) {
        textOverlays.push({ time: `${start.toFixed(1)}s`, text: `TIP ${index}`, style: "Number badge with slide-in animation" });
      }

      const powerWords = ["never", "always", "only", "secret", "mistake", "stop", "now"];
      const foundPower = powerWords.find(w => new RegExp(`\\b${w}\\b`, "i").test(content));
      if (foundPower && !isHook) {
        textOverlays.push({ time: `${(start + 0.5).toFixed(1)}s`, text: foundPower.toUpperCase(), style: "Pop emphasis with shake effect" });
      }

      if (isHook) {
        soundEffects.push({ time: `${start.toFixed(1)}s`, effect: "Impact sound or attention grabber" });
      } else if (/\bbut\b|plot twist/i.test(content)) {
        soundEffects.push({ time: `${start.toFixed(1)}s`, effect: "Record scratch or pause effect" });
      } else if (isCTA) {
        soundEffects.push({ time: `${start.toFixed(1)}s`, effect: "Success chime or notification sound" });
      }
    });

    return { transitions, bRoll, textOverlays, soundEffects };
  } catch (e) {
    console.error("Visual generation error:", e);
    return { transitions: [], bRoll: [], textOverlays: [], soundEffects: [] };
  }
}

/* ============================== 바이럴 줄바꿈 강화 ============================== */
/**
 * 문장 끝(. ! ?) 또는 콜론/대시 뒤에 시각적 템포를 위해 이중 줄바꿈을 삽입.
 * - 타임스탬프 구간 안의 텍스트만 처리
 * - [HOOK]/[CTA] 같은 토큰은 유지
 */
function applyViralLineBreaksToScript(script) {
  const lines = splitLines(script);
  const out = lines.map(line => {
    const m = line.match(/^\[\s*\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*\]\s*/);
    if (!m) return line; // 타임스탬프 없는 라인은 그대로
    const prefix = m[0];
    const text = line.slice(prefix.length);

    // 문장 경계 기준으로 이중 개행 추가
    const withBreaks = text
      .replace(/([.!?])\s+(?=\S)/g, "$1\n\n")     // . ! ? 뒤 공백을 이중 개행으로
      .replace(/([:;—-])\s+(?=\S)/g, "$1\n\n")    // : ; — - 뒤도 개행
      .replace(/\s{2,}/g, " ")
      .trim();

    return prefix + withBreaks;
  });
  return out.join("\n");
}

/* ============================== OpenAI 호출 (항상 VIRAL 파라미터) ============================== */
async function callOpenAI(systemPrompt, userPrompt, config) {
  const { OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL, HARD_TIMEOUT_MS } = config;

  // 창의성 최대로, 반복 억제는 약하게
  const temperature = 0.95;
  const top_p = 0.98;
  const max_tokens = 1200;
  const presence_penalty = 0.2;
  const frequency_penalty = 0.2;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);
  const url = `${OPENAI_BASE_URL.replace(/\/+$/,"")}/v1/chat/completions`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: OPENAI_MODEL, // gpt-4o-mini 유지
        temperature, top_p, max_tokens, presence_penalty, frequency_penalty,
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
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("Empty response from OpenAI");
    return content;
  } catch (error) {
    clearTimeout(timer);
    if (error.name === "AbortError") throw new Error("Request timeout");
    throw error;
  }
}

/* ============================== 입력 검증 ============================== */
function validateInputs({ text, style, length, tone, language, ctaInclusion, outputType }) {
  if (!text || typeof text !== "string" || text.trim().length < 3) {
    const e = new Error("`text` is required and must be a string with length ≥ 3");
    e.status = 400; throw e;
  }
  const allowedStyles = ["meme", "quicktip", "challenge", "storytelling", "productplug", "faceless"];
  let styleKey = String(style || "").toLowerCase();
  if (!allowedStyles.includes(styleKey)) styleKey = "faceless";

  const dur = Math.max(MIN_DURATION, Math.min(Number(length) || 45, MAX_DURATION));
  const toneKey = String(tone || "Casual");
  const langKey = language || "English";
  const cta = !!ctaInclusion;
  const out = String(outputType || "script").toLowerCase();

  return { styleKey, duration: dur, tone: toneKey, language: langKey, cta, output: out };
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
  if (!config.OPENAI_API_KEY) {
    return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
  }

  let body;
  try {
    body = await parseRequestBody(req);
  } catch (err) {
    const status = err?.status || 400;
    return res.status(status).json({ error: err.message || "Invalid request body" });
  }

  try {
    const {
      text, style, length, tone = "Casual",
      language = "English", ctaInclusion = false,
      outputType = "script"
    } = body;

    const { styleKey, duration, tone: toneKey, language: langInput, cta, output } =
      validateInputs({ text, style, length, tone, language, ctaInclusion, outputType });

    const wps = getWordsPerSecond(langInput);
    const wordsTarget = Math.round(duration * wps);

    // 프롬프트 생성 (항상 바이럴)
    const systemPrompt = createViralSystemPrompt(styleKey, toneKey, output, langInput, text);
    const userPrompt = createViralUserPrompt({
      text, style: styleKey, tone: toneKey, language: langInput, duration, wordsTarget, ctaInclusion: cta
    });

    // 생성
    const raw = await callOpenAI(systemPrompt, userPrompt, config);

    // 타이밍 리타이밍
    const retimed = retimeScript(raw, duration);

    // 비주얼 요소는 줄바꿈 전 스크립트 기반으로 생성 (파싱 안전)
    let visualElements = null;
    if (output === "complete") {
      visualElements = generateSmartVisualElements(retimed, text, styleKey);
    }

    // 줄바꿈 강화 적용(가독성/리듬감 업)
    const finalScript = applyViralLineBreaksToScript(retimed);

    if (output === "complete") {
      return res.status(200).json({
        result: {
          script: finalScript,
          ...visualElements
        }
      });
    } else {
      return res.status(200).json({ result: finalScript });
    }
  } catch (error) {
    const msg = String(error?.message || "Internal error");
    if (config.DEBUG_ERRORS) {
      console.error("[API Error]", msg);
    } else {
      console.error("[API Error]");
    }
    const status = error?.status || 500;
    return res.status(status).json({ error: config.DEBUG_ERRORS ? msg : "Internal server error" });
  }
};
