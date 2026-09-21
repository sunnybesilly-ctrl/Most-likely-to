const socket = io();

let myId = null;
let myCode = null;
let isHost = false;
let selectedDare = null;
let votedThisRound = false;

const $ = (id) => document.getElementById(id);

function show(viewId) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $(viewId).classList.add("active");
}

function setHostVisibility(root) {
  root.querySelectorAll(".host-only").forEach((el) => el.classList.toggle("hidden", !isHost));
  root.querySelectorAll(".non-host-only").forEach((el) => el.classList.toggle("hidden", isHost));
}

socket.on("connect", () => { myId = socket.id; });

// ---------- Landing ----------
$("btn-host").addEventListener("click", () => {
  const name = $("landing-name").value.trim();
  if (!name) return ($("landing-error").textContent = "Enter your name first.");
  socket.emit("host:createRoom", { name }, (res) => {
    if (!res.ok) return ($("landing-error").textContent = res.error || "Couldn't create room.");
    isHost = true;
    myCode = res.code;
    show("view-lobby");
  });
});

$("btn-join").addEventListener("click", () => {
  const name = $("landing-name").value.trim();
  const code = $("landing-code").value.trim().toUpperCase();
  if (!name) return ($("landing-error").textContent = "Enter your name first.");
  if (code.length !== 4) return ($("landing-error").textContent = "Enter the 4-letter room code.");
  socket.emit("player:joinRoom", { code, name }, (res) => {
    if (!res.ok) return ($("landing-error").textContent = res.error || "Couldn't join room.");
    isHost = false;
    myCode = res.code;
    show("view-lobby");
  });
});

// ---------- Room updates ----------
socket.on("room:update", (state) => {
  isHost = state.hostId === myId;
  $("lobby-code").textContent = state.code;

  $("lobby-players").innerHTML = state.players
    .map(
      (p) => `<li><span>${escapeHtml(p.name)}${p.isHost ? '<span class="crown">&#9733;</span>' : ""}</span><span class="score-pill">${p.score} pt${p.score === 1 ? "" : "s"}</span></li>`
    )
    .join("");

  const hostPanel = $("host-controls-lobby");
  const waiting = $("non-host-waiting");
  if (state.phase === "lobby" || state.phase === "dare-select") {
    show("view-lobby");
    if (isHost) {
      hostPanel.classList.remove("hidden");
      waiting.classList.add("hidden");
      renderDareChips(state.dareBank);
      $("btn-lock-dare").disabled = state.players.length < 2;
    } else {
      hostPanel.classList.add("hidden");
      waiting.classList.remove("hidden");
    }
  }
});

function renderDareChips(bank) {
  $("dare-chip-list").innerHTML = bank
    .map((d, i) => `<button class="chip" data-idx="${i}">${escapeHtml(d)}</button>`)
    .join("");
  document.querySelectorAll("#dare-chip-list .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("#dare-chip-list .chip").forEach((c) => c.classList.remove("selected"));
      chip.classList.add("selected");
      selectedDare = chip.textContent;
      $("custom-dare-input").value = "";
      $("btn-lock-dare").disabled = false;
    });
  });
}

$("custom-dare-input").addEventListener("input", (e) => {
  if (e.target.value.trim()) {
    selectedDare = e.target.value.trim();
    document.querySelectorAll("#dare-chip-list .chip").forEach((c) => c.classList.remove("selected"));
    $("btn-lock-dare").disabled = false;
  }
});

$("btn-add-dare").addEventListener("click", () => {
  const text = $("custom-dare-input").value.trim();
  if (!text) return;
  socket.emit("host:addDare", { text });
  selectedDare = text;
  $("btn-lock-dare").disabled = false;
});

$("btn-lock-dare").addEventListener("click", () => {
  if (!selectedDare) return;
  socket.emit("host:setDare", { dareText: selectedDare });
});

// ---------- Dare confirm (broadcast when dare is set) ----------
socket.on("room:update", (state) => {
  if (state.phase === "dare-select" && state.currentDare) {
    $("dare-confirm-text").textContent = state.currentDare;
    setHostVisibility(document.getElementById("view-dare-confirm"));
    show("view-dare-confirm");
  }
});

$("btn-start-round").addEventListener("click", () => {
  socket.emit("host:startRound");
});

// ---------- Round ----------
socket.on("round:start", (data) => {
  votedThisRound = !!data.spectate;
  $("question-text").textContent = data.question;
  $("timer").textContent = data.seconds;
  $("vote-progress").textContent = `0 / ${data.players.length} voted`;
  $("voted-note").classList.toggle("hidden", !votedThisRound);

  $("vote-grid").innerHTML = data.players
    .filter((p) => p.id !== myId)
    .map((p) => `<button class="vote-btn" data-id="${p.id}">${escapeHtml(p.name)}</button>`)
    .join("");

  document.querySelectorAll(".vote-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (votedThisRound) return;
      votedThisRound = true;
      document.querySelectorAll(".vote-btn").forEach((b) => b.disabled = true);
      btn.classList.add("picked");
      socket.emit("player:vote", { targetId: btn.dataset.id });
      $("voted-note").classList.remove("hidden");
    });
  });

  show("view-question");
});

socket.on("round:tick", ({ timeLeft, votesIn, totalPlayers }) => {
  $("timer").textContent = Math.max(timeLeft, 0);
  $("vote-progress").textContent = `${votesIn} / ${totalPlayers} voted`;
});

// ---------- Results ----------
socket.on("round:results", ({ results, dare, winners }) => {
  $("winner-name").textContent = winners.length ? winners.join(" & ") : "No votes cast";
  $("results-dare").textContent = dare || "";

  const maxVotes = Math.max(...results.map((r) => r.votes), 1);
  $("results-bars").innerHTML = results
    .sort((a, b) => b.votes - a.votes)
    .map(
      (r) => `<div class="bar-row">
        <div class="bar-name">${escapeHtml(r.name)}</div>
        <div class="bar-track"><div class="bar-fill ${r.isWinner ? "winner" : ""}" style="width:${(r.votes / maxVotes) * 100}%"></div></div>
        <div class="bar-count">${r.votes}</div>
      </div>`
    )
    .join("");

  setHostVisibility(document.getElementById("view-results"));
  show("view-results");
});

$("btn-next-round").addEventListener("click", () => socket.emit("host:nextRound"));
$("btn-end-game").addEventListener("click", () => socket.emit("host:endGame"));

// ---------- Ended ----------
socket.on("game:ended", ({ players }) => {
  const ranked = [...players].sort((a, b) => b.score - a.score);
  $("final-scores").innerHTML = ranked
    .map((p, i) => `<li><span class="rank">${i + 1}</span><span class="rank-name">${escapeHtml(p.name)}</span><span class="rank-score">${p.score} pt${p.score === 1 ? "" : "s"}</span></li>`)
    .join("");
  show("view-ended");
});

$("btn-play-again").addEventListener("click", () => location.reload());

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
