// api/generate-content.js — Enhanced Vercel Serverless Function
// 스크립트 + 화면전환 + B-roll + 텍스트오버레이 + 사운드이펙트 지원
// 성공: 200 { result: "script" | { script, transitions, bRoll, textOverlays, soundEffects } }

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
    en: Number(process.env.WPS_EN) || 2.6,
    ko: Number(process.env.WPS_KO) || 3.0,
    es: Number(process.env.WPS_ES) || 3.0,
    fr: Number(process.env.WPS_FR) || 2.8,
    de: Number(process.env.WPS_DE) || 2.6,
    it: Number(process.env.WPS_IT) || 2.8,
    pt: Number(process.env.WPS_PT) || 2.8,
    nl: Number(process.env.WPS_NL) || 2.6,
    ru: Number(process.env.WPS_RU) || 2.7,
    ja: Number(process.env.WPS_JA) || 3.2,
    zh: Number(process.env.WPS_ZH) || 3.2,
    ar: Number(process.env.WPS_AR) || 2.6
  };
  const langKey = normalizeLanguageKey(language);
  return WPS_TABLE[langKey] || 2.6;
}

// ========== 문자열 처리 모듈 ==========
function normalizeNewlines(text) {
  const str = String(text || "");
  let output = "";
  const LF = String.fromCharCode(10);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 13) { // CR
      if (str.charCodeAt(i + 1) === 10) i++; // CRLF -> LF
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
    if (code === 10) { // LF
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

function hasTag(text, tag) {
  return String(text).toUpperCase().indexOf(tag) >= 0;
}

// ========== 타이밍 파싱 모듈 ==========
function parseTimestamp(line) {
  const text = String(line || "").trim();
  if (text.length > 2 && text[0] === "[") {
    const closeBracket = text.indexOf("]");
    if (closeBracket > 1) {
      const timestamp = text.slice(1, closeBracket);
      const parts = timestamp.split("-");
      if (parts.length === 2) {
        const start = parseFloat(parts[0]);
        const end = parseFloat(parts[1]);
        if (!isNaN(start) && !isNaN(end)) {
          return { start, end };
        }
      }
    }
  }
  return null;
}

// ========== 단어 수 계산 모듈 ==========
function calculateWordWeight(line, language) {
  const text = String(line || "").replace("[HOOK]", "").replace("[CTA]", "").trim();
  if (!text) return 1;
  
  let words = 0, inWord = false, letters = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const isSpace = char === " " || char === "\t";
    if (isSpace) {
      if (inWord) { words++; inWord = false; }
    } else {
      inWord = true; letters++;
    }
  }
  if (inWord) words++;
  
  // 단어가 없으면 글자 수 기반으로 추정
  if (words === 0) words = Math.max(1, Math.floor(letters / 2));
  return Math.max(1, words);
}

function limitWordsPerLine(text, language) {
  const lines = splitLines(text);
  const output = [];
  const isKorean = String(language || "").toLowerCase().includes("ko");
  const MAX_WORDS = isKorean ? 18 : 16; // 한국어는 조금 더 여유롭게
  
  for (const line of lines) {
    const words = line.split(" ").filter(Boolean);
    output.push(words.length <= MAX_WORDS ? line : words.slice(0, MAX_WORDS).join(" "));
  }
  return output.join("\n");
}

// ========== 타이밍 재조정 모듈 ==========
function retimeScript(script, totalSeconds, language) {
  try {
    const duration = Math.max(1, Math.round(Number(totalSeconds) || 0 * 10) / 10);
    if (!script) return script;
    
    const lines = splitLines(script);
    if (!lines.length) return script;

    // 각 라인 분석
    const items = lines.map(line => {
      const textOnly = stripTimePrefix(line);
      return {
        text: textOnly,
        isHook: hasTag(textOnly, "[HOOK]"),
        isCTA: hasTag(textOnly, "[CTA]")
      };
    });

    // 첫 번째 라인이 HOOK이 아니면 추가
    if (!items[0].isHook) {
      items[0].text = "[HOOK] " + items[0].text.replace("[HOOK]", "").trim();
      items[0].isHook = true;
    }

    // 단어 가중치 계산
    const weights = items.map(item => calculateWordWeight(item.text, language));
    let totalWeight = weights.reduce((sum, w) => sum + w, 0);
    if (totalWeight <= 0) {
      weights.fill(1);
      totalWeight = weights.length;
    }

    // 기본 시간 분배
    const durations = weights.map(weight => (weight / totalWeight) * duration);

    // HOOK과 CTA에 특별 비율 적용
    const hookMin = 0.10 * duration, hookMax = 0.15 * duration;
    durations[0] = Math.min(hookMax, Math.max(hookMin, durations[0]));
    
    const ctaIndex = items.findIndex(item => item.isCTA);
    if (ctaIndex >= 0) {
      durations[ctaIndex] = Math.min(durations[ctaIndex], 0.08 * duration);
    }

    // 고정된 시간을 제외한 나머지 재분배
    const frozenIndices = new Set([0]);
    if (ctaIndex >= 0) frozenIndices.add(ctaIndex);
    
    const frozenSum = Array.from(frozenIndices).reduce((sum, i) => sum + durations[i], 0);
    const freeIndices = durations.map((_, i) => i).filter(i => !frozenIndices.has(i));
    const freeSum = freeIndices.reduce((sum, i) => sum + durations[i], 0);
    
    const remainingTime = Math.max(0.1, duration - frozenSum);
    const scale = freeSum > 0 ? (remainingTime / freeSum) : 1.0;
    
    freeIndices.forEach(i => durations[i] *= scale);

    // 최종 타임스탬프 생성
    const result = [];
    let currentTime = 0;
    
    for (let i = 0; i < items.length; i++) {
      const start = Math.round(currentTime * 10) / 10;
      
      if (i === items.length - 1) {
        // 마지막 라인은 정확히 총 시간으로 끝남
        const end = duration;
        result.push(`[${start.toFixed(1)}-${end.toFixed(1)}] ${items[i].text}`);
      } else {
        let endTime = Math.round((currentTime + durations[i]) * 10) / 10;
        if (endTime >= duration) endTime = Math.max(duration - 0.1, start + 0.1);
        result.push(`[${start.toFixed(1)}-${endTime.toFixed(1)}] ${items[i].text}`);
        currentTime = endTime;
      }
    }

    return result.join("\n");
  } catch (error) {
    console.error("Retiming error:", error);
    return script; // 에러 시 원본 반환
  }
}

// ========== 개선된 스타일 예시 ==========
function getStyleExamples() {
  return {
    meme: [
      "EXAMPLE (meme, 25s): [HOOK] POV: You're still editing videos one by one",
      "Setup → Unexpected twist → Relatable punchline. Keep it 3-5 beats max."
    ].join("\n"),
    
    quicktip: [
      "EXAMPLE (quicktip, 30s): [HOOK] Stop wasting hours on video editing",
      "1) Batch your filming sessions",
      "2) Lock your camera settings", 
      "3) Film all A-roll, then B-roll",
      "[CTA] Try this and comment your results!"
    ].join("\n"),
    
    challenge: [
      "EXAMPLE (challenge, 30s): [HOOK] I'll do 100 pushups every time I mess up this recipe",
      "Clear rules → Real-time attempt → Genuine reactions → Final outcome"
    ].join("\n"),
    
    storytelling: [
      "EXAMPLE (storytelling, 45s): [HOOK] I almost missed the most important meeting of my life",
      "Incident → Rising tension → Unexpected turn → Satisfying resolution"
    ].join("\n"),
    
    productplug: [
      "EXAMPLE (productplug, 35s): [HOOK] This editing took me 6 hours before I found this tool",
      "Real problem → Natural solution introduction → Quick demo → Clear CTA"
    ].join("\n"),
    
    faceless: [
      "EXAMPLE (faceless, 30s): [HOOK] These B-roll mistakes are killing your retention",
      "Voice-over only, punchy lines, no camera directions needed"
    ].join("\n")
  };
}

// ========== 개선된 시스템 프롬프트 생성 ==========
function createSystemPrompt(styleKey, outputType) {
  const styleExamples = getStyleExamples();
  const styleHint = styleExamples[styleKey] || "";

  let basePrompt = [
    "You are an expert short-form video creator specializing in TikTok, Instagram Reels, and YouTube Shorts.",
    "Create compelling scripts that maximize viewer retention and engagement.",
    "Always write in the requested LANGUAGE. Return ONLY the script text—no JSON, markdown, or explanations.",
    "",
    "⏱️ TIMING REQUIREMENTS",
    "- Target duration: TARGET_DURATION_SECONDS with roughly TARGET_WORDS_SOFT_CAP words",
    "- Every line must have precise timestamp: [start-end] using ONE decimal place",
    "- Time ranges must be contiguous: next start = previous end",
    "- Final timestamp must equal TARGET_DURATION_SECONDS exactly",
    "",
    "📝 STRUCTURE REQUIREMENTS", 
    "- Total: 6-9 lines (including HOOK and optional CTA)",
    "- First line: [0.0-H] [HOOK] (H should be 10-15% of total duration)",
    "- Body: 5-7 lines, each ≤16-18 words, one clear idea per line",
    "- Optional final line: [C1-C2] [CTA] (if CTA=Yes, keep ≤8% of duration)",
    "",
    "🎯 CONTENT STRATEGY",
    "- HOOK: Must create immediate curiosity or promise value",
    "- BODY: Logical progression, specific details over vague adjectives", 
    "- CTA: Natural, actionable, related to content",
    "- Language: Conversational, platform-appropriate, avoid corporate speak",
    "",
    "🎬 STYLE GUIDELINES",
    "- meme: Setup → twist → punchline (3-5 beats, internet slang OK)",
    "- quicktip: 3-5 numbered actionable tips + summary",
    "- challenge: Rules → attempt → real reactions → outcome",
    "- storytelling: Incident → tension → twist → resolution", 
    "- productplug: Problem → solution → proof → how-to → CTA",
    "- faceless: Voice-over optimized, short punchy lines",
    "",
    styleHint
  ].join("\n");

  if (outputType === "complete") {
    basePrompt += [
      "",
      "🎬 IMPORTANT: This script will be used to generate additional production elements:",
      "- Screen transitions and cut timing suggestions",
      "- B-roll footage recommendations", 
      "- Text overlay suggestions",
      "- Sound effect recommendations",
      "Consider visual storytelling and production needs when writing."
    ].join("\n");
  }

  return basePrompt;
}

// ========== 개선된 사용자 프롬프트 생성 ==========
function createUserPrompt(params) {
  const { text, style, tone, language, duration, wordsTarget, ctaInclusion } = params;
  
  return [
    `VIDEO IDEA: ${text}`,
    `STYLE: ${style}`,
    `TONE: ${tone}`,
    `LANGUAGE: ${language}`,
    `TARGET_DURATION_SECONDS: ${duration}`,
    `TARGET_WORDS_SOFT_CAP: ${wordsTarget}`,
    `CTA: ${ctaInclusion ? "Yes" : "No"}`,
    `KEYWORDS (must appear ≥1 time): ${text.includes(",") ? text : "N/A"}`,
    "",
    "🎯 SPECIFIC REQUIREMENTS:",
    "- Mention the VIDEO IDEA explicitly within first 2 lines",
    "- Structure: [HOOK] → 5-7 body lines → optional [CTA]",
    "- Use specific examples and concrete details",
    "- Avoid generic adjectives, focus on unique value",
    "",
    "Write the complete timestamped script now:"
  ].join("\n");
}

// ========== 비주얼 요소 생성 모듈 ==========
function generateVisualElements(script, videoIdea, style, duration) {
  try {
    const lines = splitLines(script);
    const transitions = [];
    const bRoll = [];
    const textOverlays = [];
    const soundEffects = [];

    lines.forEach((line, index) => {
      const timestamp = parseTimestamp(line);
      const content = stripTimePrefix(line);
      
      if (!timestamp) return;

      const { start, end } = timestamp;
      const isHook = hasTag(content, "[HOOK]");
      const isCTA = hasTag(content, "[CTA]");

      // Transitions (화면 전환)
      if (index > 0) {
        const transitionTypes = {
          meme: ["Quick cut", "Zoom in", "Snap transition"],
          quicktip: ["Smooth fade", "Slide transition", "Clean cut"],
          challenge: ["Quick cut", "Jump cut", "Zoom out"],
          storytelling: ["Smooth fade", "Cross dissolve", "Cinematic cut"],
          productplug: ["Clean cut", "Smooth zoom", "Product focus"],
          faceless: ["B-roll transition", "Text overlay fade", "Smooth cut"]
        };

        const types = transitionTypes[style] || ["Clean cut", "Smooth fade", "Quick cut"];
        const randomType = types[Math.floor(Math.random() * types.length)];
        
        transitions.push({
          time: `${start.toFixed(1)}s`,
          type: randomType,
          description: getTransitionDescription(content, randomType, style)
        });
      }

      // B-Roll Suggestions
      if (!isHook && !isCTA) {
        bRoll.push({
          timeRange: `${start.toFixed(1)}-${end.toFixed(1)}s`,
          content: getBRollSuggestion(content, videoIdea, style)
        });
      }

      // Text Overlays
      if (isHook) {
        textOverlays.push({
          time: `${start.toFixed(1)}s`,
          text: extractKeyPhrase(content),
          style: "Bold hook title"
        });
      } else if (content.match(/\d+\)/)) { // numbered points
        const number = content.match(/(\d+)\)/)?.[1];
        if (number) {
          textOverlays.push({
            time: `${start.toFixed(1)}s`,
            text: `TIP ${number}`,
            style: "Number highlight"
          });
        }
      } else if (isCTA) {
        textOverlays.push({
          time: `${start.toFixed(1)}s`,
          text: "👆 TRY THIS",
          style: "Call-to-action prompt"
        });
      }

      // Sound Effects
      if (isHook) {
        soundEffects.push({
          time: `${start.toFixed(1)}s`,
          effect: "Attention grab sound"
        });
      } else if (index > 0 && index < lines.length - 1) {
        if (style === "meme") {
          soundEffects.push({
            time: `${start.toFixed(1)}s`,
            effect: "Meme transition sound"
          });
        } else if (style === "quicktip") {
          soundEffects.push({
            time: `${start.toFixed(1)}s`,
            effect: "Tip notification sound"
          });
        } else {
          soundEffects.push({
            time: `${start.toFixed(1)}s`,
            effect: "Smooth transition whoosh"
          });
        }
      }
    });

    return { transitions, bRoll, textOverlays, soundEffects };
  } catch (error) {
    console.error("Visual elements generation error:", error);
    return { transitions: [], bRoll: [], textOverlays: [], soundEffects: [] };
  }
}

function getTransitionDescription(content, transitionType, style) {
  const contentLower = content.toLowerCase();
  
  if (contentLower.includes("iphone") || contentLower.includes("phone")) {
    return "Close-up of device";
  } else if (contentLower.includes("app") || contentLower.includes("interface")) {
    return "Screen recording of interface";
  } else if (contentLower.includes("2007") || contentLower.includes("2008")) {
    return "Historical footage or timeline graphic";
  } else if (style === "challenge") {
    return "Action shot or reaction closeup";
  } else if (style === "storytelling") {
    return "Narrative scene change";
  } else {
    return "Supporting visual or demonstration";
  }
}

function getBRollSuggestion(content, videoIdea, style) {
  const contentLower = content.toLowerCase();
  const ideaLower = videoIdea.toLowerCase();
  
  if (contentLower.includes("iphone") || contentLower.includes("phone")) {
    return "iPhone product shots, hands using device, close-up details";
  } else if (contentLower.includes("app store")) {
    return "App Store browsing footage, app downloads, interface navigation";
  } else if (contentLower.includes("interface") || contentLower.includes("user")) {
    return "Screen recordings of iPhone UI, finger gestures, interface interactions";
  } else if (ideaLower.includes("fitness") || ideaLower.includes("workout")) {
    return "Exercise demonstration footage, gym scenes, workout equipment";
  } else if (ideaLower.includes("cooking") || ideaLower.includes("recipe")) {
    return "Cooking process shots, ingredient close-ups, final dish presentation";
  } else if (style === "storytelling") {
    return "Supporting narrative visuals, relevant scenes, emotional moments";
  } else {
    return "Relevant demonstration footage, supporting visuals, contextual imagery";
  }
}

function extractKeyPhrase(content) {
  // Remove timestamp and tags
  let cleaned = stripTimePrefix(content).replace("[HOOK]", "").replace("[CTA]", "").trim();
  
  // Extract first meaningful phrase (up to 4 words)
  const words = cleaned.split(" ").filter(Boolean);
  if (words.length <= 4) return cleaned;
  
  // Look for question patterns
  if (cleaned.startsWith("How")) return words.slice(0, 4).join(" ") + "?";
  if (cleaned.includes("?")) return cleaned.split("?")[0] + "?";
  
  // Take first 3-4 words
  return words.slice(0, Math.min(4, words.length)).join(" ");
}

// ========== OpenAI API 호출 모듈 ==========
async function callOpenAI(systemPrompt, userPrompt, config) {
  const { OPENAI_API_KEY, OPENAI_MODEL, HARD_TIMEOUT_MS } = config;
  
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
        temperature: 0.4,
        top_p: 0.9,
        max_tokens: 700,
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

    return content;
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
  // CORS 처리
  if (!setupCORS(req, res)) {
    if (req.method === "OPTIONS") return res.status(204).end();
    return res.status(403).json({ error: "CORS: origin not allowed" });
  }

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // 설정 및 검증
  const config = getConfig();
  if (!config.OPENAI_API_KEY) {
    return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
  }

  try {
    // 요청 본문 파싱
    const body = await parseRequestBody(req);
    const { 
      text, 
      style, 
      length = 45, 
      tone = "Neutral", 
      language = "English", 
      ctaInclusion = false,
      outputType = "script" // 새로운 파라미터
    } = body;

    // 입력 검증
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "`text` (video idea) is required" });
    }
    if (!style || typeof style !== "string") {
      return res.status(400).json({ error: "`style` is required" });
    }

    // 매개변수 정규화
    const duration = Math.max(15, Math.min(Number(length) || 45, 180));
    const wps = getWordsPerSecond(language);
    const wordsTarget = Math.round(duration * wps);
    const styleKey = String(style || "").toLowerCase();
    const output = String(outputType || "script").toLowerCase();

    // 프롬프트 생성
    const systemPrompt = createSystemPrompt(styleKey, output);
    const userPrompt = createUserPrompt({
      text, style, tone, language, duration, wordsTarget, ctaInclusion
    });

    // AI 호출
    const rawScript = await callOpenAI(systemPrompt, userPrompt, config);
    
    // 후처리
    const limitedScript = limitWordsPerLine(rawScript, language);
    const finalScript = retimeScript(limitedScript, duration, language);

    // 응답 생성
    if (output === "complete") {
      // Complete Package: 스크립트 + 비주얼 요소
      const visualElements = generateVisualElements(finalScript, text, styleKey, duration);
      
      return res.status(200).json({
        result: {
          script: finalScript,
          ...visualElements
        }
      });
    } else {
      // Script Only: 기존 방식
      return res.status(200).json({ result: finalScript });
    }

  } catch (error) {
    console.error("[API Error]", error.message);
    const errorMessage = config.DEBUG_ERRORS ? error.message : "Internal server error";
    return res.status(500).json({ error: errorMessage });
  }
};
