// My Music frontend. No hardcoded / sample tracks: the grid is only
// ever filled from /api/search, /api/trending or /api/library, from
// a file track the user adds themselves, or from offline copies the
// user has already downloaded in this browser.
//
// DOWNLOADS — what this can and cannot do, honestly:
// * A track that has a direct audio file (a file track the user added,
//   or a saved track with a download_url the user attached) CAN be
//   downloaded: "Download" sends it to the browser's Downloads folder
//   (on mobile, that is the phone's Downloads folder), and
//   "Save to a folder…" opens the browser's save picker where it is
//   supported (desktop Chrome) so the user picks the path. A copy is
//   also kept in IndexedDB, so it plays offline inside the app.
// * A YouTube track has NO audio file in this app — playback is the
//   YouTube embed. This app does not extract YouTube streams, so the
//   Download button on a YouTube track asks the user to attach their
//   own / licensed file link for that song instead of faking a download.
//   YouTube's own offline saving stays inside the YouTube app (Premium).
const grid = document.getElementById("grid");
const emptyEl = document.getElementById("empty");
const titleEl = document.getElementById("sectionTitle");
const noticeEl = document.getElementById("notice");
const authArea = document.getElementById("authArea");
const addFileBox = document.getElementById("addFileBox");
let user = null;
let current = null;
let view = "home";

function showNotice(msg) {
  noticeEl.hidden = false;
  noticeEl.textContent = msg;
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function safeName(item) {
  const base = `${item.title || "track"} - ${item.channel || "unknown"}`.replace(/[\\/:*?"<>|]+/g, "").trim() || "track";
  const ext = (item.downloadUrl || "").split("?")[0].match(/\.(mp3|m4a|ogg|wav|flac)$/i);
  return base + (ext ? ext[0].toLowerCase() : ".mp3");
}

// ---------- IndexedDB: offline copies kept inside the app ----------
function openOfflineDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("my-music-offline", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("tracks", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idb(action, value) {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("tracks", action === "getAll" ? "readonly" : "readwrite");
    const store = tx.objectStore("tracks");
    const req = action === "getAll" ? store.getAll() : action === "put" ? store.put(value) : store.delete(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveOfflineCopy(item, blob) {
  try {
    await idb("put", { id: item.id, title: item.title, channel: item.channel, thumbnail: item.thumbnail || "", downloadUrl: item.downloadUrl || "", blob, savedAt: Date.now() });
    return true;
  } catch { return false; }
}
async function getOfflineCopies() {
  try { return await idb("getAll"); } catch { return []; }
}

// ---------- Local file tracks (added by the user, no account needed) ----------
function localFileTracks() {
  try { return JSON.parse(localStorage.getItem("my_music_file_tracks") || "[]"); } catch { return []; }
}
function addLocalFileTrack(item) {
  const list = localFileTracks();
  if (!list.some((t) => t.id === item.id)) list.push(item);
  localStorage.setItem("my_music_file_tracks", JSON.stringify(list));
}

// ---------- Cards ----------
function card(item, opts = {}) {
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = `${item.thumbnail ? `<img src="${escapeHtml(item.thumbnail)}" alt="">` : ""}
    <div class="card-body"><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.channel)}</span></div>
    <div class="card-actions">
      <button class="play-btn">Play</button>
      <button class="download-btn">Download</button>
    </div>`;
  el.querySelector(".play-btn").onclick = () => (opts.playOffline ? playOffline(item) : play(item));
  el.querySelector(".download-btn").onclick = (e) => { e.stopPropagation(); downloadTrack(item, {}); };
  return el;
}
function render(items, opts = {}) {
  grid.innerHTML = "";
  emptyEl.hidden = items.length > 0;
  items.forEach((item) => grid.appendChild(card(item, opts)));
}

// ---------- Playback ----------
function play(item) {
  current = item;
  document.getElementById("player").hidden = false;
  const frame = document.getElementById("playerFrame");
  const audio = document.getElementById("audioPlayer");
  if (item.id && String(item.id).startsWith("file-") && item.downloadUrl) {
    frame.hidden = true; frame.src = "";
    audio.hidden = false; audio.src = item.downloadUrl; audio.play().catch(() => {});
  } else {
    audio.hidden = true; audio.pause(); audio.removeAttribute("src");
    frame.hidden = false;
    // Privacy-enhanced embed (youtube-nocookie.com). See README: ads can
    // still appear on monetised videos; only YouTube Premium is guaranteed ad-free.
    frame.src = `https://www.youtube-nocookie.com/embed/${item.id}?autoplay=1&rel=0`;
  }
  document.getElementById("nowTitle").textContent = item.title;
  document.getElementById("nowChannel").textContent = item.channel;
}
function playOffline(item) {
  current = item;
  document.getElementById("player").hidden = false;
  const frame = document.getElementById("playerFrame");
  const audio = document.getElementById("audioPlayer");
  frame.hidden = true; frame.src = "";
  audio.hidden = false;
  audio.src = item._objectUrl || item.downloadUrl || "";
  audio.play().catch(() => {});
  document.getElementById("nowTitle").textContent = item.title + " (offline)";
  document.getElementById("nowChannel").textContent = item.channel;
}

// ---------- Download ----------
// pickFolder=true -> browser save picker (user chooses the folder/file).
// pickFolder=false -> normal browser download, which on mobile and on
// desktop with default settings lands in the Downloads folder.
async function downloadTrack(item, { pickFolder = false } = {}) {
  let url = item.downloadUrl || "";
  if (!url) {
    // YouTube track: no file exists to download. Do not extract the stream.
    // Let the user attach their own / licensed file for this song instead.
    const pasted = window.prompt(
      "This song is from YouTube, so there is no audio file in this app to download — " +
      "YouTube streams cannot be saved as a file here.\n\n" +
      "If you have your own / licensed audio file for this song, paste its direct link (MP3 etc.) " +
      "and it will be downloaded instead. Leave blank to cancel:"
    );
    if (!pasted || !/^https?:\/\//i.test(pasted.trim())) return;
    url = pasted.trim();
    item.downloadUrl = url;
    if (user) {
      try {
        await fetch("/api/library/download-url", {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: user.email, video_id: item.id, download_url: url }),
        });
      } catch { /* local download still works even if the save fails */ }
    }
  }
  showNotice("Downloading…");
  let blob = null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
  } catch {
    // Cross-origin hosts often block fetch (CORS). Fall back to a normal
    // link: on mobile, long-press > Download, or the browser's download
    // menu. This still goes to Downloads, it just cannot be forced.
    const a = document.createElement("a");
    a.href = url; a.target = "_blank"; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    showNotice("Your browser blocked a direct download of that file (CORS), so it opened instead — on mobile, use the browser menu > Download to save it to Downloads.");
    return;
  }
  const name = safeName({ ...item, downloadUrl: url });
  try {
    if (pickFolder && window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "Audio", accept: { "audio/*": [".mp3", ".m4a", ".ogg", ".wav"] } }] });
      const writable = await handle.createWritable();
      await writable.write(blob); await writable.close();
      showNotice(`Saved to the folder you chose as ${name}. A copy is also kept offline in this app.`);
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      showNotice(`Downloaded ${name} — check your Downloads folder (on mobile: Files > Downloads). A copy is also kept offline in this app.`);
    }
  } catch (e) {
    if (e && e.name === "AbortError") { showNotice("Save cancelled."); return; }
    showNotice("Could not save that file: " + (e.message || "unknown error"));
    return;
  }
  await saveOfflineCopy({ ...item, downloadUrl: url }, blob);
}

async function loadTrending() {
  titleEl.textContent = "Trending music";
  addFileBox.hidden = true;
  const res = await fetch("/api/trending");
  const data = await res.json();
  if (!res.ok) { showNotice(data.error || "Could not load trending."); render([]); return; }
  noticeEl.hidden = true;
  render(data.items || []);
}
async function loadLibrary() {
  titleEl.textContent = "Your Library";
  addFileBox.hidden = true;
  if (!user) { showNotice("Sign in with Google to see your saved tracks."); render([]); return; }
  const res = await fetch(`/api/library?email=${encodeURIComponent(user.email)}`);
  const data = await res.json();
  if (!res.ok) { showNotice(data.error || "Could not load library."); render([]); return; }
  noticeEl.hidden = true;
  render(data.tracks || []);
}
async function loadOffline() {
  titleEl.textContent = "Offline — downloaded in this app";
  addFileBox.hidden = false;
  const copies = await getOfflineCopies();
  const files = localFileTracks();
  const items = [
    ...copies.map((c) => ({ ...c, _objectUrl: URL.createObjectURL(c.blob), _offline: true })),
    ...files.filter((f) => !copies.some((c) => c.id === f.id)),
  ];
  if (!items.length) {
    showNotice("Nothing offline yet. Tap Download on a file track, or add your own audio file below — it will appear here and play without internet.");
  } else {
    noticeEl.hidden = true;
  }
  grid.innerHTML = "";
  emptyEl.hidden = items.length > 0;
  items.forEach((item) => {
    const el = card(item, { playOffline: !!item._offline });
    if (item._offline) {
      const del = document.createElement("button");
      del.className = "download-btn"; del.textContent = "Remove offline copy";
      del.onclick = async () => { await idb("delete", item.id); loadOffline(); };
      el.querySelector(".card-actions").appendChild(del);
    }
    grid.appendChild(el);
  });
}

document.getElementById("searchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = document.getElementById("searchInput").value.trim();
  if (!q) return;
  titleEl.textContent = `Results for "${q}"`;
  addFileBox.hidden = true;
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  const data = await res.json();
  if (!res.ok) { showNotice(data.error || "Search failed."); render([]); return; }
  noticeEl.hidden = true;
  render(data.items || []);
});
document.querySelectorAll(".nav").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav").forEach((x) => x.classList.remove("active"));
    btn.classList.add("active");
    view = btn.dataset.view;
    noticeEl.hidden = true;
    if (view === "library") loadLibrary();
    else if (view === "offline") loadOffline();
    else loadTrending();
  });
});
document.getElementById("saveBtn").addEventListener("click", async () => {
  if (!current) return;
  if (!user) { alert("Sign in with Google first, then save."); return; }
  const res = await fetch("/api/library", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ email: user.email, video_id: current.id, title: current.title, channel: current.channel, thumbnail: current.thumbnail, download_url: current.downloadUrl || "" }),
  });
  const data = await res.json();
  alert(res.ok ? "Saved to your Library." : (data.error || "Could not save."));
});
document.getElementById("downloadBtn").addEventListener("click", () => { if (current) downloadTrack(current, {}); });
document.getElementById("saveFolderBtn").addEventListener("click", () => { if (current) downloadTrack(current, { pickFolder: true }); });
if (!window.showSaveFilePicker) document.getElementById("saveFolderBtn").hidden = true;
document.getElementById("addFileForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("fileTitle").value.trim();
  const channel = document.getElementById("fileChannel").value.trim();
  const url = document.getElementById("fileUrl").value.trim();
  if (!title || !/^https?:\/\//i.test(url)) { alert("Add a title and a direct audio link (http/https)."); return; }
  const item = { id: `file-${Date.now()}`, title, channel, thumbnail: "", downloadUrl: url };
  addLocalFileTrack(item);
  if (user) {
    try {
      await fetch("/api/library", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ email: user.email, video_id: item.id, title, channel, thumbnail: "", download_url: url }),
      });
    } catch { /* local copy still works */ }
  }
  e.target.reset();
  showNotice("File track added. Tap Download on it to save it to Downloads / a folder you pick, and to keep it offline in this app.");
  loadOffline();
});
(async () => {
  const health = await (await fetch("/api/health")).json();
  if (!health.youtubeConfigured) {
    showNotice("YouTube API is not connected yet: add YOUTUBE_DATA_API to the .env file in the root folder, then restart the server. No sample songs are shown in the meantime.");
  }
  const me = await (await fetch("/api/me")).json();
  user = me.user;
  authArea.innerHTML = user
    ? `${escapeHtml(user.name || user.email)} &nbsp; <a href="/auth/logout">Sign out</a>`
    : `<a href="/auth/google">Sign in with Google</a>`;
  loadTrending();
})();
