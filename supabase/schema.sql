-- My Music — Supabase table for saved tracks.
-- Run this in Supabase SQL Editor. No sample rows are inserted.
create table if not exists public.saved_tracks (
  id bigint generated always as identity primary key,
  user_email text not null,
  video_id text not null,
  title text not null default '',
  channel text not null default '',
  thumbnail text not null default '',
  -- Direct audio file link the user attached (own / licensed file only).
  -- Empty for YouTube tracks: there is no file to download for those.
  download_url text not null default '',
  created_at timestamptz not null default now(),
  unique (user_email, video_id)
);
-- For tables created before this column existed:
alter table public.saved_tracks add column if not exists download_url text not null default '';
-- The backend uses the service-role key server-side, so no RLS policies
-- are required for this starter. If you expose Supabase to the browser
-- later, enable RLS and add per-user policies before doing so.
