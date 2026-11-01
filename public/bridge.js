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
            // 0 = ended -> autoplay: recommended next if autoplay is on,
            // otherwise the next track in the queue.
            if (e.data === 0) { try {
              if (isRepeat && ytPlayer) ytPlayer.playVideo();
              else if (window.__autoplayOn !== false && typeof window.__playRecommendedNext === "function") window.__playRecommendedNext();
              else nextTrack();
            } catch {} }
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
      publishedAt: it.publishedAt || "",
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

  // ---- RECOMMENDATION ENGINE (local, personal, no account) ----
  // Honest limits, by design: Google sign-in is disabled and the YouTube
  // Data API key cannot read the user's private YouTube watch history,
  // and there is no cross-user data here, so there is NO neural Two
  // Tower, NO collaborative filtering across users, and NO audio
  // fingerprinting / BPM clustering. What this IS:
  //  - Candidate pool: trending + search + related + artist tracks
  //    actually seen in this browser (YouTube's related endpoint is
  //    the closest available proxy for "people who heard X also heard Y").
  //  - Signals, with the weights the user asked for: listen duration
  //    (finish = strongest), repeat, skip <30s = strong dislike,
  //    like/save, search, and time-of-day affinity for tracks the user
  //    already played at a similar hour. All events stay in this
  //    browser's localStorage; nothing is sent to a server account.
  //  - Markov transitions: the user's own A -> B -> C plays, so the
  //    next recommendation after A prefers the B the user actually
  //    played after A before.
  const REC_KEY = "my_music_rec_events";
  let poolById = new Map();
  let recEvents = [];
  try { recEvents = JSON.parse(localStorage.getItem(REC_KEY) || "[]"); } catch { recEvents = []; }
  let currentPlaying = null; // {track, at}
  window.__autoplayOn = true;
  function saveRecEvents() { try { localStorage.setItem(REC_KEY, JSON.stringify(recEvents.slice(-1000))); } catch {} }
  function recordRec(ev) {
    recEvents.push({ at: Date.now(), hour: new Date().getHours(), ...ev });
    if (recEvents.length > 1000) recEvents = recEvents.slice(-1000);
    saveRecEvents();
  }
  function trackStats() {
    const stats = new Map();
    const get = (id) => { if (!stats.has(id)) stats.set(id, { play: 0, finish: 0, skip: 0, partial: 0, like: 0, listened: 0, lastAt: 0, hours: new Set(), channels: new Set() }); return stats.get(id); };
    for (const ev of recEvents) {
      if (!ev.id) continue;
      const s = get(ev.id);
      if (ev.type === "play") { s.play += 1; s.lastAt = Math.max(s.lastAt, ev.at); }
      if (ev.type === "finish") { s.finish += 1; s.listened += ev.listenedSec || 0; }
      if (ev.type === "skip") { s.skip += 1; }
      if (ev.type === "partial") { s.listened += ev.listenedSec || 0; }
      if (ev.type === "like") s.like = 1;
      if (ev.type === "unlike") s.like = 0;
      if (ev.channel) s.channels.add(ev.channel);
      if (typeof ev.hour === "number") s.hours.add(ev.hour);
    }
    // Saved tracks count as likes even if the like event predates this engine.
    for (const s of localSaved()) { const st = get(s.id); st.like = 1; }
    return stats;
  }
  function scoreTrack(track, stats, now) {
    const s = stats.get(track.id);
    if (!s) return 0;
    let score = 0;
    score += s.like * 50;
    score += Math.min(40, s.play * 8);
    score += Math.min(60, s.finish * 20);
    score += Math.min(30, s.play > 1 ? 15 : 0); // repeat = love
    score -= Math.min(60, s.skip * 30); // skip <30s = strong dislike
    if (s.play && track.duration) score += Math.min(40, 40 * Math.min(1, (s.listened / Math.max(1, s.play)) / Math.max(1, track.duration)));
    const daysAgo = (now - s.lastAt) / 86400000;
    if (daysAgo <= 7) score += 10; else if (daysAgo <= 30) score += 5;
    const hour = new Date().getHours();
    for (const h of s.hours) if (Math.abs(h - hour) <= 2 || Math.abs(h - hour) >= 22) score += 10;
    return score;
  }
  function buildMixes() {
    const pool = [...poolById.values()];
    const stats = trackStats();
    const now = Date.now();
    const likedChannels = new Set();
    for (const [id, s] of stats) if (s.like) { const tr = poolById.get(id); if (tr) likedChannels.add(tr.artist); }
    const scored = pool.map((tr) => ({ tr, score: scoreTrack(tr, stats, now), s: stats.get(tr.id) })).sort((a, b) => b.score - a.score);
    const hasHistory = recEvents.some((e) => e.type === "play");
    const recommended = hasHistory ? scored.filter((x) => x.score > 0).slice(0, 20).map((x) => x.tr) : [];
    // Supermix: 70% known favourites, 20% similar artists, 10% new discovery
    const known = scored.filter((x) => x.s && (x.s.play > 0 || x.s.like)).map((x) => x.tr);
    const similar = scored.filter((x) => !known.includes(x.tr) && likedChannels.has(x.tr.artist)).map((x) => x.tr);
    const discovery = scored.filter((x) => !x.s || x.s.play === 0).map((x) => x.tr);
    const supermix = hasHistory ? [...known.slice(0, 14), ...similar.slice(0, 4), ...discovery.slice(0, 2)] : [];
    // Discover Mix: never played, from artists played only 1-2 times, or new trending
    const channelPlays = new Map();
    for (const [, s] of stats) for (const ch of s.channels) channelPlays.set(ch, (channelPlays.get(ch) || 0) + s.play);
    const discover = pool.filter((tr) => { const s = stats.get(tr.id); return !s || s.play === 0; })
      .filter((tr) => { const cp = channelPlays.get(tr.artist) || 0; return cp >= 1 && cp <= 2; })
      .concat(pool.filter((tr) => { const s = stats.get(tr.id); return !s || s.play === 0; }).slice(0, 10))
      .filter((tr, i, arr) => arr.findIndex((x) => x.id === tr.id) === i).slice(0, 20);
    // Replay Mix: most played in the last 30 days
    const replay = scored.filter((x) => x.s && x.s.play > 0 && (now - x.s.lastAt) <= 30 * 86400000)
      .sort((a, b) => (b.s.play * (1 + b.s.finish)) - (a.s.play * (1 + a.s.finish))).slice(0, 20).map((x) => x.tr);
    // New Release Mix: newest songs from liked/followed channels, last 45 days
    const newReleases = pool.filter((tr) => likedChannels.has(tr.artist) && tr.publishedAt && (now - new Date(tr.publishedAt).getTime()) <= 45 * 86400000)
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)).slice(0, 20);
    return { recommended, supermix, discover, replay, newReleases, hasHistory };
  }
  function updateRecommendations() {
    try {
      const mixes = buildMixes();
      window.__recommendations = mixes;
      if (API.setRecommendations) API.setRecommendations(mixes);
    } catch {}
  }
  function finishPreviousTrack() {
    if (!currentPlaying) return;
    const prev = currentPlaying.track;
    let pos = 0, dur = prev.duration || 0;
    try {
      if (prev.videoId && !prev.audioUrl && window.__ytState) { pos = window.__ytState.current || 0; dur = window.__ytState.duration || dur; }
      else if (typeof audio !== "undefined" && audio) pos = audio.currentTime || 0;
    } catch {}
    const type = dur && pos >= dur * 0.8 ? "finish" : pos < 30 ? "skip" : "partial";
    recordRec({ type, id: prev.id, channel: prev.artist, listenedSec: Math.round(pos), durationSec: Math.round(dur) });
    currentPlaying = null;
  }
  function playRecommendedNext() {
    return (async () => {
      try {
        const cur = typeof queue !== "undefined" && typeof currentIndex !== "undefined" ? queue[currentIndex] : null;
        if (!cur) { nextTrack(); return; }
        // 1. Markov: what did this user actually play after this song before?
        const transitions = new Map();
        for (let i = 0; i + 1 < recEvents.length; i++) {
          if (recEvents[i].type === "play" && recEvents[i].id === cur.id && recEvents[i + 1].type === "play") {
            transitions.set(recEvents[i + 1].id, (transitions.get(recEvents[i + 1].id) || 0) + 1);
          }
        }
        const markovId = [...transitions.entries()].sort((a, b) => b[1] - a[1])[0];
        if (markovId && poolById.has(markovId[0])) { window.MyMusicAPI.playTrack(poolById.get(markovId[0])); return; }
        // 2. Best scored pool track not just played
        const mixes = buildMixes();
        const candidate = mixes.recommended.find((tr) => String(tr.id) !== String(cur.id));
        if (candidate) { window.MyMusicAPI.playTrack(candidate); return; }
        // 3. YouTube related = co-listening proxy
        if (cur.videoId) {
          const res = await fetch(`/api/related/${encodeURIComponent(cur.videoId)}`);
          const data = await res.json();
          const items = (data.items || []).map(mapItem);
          items.forEach((tr) => poolById.set(tr.id, tr));
          if (items.length) { window.MyMusicAPI.playTrack(items[0]); return; }
        }
      } catch {}
      nextTrack();
    })();
  }
  window.__playRecommendedNext = playRecommendedNext;

  let currentTracks = [];
  function setCatalogFor(tracks, opts = {}) {
    currentTracks = tracks;
    tracks.forEach((tr) => poolById.set(tr.id, tr));
    API.setCatalog({
      tracks,
      albums: opts.albums || [],
      artists: artistsFrom(tracks),
      playlists: opts.playlists || [{ name: "Saved tracks", sub: "Local library (no sign-in)" }],
      moods: [],
      likedIds: opts.likedIds || localSaved().map((t) => t.id),
    });
    updateRecommendations();
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
    if (track) {
      finishPreviousTrack();
      recordRec({ type: "play", id: track.id, channel: track.artist });
      currentPlaying = { track, at: Date.now() };
      poolById.set(track.id, track);
      updateRecommendations();
    }
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
    if (q) recordRec({ type: "search", query: q });
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
    recordRec({ type: liked ? "like" : "unlike", id });
    updateRecommendations();
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
