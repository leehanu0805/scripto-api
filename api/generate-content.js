// api/generate-content.js — Enhanced Script Quality Version
// 스크립트 품질 대폭 개선: 프롬프트 강화, 스타일별 최적화, 실전 예시 추가

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
    en: 2.5,  // 약간 줄임 (더 자연스러운 속도)
    ko: 2.8,  // 한국어 특성 반영
    es: 2.8,
    fr: 2.6,
    de: 2.4,
    it: 2.6,
    pt: 2.6,
    nl: 2.4,
    ru: 2.5,
    ja: 3.0,
    zh: 3.0,
    ar: 2.4
  };
  const langKey = normalizeLanguageKey(language);
  return WPS_TABLE[langKey] || 2.5;
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
  
  if (words === 0) words = Math.max(1, Math.floor(letters / 2));
  return Math.max(1, words);
}

function limitWordsPerLine(text, language) {
  const lines = splitLines(text);
  const output = [];
  const isKorean = String(language || "").toLowerCase().includes("ko");
  const MAX_WORDS = isKorean ? 15 : 14;  // 더 짧게
  
  for (const line of lines) {
    const words = line.split(" ").filter(Boolean);
    output.push(words.length <= MAX_WORDS ? line : words.slice(0, MAX_WORDS).join(" "));
  }
  return output.join("\n");
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
        isHook: hasTag(textOnly, "[HOOK]"),
        isCTA: hasTag(textOnly, "[CTA]")
      };
    });

    if (!items[0].isHook) {
      items[0].text = "[HOOK] " + items[0].text.replace("[HOOK]", "").trim();
      items[0].isHook = true;
    }

    const weights = items.map(item => calculateWordWeight(item.text, language));
    let totalWeight = weights.reduce((sum, w) => sum + w, 0);
    if (totalWeight <= 0) {
      weights.fill(1);
      totalWeight = weights.length;
    }

    const durations = weights.map(weight => (weight / totalWeight) * duration);

    const hookMin = 0.10 * duration, hookMax = 0.15 * duration;
    durations[0] = Math.min(hookMax, Math.max(hookMin, durations[0]));
    
    const ctaIndex = items.findIndex(item => item.isCTA);
    if (ctaIndex >= 0) {
      durations[ctaIndex] = Math.min(durations[ctaIndex], 0.08 * duration);
    }

    const frozenIndices = new Set([0]);
    if (ctaIndex >= 0) frozenIndices.add(ctaIndex);
    
    const frozenSum = Array.from(frozenIndices).reduce((sum, i) => sum + durations[i], 0);
    const freeIndices = durations.map((_, i) => i).filter(i => !frozenIndices.has(i));
    const freeSum = freeIndices.reduce((sum, i) => sum + durations[i], 0);
    
    const remainingTime = Math.max(0.1, duration - frozenSum);
    const scale = freeSum > 0 ? (remainingTime / freeSum) : 1.0;
    
    freeIndices.forEach(i => durations[i] *= scale);

    const result = [];
    let currentTime = 0;
    
    for (let i = 0; i < items.length; i++) {
      const start = Math.round(currentTime * 10) / 10;
      
      if (i === items.length - 1) {
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
    return script;
  }
}

// ========== 대폭 개선된 스타일 예시 및 프롬프트 ==========
function getEnhancedStylePrompts(style, tone, language) {
  const isKorean = language.toLowerCase().includes("ko");
  
  const stylePrompts = {
    meme: {
      structure: "Setup (2-3 lines) → Twist (1 line) → Punchline (1-2 lines)",
      examples: [
        "POV: You're still doing X manually... → Shows absurd old method → Plot twist: there's been an app for 5 years",
        "Me: 'I'll sleep early tonight' → Also me at 3am: *doing random thing* → Why am I like this?",
        "Nobody: ... → Absolutely nobody: ... → Me: *overreacting to minor thing*"
      ],
      tips: [
        "Use relatable situations everyone experiences",
        "Internet slang and casual language is perfect",
        "Build anticipation then subvert expectations",
        "Keep it snappy - no long explanations"
      ]
    },
    
    quicktip: {
      structure: "Hook → 3-5 numbered tips → Quick summary",
      examples: [
        "Stop wasting hours on X → 1) Specific technique with result → 2) Tool/method with time saved → 3) Mindset shift → Try one today",
        "X mistakes killing your Y → 1) Common mistake + fix → 2) Hidden problem + solution → 3) Pro tip → Which one are you doing?"
      ],
      tips: [
        "Each tip must be actionable within 10 seconds",
        "Include specific numbers/metrics when possible",
        "Use 'Stop/Start/Try' action verbs",
        "Tips should build on each other logically"
      ]
    },
    
    challenge: {
      structure: "Challenge setup → Rules → Live attempt → Result/reaction",
      examples: [
        "I'll do X every time Y happens → *Rule explanation* → *Things start happening* → Final count: Z times",
        "Can I survive a day without X? → Rules: no Y, no Z → *Struggle moments* → Plot twist ending"
      ],
      tips: [
        "Make rules crystal clear upfront",
        "Include real-time reactions and struggles",
        "Build tension toward the outcome",
        "End with unexpected result or learning"
      ]
    },
    
    storytelling: {
      structure: "Hook → Rising action → Climax → Resolution",
      examples: [
        "The day that changed everything → Normal morning until... → Unexpected encounter → Life lesson learned",
        "I thought I lost $X → Backstory of how → The panic moment → Plot twist resolution"
      ],
      tips: [
        "Start in the middle of action",
        "Use sensory details sparingly but effectively",
        "Create emotional connection quickly",
        "End with universal truth or lesson"
      ]
    },
    
    productplug: {
      structure: "Problem agitation → Natural discovery → Demonstration → Results",
      examples: [
        "Spent 6 hours on X yesterday → Found this tool by accident → Here's how it works → Now takes 10 minutes",
        "X was ruining my Y → Friend showed me Z → Quick demo → Game changer results"
      ],
      tips: [
        "Lead with relatable pain point",
        "Make discovery feel organic, not salesy",
        "Show, don't just tell",
        "Include specific before/after metrics"
      ]
    },
    
    faceless: {
      structure: "Strong statement → Evidence/examples → Conclusion",
      examples: [
        "99% of people do X wrong → Here's what pros do instead → The science behind it → Start today",
        "This one change 10x'd my results → The old way vs new way → Why it works → Your turn"
      ],
      tips: [
        "Voice-over optimized: short, punchy sentences",
        "No camera directions or visual cues",
        "Focus on information density",
        "Use power words and statistics"
      ]
    }
  };

  // Tone 조정
  const toneAdjustments = {
    Casual: "Use everyday language, contractions, and conversational flow",
    Professional: "Clear, authoritative, but still accessible",
    Friendly: "Warm, encouraging, like giving advice to a friend",
    Humorous: "Add wit, wordplay, or unexpected comparisons",
    Serious: "Direct, no-nonsense, focus on importance",
    Enthusiastic: "High energy, exclamation points, motivational",
    Neutral: "Balanced, informative, no strong emotion"
  };

  return {
    style: stylePrompts[style] || stylePrompts.faceless,
    tone: toneAdjustments[tone] || toneAdjustments.Neutral
  };
}

// ========== 완전히 새로운 시스템 프롬프트 ==========
function createEnhancedSystemPrompt(style, tone, outputType, language) {
  const prompts = getEnhancedStylePrompts(style, tone, language);
  
  const basePrompt = `You are a viral short-form video scriptwriter who has analyzed thousands of top-performing videos.
Your scripts consistently achieve >80% retention rates.

CRITICAL RULES:
1. Write ONLY in ${language}. No other language.
2. Return ONLY the timestamped script. No JSON, no markdown, no explanations.
3. Every line MUST have [start-end] timestamps with ONE decimal place
4. Total duration must match TARGET_DURATION exactly

VIRAL SCRIPT FORMULA:

**${style.toUpperCase()} STYLE**
Structure: ${prompts.style.structure}

Key principles:
${prompts.style.tips.map(tip => `• ${tip}`).join('\n')}

Real examples that went viral:
${prompts.style.examples.map((ex, i) => `Example ${i+1}: ${ex}`).join('\n')}

TONE: ${prompts.tone}

TIMING FORMULA:
- Hook: 10-15% of total time (grab attention in first 2 seconds)
- Body: 75-85% (value delivery, keep momentum)
- CTA: 5-10% (if included, make it natural)

ENGAGEMENT TACTICS:
- Pattern interrupts every 5-7 seconds
- Curiosity gaps that get answered
- Specific > vague (numbers, examples, names)
- Emotion triggers (surprise, validation, FOMO)
- Open loops that close at the end

LANGUAGE RULES:
- One idea per line (cognitive load management)
- Active voice only
- Power words that trigger action
- Remove ALL filler words
- Conversational but authoritative`;

  if (outputType === "complete") {
    return basePrompt + `

VISUAL AWARENESS:
Since this will generate production elements, write with visual storytelling in mind:
- Each line should suggest a clear visual
- Include moments for B-roll opportunities
- Natural transition points between ideas
- Text overlay worthy phrases`;
  }

  return basePrompt;
}

// ========== 개선된 사용자 프롬프트 ==========
function createEnhancedUserPrompt(params) {
  const { text, style, tone, language, duration, wordsTarget, ctaInclusion } = params;
  
  return `Create a ${style} style video script about: ${text}

REQUIREMENTS:
- Language: ${language} (MUST be in this language)
- Duration: EXACTLY ${duration} seconds
- Target words: ~${wordsTarget} words
- Tone: ${tone}
- Include CTA: ${ctaInclusion ? "Yes - make it natural and compelling" : "No"}

SCRIPT STRUCTURE:
- Lines: 6-9 total (including [HOOK] and optional [CTA])
- First line: Must start with [HOOK] and create immediate curiosity
- Body: Deliver on the hook's promise with escalating value
- Last line: ${ctaInclusion ? "[CTA] with clear action" : "Strong closing statement"}

The idea "${text}" must be explicitly addressed in the first 2 lines.
Make it feel like the viewer discovered a secret.

Write the complete timestamped script now:`;
}

// ========== 스마트 비주얼 요소 생성 (개선) ==========
function generateEnhancedVisualElements(script, videoIdea, style, duration) {
  try {
    const lines = splitLines(script);
    const transitions = [];
    const bRoll = [];
    const textOverlays = [];
    const soundEffects = [];

    const ideaLower = videoIdea.toLowerCase();
    const contentType = detectContentType(ideaLower);

    lines.forEach((line, index) => {
      const timestamp = parseTimestamp(line);
      const content = stripTimePrefix(line);
      
      if (!timestamp) return;

      const { start, end } = timestamp;
      const isHook = hasTag(content, "[HOOK]");
      const isCTA = hasTag(content, "[CTA]");

      // 전환 효과 (더 다양하고 스타일별 최적화)
      if (index > 0) {
        const transition = getSmartTransition(style, index, content, contentType);
        transitions.push({
          time: `${start.toFixed(1)}s`,
          type: transition.type,
          description: transition.description
        });
      }

      // B-Roll (더 구체적이고 실용적)
      if (!isHook && !isCTA) {
        const bRollContent = getSmartBRoll(content, contentType, style);
        bRoll.push({
          timeRange: `${start.toFixed(1)}-${end.toFixed(1)}s`,
          content: bRollContent
        });
      }

      // 텍스트 오버레이 (더 임팩트 있게)
      const overlays = getSmartOverlays(content, start, isHook, isCTA, style, index);
      textOverlays.push(...overlays);

      // 사운드 효과 (더 다이나믹하게)
      const sounds = getSmartSounds(content, start, isHook, isCTA, style, index);
      soundEffects.push(...sounds);
    });

    return { transitions, bRoll, textOverlays, soundEffects };
  } catch (error) {
    console.error("Visual elements generation error:", error);
    return { transitions: [], bRoll: [], textOverlays: [], soundEffects: [] };
  }
}

function detectContentType(ideaLower) {
  if (ideaLower.includes("workout") || ideaLower.includes("exercise") || ideaLower.includes("fitness")) return "fitness";
  if (ideaLower.includes("cook") || ideaLower.includes("recipe") || ideaLower.includes("food")) return "cooking";
  if (ideaLower.includes("tech") || ideaLower.includes("app") || ideaLower.includes("phone")) return "tech";
  if (ideaLower.includes("business") || ideaLower.includes("money") || ideaLower.includes("career")) return "business";
  if (ideaLower.includes("travel") || ideaLower.includes("destination")) return "travel";
  return "general";
}

function getSmartTransition(style, index, content, contentType) {
  const transitions = {
    meme: ["Jump cut", "Crash zoom", "Glitch effect", "Speed ramp"],
    quicktip: ["Smooth slide", "Number pop", "Clean cut", "Zoom transition"],
    challenge: ["Quick cut", "Speed ramp", "Whip pan", "Match cut"],
    storytelling: ["Cross dissolve", "Fade", "J-cut", "L-cut"],
    productplug: ["Product reveal", "Before/after wipe", "Zoom in", "Smooth transition"],
    faceless: ["Clean cut", "Fade transition", "Slide", "Morph"]
  };

  const styleTransitions = transitions[style] || transitions.faceless;
  const selectedTransition = styleTransitions[index % styleTransitions.length];

  return {
    type: selectedTransition,
    description: `${contentType} content transition - ${selectedTransition.toLowerCase()} for impact`
  };
}

function getSmartBRoll(content, contentType, style) {
  const contentLower = content.toLowerCase();
  
  const bRollMap = {
    fitness: {
      keywords: ["pushup", "plank", "squat", "cardio", "stretch"],
      default: "Exercise demonstration with proper form and multiple angles"
    },
    cooking: {
      keywords: ["chop", "mix", "heat", "season", "plate"],
      default: "Ingredient close-ups, cooking process, steam shots, final plating"
    },
    tech: {
      keywords: ["app", "feature", "setting", "trick", "hack"],
      default: "Screen recording, UI navigation, feature highlights, results"
    },
    business: {
      keywords: ["strategy", "growth", "profit", "customer", "market"],
      default: "Charts, graphs, workspace shots, success metrics visualization"
    },
    general: {
      keywords: [],
      default: "Relevant footage matching the current narrative beat"
    }
  };

  const contentMap = bRollMap[contentType] || bRollMap.general;
  
  for (const keyword of contentMap.keywords) {
    if (contentLower.includes(keyword)) {
      return `${keyword.toUpperCase()} footage - multiple angles, slow-mo highlights, detail shots`;
    }
  }
  
  return contentMap.default;
}

function getSmartOverlays(content, start, isHook, isCTA, style, index) {
  const overlays = [];
  
  if (isHook) {
    const hookText = extractPowerPhrase(content);
    overlays.push({
      time: `${start.toFixed(1)}s`,
      text: hookText,
      style: "Bold hook - animated entrance, high contrast"
    });
  } else if (isCTA) {
    overlays.push({
      time: `${start.toFixed(1)}s`,
      text: getStyleCTA(style),
      style: "CTA button animation - pulse effect"
    });
  } else if (style === "quicktip" && index > 0 && index < 6) {
    overlays.push({
      time: `${start.toFixed(1)}s`,
      text: `TIP #${index}`,
      style: "Number badge - slide in from left"
    });
  }
  
  // 강조 단어 추출
  const powerWords = extractEmphasisWords(content);
  if (powerWords.length > 0) {
    overlays.push({
      time: `${(start + 0.2).toFixed(1)}s`,
      text: powerWords[0].toUpperCase(),
      style: "Emphasis word - scale up animation"
    });
  }
  
  return overlays;
}

function getSmartSounds(content, start, isHook, isCTA, style, index) {
  const sounds = [];
  
  if (isHook) {
    sounds.push({
      time: `${start.toFixed(1)}s`,
      effect: style === "meme" ? "Vine boom or meme sound" : "Attention grabber - whoosh or impact"
    });
  } else if (isCTA) {
    sounds.push({
      time: `${start.toFixed(1)}s`,
      effect: "CTA chime - positive notification sound"
    });
  } else if (style === "quicktip" && index > 0) {
    sounds.push({
      time: `${start.toFixed(1)}s`,
      effect: `Tip transition ${index} - subtle swoosh`
    });
  }
  
  // 패턴 기반 사운드
  const contentLower = content.toLowerCase();
  if (contentLower.includes("but") || contentLower.includes("however")) {
    sounds.push({
      time: `${(start + 0.1).toFixed(1)}s`,
      effect: "Plot twist sound - record scratch or pause"
    });
  }
  
  return sounds;
}

function extractPowerPhrase(content) {
  const cleaned = content.replace("[HOOK]", "").replace("[CTA]", "").trim();
  
  // 질문 형태
  if (cleaned.includes("?")) {
    return cleaned.split("?")[0] + "?";
  }
  
  // 숫자가 있으면 포함
  const numberMatch = cleaned.match(/\d+/);
  if (numberMatch) {
    const words = cleaned.split(" ");
    const numberIndex = words.findIndex(w => w.includes(numberMatch[0]));
    return words.slice(Math.max(0, numberIndex - 1), numberIndex + 2).join(" ");
  }
  
  // 첫 3-4 단어
  return cleaned.split(" ").slice(0, 4).join(" ");
}

function extractEmphasisWords(content) {
  const powerWords = [
    "never", "always", "secret", "hack", "trick", "mistake",
    "stop", "start", "now", "today", "free", "easy", "fast",
    "proven", "guaranteed", "instant", "revolutionary"
  ];
  
  const contentLower = content.toLowerCase();
  return powerWords.filter(word => contentLower.includes(word));
}

function getStyleCTA(style) {
  const ctas = {
    meme: "😂 TAG A FRIEND",
    quicktip: "💡 TRY THIS NOW",
    challenge: "🔥 YOUR TURN",
    storytelling: "💭 SHARE YOUR STORY",
    productplug: "🚀 GET STARTED",
    faceless: "📌 SAVE THIS"
  };
  return ctas[style] || "👆 TAKE ACTION";
}

// ========== OpenAI API 호출 모듈 (온도 조정) ==========
async function callOpenAI(systemPrompt, userPrompt, config, style) {
  const { OPENAI_API_KEY, OPENAI_MODEL, HARD_TIMEOUT_MS } = config;
  
  // 스타일별 온도 조정
  const temperatures = {
    meme: 0.7,      // 더 창의적
    challenge: 0.6,  // 약간 창의적
    storytelling: 0.5,
    quicktip: 0.3,   // 더 일관성 있게
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
        top_p: 0.9,
        max_tokens: 800,
        presence_penalty: 0.1,  // 반복 감소
        frequency_penalty: 0.2,  // 다양성 증가
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
      outputType = "script"
    } = body;

    console.log("Request received:", { text, style, length, tone, language, outputType });

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

    // 향상된 프롬프트 생성
    const systemPrompt = createEnhancedSystemPrompt(styleKey, tone, output, language);
    const userPrompt = createEnhancedUserPrompt({
      text, style: styleKey, tone, language, duration, wordsTarget, ctaInclusion
    });

    // AI 호출
    const rawScript = await callOpenAI(systemPrompt, userPrompt, config, styleKey);
    
    // 후처리
    const limitedScript = limitWordsPerLine(rawScript, language);
    const finalScript = retimeScript(limitedScript, duration, language);

    // 응답 생성
    if (output === "complete") {
      const visualElements = generateEnhancedVisualElements(finalScript, text, styleKey, duration);
      
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
