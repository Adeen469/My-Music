# My Music

A YouTube Music-style app with a backend, powered by the **real YouTube Data API**.
There is **no sample data**: search, trending and library results are only ever
real API / Supabase results. If the API is not connected yet, the app shows an
empty state and a clear message instead of fake songs.

## Features

- Home with trending music (YouTube category: Music)
- Search songs, artists and albums
- Bottom player using the YouTube embed player
- Sign in with Google (OAuth 2.0)
- Save tracks to your Library, stored in Supabase (`saved_tracks` table)

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Fill in the `.env` file in the **root folder** of this repo:
   ```env
   YOUTUBE_DATA_API=
   GOOGLE_CLIENT_ID=
   GOOGLE_CLIENT_SECRET=
   GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
   SUPABASE_URL=
   SUPABASE_ANON_KEY=
   SUPABASE_SERVICE_ROLE_KEY=
   PORT=3000
   ```
   A blank template is also in `.env.example`. **Do not paste real keys in chat,
   and do not commit a filled-in `.env`** — it is gitignored. For deployment,
   set the same names as environment variables in your hosting dashboard.
3. In Supabase, run `supabase/schema.sql` in the SQL Editor to create the
   `saved_tracks` table. No sample rows are inserted.
4. In Google Cloud Console, add `http://localhost:3000/auth/google/callback`
   as an authorised redirect URI for your OAuth client.
5. Run it:
   ```bash
   npm start
   ```
   Then open http://localhost:3000

## How it works

- The browser never sees your YouTube API key or Supabase service key.
  The backend in `server.js` proxies YouTube (`/api/search`, `/api/trending`,
  `/api/video/:id`, `/api/related/:id`) and talks to Supabase
  (`/api/library`) server-side only.
- Google sign-in: `/auth/google` → `/auth/google/callback`.
- If a key is missing, the backend returns a `503` with a plain message
  (for example, "YOUTUBE_DATA_API is not set in .env") instead of fake data.

## Project structure

```
.env                  # root env file (gitignored, fill in locally)
.env.example          # blank template for .env
server.js             # Express backend + YouTube / Google / Supabase APIs
public/               # frontend (index.html, styles.css, app.js)
supabase/schema.sql   # saved_tracks table
```
