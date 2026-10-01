// 학생 기록 저장·조회 서버 (Upstash Redis REST 사용 — 따로 설치할 패키지 없음)
//
//  save    : 학생 브라우저 → 기록 저장   (ACCESS_CODE가 설정돼 있으면 일치해야 함)
//  list    : 선생님 → 학생 목록          (TEACHER_CODE 필요)
//  get     : 선생님 → 한 학생의 기록 목록
//  session : 선생님 → 기록 하나의 전체 내용
//  delete  : 선생님 → 한 학생의 모든 기록 삭제

const ACCESS_CODE = process.env.ACCESS_CODE || "";
const TEACHER_CODE = process.env.TEACHER_CODE || "";

// Vercel에서 Upstash Redis를 연결하면 자동으로 들어오는 환경 변수 이름들을 모두 찾아 봅니다.
function pickEnv(re, notRe) {
  const k = Object.keys(process.env).find((n) => re.test(n) && !(notRe && notRe.test(n)));
  return k ? process.env[k] : "";
}
const R_URL = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || pickEnv(/_REST_API_URL$|_REST_URL$/) || "").replace(/\/+$/, "");
const R_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || pickEnv(/_REST_API_TOKEN$|_REST_TOKEN$/, /READ_ONLY/);

async function redis(cmd) {
  const r = await fetch(R_URL, { method: "POST", headers: { Authorization: `Bearer ${R_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
async function pipe(cmds) {
  const r = await fetch(`${R_URL}/pipeline`, { method: "POST", headers: { Authorization: `Bearer ${R_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(cmds) });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error("pipeline failed");
  j.forEach((x) => { if (x && x.error) throw new Error(x.error); });
  return j.map((x) => x.result);
}

const normNick = (n) => String(n || "").normalize("NFC").trim().replace(/\s+/g, " ").slice(0, 20);
const studentKey = (nick) => "tlc:student:" + nick.toLowerCase();
const sessKey = (nick, id) => "tlc:session:" + nick.toLowerCase() + ":" + id;
const SET_KEY = "tlc:students";

// 호출 제한(서버 인스턴스 단위, 완벽하진 않지만 남용을 줄여 줍니다)
const buckets = new Map();
function over(name, ip, limit) {
  const k = name + "|" + ip, now = Date.now();
  const arr = (buckets.get(k) || []).filter((t) => now - t < 3600 * 1000);
  if (arr.length >= limit) { buckets.set(k, arr); return true; }
  arr.push(now); buckets.set(k, arr);
  if (buckets.size > 5000) buckets.clear();
  return false;
}
function failed(ip) { const k = "fail|" + ip, arr = buckets.get(k) || []; arr.push(Date.now()); buckets.set(k, arr); }

function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 450000) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function summarize(s, id) {
  const mats = s.materials && typeof s.materials === "object" ? s.materials : {};
  let matLevel = null, latest = -1;
  for (const k of ["j1", "j3", "g2"]) {
    if (mats[k]) { const t = Date.parse(mats[k].createdAt) || 0; if (t >= latest) { latest = t; matLevel = k; } }
  }
  const total = s.result && Number.isFinite(Number(s.result.total)) ? Number(s.result.total) : null;
  return {
    id,
    date: String(s.date || "").slice(0, 30),
    title: String(s.title || "").slice(0, 80),
    passageLevel: String(s.passageLevel || "").slice(0, 20),
    total,
    direction: s.result ? (s.result.toG2 ? "g2" : "j1") : null,
    matLevel,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const send = (status, obj) => { res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(obj)); };
  if (req.method !== "POST") return send(405, { error: "method" });

  const ip = String(req.headers["x-forwarded-for"] || (req.socket && req.socket.remoteAddress) || "unknown").split(",")[0].trim();
  let body;
  try { body = await readBody(req); } catch (e) { return send(413, { error: "too_large" }); }
  const action = body && body.action;

  if (!R_URL || !R_TOKEN) return send(503, { error: "storage_not_configured" });

  try {
    // ---- 학생 쪽: 저장 ----
    if (action === "save") {
      if (ACCESS_CODE && req.headers["x-access-code"] !== ACCESS_CODE) return send(401, { error: "auth" });
      if (over("save", ip, 300)) return send(429, { error: "rate_limited" });
      const nickname = normNick(body.nickname);
      const grade = String(body.grade || "").slice(0, 4);
      const s = body.session;
      const id = s && String(s.id || "").replace(/[^0-9]/g, "").slice(0, 16);
      if (!nickname || !id) return send(400, { error: "bad_request" });
      const clean = {
        id, date: s.date, title: s.title, passageLevel: s.passageLevel, estimateReasonKo: s.estimateReasonKo,
        passage: s.passage, questions: s.questions, answers: s.answers, result: s.result, materials: s.materials,
      };
      const text = JSON.stringify(clean);
      if (text.length > 380000) return send(413, { error: "too_large" });

      const sk = studentKey(nickname);
      const existing = await redis(["GET", sk]);
      let st = existing ? JSON.parse(existing) : { nickname, grade, createdAt: new Date().toISOString(), sessions: [] };
      st.nickname = nickname;
      if (grade) st.grade = grade;
      st.updatedAt = new Date().toISOString();
      const all = [summarize(clean, id), ...(st.sessions || []).filter((x) => x.id !== id)].sort((a, b) => Number(b.id) - Number(a.id));
      const dropped = all.slice(20);
      st.sessions = all.slice(0, 20);
      const cmds = [["SET", sessKey(nickname, id), text], ["SET", sk, JSON.stringify(st)], ["SADD", SET_KEY, sk]];
      dropped.forEach((d) => cmds.push(["DEL", sessKey(nickname, d.id)]));
      await pipe(cmds);
      return send(200, { ok: true });
    }

    // ---- 선생님 쪽 ----
    if (["list", "get", "session", "delete"].includes(action)) {
      if (!TEACHER_CODE) return send(503, { error: "teacher_code_not_set" });
      const fails = (buckets.get("fail|" + ip) || []).filter((t) => Date.now() - t < 3600 * 1000);
      if (fails.length >= 10) return send(429, { error: "rate_limited" });
      if (req.headers["x-teacher-code"] !== TEACHER_CODE) { failed(ip); return send(401, { error: "auth" }); }

      if (action === "list") {
        const keys = (await redis(["SMEMBERS", SET_KEY])) || [];
        if (!keys.length) return send(200, { students: [] });
        const rows = (await redis(["MGET", ...keys])) || [];
        const students = rows.filter(Boolean).map((r) => JSON.parse(r)).map((st) => ({
          nickname: st.nickname, grade: st.grade, createdAt: st.createdAt, updatedAt: st.updatedAt, sessions: (st.sessions || []).slice(0, 3),
        })).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        return send(200, { students });
      }

      const nickname = normNick(body.nickname);
      if (!nickname) return send(400, { error: "bad_request" });
      const sk = studentKey(nickname);

      if (action === "get") {
        const raw = await redis(["GET", sk]);
        return send(200, { student: raw ? JSON.parse(raw) : null });
      }
      if (action === "session") {
        const id = String(body.id || "").replace(/[^0-9]/g, "").slice(0, 16);
        const raw = id ? await redis(["GET", sessKey(nickname, id)]) : null;
        return send(200, { session: raw ? JSON.parse(raw) : null });
      }
      if (action === "delete") {
        const raw = await redis(["GET", sk]);
        const st = raw ? JSON.parse(raw) : { sessions: [] };
        const cmds = (st.sessions || []).map((x) => ["DEL", sessKey(nickname, x.id)]);
        cmds.push(["DEL", sk], ["SREM", SET_KEY, sk]);
        await pipe(cmds);
        return send(200, { ok: true });
      }
    }
    return send(400, { error: "bad_action" });
  } catch (e) {
    console.error("students api error", e && e.message);
    return send(502, { error: "storage_error" });
  }
};
