// My Music frontend — music.youtube.com-style UI, wired to the real backend.
// No sample tracks: content comes from /api/search, /api/trending,
// /api/library, file tracks the user adds, or offline copies already
// downloaded in this browser. Duration is shown as — because the
// YouTube search/trending responses used here do not include it;
// it is not invented.
//
// Downloads (see README): a direct audio file can be downloaded to
// Downloads (mobile: Files > Downloads) or, where supported, to a
// folder the user picks, and a copy is kept in IndexedDB for Offline.
// YouTube tracks have no file here and are not stream-extracted:
// Download on one asks the user to attach their own / licensed file.
const grid = document.getElementById("grid");
const listEmpty = document.getElementById("listEmpty");
const homeEmpty = document.getElementById("empty");
const titleEl = document.getElementById("sectionTitle");
const noticeEl = document.getElementById("notice");
const authArea = document.getElementById("authArea");
const homeView = document.getElementById("homeView");
const listView = document.getElementById("listView");
const addFileBox = document.getElementById("addFileBox");
let user = null, current = null, view = "home";
let queue = [], queueIndex = -1, isPlaying = false, shuffleOn = false, repeatOn = false;
let lastTrending = [], lastLibrary = [];

function showNotice(msg) { noticeEl.hidden = false; noticeEl.textContent = msg; }
function escapeHtml(s) { return String(s || "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function safeName(item) {
  const base = `${item.title || "track"} - ${item.channel || "unknown"}`.replace(/[\\/:*?"<>|]+/g, "").trim() || "track";
  const ext = (item.downloadUrl || "").split("?")[0].match(/\.(mp3|m4a|ogg|wav|flac)$/i);
  return base + (ext ? ext[0].toLowerCase() : ".mp3");
}
function setActiveView(v) {
  document.querySelectorAll(".nav").forEach((x) => x.classList.toggle("active", x.dataset.view === v));
}
function showView(v) {
  view = v; setActiveView(v); noticeEl.hidden = true;
  document.getElementById("sidebar").classList.remove("open");
  if (v === "home" || v === "explore") {
    homeView.hidden = false; listView.hidden = true;
    document.getElementById("trendingTitle").textContent = v === "explore" ? "Explore" : "Trending music";
    if (!lastTrending.length) loadTrending(); else renderHome(lastTrending);
  } else if (v === "library") { homeView.hidden = true; listView.hidden = false; loadLibrary(); }
  else if (v === "offline") { homeView.hidden = true; listView.hidden = false; loadOffline(); }
}

// ---------- IndexedDB offline copies ----------
function openOfflineDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("my-music-offline", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("tracks", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
}
async function idb(action, value) {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("tracks", action === "getAll" ? "readonly" : "readwrite");
    const store = tx.objectStore("tracks");
    const req = action === "getAll" ? store.getAll() : action === "put" ? store.put(value) : store.delete(value);
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
}
async function saveOfflineCopy(item, blob) {
  try { await idb("put", { id: item.id, title: item.title, channel: item.channel, thumbnail: item.thumbnail || "", downloadUrl: item.downloadUrl || "", blob, savedAt: Date.now() }); return true; } catch { return false; }
}
async function getOfflineCopies() { try { return await idb("getAll"); } catch { return []; } }
function localFileTracks() { try { return JSON.parse(localStorage.getItem("my_music_file_tracks") || "[]"); } catch { return []; } }
function addLocalFileTrack(item) {
  const list = localFileTracks();
  if (!list.some((t) => t.id === item.id)) list.push(item);
  localStorage.setItem("my_music_file_tracks", JSON.stringify(list));
}

// ---------- Cards / rows ----------
function card(item, opts = {}) {
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = `<div class="card-art${opts.circle ? " circle" : ""}">${item.thumbnail ? `<img src="${escapeHtml(item.thumbnail)}" alt="">` : ""}<div class="card-play">▶</div></div>
    <b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.channel)}</span>
    <div class="card-actions"><button class="play-btn">Play</button><button class="download-btn">Download</button></div>`;
  el.querySelector(".card-art").onclick = () => (opts.playOffline ? playOffline(item) : play(item, opts.list || [item]));
  el.querySelector(".play-btn").onclick = () => (opts.playOffline ? playOffline(item) : play(item, opts.list || [item]));
  el.querySelector(".download-btn").onclick = (e) => { e.stopPropagation(); downloadTrack(item, {}); };
  return el;
}
function renderGrid(items, opts = {}) {
  grid.innerHTML = ""; listEmpty.hidden = items.length > 0;
  items.forEach((item) => grid.appendChild(card(item, opts)));
}
function renderHome(items) {
  lastTrending = items;
  const row = document.getElementById("trendingRow"); row.innerHTML = "";
  items.forEach((item) => row.appendChild(card(item, { list: items })));
  // Artists carousel: unique channels, circle crop
  const seen = new Map();
  items.forEach((it) => { if (it.channel && !seen.has(it.channel)) seen.set(it.channel, it); });
  const arow = document.getElementById("artistRow"); arow.innerHTML = "";
  [...seen.values()].forEach((it) => {
    const c = card({ id: it.id, title: it.channel, channel: "Artist", thumbnail: it.thumbnail, downloadUrl: null }, { circle: true, list: items });
    c.querySelector(".download-btn").remove();
    arow.appendChild(c);
  });
  // Hero: first trending track
  const hero = document.getElementById("hero");
  if (items[0]) {
    hero.hidden = false;
    document.getElementById("heroArt").src = items[0].thumbnail || "";
    document.getElementById("heroTitle").textContent = items[0].title;
    document.getElementById("heroSub").textContent = items[0].channel;
    document.getElementById("heroPlay").onclick = () => play(items[0], items);
    document.getElementById("heroShuffle").onclick = () => play(items[Math.floor(Math.random() * items.length)], items);
  } else hero.hidden = true;
  // Song table
  const body = document.getElementById("songTableBody"); body.innerHTML = "";
  items.forEach((item, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="row-num">${i + 1}</td>
      <td><div class="row-title">${escapeHtml(item.title)}</div><div class="row-artist">${escapeHtml(item.channel)}</div></td>
      <td>${escapeHtml(item.channel)}</td><td class="row-dur">—</td>
      <td><button class="row-play" aria-label="Play">▶</button><button class="row-dl">Download</button></td>`;
    tr.querySelector(".row-play").onclick = () => play(item, items);
    tr.querySelector(".row-dl").onclick = () => downloadTrack(item, {});
    body.appendChild(tr);
  });
  homeEmpty.hidden = items.length > 0;
  // Mixes + playlists in sidebar
  const mixList = document.getElementById("mixList"); mixList.innerHTML = "";
  for (let m = 0; m < 3 && items.length; m++) {
    const mix = items.slice(m * 5, m * 5 + 5); if (!mix.length) break;
    const b = document.createElement("button"); b.className = "mix-item"; b.textContent = `Mix ${m + 1} • ${mix[0].channel}`;
    b.onclick = () => play(mix[0], mix); mixList.appendChild(b);
  }
}

// ---------- Playback / queue ----------
function updatePlayerUI() {
  const frame = document.getElementById("playerFrame"), audio = document.getElementById("audioPlayer");
  document.getElementById("playerArt").src = current ? (current.thumbnail || "") : "";
  document.getElementById("nowTitle").textContent = current ? current.title : "";
  document.getElementById("nowChannel").textContent = current ? current.channel : "";
  document.getElementById("expArt").src = current ? (current.thumbnail || "") : "";
  document.getElementById("expTitle").textContent = current ? current.title : "";
  document.getElementById("expChannel").textContent = current ? current.channel : "";
  document.getElementById("playPauseBtn").textContent = isPlaying ? "⏸" : "▶";
  document.getElementById("playingDot").hidden = !isPlaying;
  const q = document.getElementById("expQueue"); q.innerHTML = "";
  queue.forEach((it, i) => {
    const b = document.createElement("button"); b.textContent = `${i === queueIndex ? "▶ " : ""}${it.title} — ${it.channel}`;
    b.onclick = () => play(it, queue); q.appendChild(b);
  });
  document.querySelectorAll("#songTableBody tr").forEach((tr, i) => tr.classList.toggle("playing", current && queue === lastTrending && i === queueIndex));
  void frame; void audio;
}
function play(item, list) {
  if (list) { queue = list; queueIndex = list.indexOf(item); if (queueIndex < 0) queueIndex = 0; }
  current = item; isPlaying = true;
  document.getElementById("player").hidden = false;
  const frame = document.getElementById("playerFrame"), audio = document.getElementById("audioPlayer");
  if (item.id && String(item.id).startsWith("file-") && item.downloadUrl) {
    frame.hidden = true; frame.src = "";
    audio.hidden = false; audio.src = item.downloadUrl; audio.loop = repeatOn; audio.play().catch(() => {});
  } else {
    audio.hidden = true; audio.pause(); audio.removeAttribute("src");
    frame.hidden = false;
    frame.src = `https://www.youtube-nocookie.com/embed/${item.id}?autoplay=1&rel=0`;
  }
  updatePlayerUI();
}
function playOffline(item) {
  queue = [item]; queueIndex = 0; current = item; isPlaying = true;
  document.getElementById("player").hidden = false;
  const frame = document.getElementById("playerFrame"), audio = document.getElementById("audioPlayer");
  frame.hidden = true; frame.src = "";
  audio.hidden = false; audio.src = item._objectUrl || item.downloadUrl || ""; audio.loop = repeatOn; audio.play().catch(() => {});
  document.getElementById("nowTitle").textContent = item.title + " (offline)";
  updatePlayerUI();
}
function step(dir) {
  if (!queue.length || queueIndex < 0) return;
  if (shuffleOn) { play(queue[Math.floor(Math.random() * queue.length)], queue); return; }
  queueIndex = (queueIndex + dir + queue.length) % queue.length;
  play(queue[queueIndex], queue);
}

// ---------- Download ----------
async function downloadTrack(item, { pickFolder = false } = {}) {
  let url = item.downloadUrl || "";
  if (!url) {
    const pasted = window.prompt(
      "This song is from YouTube, so there is no audio file in this app to download — YouTube streams cannot be saved as a file here.\n\n" +
      "If you have your own / licensed audio file for this song, paste its direct link (MP3 etc.) and it will be downloaded instead. Leave blank to cancel:");
    if (!pasted || !/^https?:\/\//i.test(pasted.trim())) return;
    url = pasted.trim(); item.downloadUrl = url;
    if (user) {
      try { await fetch("/api/library/download-url", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: user.email, video_id: item.id, download_url: url }) }); } catch { /* local download still works */ }
    }
  }
  showNotice("Downloading…");
  let blob = null;
  try {
    const res = await fetch(url); if (!res.ok) throw new Error(`HTTP ${res.status}`); blob = await res.blob();
  } catch {
    const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    showNotice("Your browser blocked a direct download of that file (CORS), so it opened instead — on mobile, use the browser menu > Download to save it to Downloads.");
    return;
  }
  const name = safeName({ ...item, downloadUrl: url });
  try {
    if (pickFolder && window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "Audio", accept: { "audio/*": [".mp3", ".m4a", ".ogg", ".wav"] } }] });
      const writable = await handle.createWritable(); await writable.write(blob); await writable.close();
      showNotice(`Saved to the folder you chose as ${name}. A copy is also kept offline in this app.`);
    } else {
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      showNotice(`Downloaded ${name} — check your Downloads folder (on mobile: Files > Downloads). A copy is also kept offline in this app.`);
    }
  } catch (e) {
    if (e && e.name === "AbortError") { showNotice("Save cancelled."); return; }
    showNotice("Could not save that file: " + (e.message || "unknown error")); return;
  }
  await saveOfflineCopy({ ...item, downloadUrl: url }, blob);
}

// ---------- Views ----------
async function loadTrending() {
  const res = await fetch("/api/trending"); const data = await res.json();
  if (!res.ok) { showNotice(data.error || "Could not load trending."); renderHome([]); return; }
  noticeEl.hidden = true; renderHome(data.items || []);
}
async function loadLibrary() {
  titleEl.textContent = "Your Library"; addFileBox.hidden = true;
  if (!user) { showNotice("Sign in with Google to see your saved tracks."); renderGrid([]); return; }
  const res = await fetch(`/api/library?email=${encodeURIComponent(user.email)}`); const data = await res.json();
  if (!res.ok) { showNotice(data.error || "Could not load library."); renderGrid([]); return; }
  lastLibrary = data.tracks || []; noticeEl.hidden = true;
  const pl = document.getElementById("playlistList"); pl.innerHTML = "";
  if (lastLibrary.length) {
    const b = document.createElement("button"); b.className = "playlist-item"; b.textContent = `Saved tracks (${lastLibrary.length})`;
    b.onclick = () => showView("library"); pl.appendChild(b);
  } else pl.innerHTML = '<p class="hint">Saved tracks appear here as a playlist.</p>';
  renderGrid(lastLibrary, { list: lastLibrary });
}
async function loadOffline() {
  titleEl.textContent = "Offline — downloaded in this app"; addFileBox.hidden = false;
  const copies = await getOfflineCopies(); const files = localFileTracks();
  const items = [...copies.map((c) => ({ ...c, _objectUrl: URL.createObjectURL(c.blob), _offline: true })), ...files.filter((f) => !copies.some((c) => c.id === f.id))];
  if (!items.length) showNotice("Nothing offline yet. Tap Download on a file track, or add your own audio file below — it will appear here and play without internet.");
  else noticeEl.hidden = true;
  grid.innerHTML = ""; listEmpty.hidden = items.length > 0;
  items.forEach((item) => {
    const el = card(item, { playOffline: !!item._offline, list: items });
    if (item._offline) {
      const del = document.createElement("button"); del.className = "download-btn"; del.textContent = "Remove offline copy";
      del.onclick = async () => { await idb("delete", item.id); loadOffline(); };
      el.querySelector(".card-actions").appendChild(del);
    }
    grid.appendChild(el);
  });
}
async function runSearch(q) {
  titleEl.textContent = `Results for "${q}"`; homeView.hidden = true; listView.hidden = false; addFileBox.hidden = true;
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`); const data = await res.json();
  if (!res.ok) { showNotice(data.error || "Search failed."); renderGrid([]); return; }
  noticeEl.hidden = true; renderGrid(data.items || [], { list: data.items || [] });
  document.getElementById("suggestBox").hidden = true;
}

// ---------- Events ----------
document.querySelectorAll(".nav").forEach((btn) => btn.addEventListener("click", () => showView(btn.dataset.view)));
document.getElementById("menuBtn").addEventListener("click", () => {
  const sb = document.getElementById("sidebar");
  if (window.innerWidth <= 640) sb.classList.toggle("open"); else sb.classList.toggle("collapsed");
});
document.getElementById("logoLink").addEventListener("click", (e) => { e.preventDefault(); showView("home"); });
document.querySelectorAll(".car-arrow").forEach((btn) => btn.addEventListener("click", () => {
  const row = document.getElementById(btn.dataset.target);
  row.scrollBy({ left: btn.classList.contains("left") ? -400 : 400, behavior: "smooth" });
}));
document.getElementById("searchForm").addEventListener("submit", (e) => {
  e.preventDefault(); const q = document.getElementById("searchInput").value.trim(); if (q) runSearch(q);
});
document.getElementById("searchInput").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase(); const box = document.getElementById("suggestBox");
  if (!q) { box.hidden = true; return; }
  const pool = [...lastTrending, ...lastLibrary].filter((it) => (it.title + " " + it.channel).toLowerCase().includes(q)).slice(0, 6);
  if (!pool.length) { box.hidden = true; return; }
  box.innerHTML = ""; box.hidden = false;
  pool.forEach((it) => { const b = document.createElement("button"); b.textContent = `${it.title} — ${it.channel}`; b.onclick = () => runSearch(it.title); box.appendChild(b); });
});
document.getElementById("micBtn").addEventListener("click", () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showNotice("Voice search is not supported in this browser."); return; }
  const rec = new SR(); rec.onresult = (ev) => { document.getElementById("searchInput").value = ev.results[0][0].transcript; runSearch(ev.results[0][0].transcript); }; rec.start();
});
document.getElementById("castBtn").addEventListener("click", () => showNotice("Cast is not available in this web app."));
document.getElementById("settingsBtn").addEventListener("click", () => showNotice("Settings: Downloads go to Downloads (mobile: Files > Downloads). On desktop Chrome, use “Save to a folder…” to pick a path. Offline copies are kept in this browser under Offline."));
document.getElementById("trendingSeeAll").addEventListener("click", () => { homeView.hidden = true; listView.hidden = false; titleEl.textContent = "Trending music"; renderGrid(lastTrending, { list: lastTrending }); });
document.getElementById("prevBtn").addEventListener("click", () => step(-1));
document.getElementById("nextBtn").addEventListener("click", () => step(1));
document.getElementById("shuffleBtn").addEventListener("click", (e) => { shuffleOn = !shuffleOn; e.currentTarget.style.color = shuffleOn ? "#FF0000" : ""; });
document.getElementById("repeatBtn").addEventListener("click", (e) => { repeatOn = !repeatOn; document.getElementById("audioPlayer").loop = repeatOn; e.currentTarget.style.color = repeatOn ? "#FF0000" : ""; });
document.getElementById("playPauseBtn").addEventListener("click", () => {
  if (!current) return;
  const audio = document.getElementById("audioPlayer"), frame = document.getElementById("playerFrame");
  if (!audio.hidden) { if (audio.paused) audio.play().catch(() => {}); else audio.pause(); isPlaying = !audio.paused; }
  else { if (isPlaying) { frame.src = ""; isPlaying = false; } else { frame.src = `https://www.youtube-nocookie.com/embed/${current.id}?autoplay=1&rel=0`; isPlaying = true; } }
  updatePlayerUI();
});
document.getElementById("volumeSlider").addEventListener("input", (e) => { document.getElementById("audioPlayer").volume = e.target.value / 100; });
document.getElementById("lyricsBtn").addEventListener("click", () => { if (current) document.getElementById("expanded").hidden = false; });
document.getElementById("queueBtn").addEventListener("click", () => { if (current) document.getElementById("expanded").hidden = false; });
document.getElementById("expandBtn").addEventListener("click", () => { if (current) document.getElementById("expanded").hidden = false; });
document.getElementById("collapseBtn").addEventListener("click", () => { document.getElementById("expanded").hidden = true; });
document.getElementById("saveBtn").addEventListener("click", async () => {
  if (!current) return;
  if (!user) { alert("Sign in with Google first, then save."); return; }
  const res = await fetch("/api/library", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ email: user.email, video_id: current.id, title: current.title, channel: current.channel, thumbnail: current.thumbnail, download_url: current.downloadUrl || "" }) });
  const data = await res.json(); alert(res.ok ? "Saved to your Library." : (data.error || "Could not save."));
});
document.getElementById("downloadBtn").addEventListener("click", () => { if (current) downloadTrack(current, {}); });
document.getElementById("saveFolderBtn").addEventListener("click", () => { if (current) downloadTrack(current, { pickFolder: true }); });
if (!window.showSaveFilePicker) document.getElementById("saveFolderBtn").hidden = true;
document.getElementById("addFileForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("fileTitle").value.trim(), channel = document.getElementById("fileChannel").value.trim(), url = document.getElementById("fileUrl").value.trim();
  if (!title || !/^https?:\/\//i.test(url)) { alert("Add a title and a direct audio link (http/https)."); return; }
  const item = { id: `file-${Date.now()}`, title, channel, thumbnail: "", downloadUrl: url };
  addLocalFileTrack(item);
  if (user) { try { await fetch("/api/library", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ email: user.email, video_id: item.id, title, channel, thumbnail: "", download_url: url }) }); } catch { /* local copy still works */ } }
  e.target.reset(); showNotice("File track added. Tap Download on it to save it to Downloads / a folder you pick, and to keep it offline in this app."); loadOffline();
});
(async () => {
  const health = await (await fetch("/api/health")).json();
  if (!health.youtubeConfigured) showNotice("YouTube API is not connected yet: add YOUTUBE_DATA_API to the .env file in the root folder, then restart the server. No sample songs are shown in the meantime.");
  const me = await (await fetch("/api/me")).json(); user = me.user;
  authArea.innerHTML = user
    ? `<span class="avatar">${escapeHtml((user.name || user.email || "?")[0].toUpperCase())}</span> &nbsp; <a href="/auth/logout">Sign out</a>`
    : `<a href="/auth/google">Sign in with Google</a>`;
  loadTrending();
})();
