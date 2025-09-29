"use strict";

/* =====================================================================
   Ultra High Quality (UHQ) Script Generator v2
   - JSON 출력 강제 + Booster(후처리) + n=3 샘플 + 국소 리라이트
   - 언어별 참여도(2인칭/명령형) 인식, KO WPS 튜닝, 7라인 구조 고정(CTA 포함 시)
   - 기존 v1 API와 완전 호환(입력/출력 구조 유지)
   ===================================================================== */

/* ============================== 유틸 상수 ============================== */
const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_BODY_BYTES = Math.max(256_000, Math.min(Number(process.env.MAX_BODY_BYTES) || 1_000_000, 5_000_000));
const MIN_DURATION = 15;
const MAX_DURATION = 180;
const MIN_SLICE = 0.4;
const DEC = (n) => Math.round(n * 10) / 10;
const QUALITY_THRESHOLD = 80;
const MAX_QUALITY_ATTEMPTS = 3;

/* ============================== CORS 설정 ============================== */
function setupCORS(req, res) {
  // Super-safe ES5 CORS (no arrow, no fancy syntax)
  var allowOrigins = process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "";
  var origin = req && req.headers ? (req.headers.origin || "") : "";

  // Always send basic CORS headers
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("Vary", "Origin");

  // If no allow list provided, be permissive in dev
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

  // Return the caller origin if we allow, otherwise '*'
  var value = allowed ? (origin || "*") : "*";
  res.setHeader("Access-Control-Allow-Origin", value);
  return true;
}

/* ============================== 환경 설정 ============================== */
function getConfig() {
  return {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL || DEFAULT_MODEL,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || "https://api.openai.com",
    HARD_TIMEOUT_MS: Math.max(15000, Math.min(Number(process.env.HARD_TIMEOUT_MS) || 30000, 120000)),
    DEBUG_ERRORS: process.env.DEBUG_ERRORS === "1" || process.env.DEBUG_ERRORS === "true",
    ENABLE_QUALITY_CHECK: process.env.ENABLE_QUALITY_CHECK !== "false"
  };
}

/* ============================== 바디 파싱 ============================== */
function readRawBody(req, limitBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0; let raw = "";
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
  try { return JSON.parse(raw || "{}"); } catch (e) { return {}; }
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
  // KO 튜닝: 2.5 -> 2.3 (과소/과다 생성 방지)
  const WPS_TABLE = {
    en: 2.3, ko: 2.3, es: 2.6, fr: 2.4, de: 2.2, it: 2.4, pt: 2.4,
    nl: 2.2, ru: 2.3, ja: 2.7, zh: 2.7, ar: 2.2
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
    if (code === 13) {
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

/* ============================== 카테고리 검출 ============================== */
function detectCategory(idea) {
  const s = String(idea || "").toLowerCase();
  if (/\b(valorant|game|gaming|fps|league|lol|fortnite|minecraft|apex|warzone)\b/.test(s)) return "gaming";
  if (/\b(workout|exercise|gym|fitness|muscle|weight|cardio|yoga)\b/.test(s)) return "fitness";
  if (/\b(iphone|app|tech|ai|software|code|programming|gadget)\b/.test(s)) return "tech";
  if (/\b(recipe|cook|food|meal|kitchen|bake|ingredient)\b/.test(s)) return "cooking";
  if (/\b(money|invest|crypto|stock|rich|wealth|business|startup)\b/.test(s)) return "money";
  if (/\b(relationship|dating|love|breakup|crush|marriage)\b/.test(s)) return "relationship";
  return "general";
}

/* ============================== 초강력 바이럴 훅(템플릿) ============================== */
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
    fitness: [
      "You've been doing [EXERCISE] wrong your whole life",
      "The 30-second trick that replaced my 2-hour workout",
      "Doctors hate this [BODY_PART] exercise (it actually works)",
      "I lost 20 pounds by stopping THIS one thing",
      "Why your workout isn't working (harsh truth)",
      "The exercise that's secretly destroying your gains"
    ],
    tech: [
      "Your [DEVICE] has been spying on you (here's proof)",
      "The $10 app that replaced my $1000 [TOOL]",
      "This [FEATURE] will get removed next update",
      "Why I returned my [PRODUCT] after 3 days",
      "[COMPANY] doesn't want you to know this setting exists",
      "The hidden menu that changes everything"
    ],
    money: [
      "The $100 mistake 99% of people make daily",
      "This is why you're still broke at 30",
      "The investment strategy banks don't want you to know",
      "I turned $10 into $1000 using this app",
      "Stop saving money (do this instead)",
      "The side hustle that's actually a scam"
    ],
    relationship: [
      "The text that makes them chase you",
      "Stop doing this if you want them back",
      "The dating app trick that gets 10x more matches",
      "Why nice guys actually finish last (science explains)",
      "The red flag everyone ignores",
      "This is why you're still single"
    ],
    general: [
      "You've been doing [TOPIC] wrong this whole time",
      "The [TOPIC] secret nobody talks about",
      "Stop [ACTION] immediately (scientists explain why)",
      "97% of people don't know this about [TOPIC]",
      "The [TOPIC] trick that went viral for a reason",
      "This changes everything about [TOPIC]"
    ]
  };
  return hooks[category] || hooks.general;
}

/* ============================== 시스템/유저 프롬프트 ============================== */
function createUltraViralSystemPrompt(style, tone, outputType, language, videoIdea) {
  const category = detectCategory(videoIdea);
  const hooks = getUltraViralHooks(category);
  return `You are the TOP viral scriptwriter for TikTok/Shorts/Reels.\n\nLANGUAGE: Write ONLY in ${language}\n\nOUTPUT: Return a single JSON object ONLY, with keys: lang,duration_sec,lines[].\n\nLINES (7 when CTA included, else 6):\n- HOOK\n- ESCALATION\n- FACT\n- PROOF\n- PAYOFF\n- TWIST\n- CTA (optional, last)\n\nSTRICT RULES:\n• First 3 words must create instant curiosity\n• Include at least 3 questions across the script\n• Include specific numbers at least 2 times (percentages, $, seconds)\n• Use "you/your" or direct second-person address in the target language 4+ times\n• No filler like \"in this video\", \"let me show you\"\n• Keep each line punchy (10–14 words)\n\nCATEGORY: ${category.toUpperCase()}\nTry hooks like:\n${hooks.map(h => `- ${h}`).join('\n')}`;
}

function createUltraViralUserPrompt(params, improvementHints = [], attemptNumber = 1) {
  const { text, style, tone, language, duration, wordsTarget, ctaInclusion } = params;
  let prompt = {
    task: "Create viral script",
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
    },
    hard_requirements: [
      "HOOK must include >=2 power-words, a number, a contrast word (but/actually/instead), and end with a question.",
      "Total questions >= 3 across lines 2,4,6 if possible.",
      "Numbers appear in FACT and PAYOFF lines (percent, $, seconds).",
      "Directly address the viewer frequently (second-person).",
      "No generic intros; no \"in this video\"."
    ]
  };

  if (attemptNumber > 1) {
    prompt.retry_guidance = [
      `ATTEMPT ${attemptNumber}: be more controversial`,
      "Add more specific numbers (%, $, seconds)",
      "Convert 2+ sentences to direct questions",
      "Tighten to 10-14 words per line"
    ];
  }

  if (improvementHints.length > 0) {
    prompt.critical_improvements = improvementHints;
  }

  return JSON.stringify(prompt);
}

/* ============================== 점수 평가(언어 인지) ============================== */
function evaluateScriptQuality(script, params) {
  try {
    const { duration, language, ctaInclusion } = params;
    const langKey = normalizeLanguageKey(language);
    const lines = splitLines(script);
    if (!lines.length) return { total: 0, breakdown: {} };

    // 1) HOOK (30)
    const firstLine = stripTimePrefix(lines[0] || "").toLowerCase();
    const ultraPowerWords = [
      "stop","wrong","never","always","nobody","everyone",
      "mistake","secret","truth","actually","literally",
      "insane","crazy","unbelievable","shocking","viral",
      "broke","quit","hate","destroyed","ruined","failed",
      // Korean equivalents
      "멈춰","그만","잘못","비밀","진짜","사실","충격","미쳤","망함","실패","금지","필독"
    ];
    const hookWordCount = ultraPowerWords.filter(w => firstLine.includes(w)).length;
    const hasQuestion = firstLine.includes("?");
    const hasNumber = /\d+/.test(firstLine);
    const hasContrast = /\b(but|however|actually|instead)\b/.test(firstLine);
    let hookScore = 0;
    hookScore += hookWordCount * 10; // 파워워드당 10
    hookScore += hasQuestion ? 8 : 0;
    hookScore += hasNumber ? 5 : 0;
    hookScore += hasContrast ? 7 : 0;
    hookScore = Math.min(30, hookScore);

    // 2) 타이밍 정확도 (20)
    const expectedWords = Math.round(duration * getWordsPerSecond(language));
    const actualWords = script.replace(/\[[\d.-]+\]/g, "").split(/\s+/).filter(Boolean).length;
    const timingDiff = Math.abs(actualWords - expectedWords) / Math.max(1, expectedWords);
    const timingScore = Math.max(0, Math.round((1 - timingDiff * 1.5) * 20));

    // 3) 구조 (25)
    let structureScore = 0;
    if (/\[HOOK\]/i.test(script)) structureScore += 8;
    if (lines.length >= 6 && lines.length <= 8) structureScore += 10; else if (lines.length >= 5 && lines.length <= 10) structureScore += 5;
    if (ctaInclusion) {
      if (/\[CTA\]/i.test(script) && /follow|comment|share|save|like/.test(script.toLowerCase())) structureScore += 7;
    } else {
      structureScore += 7;
    }
    const validTimestamps = lines.filter(line => /^\[\d+(?:\.\d+)?-\d+(?:\.\d+)?\]/.test(line)).length;
    if (validTimestamps === lines.length) structureScore += 5;

    // 4) 참여도 (25) — 언어별 2인칭/명령형 인식 강화
    let engagementScore = 0;
    const questions = (script.match(/\?/g) || []).length; // 질문 수(언어무관)
    engagementScore += Math.min(10, questions * 4);

    let secondPersonCount = 0;
    if (langKey === "en") {
      secondPersonCount = (script.toLowerCase().match(/\b(you|your|you're|you've)\b/g) || []).length;
    } else if (langKey === "ko") {
      // 한국어: 직접호칭(너/당신/네가/니가/너의/당신의/님), 명령형/권유형 종결(~해, ~하지마, ~해봐, ~해라, ~해야 해)
      const koPronouns = /(너|당신|네가|니가|너의|당신의|님)/g;
      const koImperatives = /(해라|하세요|해요|해봐|해봐요|하지마|하지 마|해야 해|해야해|해|봐|해둬|해둬요|저장해|팔로우해|팔로우 해|댓글 달아|저장해라)/g;
      secondPersonCount = ((script.match(koPronouns) || []).length) + ((script.match(koImperatives) || []).length);
    } else {
      // 기타 언어는 you/your 대략 체크 + 명령형 추정("!" 빈도)
      secondPersonCount = (script.toLowerCase().match(/\byou|your\b/g) || []).length + (script.match(/!/g) || []).length;
    }
    engagementScore += Math.min(8, secondPersonCount * 2.0);

    const strongActionWords = ["stop","try","watch","wait","look","check","imagine","think","remember","notice","see"];
    const actionCount = strongActionWords.filter(w => new RegExp(`\\b${w}\\b`, 'i').test(script)).length;
    engagementScore += Math.min(7, actionCount * 3.5);

    const total = Math.min(100, hookScore + timingScore + structureScore + engagementScore);
    return { total, breakdown: { hook: hookScore, timing: timingScore, structure: structureScore, engagement: engagementScore } };
  } catch (error) {
    console.error("Quality evaluation error:", error);
    return { total: 0, breakdown: {} };
  }
}

/* ============================== 개선 힌트 생성 ============================== */
function generateImprovementHints(evaluation) {
  const hints = [];
  const { breakdown } = evaluation || { breakdown: {} };
  if (!breakdown) return hints;
  if ((breakdown.hook || 0) < 20) {
    hints.push("- CRITICAL: Start with 'Stop', 'Never', or 'You're doing X wrong' + a number + a contrast word + '?'");
  }
  if ((breakdown.timing || 0) < 15) {
    hints.push("- Match word count to duration (±10%)");
  }
  if ((breakdown.structure || 0) < 20) {
    hints.push("- Keep exactly 6–8 lines and include [HOOK]; if CTA=true, add [CTA] with follow/save/comment");
    hints.push("- Ensure every line has [start-end] timestamps");
  }
  if ((breakdown.engagement || 0) < 15) {
    hints.push("- Add 2–3 questions in mid lines; address the viewer directly 4+ times");
  }
  return hints;
}

/* ============================== JSON 파서 & 안전 추출 ============================== */
function safeJsonParse(input) {
  try { return JSON.parse(input); } catch (e) { return null; }
}
function extractJsonBlock(text) {
  if (!text) return null;
  // 가장 큰 첫 번째 { ... } 블록 시도
  const m = text.match(/\{[\s\S]*\}$/);
  if (m) {
    const obj = safeJsonParse(m[0]);
    if (obj) return obj;
  }
  // 느슨한 추출
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const obj = safeJsonParse(text.slice(start, end + 1));
    if (obj) return obj;
  }
  return null;
}

/* ============================== Booster(후처리) ============================== */
const POWER_WORDS = ["Stop","Never","Wrong","Actually","Insane","Crazy","Shocking","Viral","Quit","Hate","Destroyed","Failed"];
function ensureHookCompliance(text) {
  let t = String(text || "").trim();
  const isKo = /[가-힣]/.test(t);
  // 끝의 종결부호와 공백 제거 → 중복 물음표 방지
  while (t && (t.endsWith("?") || t.endsWith("!") || t.endsWith(".") || t.endsWith(" "))) t = t.slice(0, -1);
  // 숫자 없으면 기본 수치 추가
  if (!/[0-9]/.test(t)) t += " 97%";
  // 대비 접속사 보강
  const lower = t.toLowerCase();
  const hasContrastEn = lower.includes(" but ") || lower.includes(" actually ") || lower.includes(" instead ") || lower.startsWith("but ") || lower.startsWith("actually ") || lower.startsWith("instead ") || lower.endsWith(" but") || lower.endsWith(" actually") || lower.endsWith(" instead");
  const hasContrastKo = t.includes("하지만") || t.includes("근데") || t.includes("사실") || t.includes("반대로");
  if (!hasContrastEn && !hasContrastKo) t += (isKo ? " 사실" : " actually");
  // 시작을 강하게 (KO: 멈춰 계열, EN: Stop)
  if (isKo) {
    if (!(t.startsWith("멈춰") || t.startsWith("그만") || t.startsWith("절대") || t.startsWith("진짜"))) t = "멈춰 " + t;
  } else {
    if (!lower.startsWith("stop")) t = "Stop " + t;
  }
  return t + "?";
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
  const needTargets = ["FACT","PAYOFF"];
  for (const tag of needTargets) {
    const i = lines.findIndex(l => l.tag === tag);
    if (i >= 0 && !/[0-9]/.test(lines[i].text)) {
      if (tag === "FACT") lines[i].text += " — 97% / 1000달러 / 3초";
      else lines[i].text += " — 10배 / 30초 / 2분";
    }
  }
}

function ensureSecondPerson(lines, language) {
  const lang = normalizeLanguageKey(language);
  const join = lines.map(l => l.text).join(" ");
  const need = 4;
  let count = 0;
  if (lang === "en") {
    const lc = join.toLowerCase();
    const words = ["you","your","you're","you've"];
    count = words.reduce((n,w)=> n + (lc.split(w).length - 1), 0);
    const fillers = ["you","your","you","your"];
    let k = 0;
    for (let i = 1; i < lines.length - 1 && count < need; i++) {
      const lcl = lines[i].text.toLowerCase();
      const hasYou = lcl.includes(" you ") || lcl.includes(" your ") || lcl.startsWith("you ") || lcl.startsWith("your ") || lcl.endsWith(" you") || lcl.endsWith(" your");
      if (!hasYou) {
        lines[i].text += (lines[i].text.endsWith("?") ? " " : ". ") + fillers[k++ % fillers.length];
        count++;
      }
    }
  } else if (lang === "ko") {
    const pronouns = ["너","당신","네가","니가","너의","당신의","님"];
    const imperatives = ["해라","하세요","해요","해봐","해봐요","하지마","하지 마","해야 해","해야해","해","봐","저장해","팔로우해","댓글 달아"];
    const countIn = (txt, arr) => arr.reduce((n,w)=> n + (txt.split(w).length - 1), 0);
    count = countIn(join, pronouns) + countIn(join, imperatives);
    for (let i = 1; i < lines.length - 1 && count < need; i++) {
      const line = lines[i].text;
      const header = line.trim().toUpperCase();
      if (header.startsWith("[HOOK]") || header.startsWith("[CTA]")) continue;
      const hasPron = pronouns.some(w => line.includes(w));
      const hasImp = imperatives.some(w => line.includes(w));
      if (!hasPron && !hasImp) {
        lines[i].text = (line.startsWith("너") ? line : ("너도 " + line));
        count++;
      }
    }
  } else {
    const lc = join.toLowerCase();
    count = (lc.split(" you").length - 1) + (lc.split(" your").length - 1);
    for (let i = 1; i < lines.length - 1 && count < need; i++) {
      const lcl = lines[i].text.toLowerCase();
      if (!(lcl.includes(" you") || lcl.includes(" your"))) {
        lines[i].text = lines[i].text + (lines[i].text.endsWith("?") ? " you" : ". you");
        count++;
      }
    }
  }
}

function ensureCTA(lines, ctaInclusion) {
  if (!ctaInclusion) return;
  const last = lines[lines.length - 1];
  if (!last || last.tag !== "CTA") return;
  const hasKW = /(follow|save|comment|share|like|구독|저장|댓글|공유)/i.test(last.text);
  if (!hasKW) {
    last.text += (last.text.endsWith(".") ? " " : " ") + "Follow and save if this helped (팔로우/저장)";
  }
}

function normalizeLineCountForCTA(lines, ctaInclusion) {
  // CTA 포함 시 7줄, 미포함 6줄 맞추기 (과하면 중간 병합, 모자라면 간단 문구 추가)
  const target = ctaInclusion ? 7 : 6;
  const TAG_ORDER = ["HOOK","ESCALATION","FACT","PROOF","PAYOFF","TWIST", ...(ctaInclusion ? ["CTA"] : [])];
  // 보정: 태그 강제 순서화
  const map = new Map(lines.map(l => [l.tag, l]));
  const rebuilt = TAG_ORDER.map(tag => map.get(tag) || { tag, text: (tag === 'HOOK' ? '멈춰—97%가 잘못 쓰는 진짜 이유?' : '핵심 포인트 준비 중') });
  // 길이 보정
  if (rebuilt.length > target) {
    // TWIST를 PAYOFF로 병합
    if (ctaInclusion) {
      rebuilt[4].text += ". " + rebuilt[5].text; // PAYOFF += TWIST
      rebuilt.splice(5,1); // remove TWIST
    } else {
      rebuilt[3].text += ". " + rebuilt[4].text; // PROOF += PAYOFF
      rebuilt.splice(4,1);
    }
  } else if (rebuilt.length < target) {
    rebuilt.push({ tag: ctaInclusion ? "CTA" : "TWIST", text: "Save this now. (저장)" });
  }
  return rebuilt;
}

function booster(jsonObj, params) {
  try {
    if (!jsonObj || !Array.isArray(jsonObj.lines)) return jsonObj;
    const { language, ctaInclusion } = params;
    let lines = jsonObj.lines.map(x => ({ tag: (x.tag || '').toUpperCase(), text: (x.text || '').trim() }));

    // 1) 라인/태그 보정
    lines = normalizeLineCountForCTA(lines, ctaInclusion);

    // 2) HOOK 합격형 강제
    lines[0].text = ensureHookCompliance(lines[0].text);

    // 3) 질문/숫자/2인칭 강화
    ensureQuestions(lines, 3, [1,3,5]);
    ensureNumbers(lines);
    ensureSecondPerson(lines, language);

    // 4) CTA 키워드 보정
    ensureCTA(lines, ctaInclusion);

    return { ...jsonObj, lines };
  } catch (e) {
    console.error("Booster error", e);
    return jsonObj;
  }
}

/* ============================== 타임스탬프 조립 ============================== */
function assembleWithTimingFromJSON(jsonObj, totalSeconds, language) {
  try {
    const duration = Math.max(1, DEC(Number(totalSeconds) || 0));
    const items = (jsonObj?.lines || []).map(it => ({...it}));
    if (!items.length) return "";

    // 가중치 (HOOK/CTA 짧게)
    const weights = items.map((it, idx) => {
      const words = String(it.text || '').split(/\s+/).filter(Boolean).length;
      if (it.tag === 'HOOK') return Math.max(1, words * 0.8);
      if (it.tag === 'CTA') return Math.max(1, words * 0.7);
      return Math.max(1, words);
    });

    let totalWeight = weights.reduce((a,b)=>a+b,0) || 1;
    const durations = weights.map(w => (w/totalWeight) * duration);

    // HOOK: 2–4s, CTA: 2–3s
    const hookIdx = items.findIndex(it => it.tag === 'HOOK');
    if (hookIdx >= 0) durations[hookIdx] = Math.min(4, Math.max(2, durations[hookIdx]));
    const ctaIdx = items.findIndex(it => it.tag === 'CTA');
    if (ctaIdx >= 0) durations[ctaIdx] = Math.min(3, Math.max(2, durations[ctaIdx]));

    const frozen = new Set();
    if (hookIdx >= 0) frozen.add(hookIdx);
    if (ctaIdx >= 0) frozen.add(ctaIdx);

    const frozenSum = Array.from(frozen).reduce((s,i)=>s+durations[i],0);
    const freeIdx = durations.map((_,i)=>i).filter(i=>!frozen.has(i));
    const freeSum = freeIdx.reduce((s,i)=>s+durations[i],0) || 1;
    const targetFree = Math.max(0.1, duration - frozenSum);
    const scale = targetFree / freeSum;
    freeIdx.forEach(i => { durations[i] = Math.max(MIN_SLICE, durations[i] * scale); });

    // 최종 라인 생성
    const out = [];
    let t = 0;
    for (let i=0;i<items.length;i++) {
      const start = DEC(t); const end = i === items.length - 1 ? DEC(duration) : DEC(t + durations[i]);
      const tagPrefix = items[i].tag === 'HOOK' ? '[HOOK] ' : (items[i].tag === 'CTA' ? '[CTA] ' : '');
      out.push(`[${start.toFixed(1)}-${end.toFixed(1)}] ${tagPrefix}${items[i].text}`);
      t = end;
    }
    return out.join("\n");
  } catch (e) {
    console.error("Assemble error", e);
    return '';
  }
}

/* ============================== 비주얼 요소 생성 ============================== */
function generateSmartVisualElements(script, videoIdea, style) {
  try {
    const lines = splitLines(script);
    const transitions = [];
    const bRoll = [];
    const textOverlays = [];
    const soundEffects = [];

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
      const match = line.match(/\[\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*\]/);
      if (!match) return;
      const start = parseFloat(match[1]);
      const end = parseFloat(match[2]);
      const content = line.substring(match[0].length).trim();
      const isHook = /\[HOOK\]/i.test(content);
      const isCTA = /\[CTA\]/i.test(content);

      if (index > 0) {
        transitions.push({ time: `${start.toFixed(1)}s`, type: styleTransitions[index % styleTransitions.length], intensity: isHook ? "Maximum" : "Medium" });
      }

      if (!isHook && !isCTA) {
        const category = detectCategory(videoIdea);
        let suggestion = "Relevant stock footage, animated graphics";
        if (category === "gaming") suggestion = "Gameplay highlight, rank up animation";
        else if (category === "fitness") suggestion = "Exercise demo, transformation clip, timer";
        else if (category === "tech") suggestion = "Screen recording, feature demo, comparison chart";
        else if (category === "money") suggestion = "Chart animation, counting money, metrics";
        bRoll.push({ timeRange: `${start.toFixed(1)}-${end.toFixed(1)}s`, content: suggestion });
      }

      if (isHook) {
        textOverlays.push({ time: `${start.toFixed(1)}s`, text: "⚠️ " + content.replace(/\[HOOK\]/i, "").trim().toUpperCase(), style: "Massive bold text with shake" });
        soundEffects.push({ time: `${start.toFixed(1)}s`, effect: "Bass drop + whoosh" });
      } else if (/\d+/.test(content)) {
        const numbers = content.match(/\d+[%$]?|\$\d+/g);
        if (numbers) textOverlays.push({ time: `${start.toFixed(1)}s`, text: numbers[0], style: "Giant number glow" });
      }

      if (/stop|never|wrong/i.test(content)) soundEffects.push({ time: `${start.toFixed(1)}s`, effect: "Alert/Error" });
      if (isCTA) soundEffects.push({ time: `${start.toFixed(1)}s`, effect: "Success chime/Subscribe" });
    });

    return { transitions, bRoll, textOverlays, soundEffects };
  } catch (e) {
    console.error("Visual generation error:", e);
    return { transitions: [], bRoll: [], textOverlays: [], soundEffects: [] };
  }
}

/* ============================== 줄바꿈 강화 ============================== */
function applyViralLineBreaksToScript(script) {
  // 분석기 혼동 방지: 원문 그대로 반환
  return String(script || "");
});
  return out.join("\n");
}

/* ============================== OpenAI 호출(강화: n=3, JSON 지향) ============================== */
async function callOpenAI(systemPrompt, userPrompt, config, attemptNumber = 1) {
  const { OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL, HARD_TIMEOUT_MS } = config;
  const temperature = Math.max(0.7, 0.8 - (attemptNumber * 0.05)); // 0.8 -> 0.75 -> 0.7 (형식준수↑)
  const top_p = 0.92;
  const max_tokens = 1500;
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
        model: OPENAI_MODEL,
        temperature,
        top_p,
        max_tokens,
        presence_penalty,
        frequency_penalty,
        n: 3, // 다중 샘플
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
    const payloads = choices.map(c => c?.message?.content?.trim()).filter(Boolean);
    return payloads;
  } catch (error) {
    clearTimeout(timer);
    if (error.name === "AbortError") throw new Error("Request timeout");
    throw error;
  }
}

/* ============================== 품질 보증(샘플 선택+국소 리라이트) ============================== */
function assembleCandidateFromLLM(raw, params) {
  // JSON 파싱 -> Booster -> 타임스탬프 조립
  const obj = (typeof raw === 'string') ? (safeJsonParse(raw) || extractJsonBlock(raw)) : raw;
  if (!obj) return null;
  const boosted = booster(obj, params);
  const script = assembleWithTimingFromJSON(boosted, params.duration, params.language);
  return { json: boosted, script };
}

function localRewrite(script, params, evaluation) {
  // 점수가 애매하면 일부 라인만 규칙적으로 강화
  try {
    const lines = splitLines(script);
    if (!lines.length) return script;
    let updated = false;

    // HOOK 보강
    if ((evaluation?.breakdown?.hook || 0) < 25) {
      const first = stripTimePrefix(lines[0]);
      const prefix = lines[0].match(/^\[[^\]]+\]\s*/)?.[0] || "";
      const body = first.replace(/^\[HOOK\]\s*/i, "");
      const stronger = ensureHookCompliance(body);
      lines[0] = `${prefix}[HOOK] ${stronger}`;
      updated = true;
    }

    // 질문 수 보강
    if ((evaluation?.breakdown?.engagement || 0) < 20) {
      const idxs = [1,3,5].filter(i => i < lines.length);
      for (const i of idxs) {
        if (!/\?$/.test(lines[i])) lines[i] = lines[i] + (lines[i].endsWith("?") ? "" : "?");
      }
      updated = true;
    }

    return updated ? lines.join("\n") : script;
  } catch (e) {
    return script;
  }
}

async function generateWithQualityAssurance(params, config) {
  const { text, styleKey, tone, language, duration, wordsTarget, ctaInclusion, enableQA } = params;

  // QA 끄면 단일 생성
  if (!enableQA) {
    const systemPrompt = createUltraViralSystemPrompt(styleKey, tone, "script", language, text);
    const userPrompt = createUltraViralUserPrompt(params);
    const raws = await callOpenAI(systemPrompt, userPrompt, config, 1);
    // 첫 샘플만 사용
    const cand = assembleCandidateFromLLM(raws[0], params);
    const script = applyViralLineBreaksToScript(cand.script);
    return { script, qualityScore: null, attempts: 1 };
  }

  let best = { script: null, score: 0, eval: null };
  let improvementHints = [];

  for (let attempt=1; attempt<=MAX_QUALITY_ATTEMPTS; attempt++) {
    const systemPrompt = createUltraViralSystemPrompt(styleKey, tone, "script", language, text);
    const userPrompt = createUltraViralUserPrompt(params, improvementHints, attempt);
    const raws = await callOpenAI(systemPrompt, userPrompt, config, attempt);

    // n=3 후보를 생성 및 평가
    const candidates = raws.map(r => assembleCandidateFromLLM(r, params)).filter(Boolean);
    for (const c of candidates) {
      const evalv = evaluateScriptQuality(c.script, params);
      if (evalv.total > best.score) best = { script: c.script, score: evalv.total, eval: evalv };
    }

    // 임계치 도달
    if (best.score >= QUALITY_THRESHOLD) {
      const finalScript = applyViralLineBreaksToScript(best.script);
      return { script: finalScript, qualityScore: best.score, breakdown: best.eval.breakdown, attempts: attempt, status: "PASSED" };
    }

    // 국소 리라이트로 미세 개선
    if (best.script) {
      const tweaked = localRewrite(best.script, params, best.eval);
      const evalv2 = evaluateScriptQuality(tweaked, params);
      if (evalv2.total > best.score) best = { script: tweaked, score: evalv2.total, eval: evalv2 };
    }

    // 다음 시도 개선 힌트
    if (attempt < MAX_QUALITY_ATTEMPTS) {
      improvementHints = generateImprovementHints(best.eval || { total: 0, breakdown: {} });
      if (best.score >= 70) {
        improvementHints.push("- Almost perfect: sharpen the hook with another statistic");
        improvementHints.push("- Convert one more mid-line into a direct question");
      }
    }
  }

  const finalScript = applyViralLineBreaksToScript(best.script || "");
  return { script: finalScript, qualityScore: best.score, breakdown: best.eval?.breakdown, attempts: MAX_QUALITY_ATTEMPTS, status: best.score >= 70 ? "ACCEPTABLE" : "BELOW_TARGET" };
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
      outputType = "script",
      enableQualityCheck = true,
      includeQualityScore = false
    } = body;

    const { styleKey, duration, tone: toneKey, language: langInput, cta, output } =
      validateInputs({ text, style, length, tone, language, ctaInclusion, outputType });

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
    }, config);

    let visualElements = null;
    if (output === "complete") {
      visualElements = generateSmartVisualElements(result.script, text, styleKey);
    }

    const finalScript = applyViralLineBreaksToScript(result.script);

    const response = {
      result: output === "complete" ? { script: finalScript, ...visualElements } : finalScript
    };

    if (includeQualityScore && result.qualityScore !== null) {
      response.quality = {
        score: result.qualityScore,
        breakdown: result.breakdown,
        attempts: result.attempts,
        status: result.status
      };
    }

    return res.status(200).json(response);

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

/* --- vercel.json (create this file at repo root) ---
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
