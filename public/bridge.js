// My Music backend bridge for the Tailwind UI in index.html.
// This file is INVISIBLE: it adds no buttons, no nav items, no layout
// changes. It only connects window.MyMusicAPI to the real backend and
// plays YouTube tracks through a hidden embed (see below).
// Track shape used by the UI: { id, title, artist, album, cover,
//   audioUrl, videoId, duration }
//  - File tracks (audioUrl set): the UI's native <audio> engine plays them.
//  - YouTube tracks: audioUrl is null, videoId is the YouTube id. The
//    UI's own startPlayback would otherwise mark them "playing" with no
//    sound, so this bridge plays them through a hidden youtube-nocookie
//    embed instead. No stream is extracted, and no YouTube track ever
//    pretends to play from the audio element.
(function () {
  // YouTube IFrame Player API: this is what makes seek, progress,
  // duration and volume actually work for YouTube tracks. A plain
  // nocookie embed with autoplay cannot report time or seek, so the
  // old hidden-iframe approach left everything at 0:00 and made the
  // scrubber and volume do nothing for YouTube songs.
  const ytDiv = document.createElement("div");
  ytDiv.id = "yt-player-div";
  ytDiv.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;";
  document.body.appendChild(ytDiv);
  // Fallback iframe, used only if the IFrame API never loads.
  const yt = document.createElement("iframe");
  yt.id = "yt-engine";
  yt.allow = "autoplay; encrypted-media";
  yt.allowFullscreen = true;
  yt.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;border:0;";
  document.body.appendChild(yt);
  let ytPlayer = null;
  let ytReady = false;
  let ytPendingId = null;
  window.__ytState = { current: 0, duration: 0 };
  window.__ytSeekTo = (sec) => { try { if (ytPlayer && ytReady) ytPlayer.seekTo(Math.max(0, sec), true); } catch {} };
  window.__ytSetVolume = (vol100) => { try { if (ytPlayer && ytReady) ytPlayer.setVolume(Math.max(0, Math.min(100, vol100))); } catch {} };
  window.__ytPlay = () => { try { if (ytPlayer && ytReady) ytPlayer.playVideo(); } catch {} };
  window.__ytPause = () => { try { if (ytPlayer && ytReady) ytPlayer.pauseVideo(); } catch {} };
  function ytLoad(id) {
    ytPendingId = id;
    if (ytPlayer && ytReady) { yt.src = ""; ytPlayer.loadVideoById(id); }
    else { yt.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`; }
  }
  function ytStop() { ytPendingId = null; yt.src = ""; try { if (ytPlayer && ytReady) ytPlayer.stopVideo(); } catch {} }
  window.onYouTubeIframeAPIReady = () => {
    try {
      ytPlayer = new YT.Player("yt-player-div", {
        height: "1", width: "1",
        playerVars: { autoplay: 0, rel: 0, playsinline: 1 },
        events: {
          onReady: () => { ytReady = true; if (ytPendingId) { yt.src = ""; ytPlayer.loadVideoById(ytPendingId); } },
          onStateChange: (e) => {
            // 0 = ended -> next track (same as the audio element's ended handler)
            if (e.data === 0) { try { if (!isRepeat) nextTrack(); else if (ytPlayer) ytPlayer.playVideo(); } catch {} }
          },
        },
      });
    } catch {}
  };
  const ytScript = document.createElement("script");
  ytScript.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(ytScript);
  // Poll the player for time/duration and repaint the progress UI.
  setInterval(() => {
    try {
      if (ytPlayer && ytReady && typeof ytPlayer.getCurrentTime === "function") {
        window.__ytState = { current: ytPlayer.getCurrentTime() || 0, duration: ytPlayer.getDuration() || 0 };
        if (typeof updateProgressUI === "function") updateProgressUI();
      }
    } catch {}
  }, 500);

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
      duration: it.durationSeconds || 0, // real YouTube duration when the server returns it; 0 only if unknown, never invented
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

  // ---- YouTube playback sync (hidden, no visual change) ----
  // The UI's queue / currentIndex / isPlaying are top-level globals in
  // index.html's script, so they are visible here as global identifiers.
  function syncYouTube() {
    try {
      const cur = queue[currentIndex];
      if (!cur) { ytStop(); return; }
      if (cur.videoId && !cur.audioUrl) {
        if (isPlaying) { if (ytPlayer && ytReady) ytPlayer.playVideo(); else ytLoad(cur.videoId); }
        else { if (ytPlayer && ytReady) ytPlayer.pauseVideo(); else yt.src = ""; }
      } else {
        ytStop();
      }
    } catch { /* queue not ready yet */ }
  }
  API.on("onTrackPlay", (track) => {
    if (track && track.videoId && !track.audioUrl) ytLoad(track.videoId);
    else ytStop();
  });
  function bindPlayPauseSync() {
    const btn = document.getElementById("play-pause-btn");
    if (btn) btn.addEventListener("click", () => setTimeout(syncYouTube, 0));
    // Spacebar also toggles play in the UI; sync after its handler runs.
    document.addEventListener("keydown", (e) => {
      if (e.code === "Space" && !/INPUT|TEXTAREA/.test(document.activeElement && document.activeElement.tagName || "")) {
        setTimeout(syncYouTube, 0);
      }
    });
  }

  // ---- Separate pages: load song / artist / profile data on route change ----
  async function loadRoute(route) {
    if (!route) return;
    try {
      if (route.type === "song") {
        // File tracks are local only: no YouTube lookup, and no error
        // toast. The song page already has the track from the player.
        if (String(route.id).startsWith("file-")) { routeLoading = false; renderContent(); return; }
        // If the player just navigated here, the song is already known:
        // fetch Related in the background without flashing a loading page.
        const alreadyKnown = routeData.song && String(routeData.song.id) === String(route.id);
        if (!alreadyKnown) { routeLoading = true; renderContent(); }
        const [videoRes, relatedRes] = await Promise.all([
          fetch(`/api/video/${encodeURIComponent(route.id)}`),
          fetch(`/api/related/${encodeURIComponent(route.id)}`),
        ]);
        const video = await videoRes.json();
        const related = relatedRes.ok ? await relatedRes.json() : { items: [] };
        if (!videoRes.ok) throw new Error(video.error || "Song not found");
        routeData = { song: mapItem(video), related: (related.items || []).map(mapItem), artistTracks: [], artistName: video.channel || "" };
        routeLoading = false; renderContent();
      } else if (route.type === "artist") {
        routeLoading = true; renderContent();
        const res = await fetch(`/api/artist/${encodeURIComponent(route.name)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Artist not found");
        routeData = { song: null, related: [], artistTracks: (data.items || []).map(mapItem), artistName: route.name };
        routeLoading = false; renderContent();
      } else if (route.type === "profile") {
        await loadLibrary();
        renderContent();
      }
    } catch (e) {
      routeLoading = false;
      API.notify(e.message);
      try { renderContent(); } catch {}
    }
  }
  window.addEventListener("myMusicRoute", (e) => loadRoute(e.detail));

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
  API.on("onProfileClick", () => { try { window.showProfile(); } catch { API.notify("No sign-in needed — Google sign-in is disabled for now."); } });
  API.on("onArtistSelect", (name) => { try { window.showArtist(name); } catch {} });
  API.on("onCreatePlaylist", (name) => API.notify(`Playlist "${name}" is not saved yet — use Like (Save) to keep tracks in your Library for now.`));

  // Nav clicks: load the right data after the UI switches view.
  document.querySelectorAll('[data-nav="home"], [data-mobile-nav="home"]').forEach((b) => b.addEventListener("click", () => loadTrending()));
  document.querySelectorAll('[data-nav="explore"], [data-mobile-nav="explore"]').forEach((b) => b.addEventListener("click", () => loadTrending()));
  document.querySelectorAll('[data-nav="library"], [data-mobile-nav="library"]').forEach((b) => b.addEventListener("click", () => loadLibrary()));

  // Startup
  if (document.readyState !== "loading") bindPlayPauseSync();
  else document.addEventListener("DOMContentLoaded", bindPlayPauseSync);

  (async () => {
    try {
      const health = await (await fetch("/api/health")).json();
      if (!health.youtubeConfigured) API.notify("YouTube API is not connected yet: set YOUTUBE_API_KEY in Vercel env vars, then redeploy. No sample songs are shown.");
    } catch { /* health is best-effort */ }
    // Deep link (parsed by index.html before this script ran) wins over home.
    try {
      if (typeof routePage !== "undefined" && routePage) loadRoute(routePage);
      else loadTrending();
    } catch { loadTrending(); }
  })();
})();
