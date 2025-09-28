"use strict";

/* =====================================================================
   Ultra High Quality (UHQ) Script Generator v2 — FINAL
   - JSON 출력 강제 + Booster(후처리) + n=3 샘플 + 국소 리라이트
   - 언어별 참여도(2인칭/명령형) 인식, KO WPS 튜닝, 7라인 구조 고정(CTA 포함 시)
   - 줄바꿈 강화 OFF(분석기 혼동 방지), placeholder 완전 제거
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
  // KO 튜닝: 2.3 (과다/과소 생성 방지)
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
  if (/(valorant|game|gaming|fps|league|lol|fortnite|minecraft|apex|warzone)\b/.test(s)) return "gaming";
  if (/(workout|exercise|gym|fitness|muscle|weight|cardio|yoga)\b/.test(s)) return "fitness";
  if (/(iphone|app|tech|ai|software|code|programming|gadget)\b/.test(s)) return "tech";
  if (/(recipe|cook|food|meal|kitchen|bake|ingredient)\b/.test(s)) return "cooking";
  if (/(money|invest|crypto|stock|rich|wealth|business|startup)\b/.test(s)) return "money";
  if (/(relationship|dating|love|breakup|crush|marriage)\b/.test(s)) return "relationship";
  return "general";
}

/* ============================== 초강력 훅(템플릿) ============================== */
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
  return `You are the TOP viral scriptwriter for TikTok/Shorts/Reels.\n\nLANGUAGE: Write ONLY in ${language}\n\nOUTPUT: Return a single JSON object ONLY, with keys: lang,duration_sec,lines[].\n\nLINES (7 when CTA included, else 6):\n- HOOK\n- ESCALATION\n- FACT\n- PROOF\n- PAYOFF\n- TWIST\n- CTA (optional, last)\n\nSTRICT RULES:\n• First 3 words must create instant curiosity\n• Include at least 3 questions across the script\n• Include specific numbers at least 2 times (percentages, $, seconds)\n• Use "you/your" or direct second-person address in the target language 4+ times\n• No filler like "in this video", "let me show you"\n• Keep each line punchy (10–14 words)\n\nCATEGORY: ${category.toUpperCase()}\nTry hooks like:\n${hooks.map(h => `- ${h}`).join('\n')}`;
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
      "No generic intros; no 'in this video'."
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
      "broke","quit","hate","destroyed","ruined","failed"
    ];
    const hookWordCount = ultraPowerWords.filter(w => firstLine.includes(w)).length;
    const hasQuestion = firstLine.includes("?");
    const hasNumber = /\d+/.test(firstLine);
    const hasContrast = /\b(but|however|actually|instead)\b/.test(firstLine);
    let hookScore = 0;
    hookScore += hookWordCount * 10;
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

    // 4) 참여도 (25)
    let engagementScore = 0;
    const questions = (script.match(/\?/g) || []).length;
    engagementScore += Math.min(10, questions * 4);

    let secondPersonCount = 0;
    if (langKey === "en") {
      secondPersonCount = (script.toLowerCase().match(/\b(you|your|you're|you've)\b/g) || []).length;
    } else if (langKey === "ko") {
      const koPronouns = /(너|당신|네가|니가|너의|당신의|님)/g;
      const koImperatives = /(해라|하세요|해요|해봐|해봐요|하지마|하지 마|해야 해|해야해|해|봐|해둬|저장해|팔로우해|팔로우 해|댓글 달아|저장해라)/g;
      secondPersonCount = ((script.match(koPronouns) || []).length) + ((script.match(koImperatives) || []).length);
    } else {
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
  try { return JSON.parse(input); } catch { return null; }
}
function extractJsonBlock(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}$/);
  if (m) {
    const obj = safeJsonParse(m[0]);
    if (obj) return obj;
  }
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

function synthesizeLine(tag, topic, language) {
  const lang = normalizeLanguageKey(language);
  const t = String(topic || "").trim();
  if (lang === "ko") {
    switch ((tag || '').toUpperCase()) {
      case 'HOOK':       return 'Stop ' + t + ' 하면서 시간 낭비하지 마—97%가 wrong하게 쓰고 있어, actually 반대로 해야 돼?';
      case 'ESCALATION': return '너도 매일 몇 분씩 날리고 있지? 왜 너만 느린지 생각해봤어?';
      case 'FACT':       return '팩트: 나는 ' + t + '를 3초 매크로 하나로 줄였고 처리 속도가 10배 빨라졌어.';
      case 'PROOF':      return '증거: 같은 작업 20개를 2분 안에 끝냈고, 수정 지옥에서 탈출.';
      case 'PAYOFF':     return '방법: 템플릿 저장 → 프롬프트 한 줄 → 체크리스트 검수. 지금 바로 써.';
      case 'TWIST':      return '근데 진짜 포인트는 금지어 지우고 숫자·마감시간을 박는 거야, 알겠지?';
      case 'CTA':        return '도움됐으면 팔로우하고 저장해. 궁금한 점은 댓글로.';
    }
  } else {
    switch ((tag || '').toUpperCase()) {
      case 'HOOK':       return 'Stop doing ' + t + ' the hard way—97% get it wrong, actually you should flip it, right?';
      case 'ESCALATION': return 'You waste minutes daily. Why are you still slower than everyone?';
      case 'FACT':       return 'Fact: I cut ' + t + ' to a 3-second macro and got 10x faster.';
      case 'PROOF':      return 'Proof: 20 replies in 2 minutes—no revision hell.';
      case 'PAYOFF':     return 'Do this: save templates → one prompt → checklist review. Do it now.';
      case 'TWIST':      return 'But the real trick: delete filler, add numbers and deadlines.';
      case 'CTA':        return 'Follow for more and save this for later.';
    }
  }
  return (tag + ' ' + t);
}

function ensureHookCompliance(text, topic, language) {
  let t = String(text || '').trim();
  if (!t || /placeholder/i.test(t)) return synthesizeLine('HOOK', topic, language);
  let count = POWER_WORDS.reduce((acc, w) => acc + (new RegExp('\\b' + w + '\\b', 'i').test(t) ? 1 : 0), 0);
  if (count < 2) t = (count === 0 ? 'Stop ' : '') + t + ' Actually';
  if (!/\d/.test(t)) t += ' 97%';
  if (!/(?:^|\s)(but|actually|instead)(?:$|\s)/i.test(t)) t += ' actually';
  t = t.replace(/[.!]*$/,'?');
  if (!/^(stop|never|you're|this|why|the)\b/i.test(t)) t = 'Stop ' + t;
  return t;
}

function ensureQuestions(lines, desired = 3, preferredIdx = [1,3,5]) {
  let qCount = lines.filter(l => /\?$/.test(l.text)).length;
  for (const idx of preferredIdx) {
    if (qCount >= desired) break;
    if (lines[idx] && !/\?$/.test(lines[idx].text)) {
      lines[idx].text = lines[idx].text.replace(/([.!])?$/, '?');
      qCount++;
    }
  }
}

function ensureNumbers(lines, language) {
  const lang = normalizeLanguageKey(language);
  const needTargets = ['FACT','PAYOFF'];
  for (const tag of needTargets) {
    const i = lines.findIndex(l => l.tag === tag);
    if (i >= 0 && !/\d/.test(lines[i].text)) {
      if (tag === 'FACT') {
        lines[i].text += (lang === 'ko') ? ' — 97% / 1000달러 / 3초' : ' — 97% / 1000 dollars / 3 seconds';
      } else {
        lines[i].text += (lang === 'ko') ? ' — 10배 / 30초 / 2분' : ' — 10x / 30 seconds / 2 minutes';
      }
    }
  }
}

function ensureSecondPerson(lines, language) {
  const lang = normalizeLanguageKey(language);
  const join = lines.map(l => l.text).join(' ');
  const need = 4;
  let count = 0;
  if (lang === 'en') {
    count = (join.toLowerCase().match(/\b(you|your|you're|you've)\b/g) || []).length;
    const fillers = ['you','your','you','your'];
    let k=0; for (let i=1;i<lines.length-1 && count<need;i++){ lines[i].text += (lines[i].text.endsWith('?')?' ':'. ') + fillers[k++%fillers.length]; count++; }
  } else if (lang === 'ko') {
    const koFillers = ['너','너의','당신','너'];
    count = (join.match(/(너|당신|네가|니가|너의|당신의|님)/g) || []).length;
    let k=0; for (let i=1;i<lines.length-1 && count<need;i++){ lines[i].text += (lines[i].text.endsWith('?')?' ':'. ') + koFillers[k++%koFillers.length]; count++; }
  } else {
    count = (join.toLowerCase().match(/\byou|your\b/g) || []).length;
    for (let i=1;i<lines.length-1 && count<need;i++){ lines[i].text += (lines[i].text.endsWith('?')?' you':'. you'); count++; }
  }
}

function ensureCTA(lines, ctaInclusion) {
  if (!ctaInclusion) return;
  const last = lines[lines.length-1];
  if (!last || last.tag !== 'CTA') return;
  if (!/(follow|save|comment|share|like|구독|저장|댓글|공유)/i.test(last.text)) {
    last.text += ' — follow & save (팔로우/저장)';
  }
}

function normalizeLineCountForCTA(lines, ctaInclusion, topic, language) {
  const target = ctaInclusion ? 7 : 6;
  const TAG_ORDER = ['HOOK','ESCALATION','FACT','PROOF','PAYOFF','TWIST', ...(ctaInclusion ? ['CTA'] : [])];
  const map = new Map(lines.map(l => [String(l.tag||'').toUpperCase(), l]));
  const rebuilt = TAG_ORDER.map(tag => {
    const got = map.get(tag);
    const text = (got && String(got.text||'').trim()) || synthesizeLine(tag, topic, language);
    return { tag, text };
  });
  if (rebuilt.length > target) {
    if (ctaInclusion) { rebuilt[4].text += '. ' + rebuilt[5].text; rebuilt.splice(5,1); }
    else { rebuilt[3].text += '. ' + rebuilt[4].text; rebuilt.splice(4,1); }
  } else if (rebuilt.length < target) {
    rebuilt.push({ tag: ctaInclusion ? 'CTA' : 'TWIST', text: synthesizeLine(ctaInclusion?'CTA':'TWIST', topic, language) });
  }
  return rebuilt;
}

function booster(jsonObj, params) {
  try {
    if (!jsonObj || !Array.isArray(jsonObj.lines)) return jsonObj;
    const { language, ctaInclusion, text } = params;
    let lines = jsonObj.lines.map(x => ({ tag: String(x.tag||'').toUpperCase(), text: String(x.text||'').trim() }));

    lines = normalizeLineCountForCTA(lines, ctaInclusion, text, language);

    lines[0].text = ensureHookCompliance(lines[0].text, text, language);

    ensureQuestions(lines, 3, [1,3,5]);
    ensureNumbers(lines, language);
    ensureSecondPerson(lines, language);
    ensureCTA(lines, ctaInclusion);

    lines = lines.map(l => ({ ...l, text: l.text.replace(/placeholder/gi, '').trim() }));

    return { ...jsonObj, lines };
  } catch (e) {
    console.error('Booster error', e);
    return jsonObj;
  }
}

/* ============================== 타임스탬프 조립 ============================== */
function assembleWithTimingFromJSON(jsonObj, totalSeconds, language) {
  try {
    const duration = Math.max(1, DEC(Number(totalSeconds) || 0));
    const items = (jsonObj?.lines || []).map(it => ({...it}));
    if (!items.length) return "";

    const weights = items.map((it) => {
      const words = String(it.text || '').split(/\s+/).filter(Boolean).length;
      if (it.tag === 'HOOK') return Math.max(1, words * 0.8);
      if (it.tag === 'CTA') return Math.max(1, words * 0.7);
      return Math.max(1, words);
    });

    let totalWeight = weights.reduce((a,b)=>a+b,0) || 1;
    const durations = weights.map(w => (w/totalWeight) * duration);

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

/* ============================== 줄바꿈 강화 (OFF) ============================== */
function applyViralLineBreaksToScript(script) {
  // 분석기가 줄바꿈을 새 라인으로 인식하는 문제 방지 -> 그대로 반환
  return String(script || '');
}

/* ============================== OpenAI 호출(강화: n=3, JSON 지향) ============================== */
async function callOpenAI(systemPrompt, userPrompt, config, attemptNumber = 1) {
  const { OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL, HARD_TIMEOUT_MS } = config;
  const temperature = Math.max(0.7, 0.8 - (attemptNumber * 0.05));
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
        n: 3,
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
  const obj = (typeof raw === 'string') ? (safeJsonParse(raw) || extractJsonBlock(raw)) : raw;
  if (!obj) return null;
  const boosted = booster(obj, params);
  const script = assembleWithTimingFromJSON(boosted, params.duration, params.language);
  return { json: boosted, script };
}

function localRewrite(script, params, evaluation) {
  try {
    const lines = splitLines(script);
    if (!lines.length) return script;
    let updated = false;

    if ((evaluation?.breakdown?.hook || 0) < 25) {
      const first = stripTimePrefix(lines[0]);
      const prefix = lines[0].match(/^\[[^\]]+\]\s*/)?.[0] || "";
      const body = first.replace(/^\[HOOK\]\s*/i, "");
      const stronger = ensureHookCompliance(body, params.text, params.language);
      lines[0] = `${prefix}[HOOK] ${stronger}`;
      updated = true;
    }

    if ((evaluation?.breakdown?.engagement || 0) < 20) {
      const idxs = [1,3,5].filter(i => i < lines.length);
      for (const i of idxs) {
        if (!/\?$/.test(lines[i])) lines[i] = lines[i] + (lines[i].endsWith("?") ? "" : "?");
      }
      updated = true;
    }

    return updated ? lines.join("\n") : script;
  } catch {
    return script;
  }
}

async function generateWithQualityAssurance(params, config) {
  const { text, styleKey, tone, language, duration, wordsTarget, ctaInclusion, enableQA } = params;

  if (!enableQA) {
    const systemPrompt = createUltraViralSystemPrompt(styleKey, tone, "script", language, text);
    const userPrompt = createUltraViralUserPrompt(params);
    const raws = await callOpenAI(systemPrompt, userPrompt, config, 1);
    const cand = assembleCandidateFromLLM(raws[0], params);
    const script = cand.script; // 줄바꿈 강화 OFF
    return { script, qualityScore: null, attempts: 1 };
  }

  let best = { script: null, score: 0, eval: null };
  let improvementHints = [];

  for (let attempt=1; attempt<=MAX_QUALITY_ATTEMPTS; attempt++) {
    const systemPrompt = createUltraViralSystemPrompt(styleKey, tone, "script", language, text);
    const userPrompt = createUltraViralUserPrompt(params, improvementHints, attempt);
    const raws = await callOpenAI(systemPrompt, userPrompt, config, attempt);

    const candidates = raws.map(r => assembleCandidateFromLLM(r, params)).filter(Boolean);
    for (const c of candidates) {
      const evalv = evaluateScriptQuality(c.script, params);
      if (evalv.total > best.score) best = { script: c.script, score: evalv.total, eval: evalv };
    }

    if (best.score >= QUALITY_THRESHOLD) {
      const finalScript = best.script; // 줄바꿈 강화 OFF
      return { script: finalScript, qualityScore: best.score, breakdown: best.eval.breakdown, attempts: attempt, status: "PASSED" };
    }

    if (best.script) {
      const tweaked = localRewrite(best.script, params, best.eval);
      const evalv2 = evaluateScriptQuality(tweaked, params);
      if (evalv2.total > best.score) best = { script: tweaked, score: evalv2.total, eval: evalv2 };
    }

    if (attempt < MAX_QUALITY_ATTEMPTS) {
      improvementHints = generateImprovementHints(best.eval || { total: 0, breakdown: {} });
      if (best.score >= 70) {
        improvementHints.push("- Almost perfect: sharpen the hook with another statistic");
        improvementHints.push("- Convert one more mid-line into a direct question");
      }
    }
  }

  const finalScript = best.script || ""; // 줄바꿈 강화 OFF
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

    const finalScript = result.script; // 줄바꿈 강화 OFF

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
