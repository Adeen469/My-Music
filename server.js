// My Music — backend for a YouTube Music-style app.
// No sample data anywhere: every track shown comes from the real
// YouTube Data API, or from Supabase (saved tracks) when configured.
// If a key is missing, the API returns a clear error instead of fake data.
const fs = require("fs");
const path = require("path");
const express = require("express");

// ---- Load .env from the root folder (this file's folder) ----
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
// YouTube key: the name used in Vercel is YOUTUBE_API_KEY; the older
// YOUTUBE_DATA_API name still works as a fallback. Either one is fine.
const YOUTUBE_API = process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_DATA_API || "";
// GROQ_API_KEY is reserved for future AI features. It is read here only
// so /api/health can report whether it is set — no GROQ feature uses
// it yet, and its value is never returned to the browser.
// ADMIN_EMAIL / ADMIN_NAME are reserved for a future admin account.
// ADMIN_PASSWORD must stay in Vercel env vars only — it is never read
// into code here, never committed, and no admin login exists yet.
// Google sign-in is DISABLED for now (2026-11-01, user decision):
// no authentication is required to use the app. The Google routes
// below are kept, not deleted, and return 503 while disabled.
// To bring Google sign-in back later, set AUTH_ENABLED=true in Vercel
// (and keep GOOGLE_CLIENT_ID/SECRET + the callback URI configured).
const AUTH_ENABLED = process.env.AUTH_ENABLED === "true";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(rest.join("="));
  }
  return out;
}
function getUser(req) {
  try {
    const raw = parseCookies(req).my_music_user;
    return raw ? JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) : null;
  } catch {
    return null;
  }
}
function mapVideo(item) {
  const id = typeof item.id === "string" ? item.id : item.id && item.id.videoId;
  const s = item.snippet || {};
  return {
    id,
    title: s.title || "",
    channel: s.channelTitle || "",
    thumbnail:
      (s.thumbnails && (s.thumbnails.medium || s.thumbnails.default || {}).url) || "",
    publishedAt: s.publishedAt || "",
    // YouTube tracks have no downloadable file: downloadUrl stays null.
    // It is only set for saved / file tracks the user attached a direct
    // audio link to (see /api/library and /api/library/download-url).
    downloadUrl: null,
  };
}
async function youtube(pathname, params) {
  if (!YOUTUBE_API) {
    const err = new Error("YOUTUBE_DATA_API is not set in .env");
    err.status = 503;
    throw err;
  }
  const url = new URL(`https://www.googleapis.com/youtube/v3/${pathname}`);
  url.searchParams.set("key", YOUTUBE_API);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || "YouTube API error");
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---- Health / config (never returns secret values) ----
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    authEnabled: AUTH_ENABLED,
    youtubeConfigured: Boolean(YOUTUBE_API),
    groqConfigured: Boolean(process.env.GROQ_API_KEY),
    googleConfigured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
  });
});

app.get("/api/me", (req, res) => res.json({ user: AUTH_ENABLED ? getUser(req) : null, authEnabled: AUTH_ENABLED }));

// ---- YouTube Data API (proxied so the API key never reaches the browser) ----
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Missing ?q=" });
  try {
    const data = await youtube("search", {
      part: "snippet", type: "video", q, maxResults: "25", order: "relevance",
    });
    res.json({ items: (data.items || []).map(mapVideo) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get("/api/trending", async (req, res) => {
  try {
    const data = await youtube("videos", {
      part: "snippet,statistics", chart: "mostPopular",
      videoCategoryId: "10", maxResults: "25",
    });
    res.json({ items: (data.items || []).map(mapVideo) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get("/api/video/:id", async (req, res) => {
  try {
    const data = await youtube("videos", {
      part: "snippet,statistics,contentDetails", id: req.params.id,
    });
    const item = (data.items || [])[0];
    if (!item) return res.status(404).json({ error: "Video not found" });
    res.json(mapVideo(item));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get("/api/artist/:name", async (req, res) => {
  const name = (req.params.name || "").trim();
  if (!name) return res.status(400).json({ error: "Missing artist name" });
  try {
    const data = await youtube("search", {
      part: "snippet", type: "video", q: name, maxResults: "25", order: "relevance",
    });
    const all = (data.items || []).map(mapVideo);
    // Only songs actually by this channel, not just relevance matches.
    const exact = all.filter((t) => t.channel.toLowerCase() === name.toLowerCase());
    res.json({ items: exact, searched: all.length, exact: exact.length });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get("/api/related/:id", async (req, res) => {
  try {
    const data = await youtube("search", {
      part: "snippet", type: "video", relatedToVideoId: req.params.id, maxResults: "12",
    });
    res.json({ items: (data.items || []).map(mapVideo) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- Google sign-in (OAuth 2.0) — DISABLED unless AUTH_ENABLED=true ----
app.get("/auth/google", (req, res) => {
  if (!AUTH_ENABLED) return res.status(503).send("Google sign-in is disabled for now. No sign-in is needed to use My Music.");
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(503).send("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set in .env");
  }
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  res.redirect(url.toString());
});

app.get("/auth/google/callback", async (req, res) => {
  if (!AUTH_ENABLED) return res.status(503).send("Google sign-in is disabled for now.");
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code");
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI, grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokens.error_description || "Token exchange failed");
    const meRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await meRes.json();
    const user = { name: profile.name || "", email: profile.email || "", picture: profile.picture || "" };
    const cookie = Buffer.from(JSON.stringify(user), "utf8").toString("base64url");
    res.setHeader("Set-Cookie", `my_music_user=${encodeURIComponent(cookie)}; Path=/; Max-Age=2592000`);
    res.redirect("/");
  } catch (e) {
    res.status(500).send(`Google sign-in failed: ${e.message}`);
  }
});

app.get("/auth/logout", (req, res) => {
  res.setHeader("Set-Cookie", "my_music_user=; Path=/; Max-Age=0");
  res.redirect("/");
});

// ---- Supabase: saved tracks (server-side only, service key never sent to browser) ----
async function supabaseFetch(query, method = "GET", body) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    const err = new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set in .env");
    err.status = 503;
    throw err;
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error((data && data.message) || `Supabase error (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

app.get("/api/library", async (req, res) => {
  const email = (req.query.email || "").trim();
  if (!email) return res.json({ tracks: [], supabaseConfigured: Boolean(SUPABASE_URL) });
  try {
    const rows = await supabaseFetch(
      `saved_tracks?select=*&user_email=eq.${encodeURIComponent(email)}&order=created_at.desc`
    );
    res.json({
      tracks: (rows || []).map((r) => ({
        id: r.video_id, title: r.title, channel: r.channel, thumbnail: r.thumbnail,
        downloadUrl: r.download_url || null,
      })),
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

function validDownloadUrl(url) {
  if (!url) return "";
  if (typeof url !== "string" || url.length > 2048) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  return url;
}

app.post("/api/library", async (req, res) => {
  const { email, video_id, title, channel, thumbnail, download_url } = req.body || {};
  if (!email || !video_id) return res.status(400).json({ error: "email and video_id are required" });
  const dl = validDownloadUrl(download_url);
  if (dl === null) return res.status(400).json({ error: "download_url must be an http(s) link" });
  try {
    await supabaseFetch("saved_tracks", "POST", {
      user_email: email, video_id, title: title || "", channel: channel || "", thumbnail: thumbnail || "",
      download_url: dl,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Attach (or replace) a direct audio file link for a saved track.
// This is the user's own / licensed file — it never extracts a YouTube stream.
app.patch("/api/library/download-url", async (req, res) => {
  const { email, video_id, download_url } = req.body || {};
  if (!email || !video_id) return res.status(400).json({ error: "email and video_id are required" });
  const dl = validDownloadUrl(download_url);
  if (dl === null) return res.status(400).json({ error: "download_url must be an http(s) link" });
  try {
    await supabaseFetch(
      `saved_tracks?user_email=eq.${encodeURIComponent(email)}&video_id=eq.${encodeURIComponent(video_id)}`,
      "PATCH",
      { download_url: dl }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.delete("/api/library", async (req, res) => {
  const email = (req.query.email || "").trim();
  const videoId = (req.query.video_id || "").trim();
  if (!email || !videoId) return res.status(400).json({ error: "email and video_id are required" });
  try {
    await supabaseFetch(
      `saved_tracks?user_email=eq.${encodeURIComponent(email)}&video_id=eq.${encodeURIComponent(videoId)}`,
      "DELETE"
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// SPA fallback: /song/:id, /artist/:name, /profile, /explore, /library
// and /watch?v=:id are all served by the same single-page app, so a
// shared link or a refresh on one of those pages must not 404.
app.get(["/explore", "/library", "/profile", "/watch", "/song/*", "/artist/*"], (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Local run: `npm start` listens. On Vercel, api/index.js imports this
// app as a serverless function instead, so do not listen there.
if (require.main === module) {
  app.listen(PORT, () => console.log(`My Music running at http://localhost:${PORT}`));
}
module.exports = app;
