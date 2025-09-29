아래 두 파일을 리포 **루트**에 넣고 배포하면 됩니다.

---

## 1) `api/generate-content.js`

```javascript
"use strict";

// ============================== CORS (ES5-safe) ==============================
function setupCORS(req, res) {
  var origin = (req && req.headers && req.headers.origin) ? req.headers.origin : "";
  var allowListRaw = process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "";
  var allowList = [];
  if (allowListRaw) {
    var parts = allowListRaw.split(",");
    for (var i = 0; i < parts.length; i++) {
      var s = (parts[i] || "").trim();
      if (s) allowList.push(s);
    }
  }
  var allowAll = (allowList.length === 0) || (allowList.indexOf("*") !== -1);
  var allowed = allowAll || (origin && allowList.indexOf(origin) !== -1);
  var allowOrigin = allowed ? (origin || "*") : "*";

  try { res.setHeader("Access-Control-Allow-Origin", allowOrigin); } catch (e) {}
  try { res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); } catch (e) {}
  try { res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With"); } catch (e) {}
  try { res.setHeader("Access-Control-Max-Age", "600"); } catch (e) {}
  try { res.setHeader("Vary", "Origin"); } catch (e) {}
}

// ============================== Config ==============================
function getConfig() {
  return {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-4o-mini",
    OPENAI_BASE_URL: (process.env.OPENAI_BASE_URL && process.env.OPENAI_BASE_URL.replace(/\/+$/,'"')) ? process.env.OPENAI_BASE_URL.replace(/\/+$/,'') : "https://api.openai.com",
    HARD_TIMEOUT_MS: Math.max(15000, Math.min(Number(process.env.HARD_TIMEOUT_MS) || 30000, 120000)),
    DEBUG_ERRORS: (process.env.DEBUG_ERRORS === "1" || process.env.DEBUG_ERRORS === "true"),
    ENABLE_QUALITY_CHECK: process.env.ENABLE_QUALITY_CHECK !== "false"
  };
}

// ============================== Body Utils (ES5) ==============================
function readRawBody(req, limitBytes) {
  return new Promise(function(resolve, reject){
    var limit = limitBytes || 1000000;
    var size = 0; var raw = "";
    req.on("data", function(c){
      size += c.length;
      if (size > limit) {
        try { req.destroy(); } catch (e) {}
        var err = new Error("Payload too large");
        err.status = 413; reject(err); return;
      }
      raw += c;
    });
    req.on("end", function(){ resolve(raw); });
    req.on("error", function(err){ reject(err); });
  });
}
function isJsonRequest(req) {
  var ctype = (req.headers["content-type"] || "").toLowerCase();
  return ctype.indexOf("application/json") !== -1;
}
function sendJson(res, code, obj) {
  try { res.statusCode = code; res.setHeader("Content-Type", "application/json"); } catch (e) {}
  try { res.end(JSON.stringify(obj || {})); } catch (e) { try { res.end("{}"); } catch (e2) {} }
}

// ============================== Language Helpers ==============================
function normalizeLanguageKey(language) {
  var L0 = String(language || "").trim().toLowerCase();
  var L = L0.replace(/[_-]([a-z]{2})$/i, "");
  if (L.indexOf("korean") !== -1 || L.indexOf("한국") !== -1 || L === "ko") return "ko";
  if (L.indexOf("english") !== -1 || L === "en") return "en";
  if (L.indexOf("spanish") !== -1 || L === "es") return "es";
  if (L.indexOf("french") !== -1 || L === "fr") return "fr";
  if (L.indexOf("german") !== -1 || L === "de") return "de";
  if (L.indexOf("italian") !== -1 || L === "it") return "it";
  if (L.indexOf("portuguese") !== -1 || L === "pt") return "pt";
  if (L.indexOf("dutch") !== -1 || L === "nl") return "nl";
  if (L.indexOf("russian") !== -1 || L === "ru") return "ru";
  if (L.indexOf("japanese") !== -1 || L.indexOf("日本") !== -1 || L === "ja") return "ja";
  if (L.indexOf("chinese") !== -1 || L.indexOf("中文") !== -1 || L === "zh") return "zh";
  if (L.indexOf("arabic") !== -1 || L === "ar") return "ar";
  return "en";
}
function getWordsPerSecond(language) {
  var WPS = { en:2.3, ko:2.5, es:2.6, fr:2.4, de:2.2, it:2.4, pt:2.4, nl:2.2, ru:2.3, ja:2.8, zh:2.8, ar:2.2 };
  var key = normalizeLanguageKey(language);
  return WPS[key] || 2.3;
}

// ============================== String Helpers ==============================
function normalizeNewlines(text){
  var str = String(text || "");
  var out = ""; var LF = "\n";
  for (var i=0;i<str.length;i++){
    var code = str.charCodeAt(i);
    if (code === 13) { // CR
      if (str.charCodeAt(i+1) === 10) i++;
      out += LF;
    } else {
      out += str[i];
    }
  }
  return out;
}
function splitLines(text){
  var n = normalizeNewlines(text);
  var lines = []; var buf = "";
  for (var i=0;i<n.length;i++){
    var code = n.charCodeAt(i);
    if (code === 10){
      var t = buf.trim(); if (t) lines.push(t); buf = "";
    } else { buf += n[i]; }
  }
  if (buf.trim()) lines.push(buf.trim());
  return lines;
}
function stripTimePrefix(line){
  var text = String(line || "").trim();
  if (text.length > 2 && text[0] === "["){
    var close = text.indexOf("]");
    if (close > 1) return text.slice(close+1).trim();
  }
  return text;
}
function DEC(n){ return Math.round(n * 10) / 10; }

// ============================== Retiming & Formatting ==============================
function retimeScript(script, totalSeconds){
  try{
    var duration = Math.max(1, DEC(Number(totalSeconds) || 0));
    if (!script) return script;
    var rawLines = splitLines(script); if (!rawLines.length) return script;

    var items = [];
    for (var i=0;i<rawLines.length;i++){
      var line = rawLines[i];
      var m = line.match(/\[\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*\]/);
      var textOnly = stripTimePrefix(line);
      items.push({
        text: textOnly,
        isHook: /\[HOOK\]/i.test(textOnly),
        isCTA: /\[CTA\]/i.test(textOnly),
        hasTime: !!m
      });
    }

    if (!items[0].isHook && items[0].text){ items[0].text = "[HOOK] " + items[0].text; items[0].isHook = true; }

    var weights = [];
    for (var j=0;j<items.length;j++){
      var t = items[j].text.replace(/\[HOOK\]|\[CTA\]/gi, "").trim();
      var words = t.split(/\s+/).filter(Boolean).length;
      if (items[j].isHook) weights.push(Math.max(1, words * 0.8));
      else if (items[j].isCTA) weights.push(Math.max(1, words * 0.7));
      else weights.push(Math.max(1, words));
    }

    var totalWeight = 0; for (var k=0;k<weights.length;k++) totalWeight += weights[k];
    var durations = []; for (var k2=0;k2<weights.length;k2++) durations.push((weights[k2] / totalWeight) * duration);
    durations[0] = Math.min(4, Math.max(2, durations[0]));
    var ctaIndex = -1; for (var z=0; z<items.length; z++){ if (items[z].isCTA){ ctaIndex = z; break; } }
    if (ctaIndex >= 0){ durations[ctaIndex] = Math.min(3, Math.max(2, durations[ctaIndex])); }

    var frozen = { 0:true }; if (ctaIndex >= 0) frozen[ctaIndex] = true;
    var frozenSum = 0; for (var a in frozen){ if (frozen.hasOwnProperty(a)) frozenSum += durations[Number(a)]; }
    var targetFree = Math.max(0.1, duration - frozenSum);
    var freeSum = 0; var freeIdx = [];
    for (var q=0;q<durations.length;q++){ if (!frozen[q]){ freeSum += durations[q]; freeIdx.push(q); } }
    if (freeSum > 0){
      var scale = targetFree / freeSum;
      for (var u=0;u<freeIdx.length;u++){
        var idx = freeIdx[u];
        durations[idx] = Math.max(0.4, durations[idx] * scale);
      }
    }

    var result = []; var tcur = 0;
    for (var r=0;r<items.length;r++){
      var start = DEC(tcur);
      var end = (r === items.length - 1) ? DEC(duration) : DEC(tcur + durations[r]);
      result.push("[" + start.toFixed(1) + "-" + end.toFixed(1) + "] " + items[r].text);
      tcur = end;
    }
    return result.join("\n");
  } catch (e){ return script; }
}

function applyViralLineBreaksToScript(script){
  var lines = splitLines(script);
  var out = [];
  for (var i=0;i<lines.length;i++){
    var line = lines[i];
    var m = line.match(/^\[\s*\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*\]\s*/);
    if (!m) { out.push(line); continue; }
    var prefix = m[0];
    var text = line.slice(prefix.length);
    var withBreaks = text
      .replace(/([.!?])\s+(?=\S)/g, "$1\n\n")
      .replace(/([:;—-])\s+(?=\S)/g, "$1\n\n")
      .replace(/(\.\.\.)s*(?=\S)/g, "$1\n\n")
      .trim();
    out.push(prefix + withBreaks);
  }
  return out.join("\n");
}

// ============================== Visual Elements (optional) ==============================
function detectCategory(idea){
  var s = String(idea || "").toLowerCase();
  if (/(valorant|game|gaming|fps|league|lol|fortnite|minecraft|apex|warzone)/.test(s)) return "gaming";
  if (/(workout|exercise|gym|fitness|muscle|weight|cardio|yoga)/.test(s)) return "fitness";
  if (/(iphone|app|tech|ai|software|code|programming|gadget)/.test(s)) return "tech";
  if (/(recipe|cook|food|meal|kitchen|bake|ingredient)/.test(s)) return "cooking";
  if (/(money|invest|crypto|stock|rich|wealth|business|startup)/.test(s)) return "money";
  if (/(relationship|dating|love|breakup|crush|marriage)/.test(s)) return "relationship";
  return "general";
}
function generateSmartVisualElements(script, videoIdea, styleKey){
  try{
    var lines = splitLines(script);
    var transitions = []; var bRoll = []; var textOverlays = []; var soundEffects = [];
    var transitionTypes = {
      meme: ["Jump cut","Zoom punch","Glitch","Speed ramp","Shake"],
      quicktip: ["Number pop","Slide","Highlight","Circle zoom"],
      challenge: ["Whip pan","Crash zoom","Impact frame","Flash"],
      storytelling: ["Cross fade","Time lapse","Match cut","Reveal"],
      productplug: ["Product reveal","Comparison split","Before/after"],
      faceless: ["Text slam","Motion blur","Kinetic type"]
    };
    var styleList = transitionTypes[styleKey] || transitionTypes.faceless;

    for (var i=0;i<lines.length;i++){
      var line = lines[i];
      var m = line.match(/\[\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*\]/);
      if (!m) continue;
      var start = parseFloat(m[1]); var end = parseFloat(m[2]);
      var content = line.substring(m[0].length).trim();
      var isHook = /\[HOOK\]/i.test(content); var isCTA = /\[CTA\]/i.test(content);

      if (i > 0){ transitions.push({ time: start.toFixed(1) + "s", type: styleList[i % styleList.length], intensity: isHook ? "Maximum" : "Medium" }); }

      if (!isHook && !isCTA){
        var cat = detectCategory(videoIdea); var suggestion = "Relevant stock footage, animated graphics";
        if (cat === "gaming") suggestion = "Gameplay highlight, flick/entry POV, killfeed";
        else if (cat === "fitness") suggestion = "Exercise demo, timer overlay, set counter";
        else if (cat === "tech") suggestion = "Screen recording, feature demo, split-compare";
        else if (cat === "money") suggestion = "Chart up/down, balance overlay, ROI text";
        bRoll.push({ timeRange: start.toFixed(1) + "-" + end.toFixed(1) + "s", content: suggestion });
      }

      if (isHook){ textOverlays.push({ time: start.toFixed(1) + "s", text: (content.replace(/\[HOOK\]/i, "").trim()).toUpperCase(), style: "Bold + shake" }); }
      else if (/\d+/.test(content)){
        var numbers = content.match(/\$?\d+%?|\d+\s?(초|분|배)/g);
        if (numbers){ textOverlays.push({ time: start.toFixed(1) + "s", text: numbers[0], style: "Big number glow" }); }
      }

      if (isHook) soundEffects.push({ time: start.toFixed(1) + "s", effect: "Bass drop + whoosh" });
      else if (/stop|never|wrong/i.test(content)) soundEffects.push({ time: start.toFixed(1) + "s", effect: "Alert blip" });
      else if (isCTA) soundEffects.push({ time: start.toFixed(1) + "s", effect: "Success chime" });
    }

    return { transitions: transitions, bRoll: bRoll, textOverlays: textOverlays, soundEffects: soundEffects };
  } catch (e){ return { transitions: [], bRoll: [], textOverlays: [], soundEffects: [] }; }
}

// ============================== Prompts ==============================
function createUltraViralSystemPrompt(styleKey, tone, outputType, language, videoIdea){
  var category = detectCategory(videoIdea);
  var lang = language;
  return (
    "You are a TOP viral short-form scriptwriter.\n" +
    "Write ONLY in " + lang + "\n" +
    "Style: " + styleKey + ", Tone: " + tone + " (intense).\n" +
    "Avoid generic fluff. No \"in this video\".\n"
  );
}
function createUltraViralUserPrompt(params, improvementHints, attemptNumber){
  var text = params.text; var style = params.styleKey; var tone = params.tone; var language = params.language; var duration = params.duration; var wordsTarget = params.wordsTarget; var cta = params.ctaInclusion;
  var prompt = "Create a viral short-form video script about: " + text + "\n" +
    "Language: " + language + "\n" +
    "Duration: EXACTLY " + duration + " seconds (~" + wordsTarget + " words).\n" +
    "Use timestamps [start-end] each line. Include [HOOK] at first line" + (cta ? " and a [CTA] in the last 5 seconds." : ".") + "\n" +
    "Structure: Hook → Escalation → Fact → Proof/Story → Payoff → (optional Twist)" + (cta ? " → CTA" : "") + ".\n" +
    "Make it gaming-aware if relevant. Use concrete numbers and questions.\n\n" +
    "FORMAT EXAMPLE (fill with real lines):\n" +
    "[0.0-3.0] [HOOK] ...\n[3.0-8.0] ...\n[8.0-15.0] ...\n[15.0-22.0] ...\n[22.0-35.0] ...\n[35.0-" + duration + "] " + (cta ? "[CTA] ..." : "...") + "\n";

  if (attemptNumber && attemptNumber > 1) {
    prompt += "\nMake the hook sharper and add more concrete stats. Address skeptics.\n";
  }
  if (improvementHints && improvementHints.length){
    prompt += "\nApply these improvements strictly:\n- " + improvementHints.join("\n- ") + "\n";
  }
  prompt += "\nNow write the final script."
  return prompt;
}

function createJudgePrompt(script, params){
  var duration = params.duration; var language = params.language; var topic = params.text;
  var p = "You are a strict viral short-form SCRIPT JUDGE.\n" +
  "Judge ONLY the given script for topic '" + topic + "'.\n" +
  "Return JSON with keys: score (0-100), reasons (string), improvements (array of short bullets).\n" +
  "Consider: 1) Hook stopping power, 2) Specificity & numbers, 3) Clarity & pacing for ~" + duration + "s in " + language + ", 4) Coherence for the topic, 5) Ending/CTA effectiveness.\n" +
  "Be tough: 80+ only if it's truly strong.";
  return p + "\n\nSCRIPT:\n" + script + "\n\nReturn ONLY JSON.";
}

// ============================== OpenAI Call ==============================
async function callOpenAI(systemPrompt, userPrompt, config, signal){
  var url = (config.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/,'') + "/v1/chat/completions";
  var controller = null; var timer = null; var abortSignal = undefined;
  if (typeof AbortController !== "undefined") {
    controller = new AbortController(); abortSignal = controller.signal;
    timer = setTimeout(function(){ try{ controller.abort(); } catch (e){} }, config.HARD_TIMEOUT_MS || 30000);
  }
  try{
    var resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + config.OPENAI_API_KEY },
      body: JSON.stringify({
        model: config.OPENAI_MODEL,
        temperature: 0.9,
        top_p: 0.97,
        max_tokens: 1500,
        presence_penalty: 0.3,
        frequency_penalty: 0.3,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      }),
      signal: abortSignal
    });
    if (timer) clearTimeout(timer);
    if (!resp.ok){
      var txt = ""; try { txt = await resp.text(); } catch (e) {}
      var err = new Error("OpenAI API " + resp.status + ": " + txt.slice(0,512));
      err.status = resp.status; throw err;
    }
    var data = await resp.json();
    var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error("Empty response from OpenAI");
    return String(content).trim();
  } catch (e){
    if (timer) try { clearTimeout(timer); } catch (e2) {}
    throw e;
  }
}

async function askJudgeForScore(script, params, config){
  var system = "You evaluate scripts for virality with numeric rigor.";
  var user = createJudgePrompt(script, params);
  try{
    var out = await callOpenAI(system, user, config);
    // Extract JSON safely
    var jsonText = out;
    var m = out.match(/\{[\s\S]*\}$/);
    if (m) jsonText = m[0];
    var parsed = {};
    try { parsed = JSON.parse(jsonText); } catch (e) { parsed = {}; }
    var score = Number(parsed.score || 0);
    var improvements = parsed.improvements || [];
    if (!(improvements instanceof Array)) improvements = [];
    if (isNaN(score)) score = 0;
    return { score: score, improvements: improvements, raw: parsed, judgeText: out };
  } catch (e){
    // Judge 실패시 점수 0과 빈 개선점 (요청대로 규칙 기반은 안 씀)
    return { score: 0, improvements: ["Tighten the hook","Use concrete numbers","Add one skeptic-facing line"], raw: {}, judgeText: "" };
  }
}

// ============================== QA Loop (Judge 기반) ==============================
async function generateWithQualityAssurance(params, config){
  var enableQA = !!params.enableQA;
  var bestScript = ""; var bestScore = -1; var bestJudge = null; var bestImproves = [];
  var attempts = 3; var threshold = 80;

  var systemPrompt = createUltraViralSystemPrompt(params.styleKey, params.tone, "script", params.language, params.text);
  var improvementHints = [];

  for (var i=1;i<=attempts;i++){
    var userPrompt = createUltraViralUserPrompt(params, improvementHints, i);
    var raw = await callOpenAI(systemPrompt, userPrompt, config);
    var retimed = retimeScript(raw, params.duration);

    if (!enableQA){ bestScript = retimed; bestScore = null; bestJudge = null; break; }

    var judged = await askJudgeForScore(retimed, params, config);
    if (judged.score > bestScore){ bestScore = judged.score; bestScript = retimed; bestJudge = judged; bestImproves = judged.improvements; }
    if (judged.score >= threshold) break; // good enough

    // prepare next attempt hints
    improvementHints = judged.improvements || [];
    if (!improvementHints.length){ improvementHints = ["Sharpen the first 3 words","Add 2 precise numbers","Pose 1 direct question to the viewer","Avoid generic phrasing"]; }
  }

  return {
    script: bestScript,
    qualityScore: bestScore,
    judge: bestJudge,
    attempts: (bestScore === null ? 1 : Math.min(attempts, (bestScore>=threshold? (improvementHints.length?2:1):attempts)))
  };
}

// ============================== Input Validation ==============================
function validateInputs(body){
  var text = body.text; var style = body.style; var length = body.length; var tone = body.tone || "Casual"; var language = body.language || "Korean"; var ctaInclusion = !!body.ctaInclusion; var outputType = String(body.outputType || "script").toLowerCase();
  if (!text || typeof text !== "string" || text.trim().length < 3){ var e = new Error("`text` is required and must be a string with length ≥ 3"); e.status = 400; throw e; }
  var allowedStyles = ["meme","quicktip","challenge","storytelling","productplug","faceless"]; var styleKey = String(style || "faceless").toLowerCase(); if (allowedStyles.indexOf(styleKey) === -1) styleKey = "faceless";
  var dur = Math.max(15, Math.min(Number(length) || 45, 180));
  return { styleKey: styleKey, duration: dur, tone: tone, language: language, ctaInclusion: ctaInclusion, output: outputType };
}

// ============================== Main Handler ==============================
module.exports = async function(req, res){
  setupCORS(req, res);
  if (req.method === "OPTIONS") { res.statusCode = 200; res.end(); return; }
  if (req.method !== "POST") { sendJson(res, 405, { error: "Method Not Allowed", hint: "POST only" }); return; }

  var config = getConfig();
  if (!config.OPENAI_API_KEY){ sendJson(res, 500, { error: "Missing OPENAI_API_KEY" }); return; }

  var body = {};
  try {
    if (req.body && typeof req.body === "object") {
      body = req.body;
    } else if (isJsonRequest(req)) {
      var raw = await readRawBody(req, 5000000);
      body = raw ? JSON.parse(raw) : {};
    } else { body = {}; }
  } catch (e){ sendJson(res, 400, { error: "Invalid JSON" }); return; }

  try{
    var text = body.text, style = body.style, length = body.length, tone = body.tone || "Casual", language = body.language || "Korean", ctaInclusion = !!body.ctaInclusion, outputType = String(body.outputType || "script").toLowerCase(), enableQualityCheck = (body.enableQualityCheck !== false), includeQualityScore = !!body.includeQualityScore;

    var v = validateInputs({ text: text, style: style, length: length, tone: tone, language: language, ctaInclusion: ctaInclusion, outputType: outputType });

    var wps = getWordsPerSecond(v.language);
    var wordsTarget = Math.round(v.duration * wps);

    var qa = await generateWithQualityAssurance({
      text: text,
      styleKey: v.styleKey,
      tone: v.tone,
      language: v.language,
      duration: v.duration,
      wordsTarget: wordsTarget,
      ctaInclusion: v.ctaInclusion,
      enableQA: (config.ENABLE_QUALITY_CHECK && enableQualityCheck)
    }, config);

    var finalScript = applyViralLineBreaksToScript(qa.script);
    var payload = null;
    if (v.output === "complete"){
      var visuals = generateSmartVisualElements(finalScript, text, v.styleKey);
      payload = { script: finalScript, transitions: visuals.transitions, bRoll: visuals.bRoll, textOverlays: visuals.textOverlays, soundEffects: visuals.soundEffects };
    } else { payload = finalScript; }

    var out = { result: payload };
    if (includeQualityScore && qa.qualityScore !== null){
      out.quality = {
        score: qa.qualityScore,
        judge: (qa.judge && qa.judge.raw) ? qa.judge.raw : null,
        attempts: qa.attempts
      };
    }

    sendJson(res, 200, out);
  } catch (error){
    var msg = String(error && error.message || "Internal server error");
    if (config.DEBUG_ERRORS) sendJson(res, error.status || 500, { error: msg });
    else sendJson(res, error.status || 500, { error: "Internal server error" });
  }
};
```

---

## 2) `vercel.json` (루트)

```json
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
```

---

### 환경변수 (Vercel → Project → Settings → Environment Variables)

* `OPENAI_API_KEY` (필수)
* 선택: `ALLOWED_ORIGINS` = `https://project-hfc6crh0lxwhh8qfu7tz.framercanvas.com`

### 붙었는지 빠른 검증

```bash
# 프리플라이트 (헤더 보이면 CORS 통과)
curl -i -X OPTIONS "https://<YOUR_DOMAIN>/api/generate-content" \
  -H "Origin: https://project-hfc6crh0lxwhh8qfu7tz.framercanvas.com" \
  -H "Access-Control-Request-Method: POST"

# 실제 POST
curl -i -X POST "https://<YOUR_DOMAIN>/api/generate-content" \
  -H "Content-Type: application/json" \
  --data '{"text":"발로란트 제트 엔트리","style":"faceless","length":45,"language":"Korean","ctaInclusion":true,"includeQualityScore":true}'
```
