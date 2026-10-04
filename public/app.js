const $ = (id) => document.getElementById(id);
const socket = io({ transports: ["websocket", "polling"] });

// ---------- saved seat (survives sleep, signal drops, server restarts) ----------
const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const SESSION_TTL = 6 * 3600 * 1000;

let session = (() => {
  const s = LS.get("mlt.session");
  if (!s || !s.pid || !s.code) return null;
  if (Date.now() - (s.ts || 0) > SESSION_TTL) { LS.del("mlt.session"); return null; }
  return s;
})();
let seen = LS.get("mlt.seen") || { q: [], d: [] };
let state = null;
let lastNoticeKey = null;
let lastDareKey = null;
let lastResultsRound = null;

function saveSession(patch) {
  session = { ...(session || {}), ...patch, ts: Date.now() };
  LS.set("mlt.session", session);
}
function clearSession() {
  session = null;
  seen = { q: [], d: [] };
  LS.del("mlt.session");
  LS.del("mlt.seen");
}
function resetSeen() {
  seen = { q: [], d: [] };
  LS.set("mlt.seen", seen);
}

// ---------- ui helpers ----------
function show(viewId) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $(viewId).classList.add("active");
}
function esc(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
function applyRoles(viewId, isHost) {
  const root = $(viewId);
  root.querySelectorAll(".host-only").forEach((el) => el.classList.toggle("hidden", !isHost));
  root.querySelectorAll(".non-host-only").forEach((el) => el.classList.toggle("hidden", isHost));
}
let toastTimer = null;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3200);
}
function setTimer(n) {
  document.querySelectorAll(".timer").forEach((el) => (el.textContent = Math.max(n, 0)));
  document.querySelectorAll(".timer-chip").forEach((c) => c.classList.toggle("urgent", n <= 5));
}
function readyLabel(done, total) {
  const you = state && state.you && state.you.ready;
  return `${you ? "Ready. Tap to undo" : "Ready for next round"} (${done}/${total})`;
}
function updateProgress(phase, done, total) {
  if (phase === "dare") $("dare-progress").textContent = `${done} / ${total} voted`;
  if (phase === "lock") $("lock-progress").textContent = `${done} sitting out`;
  if (phase === "question") $("vote-progress").textContent = `${done} / ${total} voted`;
  if (phase === "results") $("btn-ready").textContent = readyLabel(done, total);
}

// ---------- keep the phone awake + connected ----------
let wakeLock = null;
async function keepAwake() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (session) keepAwake();
  if (!socket.connected) socket.connect();
});

// ---------- connection ----------
if (session) show("view-boot");

const qp = new URLSearchParams(location.search);
if (qp.get("code")) $("landing-code").value = qp.get("code").toUpperCase().slice(0, 4);

function resume() {
  socket.emit(
    "session:resume",
    { code: session.code, pid: session.pid, name: session.name, score: session.score || 0, wasHost: !!session.isHost, seenQ: seen.q, seenD: seen.d },
    (res) => {
      if (!res || !res.ok) {
        clearSession();
        state = null;
        show("view-landing");
        return;
      }
      keepAwake();
    }
  );
}
socket.on("connect", () => {
  $("conn").classList.add("hidden");
  if (session) resume();
});
socket.on("disconnect", () => {
  if (state) $("conn").classList.remove("hidden");
});

// ---------- landing ----------
const landingError = (msg) => ($("landing-error").textContent = msg);

$("btn-create").addEventListener("click", () => {
  const name = $("landing-name").value.trim();
  if (!name) return landingError("Enter your name first.");
  landingError("");
  resetSeen();
  socket.emit("room:create", { name }, (res) => {
    if (!res || !res.ok) return landingError((res && res.error) || "Couldn't create the room.");
    saveSession({ pid: res.pid, code: res.code, name, score: 0 });
    keepAwake();
  });
});

$("btn-join").addEventListener("click", () => {
  const name = $("landing-name").value.trim();
  const code = $("landing-code").value.trim().toUpperCase();
  if (!name) return landingError("Enter your name first.");
  if (code.length !== 4) return landingError("Enter the 4-letter room code.");
  landingError("");
  resetSeen();
  socket.emit("player:join", { code, name }, (res) => {
    if (!res || !res.ok) return landingError((res && res.error) || "Couldn't join the room.");
    saveSession({ pid: res.pid, code: res.code, name, score: 0 });
    keepAwake();
  });
});

function goHome() {
  socket.emit("player:leave");
  clearSession();
  state = null;
  lastDareKey = null;
  lastResultsRound = null;
  show("view-landing");
}

// ---------- state in ----------
socket.on("state", (s) => {
  state = s;
  remember(s);
  if (s.notice && s.notice.id !== lastNoticeKey) {
    lastNoticeKey = s.notice.id;
    toast(s.notice.text);
  }
  render(s);
});

socket.on("tick", (t) => {
  if (!state || t.phase !== state.phase) return;
  setTimer(t.timeLeft);
  updateProgress(t.phase, t.done, t.total);
});

// remember what this phone has seen so a restarted server can avoid repeats
function remember(s) {
  let changed = false;
  if (s.question && !seen.q.includes(s.question)) { seen.q.push(s.question); changed = true; }
  const d = s.lockedDare;
  if (d && d.cat !== "custom" && !seen.d.includes(d.text)) { seen.d.push(d.text); changed = true; }
  if (changed) LS.set("mlt.seen", seen);
  saveSession({ code: s.code, name: s.you.name, score: s.you.score, isHost: s.you.isHost });
}

function render(s) {
  if (s.phase !== "results") lastResultsRound = null;
  setTimer(s.timeLeft);
  switch (s.phase) {
    case "lobby": return renderLobby(s);
    case "dare": return renderDare(s);
    case "lock": return renderLock(s);
    case "question": return renderQuestion(s);
    case "results": return renderResults(s);
    case "ended": return renderEnded(s);
  }
}

// ---------- lobby ----------
function renderLobby(s) {
  $("lobby-code").textContent = s.code;
  $("lobby-players").innerHTML = s.players
    .map(
      (p) => `<li class="${p.online ? "" : "away"}"><span>${esc(p.name)}${p.isHost ? '<span class="crown">&#9733;</span>' : ""}${p.id === s.you.id ? '<span class="you">you</span>' : ""}</span><span class="score-pill">${p.online ? p.score + " caught" : "away"}</span></li>`
    )
    .join("");
  applyRoles("view-lobby", s.you.isHost);
  $("btn-start").disabled = s.players.filter((p) => p.online).length < 2;
  show("view-lobby");
}

$("btn-start").addEventListener("click", () => socket.emit("host:start"));
$("btn-leave").addEventListener("click", goHome);
$("btn-copy-link").addEventListener("click", async () => {
  if (!state) return;
  const url = `${location.origin}/?code=${state.code}`;
  try {
    if (navigator.share) await navigator.share({ title: "Most Likely To", text: `join my room ${state.code}`, url });
    else { await navigator.clipboard.writeText(url); toast("Invite link copied."); }
  } catch (e) {
    if (e && e.name === "AbortError") return;
    window.prompt("Copy this link", url);
  }
});

// ---------- add your own (lobby + results) ----------
document.querySelectorAll(".add-box").forEach((box) => {
  let kind = "dare";
  const input = box.querySelector(".add-input");
  const note = box.querySelector(".add-note");
  box.querySelectorAll(".seg-btn").forEach((b) =>
    b.addEventListener("click", () => {
      kind = b.dataset.kind;
      box.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("on", x === b));
      input.placeholder = kind === "dare" ? "drop a dare for the room..." : "who's most likely to...";
      note.textContent = "";
    })
  );
  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    socket.emit(kind === "dare" ? "room:addDare" : "room:addQuestion", { text }, (res) => {
      if (res && res.ok) {
        input.value = "";
        note.textContent = kind === "dare" ? "In the pile. It'll show up as an option." : "In the deck. Coming up soon.";
      } else {
        note.textContent = (res && res.error) || "Couldn't add that.";
      }
    });
  };
  box.querySelector(".add-send").addEventListener("click", send);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
});

// ---------- dare vote ----------
function renderDare(s) {
  const d = s.dare;
  $("dare-round").textContent = `Round ${String(s.round).padStart(2, "0")}`;
  const key = s.round + "|" + d.options.map((o) => o.id + o.text).join("|");
  const enter = key !== lastDareKey;
  lastDareKey = key;
  const total = Math.max(s.progress.total, 1);

  $("dare-options").innerHTML = d.options
    .map(
      (o, i) => `<button class="dare-row${enter ? " enter" : ""}${d.myVote === o.id ? " picked" : ""}" data-id="${o.id}" style="--i:${i};--p:${Math.round((o.votes / total) * 100)}%">
        <span class="dare-body"><span class="dare-tag">${esc(o.label)}${o.by ? " from " + esc(o.by) : ""}</span><span class="dare-text">${esc(o.text)}</span></span>
        <span class="dare-count">${o.votes}</span>
      </button>`
    )
    .join("");

  const veto = $("btn-reshuffle");
  veto.classList.toggle("hidden", !d.canReshuffle);
  veto.classList.toggle("picked", d.myVote === "reshuffle");
  veto.style.setProperty("--p", Math.round((d.reshuffleVotes / total) * 100) + "%");
  $("reshuffle-count").textContent = d.reshuffleVotes;

  updateProgress("dare", s.progress.done, s.progress.total);
  show("view-dare");
}

function voteDare(id) {
  socket.emit("dare:vote", { optionId: id });
  document.querySelectorAll("#view-dare .dare-row").forEach((r) =>
    r.classList.toggle("picked", (r.dataset.id || "reshuffle") === id)
  );
}
$("dare-options").addEventListener("click", (e) => {
  const row = e.target.closest(".dare-row");
  if (row && row.dataset.id) voteDare(row.dataset.id);
});
$("btn-reshuffle").addEventListener("click", () => voteDare("reshuffle"));

// ---------- dare locked / opt-out ----------
function renderLock(s) {
  const d = s.lockedDare;
  $("lock-tag").textContent = d.label + (d.by ? " from " + d.by : "");
  $("lock-dare").textContent = d.text;
  const out = s.you.sittingOut;
  $("btn-optout").textContent = out ? "I'm back in" : "I'm out";
  $("btn-optout").classList.toggle("on", out);
  updateProgress("lock", s.progress.done, s.progress.total);
  show("view-lock");
}
$("btn-optout").addEventListener("click", () => {
  if (!state) return;
  const out = !state.you.sittingOut;
  state.you.sittingOut = out;
  $("btn-optout").textContent = out ? "I'm back in" : "I'm out";
  $("btn-optout").classList.toggle("on", out);
  socket.emit("dare:optout", { out });
});

// ---------- question / vote ----------
function renderQuestion(s) {
  $("question-text").textContent = s.question;
  const voted = !!s.myVote;
  $("vote-grid").innerHTML = s.targets
    .map(
      (p) => `<button class="vote-btn${s.myVote === p.id ? " picked" : ""}" data-id="${p.id}"${voted ? " disabled" : ""}>${esc(p.name)}</button>`
    )
    .join("");
  $("voted-note").classList.toggle("hidden", !voted);
  $("sit-note").classList.toggle("hidden", voted || !s.you.sittingOut);
  updateProgress("question", s.progress.done, s.progress.total);
  show("view-question");
}
$("vote-grid").addEventListener("click", (e) => {
  const btn = e.target.closest(".vote-btn");
  if (!btn || btn.disabled || !state || state.myVote) return;
  state.myVote = btn.dataset.id;
  socket.emit("player:vote", { targetId: btn.dataset.id });
  renderQuestion(state);
});

// ---------- results ----------
function renderResults(s) {
  const r = s.results;
  const fresh = lastResultsRound !== s.round;
  lastResultsRound = s.round;

  const winner = $("winner-name");
  winner.textContent = r.winners.length ? r.winners.join(" & ") : "No votes";
  winner.classList.toggle("long", winner.textContent.length > 14);

  const maxVotes = Math.max(...r.rows.map((x) => x.votes), 1);
  const bars = $("results-bars");
  bars.classList.toggle("static", !fresh);
  bars.innerHTML = r.rows
    .map(
      (x) => `<div class="bar-row">
        <div class="bar-name">${esc(x.name)}</div>
        <div class="bar-track"><div class="bar-fill${x.isWinner ? " winner" : ""}" data-w="${(x.votes / maxVotes) * 100}" style="width:${fresh ? 0 : (x.votes / maxVotes) * 100}%"></div></div>
        <div class="bar-count">${x.votes}</div>
      </div>`
    )
    .join("");
  if (fresh) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        bars.querySelectorAll(".bar-fill").forEach((el) => (el.style.width = el.dataset.w + "%"))
      )
    );
  }

  $("results-dare").textContent = r.winners.length
    ? s.lockedDare.text
    : "Nobody got picked. Dare cancelled.";

  applyRoles("view-results", s.you.isHost);
  updateProgress("results", s.progress.done, s.progress.total);
  show("view-results");
}
$("btn-ready").addEventListener("click", () => {
  if (!state) return;
  state.you.ready = !state.you.ready;
  updateProgress("results", state.progress.done, state.progress.total);
  socket.emit("player:ready");
});
$("btn-end-game").addEventListener("click", () => socket.emit("host:end"));

// ---------- ended ----------
function renderEnded(s) {
  const ranked = [...s.players].sort((a, b) => b.score - a.score);
  const top = ranked.length ? ranked[0].score : 0;
  $("end-title").textContent = top > 0
    ? ranked.filter((p) => p.score === top).map((p) => p.name).join(" & ")
    : "Nobody. Everyone behaved.";
  $("end-title").classList.toggle("long", $("end-title").textContent.length > 14);
  $("final-scores").innerHTML = ranked
    .map(
      (p, i) => `<li><span class="rank">${i + 1}</span><span class="rank-name">${esc(p.name)}</span><span class="rank-score">${p.score} caught${p.passes ? ", sat out " + p.passes : ""}</span></li>`
    )
    .join("");
  applyRoles("view-ended", s.you.isHost);
  show("view-ended");
}
$("btn-again").addEventListener("click", () => socket.emit("host:playAgain"));
$("btn-home").addEventListener("click", goHome);
