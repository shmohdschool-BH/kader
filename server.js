"use strict";
/*
 * خادم قادر: يقدّم الصفحة ويربطها بواجهة Claude البرمجية.
 * بلا مكتبات خارجية. يحتاج Node 18 أو أحدث.
 * مفتاح الواجهة يبقى هنا في الخادم ولا يصل إلى المتصفح أبداً.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// قراءة ملف .env إن وُجد (بدون مكتبة)
try {
  const envFile = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  envFile.split(/\r?\n/).forEach((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  });
} catch (e) { /* لا يوجد .env، نستخدم متغيرات البيئة */ }

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const ACCESS_CODE = process.env.ACCESS_CODE || "";
const MAX_TOKENS = 2048;
const RATE_LIMIT = { max: 30, windowMs: 10 * 60 * 1000 }; // 30 طلباً لكل جهاز كل 10 دقائق
const INDEX_HTML = path.join(__dirname, "public", "index.html");

/* ---------- تعليمات قادر (تبقى في الخادم) ---------- */
const PERSONA =
  "أنت «قادر»، مساعد ذكي للطلبة والمعلمين بشخصية روبوت طالب بحريني ودود وفضولي وصبور. " +
  "اكتب بالعربية الفصحى المبسطة، ويمكنك أحياناً استخدام تحية خفيفة مثل «هلا» أو «خلّنا نفكّر سوا» دون إفراط.";
const COMMON =
  "قواعد عامة: لا تختلق مصادر أو أرقاماً أو اقتباسات، ولا تدّعِ أنك تتصفح الإنترنت. " +
  "إن لم تكن متأكداً فقل ذلك واقترح طريقة للتحقق. اجعل الإجابة منظمة ومختصرة قدر الإمكان " +
  "باستخدام عناوين قصيرة (###) وقوائم عند الحاجة، ولا تستخدم الجداول إلا للضرورة. " +
  "أجب بالعربية دائماً إلا إذا كانت المهمة ترجمة إلى لغة أخرى.";

const TASKS = {
  ask: {
    label: "اسأل قادر",
    inst: "أجب عن السؤال بوضوح وبأمثلة قريبة من حياة الطلبة، وإن كان السؤال واسعاً فاقترح كيف يمكن تضييقه.",
  },
  homework: {
    label: "شرح الواجب",
    inst: "اشرح حل الواجب خطوة بخطوة بلغة بسيطة مع ذكر القاعدة المستخدمة في كل خطوة، ثم اعرض الجواب النهائي بوضوح، وأنهِ بسؤال تدريبي مشابه قصير يجربه الطالب بنفسه.",
  },
  summarize: {
    label: "تلخيص",
    inst: "لخّص النص في: فكرة عامة بجملتين، ثم من 5 إلى 8 نقاط رئيسية، ثم 3 أسئلة للمراجعة. لا تضف معلومات غير موجودة في النص.",
  },
  translate: {
    label: "ترجمة",
    inst: "ترجم النص بين العربية والإنجليزية: إن كان النص عربياً فترجمه إلى الإنجليزية، وإلا فترجمه إلى العربية، ما لم يطلب المستخدم لغة أخرى. اعرض الترجمة أولاً، ثم اشرح من 3 إلى 5 مفردات أو تراكيب مهمة بإيجاز.",
  },
  slides: {
    label: "عرض تقديمي",
    inst: "ابنِ هيكل عرض تقديمي: عنوان العرض، ثم من 6 إلى 10 شرائح. لكل شريحة عنوان (استخدم ### للعنوان) وثلاث نقاط قصيرة وملاحظة للمتحدث بجملة واحدة وفكرة صورة أو رسم مناسب. إن لم يُذكر الصف أو عدد الشرائح فافترضهما وصرّح بذلك في سطر.",
  },
  research: {
    label: "بحث وأفكار",
    inst: "قدّم نظرة منظمة على الموضوع: تعريف مختصر، المحاور الرئيسية، أسئلة بحث مقترحة، وكلمات مفتاحية للبحث في مصادر موثوقة (مكتبات، مواقع حكومية وأكاديمية). لا تذكر مراجع أو روابط محددة إلا إذا كنت متأكداً منها، وبيّن في سطر أنك لا تتصفح الإنترنت.",
  },
  lesson: {
    label: "تحضير درس",
    inst: "حضّر خطة درس تتضمن: أهدافاً تعليمية قابلة للقياس، التمهيد، خطوات الشرح مع الزمن التقريبي لكل خطوة، نشاطاً تفاعلياً، تقويماً ختامياً، واجباً منزلياً، وأخطاء شائعة لدى الطلبة. إن لم يُذكر الصف أو المدة فافترضهما وصرّح بذلك في سطر.",
  },
  worksheet: {
    label: "ورقة عمل واختبار",
    inst: "أنشئ ورقة عمل أو اختباراً قصيراً بأسئلة متنوعة (اختيار من متعدد، صح وخطأ، إكمال، وسؤال مقالي قصير)، ثم افصل بخط واكتب مفتاح الإجابات في النهاية. إن لم يُذكر الصف أو عدد الأسئلة فافترضهما وصرّح بذلك في سطر.",
  },
};

function systemPrompt(role, task) {
  const t = TASKS[task];
  return (
    PERSONA + "\nالمستخدم الآن: " + (role === "teacher" ? "معلم" : "طالب") +
    ".\nالمهمة الحالية: " + t.label + ".\n" + t.inst + "\n" + COMMON
  );
}

/* ---------- أدوات مساعدة ---------- */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function sendJson(res, status, obj) {
  res.writeHead(status, Object.assign({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  }, SECURITY_HEADERS));
  res.end(JSON.stringify(obj));
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now > h.reset) { h = { count: 0, reset: now + RATE_LIMIT.windowMs }; hits.set(ip, h); }
  h.count += 1;
  return h.count > RATE_LIMIT.max;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of hits) if (now > h.reset) hits.delete(ip);
}, 60 * 1000).unref();

function codeOk(req) {
  if (!ACCESS_CODE) return true;
  const given = Buffer.from(String(req.headers["x-access-code"] || ""));
  const want = Buffer.from(ACCESS_CODE);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, tooBig = false;
    const chunks = [];
    req.on("data", (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > limit) { tooBig = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on("end", () => (tooBig ? reject({ status: 413, code: "too_large" }) : resolve(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", () => reject({ status: 400, code: "bad_request" }));
  });
}

async function readJson(req) {
  const raw = await readBody(req, 150 * 1024);
  try { return JSON.parse(raw); } catch (e) { throw { status: 400, code: "bad_request" }; }
}

function cleanMessages(list) {
  if (!Array.isArray(list) || !list.length || list.length > 12) throw { status: 400, code: "bad_request" };
  const out = [];
  for (const m of list) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") throw { status: 400, code: "bad_request" };
    const content = m.content.trim();
    if (!content) continue;
    if (content.length > 12000) throw { status: 413, code: "too_large" };
    out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  if (!out.length || out[out.length - 1].role !== "user") throw { status: 400, code: "bad_request" };
  return out;
}

function upstreamError(status) {
  if (status === 429) return { status: 429, code: "rate_limited" };
  if (status === 401 || status === 403) return { status: 503, code: "server_error" };
  if (status === 400 || status === 413) return { status: 400, code: "bad_request" };
  return { status: 502, code: "upstream_error" };
}

function callClaude(body, signal) {
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(Object.assign({ model: MODEL }, body)),
    signal,
  });
}

/* ---------- /api/chat : رد متدفق ---------- */
async function handleChat(req, res) {
  const body = await readJson(req);
  const role = body.role === "teacher" ? "teacher" : "student";
  const task = typeof body.task === "string" && TASKS[body.task] ? body.task : "ask";
  const messages = cleanMessages(body.messages);

  const abort = new AbortController();
  res.on("close", () => abort.abort());

  let upstream;
  try {
    upstream = await callClaude({
      max_tokens: MAX_TOKENS,
      system: systemPrompt(role, task),
      messages,
      stream: true,
    }, abort.signal);
  } catch (e) {
    if (abort.signal.aborted) return;
    throw { status: 502, code: "upstream_error" };
  }
  if (!upstream.ok) {
    console.error("Claude API error", upstream.status, (await upstream.text()).slice(0, 300));
    throw upstreamError(upstream.status);
  }

  res.writeHead(200, Object.assign({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  }, SECURITY_HEADERS));

  const send = (obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");
  const decoder = new TextDecoder("utf-8");
  let buf = "", truncated = false, failed = false;

  try {
    for await (const chunk of upstream.body) {
      buf += decoder.decode(chunk, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop();
      for (const ev of events) {
        const line = ev.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let data;
        try { data = JSON.parse(line.slice(5)); } catch (e) { continue; }
        if (data.type === "content_block_delta" && data.delta && data.delta.type === "text_delta") {
          send({ t: data.delta.text });
        } else if (data.type === "message_delta" && data.delta && data.delta.stop_reason === "max_tokens") {
          truncated = true;
        } else if (data.type === "error") {
          failed = true;
          send({ error: data.error && data.error.type === "rate_limit_error" ? "rate_limited" : "upstream_error" });
        }
      }
    }
  } catch (e) {
    if (!abort.signal.aborted && !failed) send({ error: "upstream_error" });
    failed = true;
  }
  if (!failed) send({ done: true, truncated });
  res.end();
}

/* ---------- /api/mindmap : JSON كامل ---------- */
function extractJson(text) {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [text, fence && fence[1]];
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) candidates.push(text.slice(a, b + 1));
  for (const c of candidates) {
    if (!c) continue;
    try { return JSON.parse(c); } catch (e) { /* التالي */ }
  }
  return null;
}

async function handleMap(req, res) {
  const body = await readJson(req);
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 6000) : "";
  if (!text) throw { status: 400, code: "bad_request" };
  const prompt =
    PERSONA + "\nأنشئ خريطة ذهنية بالعربية عن الموضوع أو النص التالي. أعد JSON فقط بالشكل: " +
    "{\"center\":\"عنوان قصير\",\"branches\":[{\"title\":\"فرع\",\"children\":[\"فكرة قصيرة\"]}]} . " +
    "من 4 إلى 6 فروع، وكل فرع من 2 إلى 4 أفكار، ولا يزيد أي نص عن 6 كلمات. لا تضف أي كلام خارج JSON.\n\nالموضوع أو النص:\n" + text;

  const abort = new AbortController();
  res.on("close", () => abort.abort());
  let upstream;
  try {
    upstream = await callClaude({ max_tokens: 1024, messages: [{ role: "user", content: prompt }] }, abort.signal);
  } catch (e) {
    if (abort.signal.aborted) return;
    throw { status: 502, code: "upstream_error" };
  }
  if (!upstream.ok) {
    console.error("Claude API error", upstream.status, (await upstream.text()).slice(0, 300));
    throw upstreamError(upstream.status);
  }
  const data = await upstream.json();
  const out = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const parsed = extractJson(out);
  if (!parsed) throw { status: 502, code: "invalid_json" };
  sendJson(res, 200, { data: parsed });
}

/* ---------- الخادم ---------- */
const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  try {
    if (req.method === "GET" && (url === "/" || url === "/index.html")) {
      const html = fs.readFileSync(INDEX_HTML);
      res.writeHead(200, Object.assign({ "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }, SECURITY_HEADERS));
      return res.end(html);
    }
    if (req.method === "GET" && url === "/health") return sendJson(res, 200, { ok: true });

    if (req.method === "POST" && (url === "/api/chat" || url === "/api/mindmap")) {
      if (!API_KEY) return sendJson(res, 503, { error: "server_error" });
      if (!codeOk(req)) return sendJson(res, 401, { error: "unauthorized" });
      if (limited(clientIp(req))) return sendJson(res, 429, { error: "rate_limited" });
      return url === "/api/chat" ? await handleChat(req, res) : await handleMap(req, res);
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (e) {
    const status = (e && e.status) || 500;
    const code = (e && e.code) || "upstream_error";
    if (!(e && e.status)) console.error(e);
    if (!res.headersSent) sendJson(res, status, { error: code });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log("قادر يعمل على http://localhost:" + PORT);
  if (!API_KEY) console.warn("تنبيه: ANTHROPIC_API_KEY غير مضبوط، لن تعمل المحادثة.");
});
