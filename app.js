/* ============================================================
   Skill Sync — networked client
   Two people join the same ROOM CODE (on any device) and share
   profiles, chat, whiteboard, video & slides live via the server.
   Certification quiz, dark mode, and PNG certificates included.
   No external APIs.
   ============================================================ */

/* ---------- Tiny helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const other = (role) => (role === "teacher" ? "learner" : "teacher");
const fileToDataURL = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
const now = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const randomRoom = () => "ROOM-" + Math.random().toString(36).slice(2, 6).toUpperCase();
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), 2800);
}

/* ---------- Session + networking state ---------- */
const CID = Math.random().toString(36).slice(2); // for whiteboard echo de-dup
const SESSION_KEY = "skillsync_session";
let net = { room: null, role: null, es: null, connected: false };
let myProfile = null;
let mirror = { profiles: {}, chat: [], media: { videoData: null, videoName: null, yt: null, slides: [] }, seen: {}, rating: { avg: 0, count: 0 } };
let _prog = null;
let pendingRole = null, pendingPhoto = null, pendingQR = null;
let planPollId = null;

/* ---------- Certificate fee (teacher pays the platform to unlock cert + badge) ---------- */
const CERT_FEE = 199;                 // fixed certificate fee in ₹ — change here if needed
let certGrants = {};                  // { topic: {code, date} } — paid + admin-approved (unlocked)
let certPending = [];                 // [topic] — paid, waiting for admin approval
async function refreshCertGrants() {
  if (!isAuthed()) return;
  try {
    const r = await fetch("/api/cert/mine?account=" + encodeURIComponent(auth.username));
    const d = await r.json();
    if (!d.ok) return;
    certGrants = d.granted || {}; certPending = d.pending || [];
    if (myProfile) {                  // partner only sees the badge once it's actually unlocked
      myProfile.certifiedTopics = Object.keys(certGrants);
      pushProfile();
    }
    renderMyCerts(); renderQuiz(); renderProfiles();
  } catch {}
}

/* ---------- Auth (server-backed accounts) ---------- */
const AUTH_KEY = "skillsync_auth";
let auth = null;
try { auth = JSON.parse(localStorage.getItem(AUTH_KEY)); } catch {}
function isAuthed() { return !!(auth && auth.username); }

// What each plan unlocks. Free is limited; approved paid plans unlock everything.
const PLAN_FEATURES = {
  "Free":      { topics: 1,  branded: true },
  "Tutor Pro": { topics: 99, branded: false },
  "Centre":    { topics: 99, branded: false },
  "Institute": { topics: 99, branded: false },
};
function planFeat() { return PLAN_FEATURES[(auth && auth.plan) || "Free"] || PLAN_FEATURES.Free; }

function me() { return myProfile || mirror.profiles[net.role]; }

/* ---------- Server actions ---------- */
function action(a) {
  fetch("/api/action", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room: net.room, action: a }),
  }).catch(() => toast("Network error — change not synced."));
}
function pushProfile() {
  if (myProfile) action({ type: "profile", role: net.role, profile: myProfile });
}

function connect() {
  if (net.es) net.es.close();
  const es = new EventSource(`/api/events?room=${encodeURIComponent(net.room)}`);
  net.es = es;
  es.onopen = () => { net.connected = true; updateConn(); };
  es.onerror = () => { net.connected = false; updateConn(); };
  es.onmessage = (e) => { try { handleEvent(JSON.parse(e.data)); } catch {} };
}
function updateConn() {
  const dot = $("#connDot");
  if (dot) dot.className = "conn-dot " + (net.connected ? "on" : "off");
}

function handleEvent(ev) {
  switch (ev.type) {
    case "state": applyState(ev.state); break;
    case "profiles":
      mirror.profiles = ev.profiles || {};
      if (myProfile) mirror.profiles[net.role] = myProfile; // keep my own card stable
      renderWhoami(); renderProfiles(); renderClassroom(); renderQuiz(); renderChat();
      break;
    case "chat":
      if (!ev.msg.id || !mirror.chat.some(m => m.id === ev.msg.id)) mirror.chat.push(ev.msg);
      renderChat();
      // If the other person messaged and I'm looking at the chat, mark it seen.
      if (ev.msg.from !== net.role && $("#tab-chat").classList.contains("active")) markSeen();
      break;
    case "seen": mirror.seen = ev.seen || {}; renderChat(); break;
    case "rating": mirror.rating = ev.rating || mirror.rating; renderClassroom(); break;
    case "stroke": if (ev.op.cid !== CID) drawOp(ev.op); break;
    case "clearboard": clearCanvas(); break;
    case "media": mirror.media = ev.media || mirror.media; renderMedia(); break;
    case "slides": mirror.media.slides = ev.slides || []; renderSlides(); break;
    case "rtc":
      if (ev.cid === CID) break; // ignore my own relayed signal
      if (ev.kind === "offer") rtcOnOffer(ev.data);
      else if (ev.kind === "answer") rtcOnAnswer(ev.data);
      else if (ev.kind === "ice") rtcOnIce(ev.data);
      else if (ev.kind === "end") rtcEnd(true);
      break;
  }
}

/* ============================================================
   LIVE VIDEO CALL (WebRTC over the room's signaling channel)
   ============================================================ */
const RTC_CFG = { iceServers: [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
] };
let pc = null, localStream = null, callActive = false;

async function getLocalStream() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  const lv = $("#localVid"); if (lv) lv.srcObject = localStream;
  return localStream;
}
function makePC() {
  pc = new RTCPeerConnection(RTC_CFG);
  pc.onicecandidate = (e) => { if (e.candidate) action({ type: "rtc", kind: "ice", cid: CID, data: e.candidate }); };
  pc.ontrack = (e) => {
    const rv = $("#remoteVid"); if (rv) rv.srcObject = e.streams[0];
    setCallBadge("Connected", "ok");
  };
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    const st = pc.connectionState;
    if (st === "connected") setCallBadge("Connected", "ok");
    else if (st === "connecting") setCallBadge("Connecting…", "");
    else if (["failed", "disconnected"].includes(st)) setCallBadge("Connection lost", "bad");
  };
  return pc;
}
function setCallBadge(txt, cls) {
  const b = $("#vpBadge"); if (!b) return;
  b.textContent = txt; b.className = "vp-badge" + (cls ? " " + cls : "");
}
function showCallUI(on) {
  callActive = on;
  const stage = $("#vpStage"); if (stage) stage.classList.toggle("live", on);
  const s = $("#callStart"); if (s) s.classList.toggle("hidden", on);
  ["callMute", "callCam", "callEnd"].forEach(id => { const el = $("#" + id); if (el) el.classList.toggle("hidden", !on); });
}
async function callStart() {
  try {
    await getLocalStream();
  } catch { toast("Couldn't access camera/mic. Allow permission and use an https or localhost link."); return; }
  makePC();
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  showCallUI(true); setCallBadge("Calling…", "");
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  action({ type: "rtc", kind: "offer", cid: CID, data: offer });
  action({ type: "call", kind: "start", by: net.role });   // log the call for admin
}
async function rtcOnOffer(offer) {
  try {
    await getLocalStream();
  } catch { toast("Incoming call — but camera/mic is blocked."); return; }
  if (!pc) makePC();
  localStream.getTracks().forEach(t => { if (!pc.getSenders().some(se => se.track === t)) pc.addTrack(t, localStream); });
  showCallUI(true); setCallBadge("Incoming call…", "");
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const ans = await pc.createAnswer();
  await pc.setLocalDescription(ans);
  action({ type: "rtc", kind: "answer", cid: CID, data: ans });
}
async function rtcOnAnswer(ans) {
  if (pc && !pc.currentRemoteDescription) await pc.setRemoteDescription(new RTCSessionDescription(ans));
}
async function rtcOnIce(c) { try { if (pc) await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {} }
function rtcEnd(remote) {
  if (pc) { try { pc.close(); } catch {} pc = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  const rv = $("#remoteVid"); if (rv) rv.srcObject = null;
  const lv = $("#localVid"); if (lv) lv.srcObject = null;
  showCallUI(false);
  if (!remote) { action({ type: "rtc", kind: "end", cid: CID }); action({ type: "call", kind: "end" }); }
  else toast("Call ended.");
}
function wireCallControls() {
  const s = $("#callStart"); if (s && !s._w) { s._w = 1; s.addEventListener("click", callStart); }
  const e = $("#callEnd"); if (e && !e._w) { e._w = 1; e.addEventListener("click", () => rtcEnd(false)); }
  const m = $("#callMute"); if (m && !m._w) { m._w = 1; m.addEventListener("click", () => {
    if (!localStream) return; const a = localStream.getAudioTracks()[0];
    if (a) { a.enabled = !a.enabled; m.textContent = a.enabled ? "🎤 Mute" : "🔇 Unmute"; }
  }); }
  const c = $("#callCam"); if (c && !c._w) { c._w = 1; c.addEventListener("click", () => {
    if (!localStream) return; const v = localStream.getVideoTracks()[0];
    if (v) { v.enabled = !v.enabled; c.textContent = v.enabled ? "📷 Camera off" : "📷 Camera on"; }
  }); }
}
function applyState(s) {
  mirror.profiles = s.profiles || {};
  if (myProfile) mirror.profiles[net.role] = myProfile;
  mirror.chat = s.chat || [];
  mirror.seen = s.seen || {};
  mirror.rating = s.rating || { avg: 0, count: 0 };
  mirror.media = s.media || { videoData: null, videoName: null, yt: null, slides: [] };
  clearCanvas();
  (s.strokes || []).forEach(drawOp);
  renderAll();
}

/* ============================================================
   ONBOARDING
   ============================================================ */
// Default suggested course fee (₹) per topic — varies by topic. Teacher can change it.
const DEFAULT_FEES = {
  "Python": 999,
  "JavaScript": 999,
  "Web Basics (HTML & CSS)": 799,
  "General Knowledge": 499,
  "AI / ML": 1499,
  "Cyber Security / Ethical Hacking": 1499,
};
function defaultFeeFor(topic) { return DEFAULT_FEES[topic] || 599; }

function populateTopicSelects() {
  const topics = Object.keys(QUESTION_BANK);
  ["#topicInput", "#wantInput"].forEach(sel => {
    const el = $(sel);
    if (el) el.innerHTML = topics.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  });
}

// Auto-fill the suggested fee whenever the teacher picks a topic.
function syncTopicFee() {
  const topic = $("#topicInput") && $("#topicInput").value;
  const fee = $("#feeInput"), hint = $("#feeHint");
  if (!topic || !fee) return;
  const def = defaultFeeFor(topic);
  fee.value = def;                                   // default charge per course
  if (hint) hint.textContent = `Suggested for ${topic}: ₹${def} — you can change it.`;
}
// Free-course toggle: hide payout details and clear the fee when "no charge" is chosen.
function syncFreeCourse() {
  const free = $("#freeCourse") && $("#freeCourse").checked;
  const details = $("#payDetails");
  if (details) details.classList.toggle("hidden", !!free);
}
{
  const ti = $("#topicInput"); if (ti) ti.addEventListener("change", syncTopicFee);
  const fc = $("#freeCourse"); if (fc) fc.addEventListener("change", syncFreeCourse);
}

$("#genRoom").addEventListener("click", () => { $("#roomInput").value = randomRoom(); });

$$(".role-btn").forEach(btn => btn.addEventListener("click", () => {
  pendingRole = btn.dataset.role;
  $$(".role-btn").forEach(b => b.classList.toggle("sel", b === btn));
  // Sign in / sign up is compulsory before the profile form.
  if (isAuthed()) showProfileForm();
  else { $("#profileForm").classList.add("hidden"); $("#authBlock").classList.remove("hidden"); $("#authMsg").textContent = ""; }
}));

function showProfileForm() {
  $("#authBlock").classList.add("hidden");
  $("#profileForm").classList.remove("hidden");
  $("#teacherFields").classList.toggle("hidden", pendingRole !== "teacher");
  $("#learnerFields").classList.toggle("hidden", pendingRole !== "learner");
  if (pendingRole === "teacher") { syncTopicFee(); syncFreeCourse(); }
  if (!$("#roomInput").value) $("#roomInput").value = randomRoom();
  if (!$("#nameInput").value && auth) $("#nameInput").value = auth.name || "";
  $("#signedInAs").textContent = auth ? `Signed in as ${auth.name || auth.username}` : "";
}

// Auth tab toggle (Sign in vs Sign up)
$$(".auth-tab").forEach(t => t.addEventListener("click", () => {
  $$(".auth-tab").forEach(x => x.classList.toggle("active", x === t));
  const signup = t.dataset.auth === "signup";
  $("#authNameWrap").classList.toggle("hidden", !signup);
  $("#authSecWrap").classList.toggle("hidden", !signup);
  $("#forgotLink").style.display = signup ? "none" : "";
  $("#authSubmit").textContent = signup ? "Create account" : "Sign in";
  $("#authMsg").textContent = "";
}));

// Auth submit
$("#authSubmit").addEventListener("click", async () => {
  const mode = ($(".auth-tab.active") || {}).dataset.auth || "login";
  const username = $("#authUser").value.trim().toLowerCase();
  const password = $("#authPass").value;
  const msg = $("#authMsg"); msg.className = "auth-msg"; msg.textContent = "";
  if (!username || !password) { msg.textContent = "Enter your username and password."; return; }
  if (mode === "signup" && !$("#authAnswer").value.trim()) { msg.textContent = "Please answer the security question (needed to reset your password)."; return; }
  const body = mode === "signup"
    ? { username, password, name: $("#authName").value.trim() || username, question: $("#authQuestion").value, answer: $("#authAnswer").value }
    : { username, password };
  $("#authSubmit").disabled = true;
  try {
    const res = await fetch("/api/" + (mode === "signup" ? "signup" : "login"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await res.json();
    if (!d.ok) { msg.textContent = d.error || "Could not sign in."; return; }
    auth = { username: d.username, name: d.name, plan: d.plan || "Free" };
    localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
    $("#logoutBtn").style.display = "";
    showProfileForm();
  } catch { msg.textContent = "Network error — is the server running?"; }
  finally { $("#authSubmit").disabled = false; }
});

// Forgot password — show the reset panel
$("#forgotLink").addEventListener("click", (e) => {
  e.preventDefault();
  $("#resetUser").value = $("#authUser").value.trim();
  $("#authMain").classList.add("hidden");
  $(".auth-tabs").classList.add("hidden");
  $("#resetStep2").classList.add("hidden");
  $("#resetMsg").className = "auth-msg"; $("#resetMsg").textContent = "";
  $("#resetBlock").classList.remove("hidden");
});
$("#backToLogin").addEventListener("click", (e) => {
  e.preventDefault();
  $("#resetBlock").classList.add("hidden");
  $(".auth-tabs").classList.remove("hidden");
  $("#authMain").classList.remove("hidden");
});
// Step 1: fetch the security question
$("#resetNext").addEventListener("click", async () => {
  const username = $("#resetUser").value.trim().toLowerCase();
  const msg = $("#resetMsg"); msg.className = "auth-msg"; msg.textContent = "";
  if (!username) { msg.textContent = "Enter your username."; return; }
  try {
    const res = await fetch("/api/forgot/question", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username }) });
    const d = await res.json();
    if (!d.ok) { msg.textContent = d.error || "Account not found."; $("#resetStep2").classList.add("hidden"); return; }
    $("#resetQ").textContent = "Security question: " + d.question;
    $("#resetStep2").classList.remove("hidden");
  } catch { msg.textContent = "Network error."; }
});
// Step 2: verify answer + set new password (auto signs you in)
$("#resetSubmit").addEventListener("click", async () => {
  const username = $("#resetUser").value.trim().toLowerCase();
  const answer = $("#resetAnswer").value;
  const password = $("#resetNewPass").value;
  const msg = $("#resetMsg"); msg.className = "auth-msg"; msg.textContent = "";
  if (!answer || !password) { msg.textContent = "Fill in your answer and a new password."; return; }
  try {
    const res = await fetch("/api/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, answer, password }) });
    const d = await res.json();
    if (!d.ok) { msg.textContent = d.error || "Could not reset."; return; }
    auth = { username: d.username, name: d.name, plan: d.plan || "Free" };
    localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
    $("#logoutBtn").style.display = "";
    $("#resetBlock").classList.add("hidden");
    $(".auth-tabs").classList.remove("hidden");
    $("#authMain").classList.remove("hidden");
    showProfileForm();
    toast("Password reset — you're signed in.");
  } catch { msg.textContent = "Network error."; }
});

// Log out (clears account + session)
$("#logoutBtn").addEventListener("click", () => {
  localStorage.removeItem(AUTH_KEY);
  localStorage.removeItem(SESSION_KEY);
  if (net.es) net.es.close();
  location.reload();
});

$("#photoInput").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  pendingPhoto = await fileToDataURL(f);
  $("#avatarPreview").innerHTML = `<img src="${pendingPhoto}" alt="me" />`;
});

$("#qrInput").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  pendingQR = await fileToDataURL(f);
  const img = $("#qrPreview");
  if (img) { img.src = pendingQR; img.classList.remove("hidden"); }
});

$("#profileForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const room = ($("#roomInput").value || "").trim().toUpperCase();
  if (!room) return toast("Enter or generate a room code.");
  if (!pendingRole) return toast("Choose teacher or learner.");
  const name = $("#nameInput").value.trim();
  if (!name) return toast("Please enter your name.");

  const profile = { role: pendingRole, name, bio: $("#bioInput").value.trim(), photo: pendingPhoto, certifiedTopics: [], account: (auth && auth.username) || "" };
  if (pendingRole === "teacher") {
    profile.topic = $("#topicInput").value;
    profile.topicDesc = $("#topicDescInput").value.trim();
    profile.notes = $("#notesInput").value.trim();
    if (!($("#certFeeAck") && $("#certFeeAck").checked)) return toast("Please tick the certificate-fee acknowledgement to continue.");
    const free = $("#freeCourse") && $("#freeCourse").checked;
    if (free) {
      // Free course — no charge, no payout details needed.
      profile.pay = { fee: 0, free: true };
    } else {
      // Compulsory payout details — this is where students pay the teacher.
      const fee = Math.round(parseFloat($("#feeInput").value) || 0);
      const upi = $("#upiInput").value.trim();
      const bankName = $("#bankNameInput").value.trim();
      const bankAcc = $("#bankAccInput").value.trim();
      const bankIfsc = $("#bankIfscInput").value.trim().toUpperCase();
      if (!(fee > 0)) return toast("Enter the course fee you charge (₹), or tick “free course”.");
      if (!/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(upi)) return toast("Enter a valid UPI ID (e.g. yourname@okaxis).");
      if (!bankName) return toast("Enter the account holder name.");
      if (!/^\d{6,18}$/.test(bankAcc)) return toast("Enter a valid bank account number.");
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(bankIfsc)) return toast("Enter a valid IFSC code (e.g. SBIN0001234).");
      if (!pendingQR) return toast("Upload your payment QR code image.");
      profile.pay = { fee, upi, bankName, bankAcc, bankIfsc, qr: pendingQR };
    }
  } else {
    profile.want = $("#wantInput").value;
    profile.goal = $("#goalInput").value.trim();
  }

  net.room = room; net.role = pendingRole; myProfile = profile; _prog = null;
  localStorage.setItem(SESSION_KEY, JSON.stringify({ room, role: net.role, profile }));
  // carry over any prior certifications stored locally for this room+role
  myProfile.certifiedTopics = getProgress().certifiedTopics || [];

  connect();
  pushProfile();
  enterApp();
  toast(`Joined ${room} as ${name.split(" ")[0]}`);
});

/* ============================================================
   APP SHELL
   ============================================================ */
function enterApp() {
  $("#onboard").classList.add("hidden");
  if (window.stopBgfx) window.stopBgfx();   // stop landing animation
  $("#app").classList.remove("hidden");
  $("#roomCodeShow").textContent = net.room;
  applyRoleGating();
  wireCallControls();
  renderAll();
  refreshPlan(); // pick up a plan approved after the user logged in (once, on entry)
  refreshCertGrants(); // pick up any certificates the admin has approved
}

// Quiz + certificates are TEACHER-ONLY. Hide them for learners.
function applyRoleGating() {
  const isTeacher = net.role === "teacher";
  const quizTab = $('.tabs .tab[data-tab="quiz"]');
  if (quizTab) quizTab.classList.toggle("hidden", !isTeacher);
  const quizBn = $('.bottom-nav [data-tab="quiz"]');
  if (quizBn) quizBn.classList.toggle("hidden", !isTeacher);
  const certsCard = $("#certsCard");
  if (certsCard) certsCard.classList.toggle("hidden", !isTeacher);
  const quizQa = $('.qa-card[data-goto="quiz"]');
  if (quizQa) quizQa.classList.toggle("hidden", !isTeacher);
  // "Find Teachers" is for students only — teachers don't browse teachers.
  const teachersTab = $('.tabs .tab[data-tab="teachers"]');
  if (teachersTab) teachersTab.classList.toggle("hidden", isTeacher);
  const teachersBn = $('.bottom-nav [data-tab="teachers"]');
  if (teachersBn) teachersBn.classList.toggle("hidden", isTeacher);
}

$$(".tab").forEach(tab => tab.addEventListener("click", () => {
  $$(".tab").forEach(t => t.classList.toggle("active", t === tab));
  $$(".panel").forEach(p => p.classList.remove("active"));
  $("#tab-" + tab.dataset.tab).classList.add("active");
  if (tab.dataset.tab === "chat") markSeen();   // opening chat marks messages seen
  if (tab.dataset.tab === "profile") renderProfiles(); // show current certificates
  if (tab.dataset.tab === "home") renderStats(); // refresh dashboard
  if (tab.dataset.tab === "teachers") renderTeachers(); // load the teacher directory
  if (tab.dataset.tab === "quiz" || tab.dataset.tab === "home") { refreshPlan(); refreshCertGrants(); } // check for just-approved plan/certificate
  syncBottomNav(tab.dataset.tab);
}));

// --- Mobile bottom navigation ---
function syncBottomNav(name) {
  $$(".bottom-nav > [data-tab]").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  const primary = ["home", "classroom", "whiteboard", "quiz"];
  const more = $("#bnMore"); if (more) more.classList.toggle("active", !primary.includes(name));
}
$$(".bottom-nav [data-tab]").forEach(b => b.addEventListener("click", () => {
  const t = $(`.tabs .tab[data-tab="${b.dataset.tab}"]`); if (t) t.click();
  $("#bnMenu").classList.add("hidden");
}));
$("#bnMore").addEventListener("click", (e) => { e.stopPropagation(); $("#bnMenu").classList.toggle("hidden"); });
document.addEventListener("click", () => $("#bnMenu").classList.add("hidden"));

// --- Lite (performance) mode ---
function applyLite(on) {
  document.documentElement.classList.toggle("lite", on);
  localStorage.setItem("skillsync_lite", on ? "1" : "0");
  const btn = $("#liteToggle");
  if (btn) { btn.textContent = on ? "✨" : "⚡"; btn.title = on ? "Effects off (lite mode)" : "Effects on"; }
  if (on) { if (window.stopBgfx) window.stopBgfx(); }
  else if (window.startBgfx && !$("#onboard").classList.contains("hidden")) window.startBgfx();
}
$("#liteToggle").addEventListener("click", () => applyLite(!document.documentElement.classList.contains("lite")));

function renderPlanBanner() {
  const el = $("#planBanner"); if (!el) return;
  const plan = (auth && auth.plan) || "Free";
  if (plan === "Free") {
    el.className = "plan-banner free";
    el.innerHTML = `All quiz topics are <b>free</b> to take. Downloading a certificate or getting the certified badge costs <b>₹${CERT_FEE}</b>.`;
  } else {
    el.className = "plan-banner paid";
    el.innerHTML = `✓ <b>${esc(plan)}</b> plan active — all topics &amp; features unlocked.`;
  }
}
function renderAll() {
  renderPlanBanner();
  renderWhoami(); renderHome(); renderMyCerts(); renderStats(); renderProfiles(); renderClassroom();
  renderQuiz(); renderChat(); renderBot(); renderMedia(); updateConn();
}

function renderHome() {
  const g = $("#heroGreet"); if (g) g.textContent = `Welcome back${auth && auth.name ? ", " + esc(auth.name.split(" ")[0]) : ""} 👋`;
  const status = $("#homeStatus"); if (!status) return;
  const t = mirror.profiles.teacher, l = mirror.profiles.learner;
  const both = t && l;
  status.innerHTML = `
    <div class="hero-chips">
      <span class="hchip"><b>ROOM</b>${esc(net.room || "—")}</span>
      <span class="hchip ${both ? "on" : ""}">${both ? "● Connected — " + esc(t.name) + " &amp; " + esc(l.name) : "○ Waiting for the other person…"}</span>
    </div>`;
}

function renderMyCerts() {
  const el = $("#certsBody"); if (!el) return;
  const m = me(); const prog = getProgress();
  const passed = prog.passedTopics || [];
  const unlocked = Object.keys(certGrants);
  const all = Object.keys(QUESTION_BANK);
  const cards = all.map(t => {
    if (certGrants[t]) {                       // paid + approved → real certificate
      const g = certGrants[t];
      return `<div class="cert2">
        <div class="seal">🏅</div>
        <h4>${esc(t)}</h4>
        <div class="meta">Certified Teacher${g.date ? " · " + esc(g.date) : ""}</div>
        <div class="acts">
          <button class="ghost cert-dl" data-cert="${esc(t)}">⬇ Download</button>
          <button class="ghost cert-sh" data-code="${esc(g.code || "")}">↗ Share</button>
        </div>
      </div>`;
    }
    if (certPending.includes(t)) {             // paid, awaiting admin approval
      return `<div class="cert2 locked">
        <div class="lockico">⏳</div>
        <h4 class="cert2-blur">${esc(t)}</h4>
        <div class="lockmsg">Payment submitted — awaiting admin approval</div>
      </div>`;
    }
    if (passed.includes(t)) {                  // passed quiz (free) — locked until paid
      return `<div class="cert2 locked">
        <div class="lockico">🔓</div>
        <h4 class="cert2-blur">${esc(t)}</h4>
        <div class="lockmsg">Passed! Unlock the certificate &amp; badge for ₹${CERT_FEE}</div>
        <div class="acts"><button class="primary cert-unlock" data-unlock="${esc(t)}">🔓 Unlock ₹${CERT_FEE}</button></div>
      </div>`;
    }
    return `<div class="cert2 locked">
      <div class="lockico">🔒</div>
      <h4 class="cert2-blur">${esc(t)}</h4>
      <div class="lockmsg">Pass the ${esc(t)} quiz (7/10) — it's free</div>
      <div class="acts"><button class="ghost cert-go" data-goto="quiz">Take quiz</button></div>
    </div>`;
  }).join("");
  el.innerHTML = (unlocked.length
    ? "" : `<div class="empty-cert"><div class="ec-ico">🏆</div><p>Take a quiz free to qualify, then unlock your certificate for ₹${CERT_FEE}.</p><button class="btn-grad" data-goto="quiz">Take a quiz</button></div>`)
    + `<div class="cert-grid2">${cards}</div>`;
  $$("#certsBody .cert-dl").forEach(b => b.addEventListener("click", () => downloadCertificate(m.name, b.dataset.cert)));
  $$("#certsBody .cert-unlock").forEach(b => b.addEventListener("click", () => openCertPay(b.dataset.unlock)));
  $$("#certsBody .cert-sh").forEach(b => b.addEventListener("click", () => {
    const link = location.origin + "/verify.html?code=" + encodeURIComponent(b.dataset.code);
    if (navigator.clipboard) navigator.clipboard.writeText(link).then(() => toast("Verify link copied — share it!")); else toast(link);
  }));
  $$("#certsBody [data-goto]").forEach(b => b.addEventListener("click", e => { e.preventDefault(); const tab = $(`.tabs .tab[data-tab="${b.dataset.goto}"]`); if (tab) tab.click(); }));
}
function renderPastChat() {
  const box = $("#transcript"); if (!box) return;
  if (!mirror.chat.length) { box.innerHTML = `<p class="muted">No messages yet in this room.</p>`; return; }
  box.innerHTML = mirror.chat.map(m =>
    `<div class="t-row"><span class="t-who">${esc(m.name || m.from)}</span>: ${esc(m.text)}<span class="t-time">${esc(m.t || "")}</span></div>`
  ).join("");
}

/* ============================================================
   FIND TEACHERS — browse all teachers & pick one (student view)
   ============================================================ */
let allTeachers = [];
let _pickTeacher = null;
async function renderTeachers() {
  const el = $("#teachersBody"); if (!el) return;
  try {
    const r = await fetch("/api/teachers");
    const d = await r.json();
    allTeachers = (d.ok && d.teachers) ? d.teachers : [];
  } catch { el.innerHTML = `<p class="muted">Couldn't load teachers — is the server running?</p>`; return; }
  drawTeachers();
}
function drawTeachers() {
  const el = $("#teachersBody"); if (!el) return;
  const q = ($("#teacherSearch") && $("#teacherSearch").value || "").trim().toLowerCase();
  const mine = (auth && auth.username || "").toLowerCase();
  let list = allTeachers.filter(t => (t.account || "") !== mine); // don't list myself
  if (q) list = list.filter(t => (t.name + " " + t.topic + " " + (t.topicDesc || "")).toLowerCase().includes(q));
  if (!list.length) { el.innerHTML = `<p class="muted" style="margin-top:10px">No teachers found yet. When teachers set up their profile, they'll appear here.</p>`; return; }
  el.innerHTML = `<div class="teacher-grid">${list.map((t, i) => `
    <div class="teacher-card">
      <div class="tc-top">
        ${t.photo ? `<img class="tc-ava" src="${t.photo}" alt="${esc(t.name)}" />` : `<div class="tc-ava ph">🧑‍🏫</div>`}
        <div><div class="tc-name">${esc(t.name)}</div><div class="tc-topic">${esc(t.topic || "—")}</div></div>
      </div>
      ${t.topicDesc ? `<p class="tc-desc">${esc(t.topicDesc)}</p>` : ""}
      <div class="tc-meta">
        <span class="tc-fee">${t.free ? "Free" : "₹" + (t.fee || 0)}</span>
        ${(t.certifiedTopics && t.certifiedTopics.length) ? `<span class="tc-cert">🎓 ${t.certifiedTopics.length} certified</span>` : ""}
      </div>
      <div class="row" style="gap:8px;margin-top:10px">
        <button class="ghost tc-view" data-i="${i}">View profile</button>
        <button class="primary tc-pick" data-i="${i}">Learn</button>
      </div>
    </div>`).join("")}</div>`;
  const shown = list;
  $$("#teachersBody .tc-view").forEach(b => b.addEventListener("click", () => openTeacher(shown[+b.dataset.i])));
  $$("#teachersBody .tc-pick").forEach(b => b.addEventListener("click", () => chooseTeacher(shown[+b.dataset.i])));
}
function openTeacher(t) {
  _pickTeacher = t;
  $("#teacherModalBody").innerHTML = `
    <div class="tc-top" style="margin-bottom:10px">
      ${t.photo ? `<img class="tc-ava lg" src="${t.photo}" alt="${esc(t.name)}" />` : `<div class="tc-ava lg ph">🧑‍🏫</div>`}
      <div><h3 style="margin:0">${esc(t.name)}</h3><div class="tc-topic">${esc(t.topic || "—")}</div></div>
    </div>
    ${t.bio ? `<div class="kv"><b>About</b>${esc(t.bio)}</div>` : ""}
    ${t.topicDesc ? `<div class="kv"><b>What this covers</b>${esc(t.topicDesc)}</div>` : ""}
    <div class="kv"><b>Course fee</b>${t.free ? "Free" : "₹" + (t.fee || 0)}</div>
    ${(t.certifiedTopics && t.certifiedTopics.length) ? `<div class="kv"><b>Certified in</b>${t.certifiedTopics.map(esc).join(", ")}</div>` : ""}
    <div class="kv"><b>Room code</b>${esc(t.room || "—")}</div>`;
  $("#teacherModal").classList.remove("hidden");
}
function closeTeacher() { $("#teacherModal").classList.add("hidden"); }
// Join the chosen teacher's room so the student and teacher meet live.
function chooseTeacher(t) {
  if (!t || !t.room) return;
  closeTeacher();
  if (net.es) { try { net.es.close(); } catch {} }
  net.room = t.room;
  mirror = { profiles: {}, chat: [], media: { videoData: null, videoName: null, yt: null, slides: [] }, seen: {}, rating: { avg: 0, count: 0 } };
  _prog = null;
  if (myProfile) { myProfile.want = myProfile.want || t.topic; }
  localStorage.setItem(SESSION_KEY, JSON.stringify({ room: net.room, role: net.role, profile: myProfile }));
  $("#roomCodeShow").textContent = net.room;
  connect();
  pushProfile();
  toast(`Joined ${t.name}'s classroom (${t.room})`);
  const tab = $('.tabs .tab[data-tab="classroom"]'); if (tab) tab.click();
}
(function wireTeachers() {
  const cl = $("#teacherClose"), ca = $("#teacherCancel"), pk = $("#teacherPick"), md = $("#teacherModal"),
    rf = $("#teachersRefresh"), se = $("#teacherSearch");
  if (cl) cl.addEventListener("click", closeTeacher);
  if (ca) ca.addEventListener("click", closeTeacher);
  if (md) md.addEventListener("click", e => { if (e.target === md) closeTeacher(); });
  if (pk) pk.addEventListener("click", () => { if (_pickTeacher) chooseTeacher(_pickTeacher); });
  if (rf) rf.addEventListener("click", renderTeachers);
  if (se) se.addEventListener("input", drawTeachers);
})();

function renderWhoami() {
  const m = me();
  const plan = (auth && auth.plan) || "Free";
  $("#whoami").innerHTML = m
    ? `<span class="pill">${m.role === "teacher" ? "🧑‍🏫" : "🧑‍🎓"} ${esc(m.name)} · ${esc(net.room)} · ${esc(plan)} plan</span>` : "";
}
// Refresh the signed-in user's plan (e.g. after the owner approves their order).
async function refreshPlan(manual) {
  if (!auth || !auth.username) return;
  try {
    const r = await fetch("/api/plan?username=" + encodeURIComponent(auth.username));
    const d = await r.json();
    if (d && d.plan) {
      const changed = d.plan !== auth.plan;
      auth.plan = d.plan; localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
      renderWhoami(); renderPlanBanner(); renderQuiz();
      if (changed) toast(`Your plan is now: ${d.plan} 🎉 — features unlocked!`);
      else if (manual) toast(`Your current plan: ${d.plan}`);
    }
  } catch {}
}

$("#leaveRoom").addEventListener("click", () => {
  localStorage.removeItem(SESSION_KEY);
  if (net.es) net.es.close();
  location.reload();
});
$("#resetAll").addEventListener("click", () => {
  if (!confirm("Clear your saved profile, certifications and chat-bot history on this device?")) return;
  Object.keys(localStorage).filter(k => k.startsWith("skillsync_")).forEach(k => localStorage.removeItem(k));
  location.reload();
});

/* ============================================================
   PROFILE TAB
   ============================================================ */
function avatarHTML(p, cls) {
  return p.photo
    ? `<div class="${cls}"><img src="${p.photo}" alt="${esc(p.name)}" /></div>`
    : `<div class="${cls}">${p.role === "teacher" ? "🧑‍🏫" : "🧑‍🎓"}</div>`;
}
function certBadges(p, isMe) {
  const c = p.certifiedTopics || [];
  if (!c.length) return `<div class="kv"><b>Certificates</b><span class="muted">${isMe ? "None yet — pass a quiz to earn one." : "None yet."}</span></div>`;
  return `<div class="kv"><b>Certificates (${c.length})</b></div>
    <div class="cert-badges">${c.map(t => `
      <span class="cert-badge">🎓 ${esc(t)}${isMe ? ` <button class="cert-badge-dl" data-cert="${esc(t)}" title="Download certificate">⬇</button>` : ""}</span>`).join("")}</div>`;
}
function profileBody(p, isMe) {
  if (p.role === "teacher") {
    return `
      <div class="kv"><b>Topic taught</b>${esc(p.topic || "—")}</div>
      ${p.topicDesc ? `<div class="kv"><b>About the topic</b>${esc(p.topicDesc)}</div>` : ""}
      <div class="kv"><b>Quiz</b>${QUESTION_BANK[p.topic] ? "10 per attempt · pass 7/10" : "—"}</div>
      ${certBadges(p, isMe)}`;
  }
  return `
    <div class="kv"><b>Wants to learn</b>${esc(p.want || "—")}</div>
    ${p.goal ? `<div class="kv"><b>Goal</b>${esc(p.goal)}</div>` : ""}
    ${certBadges(p, isMe)}`;
}
function updateStreak() {
  const today = new Date().toISOString().slice(0, 10);
  let data; try { data = JSON.parse(localStorage.getItem("skillsync_streak")) || {}; } catch { data = {}; }
  if (data.last === today) return data.count || 1;
  const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  data.count = (data.last === y) ? (data.count || 0) + 1 : 1;
  data.last = today;
  localStorage.setItem("skillsync_streak", JSON.stringify(data));
  return data.count;
}
function gamificationHTML(prog) {
  const attempts = prog.attempts || 0, certs = Object.keys(certGrants).length;
  const xp = attempts * 20 + certs * 120;
  const level = Math.floor(xp / 250) + 1, pct = Math.round((xp % 250) / 250 * 100);
  const streak = updateStreak();
  const badges = [
    { label: "🚀 First quiz", on: attempts >= 1 },
    { label: "🎓 Certified", on: certs >= 1 },
    { label: "🏆 3 topics", on: certs >= 3 },
    { label: "🔥 " + streak + "-day streak", on: streak >= 1 },
  ];
  return `<div class="gami">
      <div class="level-badge">Lv ${level}</div>
      <div class="xp"><div><b>${xp} XP</b> <span class="muted">· ${pct}% to Lv ${level + 1}</span></div>
        <div class="xp-bar"><div class="xp-fill" style="width:${pct}%"></div></div></div>
      <div class="streak">🔥 ${streak}d</div>
    </div>
    <div class="badges">${badges.map(b => `<span class="gbadge ${b.on ? "on" : "off"}">${b.label}</span>`).join("")}</div>`;
}
function renderProfiles() {
  const m = me(); if (!m) return;
  $("#meCard").innerHTML = `
    <div class="phead">
      ${avatarHTML(m, "big-avatar")}
      <div>
        <h2 style="margin:0">${esc(m.name)}</h2>
        <span class="tag">${m.role === "teacher" ? "Teacher" : "Learner"}</span>
        ${m.bio ? `<p class="muted" style="margin:6px 0 0">${esc(m.bio)}</p>` : ""}
      </div>
    </div>
    ${gamificationHTML(getProgress())}
    ${profileBody(m, true)}`;
  $$("#meCard .cert-badge-dl").forEach(b => b.addEventListener("click", () => downloadCertificate(m.name, b.dataset.cert)));

  const o = mirror.profiles[other(net.role)];
  $("#otherEmpty").classList.toggle("hidden", !!o);
  $("#otherBody").innerHTML = o ? `
    <div class="phead">
      ${avatarHTML(o, "big-avatar")}
      <div>
        <h2 style="margin:0">${esc(o.name)}</h2>
        <span class="tag">${o.role === "teacher" ? "Teacher" : "Learner"}</span>
        ${o.bio ? `<p class="muted" style="margin:6px 0 0">${esc(o.bio)}</p>` : ""}
      </div>
    </div>
    ${profileBody(o, false)}` : "";
}

/* ============================================================
   CLASSROOM TAB
   ============================================================ */
function renderClassroom() {
  const t = mirror.profiles.teacher, l = mirror.profiles.learner;
  const body = $("#classroomBody");
  if (!t || !l) {
    const meP = me();
    body.innerHTML = `
      <div class="waiting">
        <div class="pulse">🛰️</div>
        <h3>Waiting for the other person<span class="dots"></span></h3>
        <p class="muted">Share room <b>${esc(net.room)}</b> — they'll connect instantly.</p>
        <div class="parts">
          <div class="part"><div class="pa">${net.role === "teacher" ? "🧑‍🏫" : "🧑‍🎓"}</div><div class="muted small">${esc(meP ? meP.name : "You")}</div></div>
          <div class="part"><div class="pa empty">➕</div><div class="muted small">${net.role === "teacher" ? "Learner" : "Teacher"}</div></div>
        </div>
        <div class="waiting-acts">
          <button class="btn-grad" id="wCopy">Copy room code</button>
          <button class="btn-ghost2" id="wShare">Share link</button>
        </div>
      </div>`;
    $("#classTitle").textContent = "Classroom";
    const wc = $("#wCopy"), ws = $("#wShare");
    if (wc) wc.addEventListener("click", () => { if (navigator.clipboard) navigator.clipboard.writeText(net.room); toast("Room code copied: " + net.room); });
    if (ws) ws.addEventListener("click", () => { const lk = location.origin + "/app"; if (navigator.clipboard) navigator.clipboard.writeText(lk); toast("Link copied — share with room code " + net.room); });
    return;
  }
  $("#classTitle").textContent = `${esc(t.name)} → ${esc(l.name)}`;
  const rate = mirror.rating || { avg: 0, count: 0 };
  const rateBlock = `
    <div class="rate-box">
      <div><b>Teacher rating:</b> <span class="stars readonly">${starsHTML(rate.avg)}</span>
        <span class="rate-avg">${rate.count ? rate.avg.toFixed(1) : "—"}</span>
        <span class="muted">(${rate.count} rating${rate.count === 1 ? "" : "s"})</span></div>
      ${net.role === "learner"
        ? `<div style="margin-top:8px">Rate ${esc(t.name)}: <span class="stars" id="rateStars">${[1, 2, 3, 4, 5].map(i => `<span class="star" data-v="${i}">★</span>`).join("")}</span></div>`
        : ""}
    </div>`;
  body.innerHTML = `
    <div class="kv"><b>Lesson topic</b>${esc(t.topic)}</div>
    ${t.topicDesc ? `<div class="kv"><b>Overview</b>${esc(t.topicDesc)}</div>` : ""}
    <div class="kv"><b>${esc(l.name)} wants to learn</b>${esc(l.want)}</div>
    ${l.goal ? `<div class="kv"><b>Learner's goal</b>${esc(l.goal)}</div>` : ""}
    <p class="muted small">Use the tabs to share a whiteboard, play video &amp; slides, chat, and take the quiz — all live.</p>
    ${payBlock(t)}
    ${rateBlock}`;

  const upiEl = body.querySelector(".upi-copy");
  if (upiEl) upiEl.addEventListener("click", () => {
    const u = upiEl.dataset.upi || "";
    if (navigator.clipboard) navigator.clipboard.writeText(u);
    toast("UPI ID copied: " + u);
  });

  const wrap = $("#rateStars");
  if (wrap) {
    wrap.addEventListener("mouseover", e => { const s = e.target.closest(".star"); if (!s) return; const v = +s.dataset.v; [...wrap.children].forEach(c => c.classList.toggle("on", +c.dataset.v <= v)); });
    wrap.addEventListener("mouseleave", () => [...wrap.children].forEach(c => c.classList.remove("on")));
    wrap.addEventListener("click", e => {
      const s = e.target.closest(".star"); if (!s) return;
      const v = +s.dataset.v;
      action({ type: "rate", stars: v });
      const c = mirror.rating.count, a = mirror.rating.avg;
      mirror.rating = { avg: (a * c + v) / (c + 1), count: c + 1 }; // optimistic
      toast(`Thanks for rating ${v}★`);
      renderClassroom();
    });
  }
}
function starsHTML(val) {
  return [1, 2, 3, 4, 5].map(i => `<span class="star ${i <= Math.round(val) ? "on" : ""}">★</span>`).join("");
}

const COMPANY_UPI = "dpatel27@okaxis";
// Payment card: learner sees how to pay the teacher; teacher sees the payout split.
function payBlock(t) {
  const pay = t && t.pay;
  if (pay && (pay.free || pay.fee === 0)) {
    return `<div class="pay-card free">
      <h4>🆓 Free course — no charge</h4>
      <p class="muted small">${net.role === "learner" ? "This class is free. No payment needed — just learn!" : "You've made this a free course. Students join at no charge."}</p>
    </div>`;
  }
  if (!pay || !(pay.fee > 0)) return "";
  const fee = pay.fee, teacherCut = Math.round(fee * 0.8), platformCut = fee - teacherCut;
  const split = `
    <div class="split">
      <div class="split-row"><span>Course fee</span><b>₹${fee}</b></div>
      <div class="split-row"><span>Teacher receives (80%)</span><b>₹${teacherCut}</b></div>
      <div class="split-row plat"><span>Platform fee (20%) → ${esc(COMPANY_UPI)}</span><b>₹${platformCut}</b></div>
    </div>`;
  if (net.role === "learner") {
    return `<div class="pay-card">
      <h4>💳 Pay your teacher — ₹${fee}</h4>
      <div class="pay-grid">
        ${pay.qr ? `<img class="pay-qr" src="${pay.qr}" alt="Teacher payment QR" />` : ""}
        <div class="pay-info">
          <div class="kv"><b>UPI ID</b><span class="upi-copy" data-upi="${esc(pay.upi)}">${esc(pay.upi)} 📋</span></div>
          <div class="kv"><b>Account</b>${esc(pay.bankName)} · ${esc(pay.bankAcc)} · ${esc(pay.bankIfsc)}</div>
          ${split}
          <p class="muted small">Scan the QR or pay the UPI ID above. The 20% platform fee is settled to Skill Sync (${esc(COMPANY_UPI)}).</p>
        </div>
      </div>
    </div>`;
  }
  // teacher view
  return `<div class="pay-card">
    <h4>💰 Your payout — you keep ₹${teacherCut} per student</h4>
    ${split}
    <p class="muted small">Students pay to your UPI <b>${esc(pay.upi)}</b> / QR. Skill Sync's 20% platform fee goes to ${esc(COMPANY_UPI)}.</p>
  </div>`;
}

/* ============================================================
   STATS DASHBOARD (SVG charts — no libraries)
   ============================================================ */
function barChart(labels, values, color) {
  const W = 320, H = 150, pad = 24, n = values.length || 1;
  const max = Math.max(1, ...values);
  const bw = (W - pad * 2) / n;
  let bars = "";
  values.forEach((v, i) => {
    const h = (H - pad - 16) * (v / max);
    const x = pad + i * bw + bw * 0.15, w = bw * 0.7, y = H - pad - h;
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="3" fill="${color}"></rect>`;
    if (v > 0) bars += `<text x="${(x + w / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" font-size="9" fill="#64748b">${v}</text>`;
    bars += `<text x="${(x + w / 2).toFixed(1)}" y="${H - pad + 12}" text-anchor="middle" font-size="8" fill="#64748b">${esc(String(labels[i]))}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img"><line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#e6e8f0"></line>${bars}</svg>`;
}
function animateCounts(root) {
  const lite = document.documentElement.classList.contains("lite");
  (root || document).querySelectorAll("[data-to]:not([data-done])").forEach(el => {
    el.setAttribute("data-done", "1");
    const to = parseFloat(el.dataset.to) || 0, suf = el.dataset.suf || "", dec = Number(el.dataset.dec || 0);
    const final = (dec ? to.toFixed(dec) : Math.round(to)) + suf;
    if (lite) { el.textContent = final; return; }
    let startT = null;
    const step = (t) => { if (startT === null) startT = t; const p = Math.min(1, (t - startT) / 850); const v = to * (1 - Math.pow(1 - p, 3)); el.textContent = (dec ? v.toFixed(dec) : Math.round(v)) + suf; if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
    setTimeout(() => { el.textContent = final; }, 1100); // fallback if rAF is throttled (background tab)
  });
}
async function renderStats() {
  const el = $("#statsBody"); if (!el) return;
  el.innerHTML = `<div class="sk-row">${"<div class='skeleton sk-box'></div>".repeat(5)}</div><div class="skeleton sk-chart"></div>`;
  try {
    const s = await (await fetch("/api/stats")).json();
    if (!s.ok) { el.innerHTML = `<p class="muted">Stats unavailable.</p>`; return; }
    const passRate = s.attempts ? Math.round(s.passes / s.attempts * 100) : 0;
    el.innerHTML = `
      <div class="stat-row">
        <div class="stat-box"><div class="num" data-to="${s.totalUsers}">0</div><div class="lbl">Users</div></div>
        <div class="stat-box"><div class="num" data-to="${s.certified}">0</div><div class="lbl">Certified</div></div>
        <div class="stat-box"><div class="num" data-to="${s.attempts}">0</div><div class="lbl">Quiz attempts</div></div>
        <div class="stat-box"><div class="num" data-to="${passRate}" data-suf="%">0</div><div class="lbl">Pass rate</div></div>
        <div class="stat-box"><div class="num" data-to="${s.rating.avg || 0}" data-dec="1" data-suf="★">0</div><div class="lbl">Avg rating</div></div>
      </div>
      <div class="charts">
        <div class="chart-card"><h4>New users 📈</h4><p class="sub">Sign-ups, last 7 days</p><div class="chart">${barChart(s.signupDays, s.signupCounts, "#3B82F6")}</div></div>
        <div class="chart-card"><h4>Quiz results 🏆</h4><p class="sub">Scores out of 10 · average ${s.avgScore}</p><div class="chart">${barChart(s.dist.map((_, i) => i), s.dist, "#06B6D4")}</div></div>
      </div>`;
    const hs = $("#heroStats");
    if (hs) hs.innerHTML = `
      <div class="hstat"><span class="hl">Students</span><span class="hn" data-to="${s.totalUsers}">0</span></div>
      <div class="hstat"><span class="hl">Certificates</span><span class="hn" data-to="${s.certified}">0</span></div>
      <div class="hstat"><span class="hl">Avg rating</span><span class="hn" data-to="${s.rating.avg || 0}" data-dec="1" data-suf="★">0</span></div>`;
    animateCounts(document);
  } catch { el.innerHTML = `<p class="muted">Stats unavailable.</p>`; }
}

/* ============================================================
   WHITEBOARD TAB (real-time stroke sync)
   ============================================================ */
const canvas = $("#board");
const ctx = canvas.getContext("2d");
let drawing = false, erasing = false, last = null;

function pos(e) {
  const r = canvas.getBoundingClientRect();
  const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
  const y = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
  return { x: x * (canvas.width / r.width), y: y * (canvas.height / r.height) };
}
function drawOp(op) {
  ctx.lineJoin = ctx.lineCap = "round";
  ctx.lineWidth = op.size;
  ctx.strokeStyle = op.erase ? "#ffffff" : op.color;
  ctx.beginPath(); ctx.moveTo(op.x0, op.y0); ctx.lineTo(op.x1, op.y1); ctx.stroke();
}
function clearCanvas() { ctx.clearRect(0, 0, canvas.width, canvas.height); }

function startDraw(e) { drawing = true; last = pos(e); e.preventDefault(); }
function moveDraw(e) {
  if (!drawing) return;
  const p = pos(e);
  const op = { x0: last.x, y0: last.y, x1: p.x, y1: p.y, color: $("#wbColor").value, size: Number($("#wbSize").value), erase: erasing, cid: CID };
  drawOp(op);
  action({ type: "stroke", op });
  last = p; e.preventDefault();
}
function endDraw() { drawing = false; }
canvas.addEventListener("mousedown", startDraw);
canvas.addEventListener("mousemove", moveDraw);
window.addEventListener("mouseup", endDraw);
canvas.addEventListener("touchstart", startDraw);
canvas.addEventListener("touchmove", moveDraw);
canvas.addEventListener("touchend", endDraw);

$("#wbColor").addEventListener("input", () => { erasing = false; $("#wbErase").classList.remove("cur"); $("#wbErase").textContent = "Eraser"; });
$("#wbErase").addEventListener("click", (e) => {
  erasing = !erasing; e.target.classList.toggle("cur", erasing); e.target.textContent = erasing ? "Erasing…" : "Eraser";
});
$("#wbClear").addEventListener("click", () => { clearCanvas(); action({ type: "clearboard" }); });
$("#wbSave").addEventListener("click", () => { const a = document.createElement("a"); a.download = "whiteboard.png"; a.href = canvas.toDataURL(); a.click(); });

/* ============================================================
   MEDIA TAB (video + slides, synced)
   ============================================================ */
let slideIdx = 0;
$("#videoInput").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const data = await fileToDataURL(f);
  mirror.media.videoData = data; mirror.media.videoName = f.name; mirror.media.yt = null;
  action({ type: "media", media: mirror.media }); renderMedia();
});
$("#ytLoad").addEventListener("click", () => {
  const id = ytId($("#ytInput").value.trim());
  if (!id) return toast("Couldn't read that YouTube link.");
  mirror.media.yt = id; mirror.media.videoData = null;
  action({ type: "media", media: mirror.media }); renderMedia();
});
function ytId(url) { const m = url.match(/(?:youtu\.be\/|v=|embed\/)([\w-]{11})/); return m ? m[1] : null; }

$("#slideInput").addEventListener("change", async (e) => {
  for (const f of [...e.target.files]) mirror.media.slides.push(await fileToDataURL(f));
  slideIdx = 0; action({ type: "slides", slides: mirror.media.slides }); renderSlides();
});
$("#slidePrev").addEventListener("click", () => { if (slideIdx > 0) { slideIdx--; renderSlides(); } });
$("#slideNext").addEventListener("click", () => { if (slideIdx < mirror.media.slides.length - 1) { slideIdx++; renderSlides(); } });

function renderMedia() {
  const stage = $("#videoStage");
  if (mirror.media.yt) stage.innerHTML = `<iframe src="https://www.youtube.com/embed/${mirror.media.yt}" allowfullscreen></iframe>`;
  else if (mirror.media.videoData) stage.innerHTML = `<video src="${mirror.media.videoData}" controls></video>`;
  else stage.innerHTML = `<p class="muted" style="padding:20px">No video yet.</p>`;
  renderSlides();
}
function renderSlides() {
  const slides = mirror.media.slides || [];
  const img = $("#slideImg");
  $("#slideEmpty").classList.toggle("hidden", slides.length > 0);
  if (slides.length) { slideIdx = Math.min(slideIdx, slides.length - 1); img.src = slides[slideIdx]; img.classList.add("show"); }
  else img.classList.remove("show");
  $("#slideCount").textContent = `${slides.length ? slideIdx + 1 : 0} / ${slides.length}`;
}

/* ============================================================
   QUIZ TAB — certification (10 Q, pass 7, promote, 24h lock, no repeat)
   ============================================================ */
const PASS_MARK = 7;
const LOCK_MS = 24 * 60 * 60 * 1000;
let activeQuiz = null, lockTimer = null;

function progKey() { return `skillsync_prog_${net.room}_${net.role}`; }
function getProgress() {
  if (!_prog) {
    try { _prog = JSON.parse(localStorage.getItem(progKey())); } catch { _prog = null; }
    if (!_prog) _prog = { seen: {}, lockedUntil: 0, certifiedTopics: [], passedTopics: [], lastScore: null, lastTopic: null, lastPass: false, attempts: 0 };
  }
  return _prog;
}
function saveProgress() { localStorage.setItem(progKey(), JSON.stringify(_prog)); }

function shuffle(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function pickQuestions(topic, prog) {
  const pool = QUESTION_BANK[topic] || [];
  const seen = prog.seen[topic] || [];
  const need = Math.min(10, pool.length);
  let chosen = shuffle(pool.map((_, i) => i).filter(i => !seen.includes(i)));
  let refreshed = false;
  if (chosen.length < need) {
    const rest = shuffle(pool.map((_, i) => i).filter(i => !chosen.includes(i)));
    chosen = chosen.concat(rest).slice(0, need);
    prog.seen[topic] = []; refreshed = true;
  } else chosen = chosen.slice(0, need);
  return { chosen, refreshed };
}

function renderQuiz() {
  const card = $("#quizCard"); const m = me(); if (!m) { card.innerHTML = ""; return; }
  const prog = getProgress();
  const allTopics = Object.keys(QUESTION_BANK);
  const topics = allTopics;   // all quiz topics are FREE to take — only the certificate is paid
  let defaultTopic = (m.role === "teacher" ? m.topic : m.want);
  if (!topics.includes(defaultTopic)) defaultTopic = topics[0];
  if (lockTimer) { clearInterval(lockTimer); lockTimer = null; }

  // Locked
  if (prog.lockedUntil && Date.now() < prog.lockedUntil) {
    card.innerHTML = `
      <h3>Certification quiz locked 🔒</h3>
      <p>You scored <b>${prog.lastScore}/10</b> last time — you need ${PASS_MARK} to pass.</p>
      <p class="muted">You can retry after 24 hours. When you come back you'll get
        <b>fresh questions</b> — the ones you already attempted will not repeat.</p>
      <div class="score-box fail">Try again in <span id="countdown">…</span></div>`;
    const tick = () => {
      const ms = prog.lockedUntil - Date.now();
      if (ms <= 0) { renderQuiz(); return; }
      const h = Math.floor(ms / 3.6e6), mn = Math.floor((ms % 3.6e6) / 6e4), s = Math.floor((ms % 6e4) / 1000);
      const cd = $("#countdown"); if (cd) cd.textContent = `${h}h ${mn}m ${s}s`;
    };
    tick(); lockTimer = setInterval(tick, 1000); return;
  }

  // In an attempt
  if (activeQuiz && activeQuiz.topic) {
    const pool = QUESTION_BANK[activeQuiz.topic];
    card.innerHTML = `
      <h3>${esc(activeQuiz.topic)} — Certification Quiz</h3>
      <p class="muted small">${activeQuiz.chosen.length} questions · 1 mark each · pass ${PASS_MARK}/10${activeQuiz.refreshed ? " · bank refreshed" : ""}</p>
      <form id="quizTake" class="quiz-take">
        ${activeQuiz.chosen.map((qi, n) => {
          const q = pool[qi];
          return `<div class="q"><p>Q${n + 1}. ${esc(q.q)} <span class="tag">1 mark</span></p>
            ${q.options.map((o, oi) => `<label><input type="radio" name="q${n}" value="${oi}" /> ${esc(o)}</label>`).join("")}</div>`;
        }).join("")}
        <button class="primary" type="submit">Submit answers</button>
      </form><div id="quizResult"></div>`;
    $("#quizTake").addEventListener("submit", (e) => {
      e.preventDefault();
      let score = 0;
      activeQuiz.chosen.forEach((qi, n) => {
        const picked = $(`input[name="q${n}"]:checked`);
        if (picked && Number(picked.value) === pool[qi].answer) score++;
      });
      submitQuiz(score);
    });
    return;
  }

  // Start screen
  // Last result (marks only — the certificate is a separate paid step).
  const lastResult = (prog.lastScore != null && prog.lastTopic)
    ? `<div class="score-box ${prog.lastPass ? "" : "fail"}">Last quiz — <b>${esc(prog.lastTopic)}</b>: you scored <b>${prog.lastScore}/10</b> ${prog.lastPass ? "✅ Passed" : "❌ Not passed"}</div>` : "";

  // Certificate status for every topic the teacher has passed.
  const passed = prog.passedTopics || [];
  const certStatus = passed.length ? `<div class="cert-status"><h4 style="margin:10px 0 6px">🎓 Your certificates</h4>${passed.map(t => {
    const g = certGrants[t];
    if (g) return `<div class="cert-row"><span>✅ <b>${esc(t)}</b> — certificate unlocked</span> <button class="ghost cert-btn" data-dlcert="${esc(t)}">⬇ Download</button></div>`;
    if (certPending.includes(t)) return `<div class="cert-row"><span>⏳ <b>${esc(t)}</b> — payment submitted, awaiting admin approval</span></div>`;
    return `<div class="cert-row"><span>✅ <b>${esc(t)}</b> — passed (free). Certificate &amp; badge locked.</span> <button class="primary cert-btn" data-unlock="${esc(t)}">🔓 Unlock for ₹${CERT_FEE}</button></div>`;
  }).join("")}</div>` : "";

  card.innerHTML = `
    <h3>Take a Quiz 📝</h3>
    <p class="muted">Quizzes are <b>free</b> — take a 10-question quiz on any topic and see your marks (pass mark <b>${PASS_MARK}/10</b>).
      Fail and you wait <b>24 hours</b> before retrying (with <b>fresh questions</b>).
      To download your certificate or get the <b>certified-teacher badge</b>, unlock it for <b>₹${CERT_FEE}</b>.</p>
    ${lastResult}
    ${certStatus}
    <label>Choose a topic <small class="muted">(all topics are free)</small>
      <select id="quizTopic">${topics.map(t => `<option value="${esc(t)}" ${t === defaultTopic ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
    </label>
    <button class="primary big" id="startQuiz">Start quiz</button>`;
  $$("#quizCard [data-dlcert]").forEach(b => b.addEventListener("click", () => downloadCertificate(m.name, b.dataset.dlcert)));
  $$("#quizCard [data-unlock]").forEach(b => b.addEventListener("click", () => openCertPay(b.dataset.unlock)));
  $("#startQuiz").addEventListener("click", () => {
    const topic = $("#quizTopic").value;
    activeQuiz = Object.assign({ topic }, pickQuestions(topic, prog));
    saveProgress(); renderQuiz();
  });
}

function submitQuiz(score) {
  const m = me(); const prog = getProgress(); const topic = activeQuiz.topic;
  prog.attempts++; prog.lastScore = score;
  prog.seen[topic] = [...new Set([...(prog.seen[topic] || []), ...activeQuiz.chosen])];
  const pass = score >= PASS_MARK;
  // Record the result for the dashboard charts (anonymous aggregate).
  fetch("/api/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic, score, pass }) }).catch(() => {});
  prog.lastTopic = topic; prog.lastPass = pass;
  if (pass) {
    prog.lockedUntil = 0;
    // Taking the quiz is FREE — passing only QUALIFIES you. The certificate/badge are
    // unlocked separately by paying the certificate fee (see "Unlock certificate").
    prog.passedTopics = [...new Set([...(prog.passedTopics || []), topic])];
    if (!myProfile.topic) myProfile.topic = topic;
    localStorage.setItem(SESSION_KEY, JSON.stringify({ room: net.room, role: net.role, profile: myProfile }));
    toast(`You scored ${score}/10 — passed! You qualify for the ${topic} certificate.`);
  } else {
    prog.lockedUntil = Date.now() + LOCK_MS;
    toast(`You scored ${score}/10 — you need ${PASS_MARK} to pass. Locked for 24 hours.`);
  }
  activeQuiz = null; saveProgress();
  renderWhoami(); renderProfiles(); renderQuiz(); renderChat();
}

/* ---------- Certificate (premium PNG) ---------- */
function drawSeal(x, cx, cy, r) {
  // ribbon tails
  x.fillStyle = "#4338ca";
  x.beginPath(); x.moveTo(cx - 15, cy + r - 8); x.lineTo(cx - 28, cy + r + 40); x.lineTo(cx - 7, cy + r + 26); x.lineTo(cx + 1, cy + r + 40); x.closePath(); x.fill();
  x.beginPath(); x.moveTo(cx + 15, cy + r - 8); x.lineTo(cx + 28, cy + r + 40); x.lineTo(cx + 7, cy + r + 26); x.lineTo(cx - 1, cy + r + 40); x.closePath(); x.fill();
  // medallion rings
  x.beginPath(); x.arc(cx, cy, r, 0, 7); x.fillStyle = "#f59e0b"; x.fill();
  x.beginPath(); x.arc(cx, cy, r - 5, 0, 7); x.fillStyle = "#fbbf24"; x.fill();
  x.beginPath(); x.arc(cx, cy, r - 11, 0, 7); x.fillStyle = "#4f46e5"; x.fill();
  // star
  x.fillStyle = "#fff"; x.textAlign = "center"; x.textBaseline = "middle";
  x.font = `bold ${r}px Georgia`; x.fillText("★", cx, cy + 2);
  x.textBaseline = "alphabetic";
}
function downloadCertificate(name, topic) {
  const g = certGrants[topic];
  if (!g) { toast(`Unlock the ${topic} certificate first (₹${CERT_FEE}).`); return; }
  const code = g.code || "—";
  const date = g.date || new Date().toISOString().slice(0, 10);
  const W = 1000, H = 707;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d");

  // background
  const bg = x.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#fffefb"); bg.addColorStop(1, "#f3f1fb");
  x.fillStyle = bg; x.fillRect(0, 0, W, H);
  // borders
  x.strokeStyle = "#4f46e5"; x.lineWidth = 14; x.strokeRect(26, 26, W - 52, H - 52);
  x.strokeStyle = "#f59e0b"; x.lineWidth = 3; x.strokeRect(46, 46, W - 92, H - 92);
  // corner diamonds
  const diamond = (cx, cy) => { x.save(); x.translate(cx, cy); x.rotate(Math.PI / 4); x.fillStyle = "#f59e0b"; x.fillRect(-8, -8, 16, 16); x.restore(); };
  [[46, 46], [W - 46, 46], [46, H - 46], [W - 46, H - 46]].forEach(p => diamond(p[0], p[1]));

  x.textAlign = "center";
  x.fillStyle = "#4f46e5"; x.font = "bold 20px Georgia"; x.fillText("⇄   S K I L L   S Y N C", W / 2, 100);
  x.fillStyle = "#1e293b"; x.font = "bold 48px Georgia"; x.fillText("Certificate of Achievement", W / 2, 162);
  x.strokeStyle = "#f59e0b"; x.lineWidth = 3; x.beginPath(); x.moveTo(W / 2 - 160, 180); x.lineTo(W / 2 + 160, 180); x.stroke();

  x.fillStyle = "#64748b"; x.font = "italic 20px Georgia"; x.fillText("This certificate is proudly presented to", W / 2, 232);
  x.fillStyle = "#4338ca"; x.font = "bold 54px Georgia"; x.fillText(name, W / 2, 302);
  x.strokeStyle = "#e6e8f0"; x.lineWidth = 2; x.beginPath(); x.moveTo(W / 2 - 280, 322); x.lineTo(W / 2 + 280, 322); x.stroke();

  x.fillStyle = "#334155"; x.font = "19px Georgia";
  x.fillText("for successfully passing the certification quiz and being", W / 2, 372);
  x.fillText("recognised as a certified teacher of", W / 2, 399);
  x.fillStyle = "#0d9488"; x.font = "bold 38px Georgia"; x.fillText(topic, W / 2, 452);

  drawSeal(x, W / 2, 536, 34);

  // footer
  x.fillStyle = "#475569"; x.font = "15px Segoe UI"; x.textAlign = "left";
  x.fillText("Date:  " + date, 96, H - 86);
  x.fillText("Certificate ID:  " + code, 96, H - 62);
  x.textAlign = "right";
  x.fillStyle = "#1e293b"; x.font = "italic 24px Georgia"; x.fillText("Skill Sync", W - 96, H - 78);
  x.strokeStyle = "#94a3b8"; x.lineWidth = 1; x.beginPath(); x.moveTo(W - 250, H - 66); x.lineTo(W - 96, H - 66); x.stroke();
  x.fillStyle = "#94a3b8"; x.font = "12px Segoe UI"; x.fillText("Authorised signature", W - 96, H - 50);
  x.textAlign = "center"; x.fillStyle = "#94a3b8"; x.font = "12px Segoe UI";
  x.fillText("Verify this certificate at " + location.origin + "/verify.html", W / 2, H - 56);

  const a = document.createElement("a"); a.download = `Skill-Sync-Certificate-${topic}.png`; a.href = c.toDataURL("image/png"); a.click();
}

/* ---------- Certificate-fee payment (teacher pays platform → admin approves) ---------- */
let _certPayTopic = null;
function openCertPay(topic) {
  _certPayTopic = topic;
  $("#certPayTopic").textContent = `For passing the ${topic} quiz.`;
  $("#certPayFee").textContent = CERT_FEE;
  $("#certPayUpi").textContent = COMPANY_UPI;
  $("#certPayMsg").textContent = "";
  $("#certPaySubmit").disabled = false;
  $("#certPayModal").classList.remove("hidden");
}
function closeCertPay() { $("#certPayModal").classList.add("hidden"); }
(function wireCertPay() {
  const close = $("#certPayClose"), cancel = $("#certPayCancel"), copy = $("#certPayCopy"), submit = $("#certPaySubmit"), modal = $("#certPayModal");
  if (!modal) return;
  if (close) close.addEventListener("click", closeCertPay);
  if (cancel) cancel.addEventListener("click", closeCertPay);
  modal.addEventListener("click", e => { if (e.target === modal) closeCertPay(); });
  if (copy) copy.addEventListener("click", () => { if (navigator.clipboard) navigator.clipboard.writeText(COMPANY_UPI); toast("UPI ID copied: " + COMPANY_UPI); });
  if (submit) submit.addEventListener("click", async () => {
    if (!_certPayTopic || !isAuthed()) return;
    submit.disabled = true;
    const m = me();
    try {
      const r = await fetch("/api/cert/request", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: auth.username, topic: _certPayTopic, name: m ? m.name : auth.name, fee: CERT_FEE }),
      });
      const d = await r.json();
      if (!d.ok) { $("#certPayMsg").textContent = d.error || "Could not submit."; submit.disabled = false; return; }
      $("#certPayMsg").textContent = d.already ? "✓ Already unlocked!" : "✓ Submitted! Your certificate unlocks once the admin approves your payment.";
      await refreshCertGrants();
      setTimeout(closeCertPay, 1800);
    } catch { $("#certPayMsg").textContent = "Network error."; submit.disabled = false; }
  });
})();

/* ============================================================
   CHAT TAB — person to person
   ============================================================ */
function markSeen() {
  if (!net.role) return;
  const n = mirror.chat.length;
  if ((mirror.seen[net.role] || 0) < n) {
    mirror.seen[net.role] = n;                       // optimistic
    action({ type: "seen", role: net.role, count: n });
  }
}
function renderChat() {
  const box = $("#messages"); if (!box) return;
  const otherSeen = (mirror.seen && mirror.seen[other(net.role)]) || 0;
  let lastMine = -1;
  mirror.chat.forEach((m, i) => { if (m.from === net.role) lastMine = i; });
  box.innerHTML = mirror.chat.map((msg, i) => {
    const mine = msg.from === net.role;
    // Read receipt shown only under my most recent message (WhatsApp-style).
    const status = (mine && i === lastMine)
      ? `<span class="seen-tag">${otherSeen > i ? "✓✓ Seen" : "✓ Sent"}</span>` : "";
    return `<div class="msg ${mine ? "me" : "them"}">${esc(msg.text)}
      <span class="meta">${mine ? "You" : esc(msg.name || msg.from)} · ${msg.t}${status}</span></div>`;
  }).join("");
  box.scrollTop = box.scrollHeight;
  renderPastChat();
}
function exportChat() {
  const lines = mirror.chat.map(m => `[${m.t || ""}] ${m.name || m.from}: ${m.text}`).join("\n");
  const blob = new Blob([`Skill Sync — chat transcript (room ${net.room})\n\n` + lines + "\n"], { type: "text/plain" });
  const a = document.createElement("a"); a.download = `skillsync-chat-${net.room}.txt`; a.href = URL.createObjectURL(blob); a.click();
}
$("#exportChat").addEventListener("click", exportChat);
// Home quick-link tiles jump to the matching tab
$$("[data-goto]").forEach(b => b.addEventListener("click", () => {
  const tab = $(`.tab[data-tab="${b.dataset.goto}"]`); if (tab) tab.click();
}));
$("#footYear").textContent = new Date().getFullYear();
// Hero CTA buttons
if ($("#heroPrimary")) $("#heroPrimary").addEventListener("click", () => { const t = $('.tabs .tab[data-tab="classroom"]'); if (t) t.click(); });
if ($("#heroSecondary")) $("#heroSecondary").addEventListener("click", () => {
  const link = location.origin + "/app";
  if (navigator.clipboard) navigator.clipboard.writeText(link).then(() => toast(`Link copied — share room code ${net.room}`)).catch(() => toast(`Share: ${link}`));
  else toast(`Share this link: ${link}`);
});
$("#chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#chatInput").value.trim(); if (!v) return;
  const msg = { id: Date.now() + "-" + Math.random().toString(36).slice(2, 7), from: net.role, name: me().name, text: v, t: now(), account: (auth && auth.username) || "" };
  mirror.chat.push(msg); $("#chatInput").value = "";
  renderChat(); action({ type: "chat", msg });
});

/* ============================================================
   CHATBOT — local rule-based assistant
   ============================================================ */
function botKey() { return `skillsync_bot_${net.room}_${net.role}`; }
function botHist() { try { return JSON.parse(localStorage.getItem(botKey())) || []; } catch { return []; } }
function renderBot() {
  const box = $("#botMessages"); if (!box) return;
  const hist = botHist();
  if (!hist.length) {
    box.innerHTML = `<div class="msg them">Hi! I'm your learning assistant 🤖. Ask me about the topic, the quiz, the whiteboard, video & slides, or how Skill Sync works.<span class="meta">Assistant</span></div>`;
    return;
  }
  box.innerHTML = hist.map(m =>
    `<div class="msg ${m.role === "user" ? "me" : "them"}">${esc(m.text)}<span class="meta">${m.role === "user" ? "You" : "Assistant"}</span></div>`).join("");
  box.scrollTop = box.scrollHeight;
}
/* ---------- RAG: retrieve relevant lesson material for a question ---------- */
const STOP = new Set("a an the is are was were be of to in on for and or but how what why when which that this it its i you he she they we as with do does did my your our their can could would should will".split(" "));
function ragDocs() {
  const docs = [];
  const t = mirror.profiles.teacher || (net.role === "teacher" ? myProfile : null);
  if (t) {
    if (t.topicDesc) docs.push({ src: "topic overview", text: t.topicDesc });
    if (t.notes) t.notes.split(/\n+/).map(s => s.trim()).filter(Boolean).forEach(s => docs.push({ src: "lesson notes", text: s }));
    (QUESTION_BANK[t.topic] || []).forEach(q => docs.push({ src: "key fact", text: `${q.q} Answer: ${q.options[q.answer]}.` }));
  }
  return docs;
}
function retrieve(query, k = 4) {
  const docs = ragDocs(); if (!docs.length) return [];
  const qWords = new Set((query.toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => w.length > 2 && !STOP.has(w)));
  if (!qWords.size) return [];
  return docs.map(d => {
    const words = new Set(d.text.toLowerCase().match(/[a-z0-9]+/g) || []);
    let s = 0; qWords.forEach(w => { if (words.has(w)) s++; });
    return { d, s };
  }).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k).map(x => x.d);
}

$("#botForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#botInput").value.trim(); if (!v) return;
  const hist = botHist();
  hist.push({ role: "user", text: v });

  // Fully local assistant — no external API. First answer from the teacher's
  // lesson material (RAG: local keyword retrieval), else use the built-in bot.
  const docs = retrieve(v, 2);
  const reply = docs.length
    ? "From the lesson material:\n• " + docs.map(d => d.text).join("\n• ")
    : botReply(v);

  hist.push({ role: "bot", text: reply });
  localStorage.setItem(botKey(), JSON.stringify(hist));
  $("#botInput").value = ""; renderBot();
});
function botReply(q) {
  const t = q.toLowerCase();
  const teacher = mirror.profiles.teacher;
  const topic = (teacher && teacher.topic) || (me() && me().want);
  if (/hello|hi|hey/.test(t)) return "Hello! What would you like to learn today?";
  if (/topic|learn|teach|subject/.test(t)) return topic
    ? `The lesson topic is "${topic}". ${(teacher && teacher.topicDesc) || "Ask me anything about it and I'll point you in the right direction."}`.trim()
    : "No topic is set yet — the teacher chooses it when creating their profile.";
  if (/quiz|test|marks|score|certif|pass|fail/.test(t)) return "The certification quiz has 10 questions (1 mark each). Score 7 or more out of 10 to qualify as a teacher of that topic. If you don't pass, you can retry after 24 hours — and you'll get fresh questions that don't repeat.";
  if (/certificate|download|png/.test(t)) return "Once you pass a quiz, a 'Download certificate' button appears on the Quiz tab — it saves a printable PNG certificate.";
  if (/whiteboard|draw|board/.test(t)) return "Open the Whiteboard tab. Pick a colour and brush size and draw — whatever you sketch appears live on the other person's screen too. Use Clear to wipe it or Save PNG to keep a copy.";
  if (/video|slide|youtube/.test(t)) return "In the Video & Slides tab you can upload a video file, paste a YouTube link, and upload slide images. Everything you load shows up live for the other person.";
  if (/room|connect|join|invite|share/.test(t)) return `You're in room ${net.room}. Share that code with the other person — they open Skill Sync, enter the same code, pick the opposite role, and you're connected.`;
  if (/chat|message/.test(t)) return "Use the chat on the left to message the other person in real time.";
  if (/dark|theme|night|light/.test(t)) return "Tap the 🌙 / ☀️ button in the top-right to switch between light and dark mode.";
  if (/help|how|what can/.test(t)) return "I can explain the topic, the quiz, certificates, the whiteboard, video & slides, rooms, and themes. Try 'how does the quiz work?' or 'what is the topic?'.";
  return "I'm a simple built-in assistant. Try asking about the topic, the quiz, the whiteboard, video & slides, or rooms.";
}

/* ============================================================
   DARK MODE
   ============================================================ */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("#themeToggle").textContent = theme === "dark" ? "☀️" : "🌙";
  localStorage.setItem("skillsync_theme", theme);
}
$("#themeToggle").addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

/* ============================================================
   BOOT
   ============================================================ */
applyTheme(localStorage.getItem("skillsync_theme") || "dark");
populateTopicSelects();
$("#roomInput").value = randomRoom();

/* Animated tech background (particle network) for the landing page */
(function () {
  const cv = document.getElementById("bgfx"); if (!cv) return;
  const ctx = cv.getContext("2d");
  let W, H, pts, raf, running = false;
  function size() { W = cv.width = cv.offsetWidth || window.innerWidth; H = cv.height = cv.offsetHeight || window.innerHeight; }
  function make() {
    size();
    const n = Math.min(90, Math.floor(W / 16));
    pts = [];
    for (let i = 0; i < n; i++) pts.push({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5) * .5, vy: (Math.random() - .5) * .5 });
  }
  function frame() {
    ctx.clearRect(0, 0, W, H);
    for (const p of pts) { p.x += p.vx; p.y += p.vy; if (p.x < 0 || p.x > W) p.vx *= -1; if (p.y < 0 || p.y > H) p.vy *= -1; }
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i], b = pts[j], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < 145) { ctx.strokeStyle = "rgba(45,212,191," + (1 - d / 145) * 0.45 + ")"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
      }
    }
    for (const p of pts) { ctx.fillStyle = "rgba(94,234,212,.9)"; ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, 7); ctx.fill(); }
    raf = requestAnimationFrame(frame);
  }
  window.startBgfx = function () { if (running) return; running = true; make(); frame(); };
  window.stopBgfx = function () { running = false; if (raf) cancelAnimationFrame(raf); };
  window.addEventListener("resize", () => { if (running) make(); });
  startBgfx();
})();
// Apply saved lite mode (default ON if the user prefers reduced motion)
applyLite(localStorage.getItem("skillsync_lite")
  ? localStorage.getItem("skillsync_lite") === "1"
  : window.matchMedia("(prefers-reduced-motion: reduce)").matches);
if (isAuthed()) $("#logoutBtn").style.display = "";

// Live-feel readouts on the landing HUD
setInterval(() => {
  if (document.documentElement.classList.contains("lite")) return;
  if ($("#onboard").classList.contains("hidden")) return;
  const set = (id, lo, hi, pct) => { const el = document.getElementById(id); if (!el) return; const v = lo + Math.floor(Math.random() * (hi - lo)); el.textContent = pct ? String(v).padStart(2, "0") + "%" : String(v); };
  set("hudN1", 12, 99, false); set("hudN2", 1, 60, true); set("hudN3", 4, 48, false);
}, 1700);

// Auto-rejoin a saved session — only if still signed in.
try {
  const s = JSON.parse(localStorage.getItem(SESSION_KEY));
  if (isAuthed() && s && s.room && s.role && s.profile) {
    net.room = s.room; net.role = s.role; myProfile = s.profile;
    if (!myProfile.certifiedTopics) myProfile.certifiedTopics = [];
    myProfile.certifiedTopics = getProgress().certifiedTopics || myProfile.certifiedTopics;
    connect(); pushProfile(); enterApp();
  } else if (!isAuthed()) {
    localStorage.removeItem(SESSION_KEY); // signed out → require auth again
  }
} catch {}
