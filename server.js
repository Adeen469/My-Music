// My Music — backend for a YouTube Music-style app.
// No sample data anywhere: every track shown comes from the real
// YouTube Data API, or from Supabase (saved tracks) when configured.
// If a key is missing, the API returns a clear error instead of fake data.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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
// Admin panel (built 2026-11-01, user request): sign in at /admin
// with ADMIN_EMAIL + ADMIN_PASSWORD from Vercel env vars. Those
// values are NEVER sent to the browser, never logged, and never put
// in the repo — the server only compares a login attempt against
// them and issues a signed, HttpOnly session cookie. If either var
// is missing, admin sign-in fails closed (503). Use a strong, unique
// password in Vercel; a short default password is not safe for this.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_NAME = (process.env.ADMIN_NAME || "").trim();
// Google sign-in: ENABLED 2026-11-01 (user added GOOGLE_CLIENT_ID +
// GOOGLE_CLIENT_SECRET in Vercel and asked to enable it). It turns on
// automatically when both vars are present, so no AUTH_ENABLED=true
// step is needed; set AUTH_ENABLED=false to turn it off again.
// Sign-in is optional — the app still works without it, and saved
// tracks still live in the browser. The session cookie below is NOT
// a security boundary for the library API (which still takes an
// email param); it only identifies the profile shown in the UI.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const AUTH_ENABLED = process.env.AUTH_ENABLED === "false"
  ? false
  : (process.env.AUTH_ENABLED === "true" || Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET));
// Redirect URI: if GOOGLE_REDIRECT_URI is set in Vercel, use it.
// Otherwise derive it from the incoming request host, so production
// automatically uses https://<your-domain>/auth/google/callback
// instead of the old localhost default. That exact URI must be
// registered in the Google Cloud OAuth client, or Google returns
// redirect_uri_mismatch.
function getRedirectUri(req) {
  const proto = (req.get && req.get("x-forwarded-proto")) || req.protocol || "https";
  const host = (req.get && req.get("host")) || `localhost:${PORT}`;
  const fromHost = `${proto}://${host}/auth/google/callback`;
  const envUri = process.env.GOOGLE_REDIRECT_URI || "";
  // Guard against the exact bug seen live 2026-11-01: Vercel had
  // GOOGLE_REDIRECT_URI=http://localhost:3000/... set, so production
  // sent Google a localhost redirect and got redirect_uri_mismatch.
  // A localhost env value must never win on a non-localhost host.
  if (envUri && !(host.startsWith("localhost") || host.startsWith("127.0.0.1")) && envUri.includes("localhost")) return fromHost;
  if (envUri) return envUri;
  return fromHost;
}
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
function parseDuration(iso) {
  if (!iso) return null;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return null;
  return (parseInt(m[1] || "0", 10) * 3600) + (parseInt(m[2] || "0", 10) * 60) + parseInt(m[3] || "0", 10);
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
    // Real duration in seconds when YouTube returned contentDetails.
    // Search results don't include it, so mergeDurations fills it in.
    durationSeconds: item.contentDetails ? parseDuration(item.contentDetails.duration) : null,
  };
}
// India availability filter (added 2026-11-01, user request):
// Do not show videos that cannot play in India. YouTube's search
// regionCode alone is not reliable, so every list is also checked
// against videos.list, which reports the real availability:
//  - a video videos.list does not return at all = removed / private
//  - status.privacyStatus != "public" = not publicly playable
//  - status.embeddable === false = cannot play in My Music's hidden
//    YouTube player at all, so showing it only leads to a stuck 0:00
//  - contentDetails.regionRestriction.blocked contains "IN", or
//    .allowed exists and does not contain "IN" = blocked in India
// If the availability check itself fails (API outage), fail open and
// return the list unfiltered rather than blanking the whole app.
function isAvailableInIndia(detail) {
  if (!detail) return false;
  if (detail.status && detail.status.privacyStatus && detail.status.privacyStatus !== "public") return false;
  if (detail.status && detail.status.embeddable === false) return false;
  const rr = (detail.contentDetails && detail.contentDetails.regionRestriction) || null;
  if (!rr) return true;
  if (Array.isArray(rr.blocked) && rr.blocked.includes("IN")) return false;
  if (Array.isArray(rr.allowed) && !rr.allowed.includes("IN")) return false;
  return true;
}
async function filterAvailableInIndia(items) {
  if (!items || !items.length) return items;
  try {
    const kept = [];
    for (let i = 0; i < items.length; i += 50) {
      const chunk = items.slice(i, i + 50);
      const data = await youtube("videos", { part: "status,contentDetails", id: chunk.map((x) => x.id).filter(Boolean).join(",") });
      const byId = new Map((data.items || []).map((it) => [typeof it.id === "string" ? it.id : it.id.videoId, it]));
      for (const x of chunk) if (isAvailableInIndia(byId.get(x.id))) kept.push(x);
    }
    return kept;
  } catch { return items; }
}
// Search/related/artist use the search endpoint, which has no duration.
// One cheap videos.list call (cost 1) fills durations for all ids.
async function mergeDurations(items) {
  const ids = (items || []).filter((x) => x.durationSeconds == null).map((x) => x.id).filter(Boolean);
  if (!ids.length) return items;
  try {
    const data = await youtube("videos", { part: "contentDetails", id: ids.join(",") });
    const byId = new Map((data.items || []).map((it) => [typeof it.id === "string" ? it.id : it.id.videoId, parseDuration(it.contentDetails && it.contentDetails.duration)]));
    for (const x of items) if (x.durationSeconds == null && byId.has(x.id)) x.durationSeconds = byId.get(x.id);
  } catch { /* duration stays null; the UI shows 0:00 rather than a fake time */ }
  return items;
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
      part: "snippet", type: "video", q, maxResults: "25", order: "relevance", regionCode: "IN",
    });
    const withDurations = await mergeDurations((data.items || []).map(mapVideo));
    res.json({ items: await filterAvailableInIndia(withDurations) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get("/api/trending", async (req, res) => {
  try {
    const data = await youtube("videos", {
      part: "snippet,statistics,contentDetails,status", chart: "mostPopular",
      videoCategoryId: "10", maxResults: "25", regionCode: "IN",
    });
    res.json({ items: await filterAvailableInIndia((data.items || []).map(mapVideo)) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get("/api/video/:id", async (req, res) => {
  try {
    const data = await youtube("videos", {
      part: "snippet,statistics,contentDetails,status", id: req.params.id,
    });
    const item = (data.items || [])[0];
    if (!item) return res.status(404).json({ error: "Video not found" });
    if (!isAvailableInIndia(item)) return res.status(404).json({ error: "Video not available in India" });
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
      part: "snippet", type: "video", q: name, maxResults: "25", order: "relevance", regionCode: "IN",
    });
    const all = await filterAvailableInIndia(await mergeDurations((data.items || []).map(mapVideo)));
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
      part: "snippet", type: "video", relatedToVideoId: req.params.id, maxResults: "12", regionCode: "IN",
    });
    const withDurations = await mergeDurations((data.items || []).map(mapVideo));
    res.json({ items: await filterAvailableInIndia(withDurations) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- Google sign-in (OAuth 2.0) — enabled when ID+Secret are set ----
app.get("/auth/google", (req, res) => {
  if (!AUTH_ENABLED) return res.status(503).send("Google sign-in is not enabled. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Vercel and redeploy.");
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(503).send("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set. Add them in Vercel and redeploy.");
  }
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", getRedirectUri(req));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  res.redirect(url.toString());
});

app.get("/auth/google/callback", async (req, res) => {
  if (!AUTH_ENABLED) return res.status(503).send("Google sign-in is not enabled.");
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code");
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: getRedirectUri(req), grant_type: "authorization_code",
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
    const isHttps = (req.get && req.get("x-forwarded-proto") === "https") || req.secure;
    res.setHeader("Set-Cookie", `my_music_user=${encodeURIComponent(cookie)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${isHttps ? "; Secure" : ""}`);
    res.redirect("/");
  } catch (e) {
    res.status(500).send(`Google sign-in failed: ${e.message}`);
  }
});

app.get("/auth/logout", (req, res) => {
  const isHttpsOut = (req.get && req.get("x-forwarded-proto") === "https") || req.secure;
  res.setHeader("Set-Cookie", `my_music_user=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isHttpsOut ? "; Secure" : ""}`);
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

// ---- Admin panel (/admin) ----
// Stateless signed session: the cookie holds {email, exp} plus an
// HMAC made with ADMIN_PASSWORD, so it works across serverless
// invocations with no server-side session store. The password itself
// is never in the cookie, the page, or any API response.
function adminConfigured() { return Boolean(ADMIN_EMAIL && ADMIN_PASSWORD); }
function safeEqualString(a, b) {
  const ab = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}
function signAdminSession() {
  const payload = Buffer.from(JSON.stringify({ email: ADMIN_EMAIL, exp: Date.now() + 12 * 3600 * 1000 }), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", ADMIN_PASSWORD).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function verifyAdminSession(req) {
  try {
    if (!adminConfigured()) return false;
    const token = parseCookies(req).my_music_admin || "";
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return false;
    const expected = crypto.createHmac("sha256", ADMIN_PASSWORD).update(payload).digest("base64url");
    if (!safeEqualString(sig, expected)) return false;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.email === ADMIN_EMAIL && typeof data.exp === "number" && data.exp > Date.now();
  } catch { return false; }
}
function requireAdmin(req, res, next) {
  if (!verifyAdminSession(req)) return res.status(401).json({ error: "Admin sign-in required" });
  next();
}
function adminCookie(req, value, maxAge) {
  const isHttps = (req.get && req.get("x-forwarded-proto") === "https") || req.secure;
  return `my_music_admin=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${isHttps ? "; Secure" : ""}`;
}
// Basic failed-login throttling, per calling IP, in memory. On
// serverless it is per-instance, so it slows guessing rather than
// guaranteeing a global block — the strong-password advice above is
// still the real protection.
const adminFailedLogins = new Map();
function adminRateLimited(ip) {
  const now = Date.now();
  const entry = adminFailedLogins.get(ip);
  if (!entry || now - entry.first > 10 * 60 * 1000) { adminFailedLogins.set(ip, { count: 0, first: now }); return false; }
  return entry.count >= 10;
}
function recordAdminFailure(ip) {
  const now = Date.now();
  const entry = adminFailedLogins.get(ip) || { count: 0, first: now };
  if (now - entry.first > 10 * 60 * 1000) { entry.count = 0; entry.first = now; }
  entry.count += 1;
  adminFailedLogins.set(ip, entry);
}
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.post("/api/admin/login", (req, res) => {
  if (!adminConfigured()) return res.status(503).json({ error: "Admin is not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD in Vercel and redeploy." });
  const ip = ((req.headers["x-forwarded-for"] || "").split(",")[0] || "").trim() || req.ip || "unknown";
  if (adminRateLimited(ip)) return res.status(429).json({ error: "Too many failed admin sign-in attempts. Try again later." });
  const { email, password } = req.body || {};
  // Generic message on purpose: do not reveal whether the email or
  // the password was the wrong part.
  if (!safeEqualString((email || "").trim(), ADMIN_EMAIL) || !safeEqualString(password || "", ADMIN_PASSWORD)) {
    recordAdminFailure(ip);
    return res.status(401).json({ error: "Invalid admin email or password" });
  }
  adminFailedLogins.delete(ip);
  res.setHeader("Set-Cookie", adminCookie(req, signAdminSession(), 12 * 3600));
  res.json({ ok: true, admin: { name: ADMIN_NAME, email: ADMIN_EMAIL } });
});
app.post("/api/admin/logout", (req, res) => {
  res.setHeader("Set-Cookie", adminCookie(req, "", 0));
  res.json({ ok: true });
});
app.get("/api/admin/me", (req, res) => {
  if (!verifyAdminSession(req)) return res.json({ admin: null });
  res.json({ admin: { name: ADMIN_NAME, email: ADMIN_EMAIL } });
});
app.get("/api/admin/health", requireAdmin, (req, res) => {
  res.json({
    admin: { name: ADMIN_NAME, email: ADMIN_EMAIL },
    youtubeConfigured: Boolean(YOUTUBE_API),
    googleConfigured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
    groqConfigured: Boolean(process.env.GROQ_API_KEY),
    authEnabled: AUTH_ENABLED,
  });
});
app.get("/api/admin/youtube-test", requireAdmin, async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Missing ?q=" });
  try {
    const data = await youtube("search", { part: "snippet", type: "video", q, maxResults: "5", order: "relevance", regionCode: "IN" });
    const withDurations = await mergeDurations((data.items || []).map(mapVideo));
    res.json({ items: await filterAvailableInIndia(withDurations) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
app.get("/api/admin/saved-tracks", requireAdmin, async (req, res) => {
  try {
    const rows = await supabaseFetch("saved_tracks?select=user_email,video_id,title,channel,thumbnail,created_at&order=created_at.desc&limit=100");
    res.json({ tracks: rows || [], supabaseConfigured: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
app.delete("/api/admin/saved-tracks", requireAdmin, async (req, res) => {
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
