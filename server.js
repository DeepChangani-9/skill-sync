/* ============================================================
   Skill Sync server — dependency-free.
   - Serves the static front-end.
   - Real-time room sync over Server-Sent Events (SSE) + REST,
     so a teacher and a learner on two different devices share
     profiles, chat, whiteboard, and media live.
   No external packages, no AI/API calls.
   ============================================================ */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const ROOT = __dirname;
const PORT = process.env.PORT || 4321;
const MAX_BODY = 30 * 1024 * 1024; // 30 MB (room for base64 slides/video)
const ADMIN_PASS = process.env.ADMIN_PASS || "Deep@Admin#27"; // owner/admin passcode (only the owner has this)
const CHAT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // students/teachers see past chat for 7 days, then it auto-deletes

const TYPES = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

/* ---------- Certificates (file-backed, so they survive restarts) ---------- */
const CERTS_FILE = path.join(ROOT, "certs.json");
let certs = {};
try { certs = JSON.parse(fs.readFileSync(CERTS_FILE, "utf8")); } catch { certs = {}; }
function saveCerts() { try { fs.writeFileSync(CERTS_FILE, JSON.stringify(certs, null, 2)); } catch {} }
function newCertCode() { let c; do { c = "SS-" + Math.random().toString(36).slice(2, 8).toUpperCase(); } while (certs[c]); return c; }

/* ---------- Certificate grants: which teacher PAID & was approved for which topic ---------- */
// Taking a quiz is free (marks only). The certificate + certified badge are unlocked
// only after the teacher pays the certificate fee and the admin approves it.
const CERTGRANTS_FILE = path.join(ROOT, "certgrants.json");
let certgrants = {};
try { certgrants = JSON.parse(fs.readFileSync(CERTGRANTS_FILE, "utf8")); } catch { certgrants = {}; }
function saveCertgrants() { try { fs.writeFileSync(CERTGRANTS_FILE, JSON.stringify(certgrants, null, 2)); } catch {} }

/* ---------- Orders (file-backed) ---------- */
const ORDERS_FILE = path.join(ROOT, "orders.json");
let orders = [];
try { orders = JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8")); } catch { orders = []; }
function saveOrders() { try { fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2)); } catch {} }

/* ---------- Plan grants (which email has which plan, after approval) ---------- */
const GRANTS_FILE = path.join(ROOT, "grants.json");
let grants = {};
try { grants = JSON.parse(fs.readFileSync(GRANTS_FILE, "utf8")); } catch { grants = {}; }
function saveGrants() { try { fs.writeFileSync(GRANTS_FILE, JSON.stringify(grants, null, 2)); } catch {} }
function planFor(username) { return grants[(username || "").toLowerCase()] || "Free"; }

/* ---------- Quiz results & ratings (for the stats dashboard) ---------- */
const RESULTS_FILE = path.join(ROOT, "results.json");
let results = [];
try { results = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8")); } catch { results = []; }
function saveResults() { try { fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2)); } catch {} }

const RATINGS_FILE = path.join(ROOT, "ratings.json");
let ratings = [];
try { ratings = JSON.parse(fs.readFileSync(RATINGS_FILE, "utf8")); } catch { ratings = []; }
function saveRatings() { try { fs.writeFileSync(RATINGS_FILE, JSON.stringify(ratings, null, 2)); } catch {} }

/* ---------- User accounts (file-backed) ---------- */
const USERS_FILE = path.join(ROOT, "users.json");
let users = {};
try { users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } catch { users = {}; }
function saveUsers() { try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch {} }
function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString("hex"); }

/* ---------- Permanent chat log (admin-only, NEVER auto-deleted) ---------- */
const CHATLOG_FILE = path.join(ROOT, "chatlog.json");
let chatlog = [];
try { chatlog = JSON.parse(fs.readFileSync(CHATLOG_FILE, "utf8")); } catch { chatlog = []; }
let chatlogDirty = false;
function saveChatlog() { try { fs.writeFileSync(CHATLOG_FILE, JSON.stringify(chatlog, null, 2)); chatlogDirty = false; } catch {} }
// Throttle disk writes — chat can be frequent.
setInterval(() => { if (chatlogDirty) saveChatlog(); }, 4000);

/* ---------- Video-call log (admin-only, file-backed, never auto-deleted) ---------- */
const CALLS_FILE = path.join(ROOT, "calls.json");
let calls = [];
try { calls = JSON.parse(fs.readFileSync(CALLS_FILE, "utf8")); } catch { calls = []; }
function saveCalls() { try { fs.writeFileSync(CALLS_FILE, JSON.stringify(calls, null, 2)); } catch {} }

/* ---------- Pairings: which student chose which teacher (file-backed) ---------- */
const PAIRINGS_FILE = path.join(ROOT, "pairings.json");
let pairings = {};
try { pairings = JSON.parse(fs.readFileSync(PAIRINGS_FILE, "utf8")); } catch { pairings = {}; }
function savePairings() { try { fs.writeFileSync(PAIRINGS_FILE, JSON.stringify(pairings, null, 2)); } catch {} }
// Record/refresh a teacher<->student pairing whenever a room has both sides.
function recordPairing(code, room) {
  const t = room.profiles.teacher, l = room.profiles.learner;
  if (!t && !l) return;
  const p = pairings[code] || { room: code, firstSeen: new Date().toISOString() };
  if (t) { p.teacherName = t.name; p.teacherAccount = t.account || ""; p.topic = t.topic || ""; p.fee = t.pay ? t.pay.fee : null; p.free = !!(t.pay && t.pay.free); }
  if (l) { p.studentName = l.name; p.studentAccount = l.account || ""; p.want = l.want || ""; }
  p.lastSeen = new Date().toISOString();
  pairings[code] = p;
  savePairings();
}
// Track each account's most recent role (so admin can delete students only).
function rememberRole(profile, role) {
  const acc = (profile && profile.account || "").toLowerCase();
  if (!acc || !users[acc]) return;
  users[acc].lastRole = role;
  saveUsers();
}
function safeEq(a, b) {
  const ba = Buffer.from(a, "hex"), bb = Buffer.from(b, "hex");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/* ---------- Room state (in memory) ---------- */
const rooms = {}; // code -> { profiles, chat, strokes, media, clients:Set<res> }
function getRoom(code) {
  if (!rooms[code]) {
    rooms[code] = {
      code,
      profiles: {},                 // { teacher:{...}, learner:{...} }
      // Seed the visible chat with this room's last 7 days from the permanent log.
      chat: recentChatFor(code),    // [{id, from, name, text, t, ts}]
      seen: { teacher: 0, learner: 0 }, // how many messages each side has seen
      strokes: [],                  // whiteboard ops [{x0,y0,x1,y1,color,size,erase,cid}]
      media: { videoData: null, videoName: null, yt: null, slides: [] },
      clients: new Set(),
    };
  }
  return rooms[code];
}
// Messages for a room within the 7-day window (what students/teachers may see).
function recentChatFor(code) {
  const cut = Date.now() - CHAT_TTL_MS;
  return chatlog
    .filter(m => m.room === code && (m.ts || 0) >= cut)
    .map(m => ({ id: m.id, from: m.from, name: m.name, text: m.text, t: m.t, ts: m.ts }));
}
// Drop >7-day-old messages from a live room's visible chat (admin log keeps them).
function pruneRoomChat(room) {
  const cut = Date.now() - CHAT_TTL_MS;
  if (room.chat && room.chat.length) room.chat = room.chat.filter(m => (m.ts || 0) >= cut);
}
function ratingOf(room) {
  const a = room.ratings || [];
  return { avg: a.length ? a.reduce((s, n) => s + n, 0) / a.length : 0, count: a.length };
}
function snapshot(room) {
  return { profiles: room.profiles, chat: room.chat, strokes: room.strokes, media: room.media, seen: room.seen, rating: ratingOf(room) };
}
function broadcast(room, event, exceptRes) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of room.clients) {
    if (res === exceptRes) continue;
    try { res.write(payload); } catch { /* dropped client */ }
  }
}

/* ---------- Apply a client action to a room ---------- */
function applyAction(room, a) {
  switch (a.type) {
    case "profile":
      if (a.role) {
        room.profiles[a.role] = a.profile;
        rememberRole(a.profile, a.role);          // track teacher/student per account
        recordPairing(room.code, room);           // which student chose which teacher
        broadcast(room, { type: "profiles", profiles: room.profiles });
      }
      break;
    case "chat": {
      const msg = a.msg || {};
      if (!msg.ts) msg.ts = Date.now();           // server timestamp for 7-day retention
      room.chat.push(msg);
      pruneRoomChat(room);                        // users keep only the last 7 days
      // Permanent admin log — never auto-deleted.
      const t = room.profiles.teacher, l = room.profiles.learner;
      chatlog.push({
        room: room.code, id: msg.id, from: msg.from, name: msg.name, text: msg.text,
        account: msg.account || "", t: msg.t, ts: msg.ts,
        teacherName: t ? t.name : "", studentName: l ? l.name : "",
      });
      chatlogDirty = true;
      broadcast(room, { type: "chat", msg });
      break;
    }
    case "seen":
      if (a.role && room.seen) {
        room.seen[a.role] = Math.max(room.seen[a.role] || 0, a.count || 0);
        broadcast(room, { type: "seen", seen: room.seen });
      }
      break;
    case "stroke":
      room.strokes.push(a.op);
      if (room.strokes.length > 20000) room.strokes.splice(0, room.strokes.length - 20000);
      broadcast(room, { type: "stroke", op: a.op });
      break;
    case "clearboard":
      room.strokes = []; broadcast(room, { type: "clearboard" });
      break;
    case "media":
      room.media = a.media; broadcast(room, { type: "media", media: room.media });
      break;
    case "slides":
      room.media.slides = a.slides; broadcast(room, { type: "slides", slides: a.slides });
      break;
    case "rtc":
      // WebRTC signaling relay (offer/answer/ice/end) — sender is ignored client-side by cid.
      broadcast(room, { type: "rtc", kind: a.kind, cid: a.cid, data: a.data });
      break;
    case "call": {
      // Log a video call: which student ↔ which teacher, when it started and ended.
      const t = room.profiles.teacher, l = room.profiles.learner;
      if (a.kind === "start" && !room.activeCall) {
        const rec = {
          room: room.code,
          teacherName: t ? t.name : "", teacherAccount: t ? (t.account || "") : "",
          studentName: l ? l.name : "", studentAccount: l ? (l.account || "") : "",
          startedBy: a.by || "", startTs: Date.now(), endTs: null, durationSec: null,
        };
        calls.push(rec);
        room.activeCall = rec;     // hold a reference so "end" can close this same record
        saveCalls();
      } else if (a.kind === "end" && room.activeCall) {
        room.activeCall.endTs = Date.now();
        room.activeCall.durationSec = Math.max(0, Math.round((room.activeCall.endTs - room.activeCall.startTs) / 1000));
        room.activeCall = null;
        saveCalls();
      }
      break;
    }
    case "rate": {
      const stars = Math.max(1, Math.min(5, Number(a.stars) || 0));
      room.ratings = room.ratings || [];
      room.ratings.push(stars);
      ratings.push({ stars, ts: new Date().toISOString() }); saveRatings();
      broadcast(room, { type: "rating", rating: ratingOf(room) });
      break;
    }
  }
}

/* ---------- Helpers ---------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

/* ---------- Server ---------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const route = u.pathname;

  // --- SSE event stream for a room ---
  if (route === "/api/events" && req.method === "GET") {
    const code = (u.searchParams.get("room") || "main").toUpperCase();
    const room = getRoom(code);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "state", state: snapshot(room) })}\n\n`);
    room.clients.add(res);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25000);
    req.on("close", () => { clearInterval(ping); room.clients.delete(res); });
    return;
  }

  // --- Apply an action to a room ---
  if (route === "/api/action" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const code = (body.room || "main").toUpperCase();
      applyAction(getRoom(code), body.action || {});
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }); }
  }

  // --- Snapshot of a room (used on (re)connect) ---
  if (route === "/api/state" && req.method === "GET") {
    const code = (u.searchParams.get("room") || "main").toUpperCase();
    return json(res, 200, snapshot(getRoom(code)));
  }

  // --- Sign up (create an account) ---
  if (route === "/api/signup" && req.method === "POST") {
    try {
      const b = JSON.parse(await readBody(req));
      const username = String(b.username || "").trim().toLowerCase();
      const password = String(b.password || "");
      if (!username || password.length < 4) return json(res, 400, { ok: false, error: "Username required and password must be at least 4 characters." });
      if (users[username]) return json(res, 409, { ok: false, error: "That account already exists — try signing in." });
      const salt = crypto.randomBytes(16).toString("hex");
      const u = { name: String(b.name || username).slice(0, 60), salt, hash: hashPw(password, salt), created: new Date().toISOString() };
      // Optional security question for password recovery (no email needed).
      const q = String(b.question || "").slice(0, 120);
      const ans = String(b.answer || "").trim().toLowerCase();
      if (q && ans) { u.question = q; u.ansSalt = crypto.randomBytes(16).toString("hex"); u.ansHash = hashPw(ans, u.ansSalt); }
      users[username] = u;
      saveUsers();
      return json(res, 200, { ok: true, username, name: users[username].name, plan: planFor(username) });
    } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }); }
  }

  // --- Log in ---
  if (route === "/api/login" && req.method === "POST") {
    try {
      const b = JSON.parse(await readBody(req));
      const username = String(b.username || "").trim().toLowerCase();
      const u = users[username];
      if (!u || !safeEq(u.hash, hashPw(String(b.password || ""), u.salt)))
        return json(res, 401, { ok: false, error: "Wrong username or password." });
      return json(res, 200, { ok: true, username, name: u.name, plan: planFor(username) });
    } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }); }
  }

  // --- Forgot password: fetch the security question ---
  if (route === "/api/forgot/question" && req.method === "POST") {
    try {
      const b = JSON.parse(await readBody(req));
      const u = users[String(b.username || "").trim().toLowerCase()];
      if (u && u.question) return json(res, 200, { ok: true, question: u.question });
      return json(res, 200, { ok: false, error: "No security question is set for that account." });
    } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }); }
  }

  // --- Reset password using the security answer ---
  if (route === "/api/reset" && req.method === "POST") {
    try {
      const b = JSON.parse(await readBody(req));
      const username = String(b.username || "").trim().toLowerCase();
      const u = users[username];
      if (!u || !u.ansHash) return json(res, 400, { ok: false, error: "This account can't be reset." });
      if (!safeEq(u.ansHash, hashPw(String(b.answer || "").trim().toLowerCase(), u.ansSalt)))
        return json(res, 401, { ok: false, error: "Wrong answer to the security question." });
      const pw = String(b.password || "");
      if (pw.length < 4) return json(res, 400, { ok: false, error: "New password must be at least 4 characters." });
      u.salt = crypto.randomBytes(16).toString("hex"); u.hash = hashPw(pw, u.salt);
      saveUsers();
      return json(res, 200, { ok: true, username, name: u.name, plan: planFor(username) });
    } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }); }
  }

  // --- Place an order (buying a plan) ---
  if (route === "/api/order" && req.method === "POST") {
    try {
      const b = JSON.parse(await readBody(req));
      if (!b.plan || !b.name || !b.contact) return json(res, 400, { ok: false, error: "Name, contact and plan are required." });
      const id = "ORD-" + Math.random().toString(36).slice(2, 8).toUpperCase();
      orders.push({
        id, plan: String(b.plan).slice(0, 40), name: String(b.name).slice(0, 80),
        email: String(b.email || b.contact || "").trim().toLowerCase().slice(0, 80),
        contact: String(b.contact || b.email || "").slice(0, 80),
        status: "pending", ts: new Date().toISOString(), // UTC; shown in the viewer's local time
      });
      saveOrders();
      return json(res, 200, { ok: true, id });
    } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }); }
  }

  // --- Teacher: request a certificate after paying the certificate fee (admin approves) ---
  if (route === "/api/cert/request" && req.method === "POST") {
    try {
      const b = JSON.parse(await readBody(req));
      const account = String(b.account || "").trim().toLowerCase();
      const topic = String(b.topic || "").slice(0, 60);
      const name = String(b.name || account).slice(0, 80);
      if (!account || !topic) return json(res, 400, { ok: false, error: "Account and topic are required." });
      if (certgrants[account] && certgrants[account][topic])
        return json(res, 200, { ok: true, already: true });   // already unlocked
      // Don't pile up duplicate pending requests for the same teacher+topic.
      const dup = orders.find(o => o.kind === "cert" && o.email === account && o.topic === topic && o.status === "pending");
      if (dup) return json(res, 200, { ok: true, id: dup.id, pending: true });
      const id = "CRT-" + Math.random().toString(36).slice(2, 8).toUpperCase();
      orders.push({
        id, kind: "cert", topic, plan: "🎓 Certificate – " + topic,
        name, email: account, contact: account,
        fee: Math.round(Number(b.fee) || 0),
        status: "pending", ts: new Date().toISOString(),
      });
      saveOrders();
      return json(res, 200, { ok: true, id });
    } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }); }
  }

  // --- Which certificates has this account unlocked (paid + approved)? ---
  if (route === "/api/cert/mine" && req.method === "GET") {
    const account = String(u.searchParams.get("account") || "").trim().toLowerCase();
    const granted = certgrants[account] || {};
    const pending = orders.filter(o => o.kind === "cert" && o.email === account && o.status === "pending").map(o => o.topic);
    return json(res, 200, { ok: true, granted, pending });
  }

  // --- Owner: list all orders/inquiries (passcode-protected) ---
  if (route === "/api/orders" && req.method === "GET") {
    if ((u.searchParams.get("pass") || "") !== ADMIN_PASS) return json(res, 403, { ok: false, error: "Wrong passcode." });
    return json(res, 200, { ok: true, orders: [...orders].reverse() });
  }

  // --- Owner: approve / revoke an order (grants or removes the plan) ---
  if ((route === "/api/order/approve" || route === "/api/order/revoke") && req.method === "POST") {
    try {
      const b = JSON.parse(await readBody(req));
      if (b.pass !== ADMIN_PASS) return json(res, 403, { ok: false, error: "Wrong passcode." });
      const o = orders.find(x => x.id === b.id);
      if (!o) return json(res, 404, { ok: false, error: "Order not found." });
      if (route.endsWith("approve")) {
        o.status = "approved";
        if (o.kind === "cert") {
          // Certificate purchase approved → issue the cert and unlock it for that teacher.
          const acc = (o.email || "").toLowerCase(), topic = o.topic || "";
          if (acc && topic) {
            certgrants[acc] = certgrants[acc] || {};
            if (!certgrants[acc][topic]) {
              const code = newCertCode();
              const date = new Date().toISOString().slice(0, 10);
              certs[code] = { name: o.name || acc, topic, date, ts: new Date().toISOString() };
              certgrants[acc][topic] = { code, date };
              saveCerts();
            }
            saveCertgrants();
          }
        } else if (o.email) {
          grants[o.email] = o.plan;     // activate the plan for that account email
        }
      } else {
        o.status = "pending";
        if (o.kind === "cert") {
          const acc = (o.email || "").toLowerCase(), topic = o.topic || "";
          if (acc && certgrants[acc] && certgrants[acc][topic]) { delete certgrants[acc][topic]; saveCertgrants(); }
        } else if (o.email && grants[o.email] === o.plan) {
          delete grants[o.email];
        }
      }
      saveOrders(); saveGrants();
      return json(res, 200, { ok: true, status: o.status });
    } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }); }
  }

  // --- Owner: delete a customer (account + plan + their orders) ---
  if (route === "/api/customer/delete" && req.method === "POST") {
    try {
      const b = JSON.parse(await readBody(req));
      if (b.pass !== ADMIN_PASS) return json(res, 403, { ok: false, error: "Wrong passcode." });
      const email = String(b.email || "").trim().toLowerCase();
      if (email) {
        // Admin may delete STUDENT accounts only — never a teacher account.
        if (users[email] && users[email].lastRole === "teacher")
          return json(res, 403, { ok: false, error: "Teachers can't be deleted — students only." });
        delete users[email]; delete grants[email];
        orders = orders.filter(o => (o.email || "").toLowerCase() !== email);
        saveUsers(); saveGrants(); saveOrders();
      } else if (b.id) {
        orders = orders.filter(o => o.id !== b.id); saveOrders();   // no account on this order → just remove the row
      } else {
        return json(res, 400, { ok: false, error: "Nothing to delete." });
      }
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }); }
  }

  // --- Owner/admin: full dashboard data (passcode-protected) ---
  if (route === "/api/admin/data" && req.method === "GET") {
    if ((u.searchParams.get("pass") || "") !== ADMIN_PASS) return json(res, 403, { ok: false, error: "Wrong passcode." });

    // Certificates grouped by the name on the cert.
    const certList = Object.entries(certs).map(([code, c]) => ({ code, name: c.name, topic: c.topic, date: c.date || c.ts || "" }));

    // All accounts with full details (never the password hash).
    const userList = Object.entries(users).map(([username, x]) => ({
      username, name: x.name, created: x.created || "",
      role: x.lastRole || "—", plan: planFor(username),
      question: x.question || "", hasRecovery: !!x.ansHash,
      certs: certList.filter(c => (c.name || "").toLowerCase() === (x.name || "").toLowerCase()),
    }));
    const teachers = userList.filter(x => x.role === "teacher");
    const students = userList.filter(x => x.role === "student" || x.role === "learner");

    // Chats grouped by room (full history, never deleted) with the 7-day cutoff marked.
    const cut = Date.now() - CHAT_TTL_MS;
    const byRoom = {};
    for (const m of chatlog) {
      (byRoom[m.room] = byRoom[m.room] || []).push({
        from: m.from, name: m.name, text: m.text, t: m.t, ts: m.ts,
        expired: (m.ts || 0) < cut, // older than 7 days → hidden from users, still shown to admin
      });
    }
    const chats = Object.keys(byRoom).map(room => {
      const p = pairings[room] || {};
      return { room, teacherName: p.teacherName || "", studentName: p.studentName || "", messages: byRoom[room] };
    });

    return json(res, 200, {
      ok: true,
      counts: {
        total: userList.length, teachers: teachers.length, students: students.length,
        certs: certList.length, plans: Object.keys(grants).length, orders: orders.length,
        rooms: chats.length, calls: calls.length,
      },
      users: userList, teachers, students,
      certs: certList,
      grants: Object.entries(grants).map(([email, plan]) => ({ email, plan })),
      pairings: Object.values(pairings).sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || "")),
      orders: [...orders].reverse(),
      chats,
      calls: [...calls].reverse(),   // most recent first
    });
  }

  // --- Current plan for an account (so the app can show/refresh it) ---
  if (route === "/api/plan" && req.method === "GET") {
    return json(res, 200, { ok: true, plan: planFor(u.searchParams.get("username") || "") });
  }

  // --- Record a quiz result (for the results chart) ---
  if (route === "/api/result" && req.method === "POST") {
    try {
      const b = JSON.parse(await readBody(req));
      results.push({ topic: String(b.topic || "").slice(0, 40), score: Math.max(0, Math.min(10, Number(b.score) || 0)), pass: !!b.pass, ts: new Date().toISOString() });
      saveResults();
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }); }
  }

  // --- Aggregate stats for the dashboard charts ---
  if (route === "/api/stats" && req.method === "GET") {
    const userList = Object.values(users);
    const now = new Date();
    const days = [], signups = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      days.push(key.slice(5));                 // MM-DD
      signups.push(userList.filter(x => (x.created || "").slice(0, 10) === key).length);
    }
    const attempts = results.length;
    const passes = results.filter(r => r.pass).length;
    const avgScore = attempts ? results.reduce((s, r) => s + r.score, 0) / attempts : 0;
    const dist = Array(11).fill(0);
    results.forEach(r => { if (r.score >= 0 && r.score <= 10) dist[r.score]++; });
    const rAvg = ratings.length ? ratings.reduce((s, r) => s + r.stars, 0) / ratings.length : 0;
    return json(res, 200, {
      ok: true,
      totalUsers: userList.length,
      certified: Object.keys(grants).length,
      orders: orders.length,
      signupDays: days, signupCounts: signups,
      attempts, passes, fails: attempts - passes,
      avgScore: Math.round(avgScore * 10) / 10, dist,
      rating: { avg: Math.round(rAvg * 10) / 10, count: ratings.length },
    });
  }

  // --- Issue a certificate (returns a verifiable code) ---
  if (route === "/api/cert" && req.method === "POST") {
    try {
      const b = JSON.parse(await readBody(req));
      if (!b.name || !b.topic) return json(res, 400, { error: "name and topic required" });
      const code = newCertCode();
      certs[code] = {
        code, name: String(b.name).slice(0, 80), topic: String(b.topic).slice(0, 80),
        date: new Date().toISOString().slice(0, 10),
      };
      saveCerts();
      return json(res, 200, certs[code]);
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }

  // --- Verify a certificate by code ---
  if (route === "/api/verify" && req.method === "GET") {
    const code = (u.searchParams.get("code") || "").trim().toUpperCase();
    const c = certs[code];
    return json(res, 200, c ? Object.assign({ valid: true }, c) : { valid: false });
  }

  // --- Static files (root = landing page, /app = the application) ---
  let reqPath = route;
  if (reqPath === "/") reqPath = "/landing.html";
  else if (reqPath === "/app" || reqPath === "/app/") reqPath = "/index.html";
  let filePath = path.join(ROOT, decodeURIComponent(reqPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Skill Sync running on http://localhost:${PORT}`);
});
