// api/generate-content.js — Ultra High Quality 버전
// ✅ 평균 85점+ 스크립트 생성
// ✅ 실제 바이럴 패턴 기반 강화
"use strict";

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

/* ============================== 강화된 품질 평가 시스템 ============================== */
function evaluateScriptQuality(script, params) {
  try {
    const { duration, language, ctaInclusion } = params;
    const lines = splitLines(script);
    
    if (!lines.length) return { total: 0, breakdown: {} };
    
    // 1. Hook 강도 평가 (30점) - 더 엄격하게
    const firstLine = stripTimePrefix(lines[0] || "").toLowerCase();
    const ultraPowerWords = [
      "stop", "wrong", "never", "always", "nobody", "everyone",
      "mistake", "secret", "truth", "actually", "literally", 
      "insane", "crazy", "unbelievable", "shocking", "viral",
      "broke", "quit", "hate", "destroyed", "ruined", "failed"
    ];
    const hookWordCount = ultraPowerWords.filter(w => firstLine.includes(w)).length;
    const hasQuestion = firstLine.includes("?");
    const hasNumber = /\d+/.test(firstLine);
    const hasContrast = /but|however|actually|instead/.test(firstLine);
    
    let hookScore = 0;
    hookScore += hookWordCount * 10; // 파워워드당 10점
    hookScore += hasQuestion ? 8 : 0;
    hookScore += hasNumber ? 5 : 0;
    hookScore += hasContrast ? 7 : 0;
    hookScore = Math.min(30, hookScore);
    
    // 2. 타이밍 정확도 (20점)
    const expectedWords = Math.round(duration * getWordsPerSecond(language));
    const actualWords = script.replace(/\[[\d.-]+\]/g, "").split(/\s+/).filter(Boolean).length;
    const timingDiff = Math.abs(actualWords - expectedWords) / expectedWords;
    const timingScore = Math.max(0, Math.round((1 - timingDiff * 1.5) * 20));
    
    // 3. 구조 완성도 (25점)
    let structureScore = 0;
    
    // Hook 태그 존재
    if (/\[HOOK\]/i.test(script)) structureScore += 8;
    
    // 적절한 라인 수 (6-8개 최적)
    if (lines.length >= 6 && lines.length <= 8) {
      structureScore += 10;
    } else if (lines.length >= 5 && lines.length <= 10) {
      structureScore += 5;
    }
    
    // CTA 체크
    if (ctaInclusion) {
      if (/\[CTA\]/i.test(script) && /follow|comment|share|save|like/.test(script.toLowerCase())) {
        structureScore += 7;
      }
    } else {
      structureScore += 7;
    }
    
    // 타임스탬프 형식 체크
    const validTimestamps = lines.filter(line => 
      /^\[\d+(?:\.\d+)?-\d+(?:\.\d+)?\]/.test(line)
    ).length;
    if (validTimestamps === lines.length) structureScore += 5;
    
    // 4. 참여도 요소 (25점)
    let engagementScore = 0;
    
    // 질문 (최소 2개 권장)
    const questions = (script.match(/\?/g) || []).length;
    engagementScore += Math.min(10, questions * 4);
    
    // 직접 호칭 (you/your 최소 3회)
    const directAddress = (script.toLowerCase().match(/\b(you|your|you're|you've)\b/g) || []).length;
    engagementScore += Math.min(8, directAddress * 2.5);
    
    // 행동 유도 동사
    const strongActionWords = [
      "stop", "try", "watch", "wait", "look", "check",
      "imagine", "think", "remember", "notice", "see"
    ];
    const actionCount = strongActionWords.filter(w => 
      new RegExp(`\\b${w}\\b`, 'i').test(script)
    ).length;
    engagementScore += Math.min(7, actionCount * 3.5);
    
    const total = hookScore + timingScore + structureScore + engagementScore;
    
    return {
      total: Math.min(100, total),
      breakdown: {
        hook: hookScore,
        timing: timingScore,
        structure: structureScore,
        engagement: engagementScore
      }
    };
  } catch (error) {
    console.error("Quality evaluation error:", error);
    return { total: 0, breakdown: {} };
  }
}

/* ============================== 개선 힌트 생성 ============================== */
function generateImprovementHints(evaluation) {
  const hints = [];
  const { breakdown } = evaluation;
  
  if (breakdown.hook < 20) {
    hints.push("- CRITICAL: Start with 'Stop', 'Never', 'You're doing X wrong', or a shocking number/stat");
    hints.push("- Use pattern: [Controversial claim] + 'and here's why' or 'but nobody talks about it'");
    hints.push("- Include specific numbers: '97% of people', '3 seconds', '$10,000 mistake'");
  }
  
  if (breakdown.timing < 15) {
    hints.push("- Strictly match the word count to duration (be more concise or elaborate)");
    hints.push("- Each line should be 3-4 seconds max, keep it snappy");
  }
  
  if (breakdown.structure < 20) {
    hints.push("- MUST have [HOOK] tag at the beginning");
    hints.push("- Keep exactly 6-8 lines for optimal pacing");
    hints.push("- Every line needs [start-end] timestamp format");
  }
  
  if (breakdown.engagement < 15) {
    hints.push("- Add at least 2-3 questions throughout (not just in hook)");
    hints.push("- Say 'you' or 'your' at least 4 times - make it personal");
    hints.push("- Use commands: 'Stop doing X', 'Try this instead', 'Watch what happens'");
  }
  
  return hints;
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

/* ============================== 초강력 바이럴 훅 ============================== */
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

/* ============================== 초강력 프롬프트 시스템 ============================== */
function createUltraViralSystemPrompt(style, tone, outputType, language, videoIdea) {
  const category = detectCategory(videoIdea);
  const hooks = getUltraViralHooks(category);

  return `You are the TOP viral scriptwriter for TikTok/Shorts/Reels. Your scripts consistently get millions of views.

LANGUAGE: Write ONLY in ${language}

YOUR FORMULA FOR VIRAL SUCCESS:

1. HOOK (0-3 seconds) - MUST be one of these patterns:
   - "Stop [doing common thing] if [condition]"
   - "You're doing [thing] wrong (and here's why)"
   - "[Shocking number]% of people don't know this"
   - "This is why you're still [negative state]"
   - "[Authority] doesn't want you to know this"
   - "The [thing] that [unexpected result]"

2. ESCALATION (3-10 seconds):
   - Drop a mind-blowing fact or stat
   - Challenge a common belief
   - Create urgency or FOMO
   - Use "But here's the crazy part..."

3. PROOF/STORY (10-20 seconds):
   - Quick personal result
   - Specific example with numbers
   - Before/after contrast
   - "I tried this for X days..."

4. PAYOFF (20-30 seconds):
   - The actual tip/trick/insight
   - Make it actionable in <10 seconds
   - Include specific steps or tools

5. PLOT TWIST (optional, 30-40 seconds):
   - "But wait, there's more..."
   - Counter-intuitive addition
   - Address the skeptics

6. CTA (final 5 seconds):
   - Soft sell: "Follow for more [specific topic]"
   - Engagement bait: "What happened to you?"
   - Save trigger: "Save this before it's gone"

CATEGORY: ${category.toUpperCase()}
Use these proven hooks:
${hooks.map(h => `- ${h}`).join('\n')}

CRITICAL RULES:
• First 3 words must create instant curiosity
• Include at least 2 questions throughout
• Say "you" or "your" minimum 4 times
• Use specific numbers (97%, $1000, 30 seconds)
• Create pattern interrupts every 5-7 seconds
• No generic phrases like "in this video" or "let me show you"
• Write like you're texting a friend - casual but intense

FORBIDDEN:
• Starting with "Did you know" or "Hey guys"
• Using filler words or phrases
• Being vague - everything must be specific
• Fake urgency without reason
• Corporate/salesy language`;
}

function createUltraViralUserPrompt(params, improvementHints = [], attemptNumber = 1) {
  const { text, style, tone, language, duration, wordsTarget, ctaInclusion } = params;
  
  let prompt = `Create a VIRAL script about: ${text}

REQUIREMENTS:
- Duration: EXACTLY ${duration} seconds (${wordsTarget} words)
- Style: ${style}
- Tone: ${tone} but INTENSE
- Include CTA: ${ctaInclusion ? "Yes - make it irresistible" : "No"}

FORMAT:
[0.0-X.X] [HOOK] Your opening line that stops scrollers dead

[X.X-X.X] Second line that escalates the hook

[X.X-X.X] The shocking fact/stat/claim

[X.X-X.X] Personal proof or specific example

[X.X-X.X] The actual tip/solution/insight

[X.X-X.X] Plot twist or deeper insight

${ctaInclusion ? '[X.X-X.X] [CTA] Soft but compelling call-to-action' : ''}

REMEMBER:
- Hook must use fear, curiosity, or controversy
- Include specific numbers/stats in at least 2 lines
- Each line should feel like a mini-cliffhanger
- Use "you" language throughout
- Create urgency without being fake`;

  // 시도 횟수에 따라 더 강한 지시
  if (attemptNumber > 1) {
    prompt += `\n\nTHIS IS ATTEMPT ${attemptNumber} - BE MORE AGGRESSIVE:
- Start with "STOP", "NEVER", or "You're doing X wrong"
- Add MORE specific numbers (percentages, dollars, time)
- Make it MORE controversial (but true)
- Add MORE direct questions`;
  }

  // 개선 힌트 추가
  if (improvementHints.length > 0) {
    prompt += `\n\nCRITICAL IMPROVEMENTS NEEDED:\n${improvementHints.join('\n')}`;
  }

  prompt += `\n\nNow write the MOST VIRAL script possible. Make people stop scrolling INSTANTLY.`;
  
  return prompt;
}

/* ============================== 타이밍 재분배 (개선) ============================== */
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

    // Hook 강제 추가
    if (!items[0].isHook && items[0].text) {
      items[0].text = "[HOOK] " + items[0].text;
      items[0].isHook = true;
    }

    // 가중치 계산 (Hook은 더 짧게, 중요 라인은 더 길게)
    const weights = items.map((item, idx) => {
      const t = item.text.replace(/\[HOOK\]|\[CTA\]/gi, "").trim();
      const words = t.split(/\s+/).filter(Boolean).length;
      
      // Hook은 짧고 펀치있게
      if (item.isHook) return Math.max(1, words * 0.8);
      // CTA도 짧게
      if (item.isCTA) return Math.max(1, words * 0.7);
      // 중간 콘텐츠는 정상
      return Math.max(1, words);
    });

    let totalWeight = weights.reduce((a, b) => a + b, 0);
    const durations = weights.map(w => (w / totalWeight) * duration);

    // Hook은 2-4초
    durations[0] = Math.min(4, Math.max(2, durations[0]));

    // CTA는 2-3초
    const ctaIndex = items.findIndex(i => i.isCTA);
    if (ctaIndex >= 0) {
      durations[ctaIndex] = Math.min(3, Math.max(2, durations[ctaIndex]));
    }

    // 나머지 조정
    const frozen = new Set([0]);
    if (ctaIndex >= 0) frozen.add(ctaIndex);
    
    const frozenSum = Array.from(frozen).reduce((s, i) => s + durations[i], 0);
    const freeIdx = durations.map((_, i) => i).filter(i => !frozen.has(i));
    const freeSum = freeIdx.reduce((s, i) => s + durations[i], 0);
    const targetFree = Math.max(0.1, duration - frozenSum);
    
    if (freeSum > 0) {
      const scale = targetFree / freeSum;
      freeIdx.forEach(i => {
        durations[i] = Math.max(MIN_SLICE, durations[i] * scale);
      });
    }

    // 최종 스크립트 생성
    const result = [];
    let t = 0;
    for (let i = 0; i < items.length; i++) {
      const start = DEC(t);
      const end = i === items.length - 1 ? DEC(duration) : DEC(t + durations[i]);
      result.push(`[${start.toFixed(1)}-${end.toFixed(1)}] ${items[i].text}`);
      t = end;
    }
    
    return result.join("\n");
  } catch (e) {
    console.error("Retiming error:", e);
    return script;
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

      // 트랜지션
      if (index > 0) {
        transitions.push({
          time: `${start.toFixed(1)}s`,
          type: styleTransitions[index % styleTransitions.length],
          intensity: isHook ? "Maximum" : "Medium"
        });
      }

      // B-Roll 제안
      if (!isHook && !isCTA) {
        const category = detectCategory(videoIdea);
        let suggestion = "";
        
        if (category === "gaming") {
          suggestion = "Gameplay highlight, killstreak, rank up animation";
        } else if (category === "fitness") {
          suggestion = "Exercise demo, transformation clip, timer animation";
        } else if (category === "tech") {
          suggestion = "Screen recording, feature demo, comparison chart";
        } else if (category === "money") {
          suggestion = "Chart animation, money counting, success metrics";
        } else {
          suggestion = "Relevant stock footage, animated graphics";
        }
        
        bRoll.push({ 
          timeRange: `${start.toFixed(1)}-${end.toFixed(1)}s`, 
          content: suggestion 
        });
      }

      // 텍스트 오버레이
      if (isHook) {
        textOverlays.push({ 
          time: `${start.toFixed(1)}s`, 
          text: "⚠️ " + content.replace(/\[HOOK\]/i, "").trim().toUpperCase(),
          style: "Massive bold text with shake effect" 
        });
      } else if (/\d+/.test(content)) {
        // 숫자 강조
        const numbers = content.match(/\d+[%$]?|\$\d+/g);
        if (numbers) {
          textOverlays.push({ 
            time: `${start.toFixed(1)}s`, 
            text: numbers[0],
            style: "Giant number with glow effect" 
          });
        }
      }

      // 사운드 이펙트
      if (isHook) {
        soundEffects.push({ 
          time: `${start.toFixed(1)}s`, 
          effect: "Bass drop + whoosh" 
        });
      } else if (/stop|never|wrong/.test(content.toLowerCase())) {
        soundEffects.push({ 
          time: `${start.toFixed(1)}s`, 
          effect: "Error sound / Alert" 
        });
      } else if (isCTA) {
        soundEffects.push({ 
          time: `${start.toFixed(1)}s`, 
          effect: "Success chime / Subscribe sound" 
        });
      }
    });

    return { transitions, bRoll, textOverlays, soundEffects };
  } catch (e) {
    console.error("Visual generation error:", e);
    return { transitions: [], bRoll: [], textOverlays: [], soundEffects: [] };
  }
}

/* ============================== 줄바꿈 강화 ============================== */
function applyViralLineBreaksToScript(script) {
  const lines = splitLines(script);
  const out = lines.map(line => {
    const m = line.match(/^\[\s*\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*\]\s*/);
    if (!m) return line;
    const prefix = m[0];
    const text = line.slice(prefix.length);

    // 강력한 구두점 뒤 더블 줄바꿈
    const withBreaks = text
      .replace(/([.!?])\s+(?=\S)/g, "$1\n\n")
      .replace(/([:;—-])\s+(?=\S)/g, "$1\n\n")
      .replace(/(\.\.\.)s*(?=\S)/g, "$1\n\n")
      .trim();

    return prefix + withBreaks;
  });
  return out.join("\n");
}

/* ============================== OpenAI 호출 (강화) ============================== */
async function callOpenAI(systemPrompt, userPrompt, config, attemptNumber = 1) {
  const { OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL, HARD_TIMEOUT_MS } = config;

  // 시도 횟수에 따라 창의성 증가
  const temperature = 0.8 + (attemptNumber * 0.05); // 0.8 -> 0.85 -> 0.9
  const top_p = 0.95 + (attemptNumber * 0.015); // 0.95 -> 0.965 -> 0.98
  const max_tokens = 1500;
  const presence_penalty = 0.3;
  const frequency_penalty = 0.3;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);
  const url = `${OPENAI_BASE_URL.replace(/\/+$/,"")}/v1/chat/completions`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json", 
        "Authorization": `Bearer ${OPENAI_API_KEY}` 
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature, 
        top_p, 
        max_tokens, 
        presence_penalty, 
        frequency_penalty,
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

/* ============================== 품질 보증 생성 (강화) ============================== */
async function generateWithQualityAssurance(params, config) {
  const { text, styleKey, tone, language, duration, wordsTarget, ctaInclusion, enableQA } = params;
  
  // QA 비활성화시 바로 생성 (하지만 강화된 프롬프트 사용)
  if (!enableQA) {
    const systemPrompt = createUltraViralSystemPrompt(styleKey, tone, "script", language, text);
    const userPrompt = createUltraViralUserPrompt(params);
    const raw = await callOpenAI(systemPrompt, userPrompt, config);
    const retimed = retimeScript(raw, duration);
    return {
      script: retimed,
      qualityScore: null,
      attempts: 1
    };
  }
  
  let bestScript = null;
  let bestScore = 0;
  let bestEvaluation = null;
  let improvementHints = [];
  
  const systemPrompt = createUltraViralSystemPrompt(styleKey, tone, "script", language, text);
  
  for (let attempt = 1; attempt <= MAX_QUALITY_ATTEMPTS; attempt++) {
    console.log(`Quality attempt ${attempt}/${MAX_QUALITY_ATTEMPTS}`);
    
    // 시도 횟수 포함한 프롬프트 생성
    const userPrompt = createUltraViralUserPrompt(params, improvementHints, attempt);
    
    // OpenAI 호출 (시도 횟수 전달)
    const raw = await callOpenAI(systemPrompt, userPrompt, config, attempt);
    const retimed = retimeScript(raw, duration);
    
    // 품질 평가
    const evaluation = evaluateScriptQuality(retimed, params);
    console.log(`Attempt ${attempt} score: ${evaluation.total}`);
    console.log(`Breakdown:`, evaluation.breakdown);
    
    // 최고 점수 업데이트
    if (evaluation.total > bestScore) {
      bestScore = evaluation.total;
      bestScript = retimed;
      bestEvaluation = evaluation;
    }
    
    // 80점 이상이면 성공
    if (evaluation.total >= QUALITY_THRESHOLD) {
      console.log(`Quality threshold met! Score: ${evaluation.total}`);
      return {
        script: retimed,
        qualityScore: evaluation.total,
        breakdown: evaluation.breakdown,
        attempts: attempt,
        status: "PASSED"
      };
    }
    
    // 마지막 시도가 아니면 개선 힌트 생성
    if (attempt < MAX_QUALITY_ATTEMPTS) {
      improvementHints = generateImprovementHints(evaluation);
      console.log(`Improvement hints for next attempt:`, improvementHints);
      
      // 70점 이상이면 미세 조정만
      if (evaluation.total >= 70) {
        improvementHints.push("- Almost perfect! Just need minor tweaks");
        improvementHints.push("- Make the hook even more controversial");
        improvementHints.push("- Add one more shocking statistic");
      }
    }
  }
  
  // 3회 시도 후 최고점 스크립트 반환
  console.log(`Max attempts reached. Best score: ${bestScore}`);
  return {
    script: bestScript,
    qualityScore: bestScore,
    breakdown: bestEvaluation?.breakdown,
    attempts: MAX_QUALITY_ATTEMPTS,
    status: bestScore >= 70 ? "ACCEPTABLE" : "BELOW_TARGET"
  };
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

    // QA 모드로 생성
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

    // 비주얼 요소 생성 (complete 모드시)
    let visualElements = null;
    if (output === "complete") {
      visualElements = generateSmartVisualElements(result.script, text, styleKey);
    }

    // 줄바꿈 강화 적용
    const finalScript = applyViralLineBreaksToScript(result.script);

    // 응답 생성
    const response = {
      result: output === "complete" 
        ? { script: finalScript, ...visualElements }
        : finalScript
    };

    // 품질 점수 포함 옵션
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
