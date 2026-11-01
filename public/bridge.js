// My Music backend bridge for the Tailwind UI in index.html.
// It connects window.MyMusicAPI to the real backend in server.js:
//   /api/trending, /api/search, local Library (no sign-in for now),
//   IndexedDB Offline copies, and Downloads.
// Track shape used by the UI: { id, title, artist, album, cover,
//   audioUrl, videoId, duration }
//  - File tracks (added by the user, or with a downloadUrl): audioUrl is
//    the direct file, so the UI's native <audio> engine plays them.
//  - YouTube tracks: audioUrl is null, videoId is the YouTube id, and
//    the patched startPlayback/togglePlay in index.html play them via
//    the youtube-nocookie embed. No stream is extracted, and a YouTube
//    track never pretends to play from the audio element.
(function () {
  // Hidden YouTube embed engine, created by the bridge (the UI file has
  // only the audio engine). Patched playback code in index.html uses it.
  const yt = document.createElement("iframe");
  yt.id = "yt-engine";
  yt.allow = "autoplay; encrypted-media";
  yt.allowFullscreen = true;
  yt.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;border:0;";
  document.body.appendChild(yt);

  const API = window.MyMusicAPI;
  if (!API) return;

  function mapItem(it) {
    const isFile = it && String(it.id || "").startsWith("file-");
    return {
      id: it.id,
      title: it.title || "",
      artist: it.channel || "",
      album: it.channel || "",
      cover: it.thumbnail || "",
      audioUrl: it.downloadUrl || null,
      videoId: isFile ? null : it.id,
      downloadUrl: it.downloadUrl || null,
      duration: 0, // not in the YouTube responses used here; shown as 0:00, not invented
    };
  }
  function artistsFrom(tracks) {
    const seen = new Map();
    tracks.forEach((t) => { if (t.artist && !seen.has(t.artist)) seen.set(t.artist, { id: t.artist, name: t.artist, cover: t.cover, subscribers: "" }); });
    return [...seen.values()];
  }
  function localSaved() { try { return JSON.parse(localStorage.getItem("my_music_saved_tracks") || "[]"); } catch { return []; } }
  function localFiles() { try { return JSON.parse(localStorage.getItem("my_music_file_tracks") || "[]"); } catch { return []; } }
  function saveLocal(track) {
    const list = localSaved();
    if (!list.some((t) => t.id === track.id)) list.push({ id: track.id, title: track.title, channel: track.artist, thumbnail: track.cover, downloadUrl: track.downloadUrl || null });
    localStorage.setItem("my_music_saved_tracks", JSON.stringify(list));
  }

  // ---- IndexedDB offline copies (same store as the previous frontend) ----
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("my-music-offline", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("tracks", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
  }
  async function idb(action, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("tracks", action === "getAll" ? "readonly" : "readwrite");
      const store = tx.objectStore("tracks");
      const req = action === "getAll" ? store.getAll() : action === "put" ? store.put(value) : store.delete(value);
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
  }
  async function offlineTracks() {
    try {
      const copies = await idb("getAll");
      return copies.map((c) => ({ id: c.id, title: c.title, artist: c.channel, album: c.channel, cover: c.thumbnail || "", audioUrl: URL.createObjectURL(c.blob), videoId: null, downloadUrl: c.downloadUrl || null, duration: 0, _offline: true }));
    } catch { return []; }
  }

  let currentTracks = [];
  function setCatalogFor(tracks, opts = {}) {
    currentTracks = tracks;
    API.setCatalog({
      tracks,
      albums: opts.albums || [],
      artists: artistsFrom(tracks),
      playlists: opts.playlists || [{ name: "Saved tracks", sub: "Local library (no sign-in)" }],
      moods: [],
      likedIds: opts.likedIds || localSaved().map((t) => t.id),
    });
  }

  async function loadTrending() {
    API.setLoading(true);
    try {
      const res = await fetch("/api/trending"); const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load trending");
      setCatalogFor((data.items || []).map(mapItem));
    } catch (e) {
      API.notify(e.message);
      setCatalogFor([]);
    } finally { API.setLoading(false); }
  }
  async function loadLibrary() {
    const saved = [...localSaved(), ...localFiles()].map((t) => mapItem({ id: t.id, title: t.title, channel: t.channel, thumbnail: t.thumbnail, downloadUrl: t.downloadUrl || null }));
    setCatalogFor(saved, { likedIds: saved.map((t) => t.id) });
  }
  async function loadOffline() {
    const off = await offlineTracks();
    const files = localFiles().map((t) => mapItem({ id: t.id, title: t.title, channel: t.channel, thumbnail: t.thumbnail, downloadUrl: t.downloadUrl || null }));
    const merged = [...off, ...files.filter((f) => !off.some((o) => o.id === f.id))];
    if (!merged.length) API.notify("Nothing offline yet. Download a file track first — it will appear here and play without internet.");
    setCatalogFor(merged);
  }

  // ---- Download (Downloads folder, or save picker where supported) ----
  function safeName(track) {
    const base = `${track.title || "track"} - ${track.artist || "unknown"}`.replace(/[\\/:*?"<>|]+/g, "").trim() || "track";
    const ext = (track.downloadUrl || track.audioUrl || "").split("?")[0].match(/\.(mp3|m4a|ogg|wav|flac)$/i);
    return base + (ext ? ext[0].toLowerCase() : ".mp3");
  }
  async function downloadTrack(track, pickFolder) {
    let url = track.downloadUrl || track.audioUrl || "";
    if (!url) {
      const pasted = window.prompt(
        "This song is from YouTube, so there is no audio file in this app to download — YouTube streams cannot be saved as a file here.\n\n" +
        "If you have your own / licensed audio file for this song, paste its direct link (MP3 etc.) and it will be downloaded instead. Leave blank to cancel:");
      if (!pasted || !/^https?:\/\//i.test(pasted.trim())) return;
      url = pasted.trim(); track.downloadUrl = url; track.audioUrl = url;
    }
    API.notify("Downloading…");
    let blob = null;
    try {
      const res = await fetch(url); if (!res.ok) throw new Error(`HTTP ${res.status}`); blob = await res.blob();
    } catch {
      const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener";
      document.body.appendChild(a); a.click(); a.remove();
      API.notify("Browser blocked a direct download (CORS), so the file opened instead — on mobile, use the browser menu > Download to save it to Downloads.");
      return;
    }
    const name = safeName({ ...track, downloadUrl: url });
    try {
      if (pickFolder && window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "Audio", accept: { "audio/*": [".mp3", ".m4a", ".ogg", ".wav"] } }] });
        const w = await handle.createWritable(); await w.write(blob); await w.close();
        API.notify(`Saved to the folder you chose as ${name}.`);
      } else {
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        API.notify(`Downloaded ${name} — check Downloads (mobile: Files > Downloads).`);
      }
    } catch (e) {
      if (e && e.name === "AbortError") { API.notify("Save cancelled."); return; }
      API.notify("Could not save that file: " + (e.message || "unknown error")); return;
    }
    try { await idb("put", { id: track.id, title: track.title, channel: track.artist, thumbnail: track.cover || "", downloadUrl: url, blob, savedAt: Date.now() }); } catch { /* offline copy is best-effort */ }
  }
  // Global, so the Download buttons rendered by index.html can call it.
  window.downloadTrackById = function (id) {
    const track = currentTracks.find((t) => String(t.id) === String(id));
    if (track) downloadTrack(track, false); else API.notify("That track is no longer in the list.");
  };

  // Player-bar Download button (the UI file has no download button there).
  function addPlayerDownloadButton() {
    const toggle = document.getElementById("drawer-toggle-btn");
    if (!toggle || document.getElementById("bridge-download-btn")) return;
    const btn = document.createElement("button");
    btn.id = "bridge-download-btn";
    btn.className = "p-2 rounded-full hover:bg-white/10 text-white flex items-center justify-center transition";
    btn.title = "Download current track";
    btn.innerHTML = '<span class="material-symbols-outlined text-xl">download</span>';
    btn.onclick = () => {
      // The UI's queue/currentIndex are top-level globals in index.html's script.
      try {
        const cur = typeof queue !== "undefined" && typeof currentIndex !== "undefined" ? queue[currentIndex] : null;
        if (cur) downloadTrack(cur, false); else API.notify("Play a track first, then download it.");
      } catch { API.notify("Play a track first, then download it."); }
    };
    toggle.parentNode.insertBefore(btn, toggle);
  }

  // Sidebar + mobile nav: Offline, and Add file track.
  function addOfflineNav() {
    const sidebarNav = document.getElementById("nav-links");
    if (sidebarNav && !document.querySelector('[data-nav="offline"]')) {
      const b = document.createElement("button");
      b.dataset.nav = "offline"; b.className = "nav-btn w-full flex items-center gap-5 px-3 py-2.5 rounded-lg hover:bg-white/5 text-zinc-300 font-medium text-sm transition";
      b.innerHTML = '<span class="material-symbols-outlined">download</span><span class="nav-label">Offline</span>';
      b.onclick = async () => { await loadOffline(); window.switchView("home"); API.notify("Offline copies — these play without internet."); };
      sidebarNav.appendChild(b);
    }
    const addBtn = document.createElement("button");
    addBtn.className = "w-full py-2 px-4 rounded-full bg-white/10 hover:bg-white/20 text-white font-medium text-sm flex items-center justify-center gap-2 transition mt-2";
    addBtn.innerHTML = '<span class="material-symbols-outlined text-xl">add</span><span>Add file track</span>';
    addBtn.onclick = () => {
      const title = window.prompt("Song title:"); if (!title) return;
      const artist = window.prompt("Artist (optional):") || "";
      const url = window.prompt("Direct audio link (MP3 etc., that you own or have rights to):");
      if (!url || !/^https?:\/\//i.test(url.trim())) { API.notify("Add a direct http(s) audio link."); return; }
      const item = { id: `file-${Date.now()}`, title: title.trim(), channel: artist.trim(), thumbnail: "", downloadUrl: url.trim() };
      const list = localFiles(); list.push(item); localStorage.setItem("my_music_file_tracks", JSON.stringify(list));
      API.notify("File track added. Open Library to play or download it.");
    };
    const playlistWrap = document.querySelector(".sidebar-extra");
    if (playlistWrap) playlistWrap.appendChild(addBtn);
  }

  // ---- MyMusicAPI event wiring ----
  let searchTimer = null;
  API.on("onSearch", (q) => {
    clearTimeout(searchTimer);
    if (!q) { loadTrending(); return; }
    searchTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`); const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Search failed");
        setCatalogFor((data.items || []).map(mapItem));
        // The UI filters its own list by the typed query; clear that filter
        // so server results are shown as returned, not double-filtered.
        try { searchQuery = ""; renderContent(); } catch { /* render already done by setCatalog */ }
      } catch (e) { API.notify(e.message); }
    }, 350);
  });
  API.on("onTrackPlay", (track) => {
    // YouTube tracks are handled by the patched playback in index.html.
    // File tracks play through the UI's native audio engine.
    void track;
  });
  API.on("onLikeToggle", ({ id, liked }) => {
    if (liked) {
      const track = currentTracks.find((t) => String(t.id) === String(id));
      if (track) saveLocal(track);
      API.notify("Saved to your Library in this browser (no sign-in).");
    } else {
      const list = localSaved().filter((t) => String(t.id) !== String(id));
      localStorage.setItem("my_music_saved_tracks", JSON.stringify(list));
      API.notify("Removed from Library.");
    }
  });
  API.on("onPlaylistSelect", () => { loadLibrary(); window.switchView("library"); });
  API.on("onCastClick", () => API.notify("Cast is not available in this web app."));
  API.on("onProfileClick", () => API.notify("No sign-in needed — Google sign-in is disabled for now."));
  API.on("onCreatePlaylist", (name) => API.notify(`Playlist "${name}" is not saved yet — use Like (Save) to keep tracks in your Library for now.`));

  // Nav clicks: load the right data after the UI switches view.
  document.querySelectorAll('[data-nav="home"], [data-mobile-nav="home"]').forEach((b) => b.addEventListener("click", () => loadTrending()));
  document.querySelectorAll('[data-nav="explore"], [data-mobile-nav="explore"]').forEach((b) => b.addEventListener("click", () => loadTrending()));
  document.querySelectorAll('[data-nav="library"], [data-mobile-nav="library"]').forEach((b) => b.addEventListener("click", () => loadLibrary()));

  // Startup
  document.addEventListener("DOMContentLoaded", () => {
    addPlayerDownloadButton();
    addOfflineNav();
  });
  // If DOMContentLoaded already fired (script order), run now.
  if (document.readyState !== "loading") { addPlayerDownloadButton(); addOfflineNav(); }

  (async () => {
    try {
      const health = await (await fetch("/api/health")).json();
      if (!health.youtubeConfigured) API.notify("YouTube API is not connected yet: set YOUTUBE_API_KEY in Vercel env vars, then redeploy. No sample songs are shown.");
    } catch { /* health is best-effort */ }
    loadTrending();
  })();
})();
