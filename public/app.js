// My Music frontend. No hardcoded / sample tracks: the grid is only
// ever filled from /api/search, /api/trending or /api/library.
const grid = document.getElementById("grid");
const emptyEl = document.getElementById("empty");
const titleEl = document.getElementById("sectionTitle");
const noticeEl = document.getElementById("notice");
const authArea = document.getElementById("authArea");
let user = null;
let current = null;
let view = "home";

function card(item) {
  const b = document.createElement("button");
  b.className = "card";
  b.innerHTML = `<img src="${item.thumbnail || ""}" alt=""><div><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.channel)}</span></div>`;
  b.onclick = () => play(item);
  return b;
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function render(items) {
  grid.innerHTML = "";
  emptyEl.hidden = items.length > 0;
  items.forEach((item) => grid.appendChild(card(item)));
}
function play(item) {
  current = item;
  document.getElementById("player").hidden = false;
  document.getElementById("playerFrame").src = `https://www.youtube.com/embed/${item.id}?autoplay=1&rel=0`;
  document.getElementById("nowTitle").textContent = item.title;
  document.getElementById("nowChannel").textContent = item.channel;
}
async function loadTrending() {
  titleEl.textContent = "Trending music";
  const res = await fetch("/api/trending");
  const data = await res.json();
  if (!res.ok) { noticeEl.hidden = false; noticeEl.textContent = data.error || "Could not load trending."; render([]); return; }
  render(data.items || []);
}
async function loadLibrary() {
  titleEl.textContent = "Your Library";
  if (!user) { noticeEl.hidden = false; noticeEl.textContent = "Sign in with Google to see your saved tracks."; render([]); return; }
  const res = await fetch(`/api/library?email=${encodeURIComponent(user.email)}`);
  const data = await res.json();
  if (!res.ok) { noticeEl.hidden = false; noticeEl.textContent = data.error || "Could not load library."; render([]); return; }
  render(data.tracks || []);
}
document.getElementById("searchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = document.getElementById("searchInput").value.trim();
  if (!q) return;
  titleEl.textContent = `Results for "${q}"`;
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  const data = await res.json();
  if (!res.ok) { noticeEl.hidden = false; noticeEl.textContent = data.error || "Search failed."; render([]); return; }
  noticeEl.hidden = true;
  render(data.items || []);
});
document.querySelectorAll(".nav").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav").forEach((x) => x.classList.remove("active"));
    btn.classList.add("active");
    view = btn.dataset.view;
    noticeEl.hidden = true;
    if (view === "library") loadLibrary(); else loadTrending();
  });
});
document.getElementById("saveBtn").addEventListener("click", async () => {
  if (!current) return;
  if (!user) { alert("Sign in with Google first, then save."); return; }
  const res = await fetch("/api/library", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ email: user.email, video_id: current.id, title: current.title, channel: current.channel, thumbnail: current.thumbnail }),
  });
  const data = await res.json();
  alert(res.ok ? "Saved to your Library." : (data.error || "Could not save."));
});
(async () => {
  const health = await (await fetch("/api/health")).json();
  if (!health.youtubeConfigured) {
    noticeEl.hidden = false;
    noticeEl.textContent = "YouTube API is not connected yet: add YOUTUBE_DATA_API to the .env file in the root folder, then restart the server. No sample songs are shown in the meantime.";
  }
  const me = await (await fetch("/api/me")).json();
  user = me.user;
  authArea.innerHTML = user
    ? `${escapeHtml(user.name || user.email)} &nbsp; <a href="/auth/logout">Sign out</a>`
    : `<a href="/auth/google">Sign in with Google</a>`;
  loadTrending();
})();
