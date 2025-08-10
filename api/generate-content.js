// api/generate-content.js — Vercel Serverless Function (CommonJS)
// 성공: 200 { result: "..." } / 실패: 4xx~5xx { error: "..." } (풀백 없음)

"use strict";

module.exports = async (req, res) => {
  // ---------- CORS (화이트리스트) ----------
  const rawList =
    process.env.ALLOWED_ORIGINS /* "https://scripto.framer.website,https://scripto.framer.app" */ ||
    process.env.ALLOWED_ORIGIN  /* 과거 단일 키도 지원 */ ||
    "";

  const ALLOW_LIST = rawList
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(v => {
      try { return new URL(v).origin } catch { return v }
    });

  const requestOrigin = (() => {
    const o = req.headers.origin;
    if (!o) return null;
    try { return new URL(o).origin } catch { return o }
  })();

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Max-Age", "600"); // preflight 10분

  const allowAll = ALLOW_LIST.includes("*");
  const allowThis =
    allowAll ||
    (ALLOW_LIST.length === 0 && !!requestOrigin) ||
    (requestOrigin && ALLOW_LIST.includes(requestOrigin));

  if (allowAll) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (ALLOW_LIST.length === 0) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin || "*");
  } else if (allowThis && requestOrigin) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
  } else {
    if (req.method === "OPTIONS") return res.status(204).end();
    return res.status(403).json({ error: "CORS: origin not allowed" });
  }

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // ---------- Config ----------
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // 기본 미니
  const HARD_TIMEOUT_MS = Math.max(15000, Math.min(Number(process.env.HARD_TIMEOUT_MS) || 30000, 120000));
  const DEBUG_ERRORS = process.env.DEBUG_ERRORS === "1" || process.env.DEBUG_ERRORS === "true";

  if (!OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

  // ---------- Body safe-parse (문자열/빈 바디 대응) ----------
  async function readJsonBody(req) {
    if (req.body && typeof req.body === "object") return req.body;
    if (typeof req.body === "string" && req.body.length) {
      try { return JSON.parse(req.body) } catch { /* ignore */ }
    }
    let raw = "";
    await new Promise(resolve => { req.on("data", c => raw += c); req.on("end", resolve) });
    try { return JSON.parse(raw || "{}") } catch { return {} }
  }

  const body = await readJsonBody(req);
  const {
    text,
    style,
    length = 45,
    tone = "Neutral",
    language = "English",
    ctaInclusion = false,
  } = body || {};

  if (!text || typeof text !== "string") return res.status(400).json({ error: "`text` is required" });
  if (!style || typeof style !== "string") return res.status(400).json({ error: "`style` is required" });

  const sec = Math.max(15, Math.min(Number(length) || 45, 180));
  const wordsTarget = Math.round(sec * 2.2); // 1초 ≈ 2.2단어(소프트 캡)

  // ---------- 줄바꿈 정규화 (정규식/replaceAll NO) ----------
  function normalizeNewlines(s) {
    const t = String(s || "");
    let out = "";
    const NL = String.fromCharCode(10);
    for (let i = 0; i < t.length; i++) {
      const code = t.charCodeAt(i);
      if (code === 13) { // CR
        if (t.charCodeAt(i + 1) === 10) i++; // skip CRLF
        out += NL;
      } else {
        out += t[i];
      }
    }
    return out;
  }

  // ---------- 타임코드 리타이밍 유틸 (정규식 없이 안전하게) ----------
  function splitLinesSafe(s) {
    const norm = normalizeNewlines(s);
    const arr = [];
    let buf = "";
    for (let i = 0; i < norm.length; i++) {
      const ch = norm[i];
      if (ch === "\n") {
        const trimmed = buf.trim();
        if (trimmed) arr.push(trimmed);
        buf = "";
      } else {
        buf += ch;
      }
    }
    if (buf.trim()) arr.push(buf.trim());
    return arr;
  }

  function stripTimePrefix(line) {
    // "[a-b] ..." 형태면 접두부 제거 (대충한 파서: 첫 ']' 까지 버림)
    const s = String(line || "").trim();
    if (s.length > 2 && s[0] === "[") {
      const rb = s.indexOf("]");
      if (rb > 1) return s.slice(rb + 1).trim();
    }
    return s;
  }

  function isHookTag(s) { return String(s).toUpperCase().indexOf("[HOOK]") >= 0 }
  function isCtaTag(s) { return String(s).toUpperCase().indexOf("[CTA]") >= 0 }

  function wordWeight(line, lang) {
    // 아주 러프하게: 한글/영문은 공백기준, 그 외는 문자수/2 대충
    const txt = String(line || "").replace("[HOOK]", "").replace("[CTA]", "").trim();
    if (!txt) return 1;
    const lower = String(lang || "").toLowerCase();
    const isKo = lower.indexOf("ko") >= 0 || lower.indexOf("korean") >= 0 || lower.indexOf("한국") >= 0;
    if (isKo) {
      // 공백 기준 어절수
      let c = 0, inWord = false;
      for (let i = 0; i < txt.length; i++) {
        const ch = txt[i];
        if (ch === " " || ch === "\t") { if (inWord) { c++; inWord = false } }
        else inWord = true;
      }
      if (inWord) c++;
      return Math.max(1, c);
    } else {
      // 영문도 공백 기준. CJK는 대충 len/2
      let c = 0, inWord = false;
      for (let i = 0; i < txt.length; i++) {
        const ch = txt[i];
        if (ch === " " || ch === "\t") { if (inWord) { c++; inWord = false } }
        else inWord = true;
      }
      if (inWord) c++;
      if (c === 0) {
        // 공백이 거의 없으면 문자수 절반
        let letters = 0;
        for (let i = 0; i < txt.length; i++) if (txt[i] !== " " && txt[i] !== "\t") letters++;
        c = Math.max(1, Math.floor(letters / 2));
      }
      return Math.max(1, c);
    }
  }

  function clipWordsPerLine(text) {
    // 16 단어 초과 줄은 간단히 잘라줌(안전장치)
    const arr = splitLinesSafe(text);
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const l = arr[i];
      const parts = l.split(" ");
      if (parts.length <= 16) {
        out.push(l);
      } else {
        out.push(parts.slice(0, 16).join(" "));
      }
    }
    return out.join("\n");
  }

  function retimeScript(script, totalSec, lang) {
    try {
      const T = Math.max(1, Math.round(Number(totalSec) * 10) / 10); // 0.1 단위 반올림
      if (!script) return script;
      // 기존 타임코드 제거 + 라인 분해
      const rawLines = splitLinesSafe(script);
      if (!rawLines.length) return script;
      const items = rawLines.map((l) => {
        const textOnly = stripTimePrefix(l);
        return {
          text: textOnly,
          isHook: isHookTag(textOnly),
          isCTA: isCtaTag(textOnly),
        };
      });

      // 첫 줄은 무조건 HOOK 달기
      if (!items[0].isHook) {
        items[0].text = "[HOOK] " + items[0].text.replace("[HOOK]", "").trim();
        items[0].isHook = true;
      }

      // 가중치 = 대략 단어수
      const weights = items.map(it => Math.max(1, wordWeight(it.text, lang)));
      let sumW = 0; for (let i = 0; i < weights.length; i++) sumW += weights[i];
      if (sumW <= 0) { for (let i = 0; i < weights.length; i++) weights[i] = 1; sumW = weights.length; }

      // 기본 비례 할당
      const durs = weights.map(w => (w / sumW) * T);

      // HOOK/CTA 제약
      const hookMin = 0.12 * T, hookMax = 0.20 * T;
      durs[0] = Math.min(hookMax, Math.max(hookMin, durs[0]));
      let ctaIdx = -1;
      for (let i = 0; i < items.length; i++) if (items[i].isCTA) { ctaIdx = i; break; }
      if (ctaIdx >= 0) durs[ctaIdx] = Math.min(durs[ctaIdx], 0.10 * T);

      // 동결분 제외하고 나머지 재스케일 → 합계 T 맞추기
      const frozen = {};
      frozen[0] = true;
      if (ctaIdx >= 0) frozen[ctaIdx] = true;

      let frozenSum = 0;
      for (let i = 0; i < durs.length; i++) if (frozen[i]) frozenSum += durs[i];

      let freeSum = 0; const freeIdx = [];
      for (let i = 0; i < durs.length; i++) if (!frozen[i]) { freeSum += durs[i]; freeIdx.push(i); }
      const remain = Math.max(0.1, T - frozenSum);
      const scale = freeSum > 0 ? (remain / freeSum) : 1.0;
      for (let k = 0; k < freeIdx.length; k++) durs[freeIdx[k]] *= scale;

      // 연속 타임코드 빌드 (0.1 단위)
      const out = [];
      let cur = 0;
      for (let i = 0; i < items.length; i++) {
        if (i === items.length - 1) {
          const start = Math.round(cur * 10) / 10;
          const end = Math.round(T * 10) / 10;
          out.push("[" + start + "-" + end + "] " + items[i].text);
          cur = T;
        } else {
          const start = Math.round(cur * 10) / 10;
          let end = Math.round((cur + durs[i]) * 10) / 10;
          if (end >= T) end = Math.max(Math.round((T - 0.1) * 10) / 10, start + 0.1);
          out.push("[" + start + "-" + end + "] " + items[i].text);
          cur = end;
        }
      }

      return out.join("\n");
    } catch (e) {
      return script;
    }
  }

  // ---------- 스타일 힌트 ----------
  const styleExamples = {
    meme: `EXAMPLE (meme, 25s): [HOOK] POV you still edit 1-by-1
setup→twist→tag. 3–5 beats. One punchline.`,
    quicktip: `EXAMPLE (quicktip, 30s): [HOOK] Batch film = 3x output
1) Script bullets only.
2) Lock exposure.
3) A-roll then B-roll.
[CTA] Comment "GEAR".`,
    challenge: `EXAMPLE (challenge, 30s): [HOOK] 10 pushups every missed beat
premise→rules→attempt→result. Present tense. One suspense beat.`,
    storytelling: `EXAMPLE (storytelling, 45s): [HOOK] Missed the midnight train
incident→complication→turn→button. Vivid verbs.`,
    productplug: `EXAMPLE (productplug, 35s): [HOOK] Editing took me 3 hours
problem→product→proof→how-to→CTA. No hype words.`,
    faceless: `EXAMPLE (faceless, 30s): [HOOK] Stop wasting your B-roll
voiceover-only, short lines, no camera directions.`,
  };
  const styleKey = String(style || "").toLowerCase();
  const styleHint = styleExamples[styleKey] || "";

  // ---------- 프롬프트 ----------
  const sys =
`You are a short-form video scriptwriter for TikTok/Reels/Shorts.
Always write in the requested LANGUAGE. Return only the script text—no JSON/markdown/disclaimers.
Keep pacing for TARGET_DURATION_SECONDS and roughly TARGET_WORDS_SOFT_CAP words.

OUTPUT FORMAT (STRICT)
- Prefix EVERY line with a time range in seconds using ONE decimal place: [start-end] (e.g., [0.0-1.2]).
- First line is the hook: [0.0-H] [HOOK] <≤ 8 words> (H ≈ 12–20% of total duration).
- Then 3–6 body lines, each with its own [start-end]; ≤ 16 words per line; one idea per line.
- If CTA=Yes, end with: [C1-C2] [CTA] <one short line>.
- Do not include any other text, labels, or explanations.

TIMING RULES
- Time ranges must be contiguous and non-overlapping: next start == previous end.
- The final end must be exactly TARGET_DURATION_SECONDS (match to one decimal if needed).
- Suggested allocation: HOOK ≈ 12–20% of total; distribute remainder across body lines; CTA ≤ 10% if present.

LENGTH ALIGNMENT
- Keep total words near TARGET_WORDS_SOFT_CAP; distribute words roughly proportional to each segment's duration.
- Shorter segments must have fewer words; longer segments may have more words, but still ≤ 16 words per line.

STYLE PACKS
- meme: setup→twist→tag; 3–5 beats; internet slang ok.
- quicktip: 3–5 numbered tips; each ≤ 2 lines; 1-line summary.
- challenge: premise→rules→attempt→result; present tense; suspense.
- storytelling: incident→complication→turn→button; vivid verbs.
- productplug: problem→product→proof→how-to→CTA; no hype words.
- faceless: voiceover-only; short lines; no camera directions.

${styleHint}`.trim();

  const keywordsCSV = String(text).indexOf(",") >= 0 ? text : "";

  const user =
`TOPIC: ${text}
STYLE: ${style}
TONE: ${tone}
LANGUAGE: ${language}
TARGET_DURATION_SECONDS: ${sec}
TARGET_WORDS_SOFT_CAP: ${wordsTarget}
CTA: ${ctaInclusion ? "Yes" : "No"}
KEYWORDS (must appear ≥1 time): ${keywordsCSV || "N/A"}

CONSTRAINTS:
- Mention TOPIC explicitly within first 2 lines.
- Structure: [HOOK] → 3–6 body lines → optional [CTA].
- Prefer specifics over adjectives.

Write the final script now.`;

  // ---------- OpenAI Call ----------
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.4,
        top_p: 0.9,
        max_tokens: 512,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });

    if (!r.ok) {
      const err = await r.text().catch(() => "");
      clearTimeout(timer);
      console.error("[OpenAI error]", r.status, err.slice(0, 300));
      return res.status(r.status).json({ error: `OpenAI ${r.status}: ${err}` });
    }

    const data = await r.json();
    const draft = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "").trim();

    if (!draft) {
      clearTimeout(timer);
      return res.status(502).json({ error: "Empty response from model" });
    }

    // 타임코드 재배치(합계 정확히 입력 초)
    const retimed = retimeScript(clipWordsPerLine(draft), sec, language);

    clearTimeout(timer);
    return res.status(200).json({ result: retimed });
  } catch (e) {
    clearTimeout(timer);
    const msg = (e && e.stack) || (e && e.message) || String(e);
    console.error("[Server error]", msg);
    if (e && e.name === "AbortError") return res.status(504).json({ error: "Upstream timeout" });
    return res.status(500).json({ error: DEBUG_ERRORS ? String(msg) : "Server error" });
  }
};
