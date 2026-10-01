// 중계 서버: 브라우저 → (이 함수) → ChatKHU API Gateway
// API 키는 서버 환경 변수(CHATKHU_API_KEY)에만 있고, 브라우저로는 절대 나가지 않습니다.

const BASE = (process.env.CHATKHU_BASE_URL || "https://factchat-cloud.mindlogic.ai/v1/gateway").replace(/\/+$/, "");
const MODEL = process.env.CHATKHU_MODEL || "claude-sonnet-5-5";
const ACCESS_CODE = process.env.ACCESS_CODE || "";                  // 비워 두면 누구나 사용 가능
const HOURLY_LIMIT = Number(process.env.HOURLY_LIMIT_PER_IP || 30);  // IP당 시간당 호출 상한
const MAX_PROMPT_CHARS = 24000;
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 8000);

// 단순한 메모리 기반 호출 제한 (서버 인스턴스 단위라 완벽하진 않지만 크레딧 폭주를 막아 줍니다)
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 3600 * 1000);
  if (arr.length >= HOURLY_LIMIT) { hits.set(ip, arr); return true; }
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return false;
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 200000) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.statusCode = 405; return res.end(JSON.stringify({ error: "method" })); }

  const send = (status, obj) => { res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(obj)); };

  const key = process.env.CHATKHU_API_KEY;
  if (!key) return send(500, { error: "server_not_configured" });

  if (ACCESS_CODE && req.headers["x-access-code"] !== ACCESS_CODE) return send(401, { error: "auth" });

  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  if (limited(ip)) return send(429, { error: "rate_limited" });

  let body;
  try { body = await readBody(req); } catch (e) { return send(413, { error: "too_large" }); }
  const prompt = body && typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt) return send(400, { error: "empty_prompt" });
  if (prompt.length > MAX_PROMPT_CHARS) return send(413, { error: "too_large" });

  try {
    const r = await fetch(`${BASE}/chat/completions/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.4,
      }),
      signal: AbortSignal.timeout(110000),
    });
    if (!r.ok) {
      const detail = (await r.text().catch(() => "")).slice(0, 500);
      console.error("upstream error", r.status, detail);   // Vercel 로그에서 확인 (키는 기록되지 않음)
      return send(r.status === 429 ? 429 : 502, { error: "upstream", status: r.status });
    }
    const data = await r.json();
    let text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (Array.isArray(text)) text = text.map((p) => (typeof p === "string" ? p : p && p.text) || "").join("");
    if (!text) return send(502, { error: "empty" });
    return send(200, { text });
  } catch (e) {
    console.error("proxy failure", e && e.name, e && e.message);
    return send(504, { error: "timeout_or_network" });
  }
};
