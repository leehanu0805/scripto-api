// api/generate-content.js — Vercel Serverless Function (CommonJS)
// 성공: 200 { result: "..." } / 실패: 4xx~5xx { error: "..." }
// 안전판: 멀티라인 문자열은 전부 배열+join("
") 사용 (백틱/정규식/replaceAll 안 씀)

"use strict";

module.exports = async (req, res) => {
  // ---------- CORS ----------
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
    if (req.method === "OPTIONS") return res.status(204).end();
    return res.status(403).json({ error: "CORS: origin not allowed" });
  }

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // ---------- Config ----------
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const HARD_TIMEOUT_MS = Math.max(15000, Math.min(Number(process.env.HARD_TIMEOUT_MS) || 30000, 120000));
  const DEBUG_ERRORS = process.env.DEBUG_ERRORS === "1" || process.env.DEBUG_ERRORS === "true";

  if (!OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

  // ---------- Safe body parse ----------
  async function readJsonBody(req) {
    if (req.body && typeof req.body === "object") return req.body;
    if (typeof req.body === "string" && req.body.length) {
      try { return JSON.parse(req.body); } catch {}
    }
    let raw = "";
    await new Promise((resolve) => { req.on("data", (c) => (raw += c)); req.on("end", resolve); });
    try { return JSON.parse(raw || "{}"); } catch { return {}; }
  }

  const body = await readJsonBody(req);
  const { text, style, length = 45, tone = "Neutral", language = "English", ctaInclusion = false } = body || {};
  if (!text || typeof text !== "string") return res.status(400).json({ error: "`text` is required" });
  if (!style || typeof style !== "string") return res.status(400).json({ error: "`style` is required" });

  const sec = Math.max(15, Math.min(Number(length) || 45, 180));

  // ---------- Language/WPS ----------
  function normLangKey(s) {
    const L = String(s || "").trim().toLowerCase();
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

  const LKEY = normLangKey(language);
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
  const WPS = WPS_TABLE[LKEY] || 2.6;
  const wordsTarget = Math.round(sec * WPS);

  // ---------- Newline helpers (no regex) ----------
  function normalizeNewlines(s) {
    const t = String(s || "");
    let out = "";
    const NL = String.fromCharCode(10);
    for (let i = 0; i < t.length; i++) {
      const code = t.charCodeAt(i);
      if (code === 13) { // CR
        if (t.charCodeAt(i + 1) === 10) i++; // CRLF
        out += NL;
      } else {
        out += t[i];
      }
    }
    return out;
  }

  function splitLinesSafe(s) {
    const norm = normalizeNewlines(s);
    const arr = [];
    let buf = "";
    for (let i = 0; i < norm.length; i++) {
      const code = norm.charCodeAt(i);
      if (code === 10) { // 

        const trimmed = buf.trim();
        if (trimmed) arr.push(trimmed);
        buf = "";
      } else {
        buf += norm[i];
      }
    }
    if (buf.trim()) arr.push(buf.trim());
    return arr;
  }

  function stripTimePrefix(line) {
    const s = String(line || "").trim();
    if (s.length > 2 && s[0] === "[") {
      const rb = s.indexOf("]");
      if (rb > 1) return s.slice(rb + 1).trim();
    }
    return s;
  }

  function hasTag(s, tag) { return String(s).toUpperCase().indexOf(tag) >= 0; }

  function wordWeight(line, lang) {
    const txt = String(line || "").replace("[HOOK]", "").replace("[CTA]", "").trim();
    if (!txt) return 1;
    let words = 0, inWord = false, letters = 0;
    for (let i = 0; i < txt.length; i++) {
      const ch = txt[i];
      const isSpace = ch === " " || ch === "	";
      if (isSpace) { if (inWord) { words++; inWord = false; } }
      else { inWord = true; letters++; }
    }
    if (inWord) words++;
    if (words === 0) words = Math.max(1, Math.floor(letters / 2));
    return Math.max(1, words);
  }

  function clipWordsPerLine(text, lang) {
    const arr = splitLinesSafe(text);
    const out = [];
    const lower = String(lang || "").toLowerCase();
    const isKo = lower.includes("ko") || lower.includes("korean") || lower.includes("한국");
    const MAX = isKo ? 18 : 16; // rollback limits
    for (let i = 0; i < arr.length; i++) {
      const l = arr[i];
      const parts = l.split(" ").filter(Boolean);
      out.push(parts.length <= MAX ? l : parts.slice(0, MAX).join(" "));
    }
    return out.join("
");
  }

  function round1(n) { return Math.round(n * 10) / 10; }
  function to1(n) { return round1(n).toFixed(1); }

  function retimeScript(script, totalSec, lang) {
    try {
      const T = Math.max(1, round1(Number(totalSec) || 0));
      if (!script) return script;
      const raw = splitLinesSafe(script);
      if (!raw.length) return script;

      const items = raw.map(function (l) {
        const textOnly = stripTimePrefix(l);
        return { text: textOnly, isHook: hasTag(textOnly, "[HOOK]"), isCTA: hasTag(textOnly, "[CTA]") };
      });

      if (!items[0].isHook) {
        items[0].text = "[HOOK] " + items[0].text.replace("[HOOK]", "").trim();
        items[0].isHook = true;
      }

      const weights = items.map(function (it) { return Math.max(1, wordWeight(it.text, lang)); });
      var sumW = 0; for (var i = 0; i < weights.length; i++) sumW += weights[i];
      if (sumW <= 0) { for (var j = 0; j < weights.length; j++) weights[j] = 1; sumW = weights.length; }

      const durs = weights.map(function (w) { return (w / sumW) * T; });

      const hookMin = 0.10 * T, hookMax = 0.15 * T; // rollback ratios
      durs[0] = Math.min(hookMax, Math.max(hookMin, durs[0]));
      var ctaIdx = -1; for (var k = 0; k < items.length; k++) if (items[k].isCTA) { ctaIdx = k; break; }
      if (ctaIdx >= 0) durs[ctaIdx] = Math.min(durs[ctaIdx], 0.08 * T);

      const frozen = {}; frozen[0] = true; if (ctaIdx >= 0) frozen[ctaIdx] = true;
      var frozenSum = 0; for (var a = 0; a < durs.length; a++) if (frozen[a]) frozenSum += durs[a];
      var freeSum = 0; const freeIdx = []; for (var b = 0; b < durs.length; b++) if (!frozen[b]) { freeSum += durs[b]; freeIdx.push(b); }
      const remain = Math.max(0.1, T - frozenSum);
      const scale = freeSum > 0 ? (remain / freeSum) : 1.0;
      for (var c = 0; c < freeIdx.length; c++) durs[freeIdx[c]] *= scale;

      const out = [];
      var cur = 0;
      for (var m = 0; m < items.length; m++) {
        if (m === items.length - 1) {
          const start = to1(cur);
          const end = to1(T);
          out.push("[" + start + "-" + end + "] " + items[m].text);
          cur = T;
        } else {
          const start = to1(cur);
          var endNum = round1(cur + durs[m]);
          if (endNum >= T) endNum = Math.max(round1(T - 0.1), round1(cur + 0.1));
          const end = to1(endNum);
          out.push("[" + start + "-" + end + "] " + items[m].text);
          cur = endNum;
        }
      }

      return out.join("
");
    } catch (e) {
      return script;
    }
  }

  // ---------- Style examples (arrays + join) ----------
  const styleExamples = {
    meme: [
      "EXAMPLE (meme, 25s): [HOOK] POV you still edit 1-by-1",
      "setup->twist->tag. 3-5 beats. One punchline."
    ].join("
"),
    quicktip: [
      "EXAMPLE (quicktip, 30s): [HOOK] Batch film = 3x output",
      "1) Script bullets only.",
      "2) Lock exposure.",
      "3) A-roll then B-roll.",
      "[CTA] Comment \"GEAR\"."
    ].join("
"),
    challenge: [
      "EXAMPLE (challenge, 30s): [HOOK] 10 pushups every missed beat",
      "premise->rules->attempt->result. Present tense. One suspense beat."
    ].join("
"),
    storytelling: [
      "EXAMPLE (storytelling, 45s): [HOOK] Missed the midnight train",
      "incident->complication->turn->button. Vivid verbs."
    ].join("
"),
    productplug: [
      "EXAMPLE (productplug, 35s): [HOOK] Editing took me 3 hours",
      "problem->product->proof->how-to->CTA. No hype words."
    ].join("
"),
    faceless: [
      "EXAMPLE (faceless, 30s): [HOOK] Stop wasting your B-roll",
      "voiceover-only, short lines, no camera directions."
    ].join("
")
  };
  const styleKey = String(style || "").toLowerCase();
  const styleHint = styleExamples[styleKey] || "";

  // ---------- System prompt (array join) ----------
  const sys = [
    "You are a short-form video scriptwriter for TikTok/Reels/Shorts.",
    "Always write in the requested LANGUAGE. Return only the script text—no JSON/markdown/disclaimers.",
    "Keep pacing for TARGET_DURATION_SECONDS and roughly TARGET_WORDS_SOFT_CAP words.",
    "",
    "OUTPUT FORMAT (STRICT)",
    "- Total lines (including HOOK and optional CTA): 6–9 lines.",
    "- Prefix EVERY line with a time range in seconds using ONE decimal place: [start-end] (e.g., [0.0-1.2]).",
    "- First line is the hook: [0.0-H] [HOOK] (H ~ 10-15% of total duration).",
    "- Then 5–7 body lines, each with its own [start-end]; <= 16–18 words per line; one idea per line.",
    "- If CTA=Yes, end with: [C1-C2] [CTA] (one short line).",
    "- Do not include any other text, labels, or explanations.",
    "",
    "TIMING RULES",
    "- Time ranges must be contiguous and non-overlapping: next start == previous end.",
    "- The final end must be exactly TARGET_DURATION_SECONDS (match to one decimal if needed).",
    "- Suggested allocation: HOOK ~ 10–15% of total; CTA <= 8%; rest to body lines.",
    "",
    "LENGTH ALIGNMENT",
    "- Aim for TOTAL words ~ TARGET_WORDS_SOFT_CAP (+/-10%).",
    "- Distribute words roughly proportional to each segment's duration.",
    "- Shorter segments fewer words; longer segments may have more, within per-line limits.",
    "",
    "STYLE PACKS",
    "- meme: setup->twist->tag; 3-5 beats; internet slang ok.",
    "- quicktip: 3-5 numbered tips; each <= 2 lines; 1-line summary.",
    "- challenge: premise->rules->attempt->result; present tense; suspense.",
    "- storytelling: incident->complication->turn->button; vivid verbs.",
    "- productplug: problem->product->proof->how-to->CTA; no hype words.",
    "- faceless: voiceover-only; short lines; no camera directions.",
    "",
    styleHint
  ].join("
");

  // ---------- User prompt (string concat) ----------
  const user =
    "TOPIC: " + text + "
" +
    "STYLE: " + style + "
" +
    "TONE: " + tone + "
" +
    "LANGUAGE: " + language + "
" +
    "TARGET_DURATION_SECONDS: " + sec + "
" +
    "TARGET_WORDS_SOFT_CAP: " + wordsTarget + "
" +
    "CTA: " + (ctaInclusion ? "Yes" : "No") + "
" +
    "KEYWORDS (must appear >=1 time): " + (String(text).indexOf(",") >= 0 ? text : "N/A") + "

" +
    "CONSTRAINTS:
" +
    "- Mention TOPIC explicitly within first 2 lines.
" +
    "- Structure: [HOOK] -> 5–7 body lines -> optional [CTA].
" +
    "- Prefer specifics over adjectives.

" +
    "Write the final script now.";

  // ---------- OpenAI Call ----------
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + OPENAI_API_KEY },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.4,
        top_p: 0.9,
        max_tokens: 700,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user }
        ]
      }),
      signal: controller.signal
    });

    if (!r.ok) {
      const err = await r.text().catch(function () { return ""; });
      clearTimeout(timer);
      console.error("[OpenAI error]", r.status, err.slice(0, 300));
      return res.status(r.status).json({ error: "OpenAI " + r.status + ": " + err });
    }

    const data = await r.json();
    const draft = ((data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim();
    if (!draft) {
      clearTimeout(timer);
      return res.status(502).json({ error: "Empty response from model" });
    }

    const retimed = retimeScript(clipWordsPerLine(draft, language), sec, language);

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
