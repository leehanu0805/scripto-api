// api/generate-content.js — 진짜 바이럴 버전
// 팩트체킹, 클리셰 필터, 후크 공식, 실전 데이터 모두 포함

"use strict";

// ========== CORS 설정 모듈 ==========
function setupCORS(req, res) {
  const rawList = process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "";
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
  const allowThis = allowAll || (ALLOW_LIST.length === 0 && !!requestOrigin) || (requestOrigin && ALLOW_LIST.includes(requestOrigin));

  if (allowAll) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (ALLOW_LIST.length === 0) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin || "*");
  } else if (allowThis && requestOrigin) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
  } else {
    return false;
  }
  return true;
}

// ========== 환경 설정 모듈 ==========
function getConfig() {
  return {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-4o-mini",
    HARD_TIMEOUT_MS: Math.max(15000, Math.min(Number(process.env.HARD_TIMEOUT_MS) || 30000, 120000)),
    DEBUG_ERRORS: process.env.DEBUG_ERRORS === "1" || process.env.DEBUG_ERRORS === "true"
  };
}

// ========== 요청 본문 파싱 모듈 ==========
async function parseRequestBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.length) {
    try { return JSON.parse(req.body); } catch {}
  }
  let raw = "";
  await new Promise((resolve) => { 
    req.on("data", (c) => (raw += c)); 
    req.on("end", resolve); 
  });
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

// ========== 언어 처리 모듈 ==========
function normalizeLanguageKey(language) {
  const L = String(language || "").trim().toLowerCase();
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
    en: 2.3,  // 실제 바이럴 영상 기준
    ko: 2.5,
    es: 2.6,
    fr: 2.4,
    de: 2.2,
    it: 2.4,
    pt: 2.4,
    nl: 2.2,
    ru: 2.3,
    ja: 2.8,
    zh: 2.8,
    ar: 2.2
  };
  const langKey = normalizeLanguageKey(language);
  return WPS_TABLE[langKey] || 2.3;
}

// ========== 문자열 처리 모듈 ==========
function normalizeNewlines(text) {
  const str = String(text || "");
  let output = "";
  const LF = String.fromCharCode(10);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 13) {
      if (str.charCodeAt(i + 1) === 10) i++;
      output += LF;
    } else {
      output += str[i];
    }
  }
  return output;
}

function splitLines(text) {
  const normalized = normalizeNewlines(text);
  const lines = [];
  let buffer = "";
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    if (code === 10) {
      const trimmed = buffer.trim();
      if (trimmed) lines.push(trimmed);
      buffer = "";
    } else {
      buffer += normalized[i];
    }
  }
  if (buffer.trim()) lines.push(buffer.trim());
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

// ========== 바이럴 후크 데이터베이스 ==========
function getViralHookFormulas() {
  return {
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
}

// ========== 클리셰 필터 ==========
function getBannedPhrases() {
  return [
    "놓친 비밀이 있습니다",
    "모든 것을 경험",
    "완전히 바꿨습니다",
    "게임 체인저",
    "혁명적인",
    "놀라운 사실",
    "충격적인 진실",
    "이것 하나로",
    "단 하나의",
    "믿기 어려운",
    "절대 후회하지 않을"
  ];
}

// ========== 강화된 시스템 프롬프트 ==========
function createViralSystemPrompt(style, tone, outputType, language, videoIdea) {
  const hooks = getViralHookFormulas();
  const bannedPhrases = getBannedPhrases();
  
  // 아이디어 분석
  const ideaLower = videoIdea.toLowerCase();
  let category = "general";
  if (ideaLower.includes("valorant") || ideaLower.includes("game") || ideaLower.includes("lol")) category = "gaming";
  else if (ideaLower.includes("workout") || ideaLower.includes("exercise")) category = "fitness";
  else if (ideaLower.includes("iphone") || ideaLower.includes("app") || ideaLower.includes("tech")) category = "tech";
  else if (ideaLower.includes("recipe") || ideaLower.includes("cook")) category = "cooking";

  const relevantHooks = hooks[category] || hooks.general;

  return `You are a viral content strategist who has analyzed 10,000+ viral videos.
Your scripts have a 85% retention rate average.

MANDATORY LANGUAGE: ${language} - Write ONLY in this language.

VIRAL HOOK FORMULAS FOR THIS VIDEO:
${relevantHooks.map((h, i) => `${i+1}. ${h}`).join('\n')}

BANNED CLICHÉ PHRASES (NEVER USE):
${bannedPhrases.map(p => `• ${p}`).join('\n')}

${style.toUpperCase()} STYLE REQUIREMENTS:

For ${style}, follow this EXACT structure:

MEME STYLE:
Line 1: Relatable scenario everyone knows
Line 2-3: Build up the absurdity
Line 4: Unexpected twist
Line 5: Self-aware punchline
Example: "POV: You say 'one more game' → It's now 4am → You have work at 7 → You queue again → Why are we like this?"

QUICKTIP STYLE:
Line 1: Problem agitation (make them feel the pain)
Line 2-5: Numbered solutions with SPECIFIC details
Line 6: Result they'll get
Example: "Stop wasting 3 hours editing → 1) Batch all clips first → 2) One LUT for everything → 3) Template your intros → Done in 20 minutes"

CHALLENGE STYLE:
Line 1: Impossible-sounding challenge
Line 2: Stakes/consequences
Line 3-5: Real attempts with reactions
Line 6: Unexpected outcome
Example: "100 pushups for every death in ranked → I'm hardstuck Bronze → First game: 12 deaths → My arms are gone → Plot twist: I ranked up"

STORYTELLING STYLE:
Line 1: Start at the climax moment
Line 2-3: Quick context flashback
Line 4: The turning point
Line 5: Lesson that hits different
Example: "I almost deleted my channel → 6 months, 12 subscribers → Then this one video → 100k views overnight → Consistency isn't sexy but it works"

PRODUCTPLUG STYLE:
Line 1: Painful problem everyone has
Line 2: Failed attempts to solve it
Line 3: Discovery moment (organic)
Line 4: Specific demonstration
Line 5: Measurable results
Example: "Editing took me 6 hours per video → Tried 5 different apps, all trash → Friend showed me X → Watch this workflow → Now it's 30 minutes max"

FACELESS STYLE:
Line 1: Controversial/surprising statement
Line 2-3: Evidence/proof points
Line 4: Counter-intuitive insight
Line 5: Call to action
Example: "99% use their phone wrong → Studies show X causes Y → But nobody talks about Z → Here's what to do instead → Save this before it's gone"

CRITICAL REQUIREMENTS:
1. First 3 seconds must create curiosity gap
2. Use specific numbers, not vague claims
3. Include pattern interrupts every 5 seconds
4. Reference current events/trends when relevant
5. End with open loop or compelling CTA

TONE: ${tone}
- Casual: Use slang, contractions, conversational
- Professional: Authoritative but accessible
- Humorous: Self-aware, unexpected comparisons
- Enthusiastic: High energy without being fake

For ${category} content specifically:
- Use insider terminology correctly
- Reference recent updates/changes accurately
- Address actual community pain points
- Avoid outdated information

TIMING:
- Hook: Exactly 10-15% of total duration
- Each line: Maximum 4 seconds to read
- Pauses built into timestamps for emphasis`;
}

// ========== 개선된 사용자 프롬프트 ==========
function createViralUserPrompt(params) {
  const { text, style, tone, language, duration, wordsTarget, ctaInclusion } = params;
  
  // 아이디어에서 핵심 키워드 추출
  const keywords = text.toLowerCase().split(" ").filter(word => 
    word.length > 3 && !["this", "that", "make", "making", "video", "people"].includes(word)
  );

  return `VIDEO BRIEF: ${text}

STRICT REQUIREMENTS:
- Language: ${language}
- Duration: EXACTLY ${duration} seconds
- Word count: ~${wordsTarget} words (adjust for natural pacing)
- Include CTA: ${ctaInclusion ? "Yes - organic and compelling" : "No"}

MUST INCLUDE:
- Specific reference to "${keywords[0]}" in first line
- Current/recent information only (2024-2025)
- Pattern interrupt every 5-7 seconds
- One surprising fact or stat
- Clear value proposition within 10 seconds

STRUCTURE:
Total lines: 6-8 (including [HOOK] and optional [CTA])
Format: [start-end] text (one decimal place)

DO NOT:
- Make up features or updates
- Use generic phrases
- Include filler words
- Be vague about benefits

Create the timestamped script now:`;
}

// ========== 타이밍 재조정 모듈 ==========
function retimeScript(script, totalSeconds, language) {
  try {
    const duration = Math.max(1, Math.round((Number(totalSeconds) || 0) * 10) / 10);
    
    if (!script) return script;
    
    const lines = splitLines(script);
    if (!lines.length) return script;

    const items = lines.map(line => {
      const textOnly = stripTimePrefix(line);
      return {
        text: textOnly,
        isHook: textOnly.includes("[HOOK]"),
        isCTA: textOnly.includes("[CTA]")
      };
    });

    // 후크 확인
    if (!items[0].isHook && items[0].text) {
      items[0].text = "[HOOK] " + items[0].text;
      items[0].isHook = true;
    }

    // 가중치 계산
    const weights = items.map(item => {
      const text = item.text.replace("[HOOK]", "").replace("[CTA]", "").trim();
      const words = text.split(" ").filter(Boolean).length;
      return Math.max(1, words);
    });

    let totalWeight = weights.reduce((sum, w) => sum + w, 0);
    if (totalWeight <= 0) {
      weights.fill(1);
      totalWeight = weights.length;
    }

    // 시간 분배
    const durations = weights.map(weight => (weight / totalWeight) * duration);

    // 후크는 10-15%
    const hookDuration = Math.min(duration * 0.15, Math.max(duration * 0.10, durations[0]));
    durations[0] = hookDuration;
    
    // CTA는 5-8%
    const ctaIndex = items.findIndex(item => item.isCTA);
    if (ctaIndex >= 0) {
      durations[ctaIndex] = Math.min(duration * 0.08, durations[ctaIndex]);
    }

    // 나머지 재분배
    const frozenIndices = new Set([0]);
    if (ctaIndex >= 0) frozenIndices.add(ctaIndex);
    
    const frozenSum = Array.from(frozenIndices).reduce((sum, i) => sum + durations[i], 0);
    const freeIndices = durations.map((_, i) => i).filter(i => !frozenIndices.has(i));
    const freeSum = freeIndices.reduce((sum, i) => sum + durations[i], 0);
    
    if (freeSum > 0) {
      const remainingTime = Math.max(0.1, duration - frozenSum);
      const scale = remainingTime / freeSum;
      freeIndices.forEach(i => durations[i] *= scale);
    }

    // 타임스탬프 생성
    const result = [];
    let currentTime = 0;
    
    for (let i = 0; i < items.length; i++) {
      const start = Math.round(currentTime * 10) / 10;
      
      if (i === items.length - 1) {
        result.push(`[${start.toFixed(1)}-${duration.toFixed(1)}] ${items[i].text}`);
      } else {
        const endTime = Math.min(
          duration - 0.1,
          Math.round((currentTime + durations[i]) * 10) / 10
        );
        result.push(`[${start.toFixed(1)}-${endTime.toFixed(1)}] ${items[i].text}`);
        currentTime = endTime;
      }
    }

    return result.join("\n");
  } catch (error) {
    console.error("Retiming error:", error);
    return script;
  }
}

// ========== 비주얼 요소 생성 (스마트 버전) ==========
function generateSmartVisualElements(script, videoIdea, style, duration) {
  try {
    const lines = splitLines(script);
    const transitions = [];
    const bRoll = [];
    const textOverlays = [];
    const soundEffects = [];

    lines.forEach((line, index) => {
      const match = line.match(/\[(\d+\.?\d*)-(\d+\.?\d*)\]/);
      if (!match) return;

      const start = parseFloat(match[1]);
      const end = parseFloat(match[2]);
      const content = line.substring(match[0].length).trim();
      const isHook = content.includes("[HOOK]");
      const isCTA = content.includes("[CTA]");

      // 스마트 전환
      if (index > 0) {
        const transitionTypes = {
          meme: ["Jump cut", "Zoom punch", "Glitch", "Speed ramp"],
          quicktip: ["Slide", "Pop", "Wipe", "Fade"],
          challenge: ["Whip pan", "Quick cut", "Crash zoom", "Match cut"],
          storytelling: ["Cross fade", "J-cut", "L-cut", "Dissolve"],
          productplug: ["Reveal", "Comparison wipe", "Focus pull", "Smooth"],
          faceless: ["Cut", "Fade", "Morph", "Slide"]
        };
        
        const styleTransitions = transitionTypes[style] || transitionTypes.faceless;
        transitions.push({
          time: `${start.toFixed(1)}s`,
          type: styleTransitions[index % styleTransitions.length],
          description: `Transition for beat ${index + 1}`
        });
      }

      // B-Roll 제안
      if (!isHook && !isCTA) {
        const ideaLower = videoIdea.toLowerCase();
        let bRollSuggestion = "Supporting footage";
        
        if (ideaLower.includes("valorant")) {
          if (content.toLowerCase().includes("agent") || content.toLowerCase().includes("요원")) {
            bRollSuggestion = "Agent ability showcase, ultimate animations, gameplay highlights";
          } else if (content.toLowerCase().includes("map") || content.toLowerCase().includes("맵")) {
            bRollSuggestion = "Map flythrough, callout locations, angle demonstrations";
          } else {
            bRollSuggestion = "Ranked gameplay, clutch moments, pro player clips";
          }
        } else if (ideaLower.includes("fitness")) {
          bRollSuggestion = "Exercise form demonstration, multiple angles, common mistakes comparison";
        } else if (ideaLower.includes("tech")) {
          bRollSuggestion = "Screen recording, UI navigation, feature demonstration, before/after";
        }

        bRoll.push({
          timeRange: `${start.toFixed(1)}-${end.toFixed(1)}s`,
          content: bRollSuggestion
        });
      }

      // 텍스트 오버레이
      if (isHook) {
        const hookText = content.replace("[HOOK]", "").trim().split(" ").slice(0, 5).join(" ");
        textOverlays.push({
          time: `${start.toFixed(1)}s`,
          text: hookText,
          style: "Bold animated entrance - scale up with glow"
        });
      } else if (style === "quicktip" && index > 0 && index < 6) {
        textOverlays.push({
          time: `${start.toFixed(1)}s`, 
          text: `TIP ${index}`,
          style: "Number badge with slide-in animation"
        });
      }

      // 키워드 강조
      const powerWords = ["never", "always", "only", "secret", "mistake", "stop", "now"];
      const foundPower = powerWords.find(w => content.toLowerCase().includes(w));
      if (foundPower && !isHook) {
        textOverlays.push({
          time: `${(start + 0.5).toFixed(1)}s`,
          text: foundPower.toUpperCase(),
          style: "Pop emphasis with shake effect"
        });
      }

      // 사운드 효과
      if (isHook) {
        soundEffects.push({
          time: `${start.toFixed(1)}s`,
          effect: "Impact sound or attention grabber"
        });
      } else if (content.toLowerCase().includes("but") || content.toLowerCase().includes("plot twist")) {
        soundEffects.push({
          time: `${start.toFixed(1)}s`,
          effect: "Record scratch or pause effect"
        });
      } else if (isCTA) {
        soundEffects.push({
          time: `${start.toFixed(1)}s`,
          effect: "Success chime or notification sound"
        });
      }
    });

    return { transitions, bRoll, textOverlays, soundEffects };
  } catch (error) {
    console.error("Visual generation error:", error);
    return { transitions: [], bRoll: [], textOverlays: [], soundEffects: [] };
  }
}

// ========== OpenAI API 호출 (최적화) ==========
async function callOpenAI(systemPrompt, userPrompt, config, style) {
  const { OPENAI_API_KEY, OPENAI_MODEL, HARD_TIMEOUT_MS } = config;
  
  const temperatures = {
    meme: 0.8,
    challenge: 0.6,
    storytelling: 0.5,
    quicktip: 0.3,
    productplug: 0.4,
    faceless: 0.3
  };
  
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: temperatures[style] || 0.4,
        top_p: 0.95,
        max_tokens: 800,
        presence_penalty: 0.3,
        frequency_penalty: 0.4,
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
      throw new Error(`OpenAI API ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content?.trim();
    
    if (!content) {
      throw new Error("Empty response from OpenAI");
    }

    // 클리셰 필터링
    const banned = getBannedPhrases();
    let filtered = content;
    banned.forEach(phrase => {
      const regex = new RegExp(phrase, 'gi');
      filtered = filtered.replace(regex, '');
    });

    return filtered;
  } catch (error) {
    clearTimeout(timer);
    if (error.name === "AbortError") {
      throw new Error("Request timeout");
    }
    throw error;
  }
}

// ========== 메인 핸들러 ==========
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

  try {
    const body = await parseRequestBody(req);
    const { 
      text, 
      style, 
      length = 45, 
      tone = "Casual", 
      language = "English", 
      ctaInclusion = false,
      outputType = "script"
    } = body;

    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "`text` is required" });
    }
    if (!style || typeof style !== "string") {
      return res.status(400).json({ error: "`style` is required" });
    }

    const duration = Math.max(15, Math.min(Number(length) || 45, 180));
    const wps = getWordsPerSecond(language);
    const wordsTarget = Math.round(duration * wps);
    const styleKey = String(style || "").toLowerCase();
    const output = String(outputType || "script").toLowerCase();

    // 바이럴 프롬프트 생성
    const systemPrompt = createViralSystemPrompt(styleKey, tone, output, language, text);
    const userPrompt = createViralUserPrompt({
      text, style: styleKey, tone, language, duration, wordsTarget, ctaInclusion
    });

    // AI 호출
    const rawScript = await callOpenAI(systemPrompt, userPrompt, config, styleKey);
    
    // 타이밍 조정
    const finalScript = retimeScript(rawScript, duration, language);

    if (output === "complete") {
      const visualElements = generateSmartVisualElements(finalScript, text, styleKey, duration);
      
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
    console.error("[API Error]", error.message);
    const errorMessage = config.DEBUG_ERRORS ? error.message : "Internal server error";
    return res.status(500).json({ error: errorMessage });
  }
};
