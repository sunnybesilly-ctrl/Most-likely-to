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
let lastResultsRound = null;
let lastPhase = null;
let boardRound = null;
let boardIds = new Set();

// favorites picker
let inFavs = false;
let catalog = null;
let favTab = "show";
let myFavs = [];

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
function buzz(ms) {
  try { if (navigator.vibrate && document.visibilityState === "visible") navigator.vibrate(ms); } catch {}
}

// ---------- the clock: digits + draining bar + panic mode ----------
const TIMED = ["dare", "agree", "countdown", "question"];

function setTimer(n, phase) {
  const hot = phase === "dare" || phase === "agree" || phase === "question";
  const warn = hot && n <= 10 && n > 5;
  const urgent = (hot && n <= 5 && n > 0) || phase === "countdown";
  document.querySelectorAll(".timer").forEach((el) => (el.textContent = Math.max(n, 0)));
  document.querySelectorAll(".timer-chip, .tbar").forEach((el) => {
    el.classList.toggle("warn", warn);
    el.classList.toggle("urgent", urgent);
  });
  document.body.classList.toggle("urgent", hot && n <= 5 && n > 0);
}

// the bar glides to empty over exactly the time that's left
function syncBar(t) {
  document.querySelectorAll(".tbar i").forEach((bar) => {
    const frac = t.total ? Math.min(1, t.remainingMs / (t.total * 1000)) : 0;
    bar.style.transition = "none";
    bar.style.width = frac * 100 + "%";
    void bar.offsetWidth;
    if (t.remainingMs > 0) {
      bar.style.transition = `width ${t.remainingMs}ms linear`;
      bar.style.width = "0%";
    }
  });
}

function setBig(n) {
  const el = $("count-big");
  el.textContent = Math.max(n, 0);
  el.classList.remove("pop");
  void el.offsetWidth;
  el.classList.add("pop");
}

function readyLabel(done, total) {
  const you = state && state.you && state.you.ready;
  return `${you ? "Ready. Tap to undo" : "Ready for next round"} (${done}/${total})`;
}
function updateProgress(phase, done, total) {
  if (phase === "dare") $("dare-progress").textContent = `${done} / ${total} locked in`;
  if (phase === "agree") $("agree-progress").textContent = `${done} / ${total} answered`;
  if (phase === "question") $("vote-progress").textContent = `${done} / ${total} voted`;
  if (phase === "results") $("btn-ready").textContent = readyLabel(done, total);
}

function renderRoster(el, roster, meId) {
  el.innerHTML = (roster || [])
    .map((p) => {
      const cls = ["rchip"];
      if (p.status === "in") cls.push("in");
      else if (p.status === "out") cls.push("out");
      else if (p.done) cls.push("done");
      if (p.id === meId) cls.push("me");
      return `<span class="${cls.join(" ")}">${esc(p.name)}</span>`;
    })
    .join("");
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
    {
      code: session.code,
      pid: session.pid,
      name: session.name,
      score: session.score || 0,
      wasHost: !!session.isHost,
      favs: session.favs || [],
      seenQ: seen.q,
      seenD: seen.d,
    },
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
    saveSession({ pid: res.pid, code: res.code, name, score: 0, favs: [] });
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
    saveSession({ pid: res.pid, code: res.code, name, score: 0, favs: [] });
    keepAwake();
  });
});

function goHome() {
  socket.emit("player:leave");
  clearSession();
  state = null;
  inFavs = false;
  boardRound = null;
  lastResultsRound = null;
  lastPhase = null;
  document.body.classList.remove("urgent");
  show("view-landing");
}

// ---------- state in ----------
socket.on("state", (s) => {
  state = s;
  myFavs = s.you.favs || [];
  remember(s);
  if (s.notice && s.notice.id !== lastNoticeKey) {
    lastNoticeKey = s.notice.id;
    toast(s.notice.text);
  }
  render(s);
});

socket.on("tick", (t) => {
  if (!state || t.phase !== state.phase) return;
  state.timer = { left: t.timeLeft, total: t.totalMs / 1000, remainingMs: t.remainingMs, closing: t.closing };
  setTimer(t.timeLeft, t.phase);
  updateProgress(t.phase, t.done, t.total);
  if (t.phase === "countdown") { setBig(t.timeLeft); buzz(45); }
  else if (TIMED.includes(t.phase) && t.timeLeft <= 5 && t.timeLeft > 0) buzz(25);
});

// remember what this phone has seen so a restarted server can avoid repeats
function remember(s) {
  let changed = false;
  if (s.question && !seen.q.includes(s.question.text)) { seen.q.push(s.question.text); changed = true; }
  if (s.dare) {
    for (const o of s.dare.options) {
      if (o.kind !== "written" && !seen.d.includes(o.text)) { seen.d.push(o.text); changed = true; }
    }
  }
  if (changed) LS.set("mlt.seen", seen);
  saveSession({ code: s.code, name: s.you.name, score: s.you.score, isHost: s.you.isHost, favs: s.you.favs || [] });
}

function render(s) {
  if (s.phase !== "results") lastResultsRound = null;
  if (inFavs) {
    if (s.phase === "lobby" || s.phase === "results") { renderFavs(); return; }
    inFavs = false;
    toast("Game's moving. Your picks are saved.");
  }

  const t = s.timer || { left: 0, total: 0, remainingMs: 0, closing: false };
  setTimer(t.left, s.phase);
  syncBar(t);

  // phase-change haptics: a heavy buzz when the question lands
  if (lastPhase !== s.phase) {
    if (s.phase === "question") buzz(260);
    if (s.phase === "agree") buzz(120);
  }
  lastPhase = s.phase;

  switch (s.phase) {
    case "lobby": return renderLobby(s);
    case "dare": return renderDare(s);
    case "agree": return renderAgree(s);
    case "countdown": return renderCountdown(s);
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
  $("btn-favs").textContent = `Pick your 2 favorite dares (${myFavs.length}/2)`;
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

// ---------- favorites ----------
function openFavs() {
  inFavs = true;
  socket.emit("dares:list", {}, (res) => {
    if (res && res.ok) catalog = res.list;
    renderFavs();
  });
  renderFavs();
}
function renderFavs() {
  const list = catalog || [];
  const order = ["show", "phone", "spill", "spicy", "custom"];
  const present = order.filter((c) => list.some((d) => d.cat === c));
  if (!present.includes(favTab)) favTab = present[0] || "show";

  $("favs-tabs").innerHTML = present
    .map((c) => {
      const label = (list.find((d) => d.cat === c) || {}).label || c;
      return `<button type="button" class="tab${c === favTab ? " on" : ""}" data-tab="${c}">${esc(label)}</button>`;
    })
    .join("");

  $("favs-list").innerHTML = list
    .filter((d) => d.cat === favTab)
    .map((d) => {
      const on = myFavs.includes(d.id);
      return `<li><button type="button" class="fav-row${on ? " on" : ""}" data-id="${esc(d.id)}"><span class="star">${on ? "&#9733;" : "&#9734;"}</span><span class="fav-text">${esc(d.text)}${d.by ? `<em> from ${esc(d.by)}</em>` : ""}</span></button></li>`;
    })
    .join("");

  $("favs-count").textContent = `${myFavs.length} / 2`;
  show("view-favs");
}
function toggleFav(id) {
  let f = [...myFavs];
  if (f.includes(id)) f = f.filter((x) => x !== id);
  else {
    f.push(id);
    if (f.length > 2) { f.shift(); toast("Swapped out your oldest pick."); }
  }
  myFavs = f;
  if (state) state.you.favs = f;
  saveSession({ favs: f });
  renderFavs();
  socket.emit("fav:set", { ids: f });
}
$("btn-favs").addEventListener("click", openFavs);
$("btn-favs-results").addEventListener("click", openFavs);
$("favs-tabs").addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (!b) return;
  favTab = b.dataset.tab;
  renderFavs();
});
$("favs-list").addEventListener("click", (e) => {
  const b = e.target.closest(".fav-row");
  if (b) toggleFav(b.dataset.id);
});
$("btn-favs-done").addEventListener("click", () => {
  inFavs = false;
  if (state) render(state);
});

// ---------- write your own (lobby + results) ----------
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
        note.textContent = kind === "dare" ? "In the pile. It'll show up on the board." : "In the deck. Coming up soon.";
      } else {
        note.textContent = (res && res.error) || "Couldn't add that.";
      }
    });
  };
  box.querySelector(".add-send").addEventListener("click", send);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
});

// ---------- the dare board ----------
function shortName(n) { return n.length > 8 ? n.slice(0, 8) : n; }

function renderDare(s) {
  const d = s.dare;
  const me = s.you.id;
  $("dare-round").textContent = `Round ${String(s.round).padStart(2, "0")}`;
  const total = Math.max(s.progress.total, 1);

  // whole new board = everything animates in; otherwise only brand-new rows flash
  const ids = d.options.map((o) => o.id);
  const freshBoard = boardRound !== s.round || ids.every((id) => !boardIds.has(id));
  const known = boardIds;
  boardRound = s.round;
  boardIds = new Set(ids);

  $("dare-options").innerHTML = d.options
    .map((o, i) => {
      const cls = ["dare-row", "kind-" + o.kind];
      if (d.myVote === o.id) cls.push("picked");
      if (freshBoard) cls.push("enter");
      else if (!known.has(o.id)) cls.push("new");
      const tag = o.kind === "written" ? `From the room${o.by ? " · " + esc(o.by) : ""}` : esc(o.label);
      const chips = o.voters
        .map((v) => `<span class="chip${v.id === me ? " me" : ""}">${esc(shortName(v.name))}</span>`)
        .join("");
      return `<button class="${cls.join(" ")}" data-id="${esc(o.id)}" style="--i:${i};--p:${Math.round((o.votes / total) * 100)}%">
        <span class="dare-body"><span class="dare-tag">${tag}</span><span class="dare-text">${esc(o.text)}</span>${chips ? `<span class="chips">${chips}</span>` : ""}</span>
        <span class="dare-count">${o.votes}</span>
      </button>`;
    })
    .join("");

  const veto = $("btn-reshuffle");
  veto.classList.toggle("hidden", !d.canReshuffle);
  veto.classList.toggle("picked", d.myVote === "reshuffle");
  veto.style.setProperty("--p", Math.round((d.reshuffleVotes / total) * 100) + "%");
  $("reshuffle-count").textContent = d.reshuffleVotes;
  $("reshuffle-chips").innerHTML = d.reshuffleVoters
    .map((v) => `<span class="chip${v.id === me ? " me" : ""}">${esc(shortName(v.name))}</span>`)
    .join("");

  renderRoster($("dare-roster"), s.roster, me);
  $("dare-closing").classList.toggle("hidden", !s.timer.closing);
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

// type a dare right on the board: it pops onto everyone's screen and joins the vote
function sendWrite() {
  const input = $("write-dare-input");
  const text = input.value.trim();
  if (!text) return;
  socket.emit("room:addDare", { text }, (res) => {
    const note = $("write-note");
    if (res && res.ok) {
      input.value = "";
      note.textContent = res.live ? "Added. It's on everyone's board now." : "Added. The board's full, so it's queued for the next round.";
    } else {
      note.textContent = (res && res.error) || "Couldn't add that.";
    }
  });
}
$("btn-write-dare").addEventListener("click", sendWrite);
$("write-dare-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendWrite(); });

// ---------- dare locked: in or out ----------
function paintAnswer(answer) {
  $("btn-in").classList.toggle("on", answer === "in");
  $("btn-out").classList.toggle("on", answer === "out");
}
function renderAgree(s) {
  const d = s.lockedDare;
  $("agree-tag").textContent = d.label + (d.by ? " from " + d.by : "");
  $("agree-dare").textContent = d.text;
  renderRoster($("agree-roster"), s.roster, s.you.id);
  paintAnswer(s.you.answer);
  $("agree-closing").classList.toggle("hidden", !s.timer.closing);
  updateProgress("agree", s.progress.done, s.progress.total);
  show("view-agree");
}
function answer(a) {
  if (!state) return;
  state.you.answer = a;
  paintAnswer(a);
  socket.emit("dare:answer", { answer: a });
}
$("btn-in").addEventListener("click", () => answer("in"));
$("btn-out").addEventListener("click", () => answer("out"));

// ---------- countdown ----------
function renderCountdown(s) {
  setBig(s.timer.left);
  $("count-dare").textContent = s.lockedDare.text;
  $("count-sitting").textContent = s.sitting && s.sitting.length ? `Sitting out: ${s.sitting.join(", ")}` : "Everyone's in.";
  show("view-countdown");
}

// ---------- question / vote ----------
function renderQuestion(s) {
  $("question-text").textContent = s.question.text;
  $("question-hint").textContent = s.question.hint;
  const voted = !!s.myVote;
  $("vote-grid").innerHTML = s.targets
    .map(
      (p) => `<button class="vote-btn${s.myVote === p.id ? " picked" : ""}" data-id="${p.id}"${voted ? " disabled" : ""}>${esc(p.name)}</button>`
    )
    .join("");
  $("voted-note").classList.toggle("hidden", !voted);
  $("sit-note").classList.toggle("hidden", voted || !s.you.sittingOut);
  renderRoster($("vote-roster"), s.roster, s.you.id);
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

  $("results-dare").textContent = r.winners.length ? s.lockedDare.text : "Nobody got picked. Dare cancelled.";

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
