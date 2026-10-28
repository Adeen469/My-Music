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
const YOUTUBE_API = process.env.YOUTUBE_DATA_API || process.env.YOUTUBE_API_KEY || "";
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
    youtubeConfigured: Boolean(YOUTUBE_API),
    googleConfigured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
  });
});

app.get("/api/me", (req, res) => res.json({ user: getUser(req) }));

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

// ---- Google sign-in (OAuth 2.0) ----
app.get("/auth/google", (req, res) => {
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
      })),
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post("/api/library", async (req, res) => {
  const { email, video_id, title, channel, thumbnail } = req.body || {};
  if (!email || !video_id) return res.status(400).json({ error: "email and video_id are required" });
  try {
    await supabaseFetch("saved_tracks", "POST", {
      user_email: email, video_id, title: title || "", channel: channel || "", thumbnail: thumbnail || "",
    });
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

app.listen(PORT, () => console.log(`My Music running at http://localhost:${PORT}`));
