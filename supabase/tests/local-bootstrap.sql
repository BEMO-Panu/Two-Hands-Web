-- Embedded PostgreSQL ONLY: minimal interfaces supplied by hosted Supabase.
-- Never apply this file to a real Supabase project.
create role anon nologin;create role authenticated nologin;
create schema auth;create schema storage;
grant usage on schema auth,storage to anon,authenticated;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz,raw_user_meta_data jsonb default '{}');
create table auth.mfa_factors(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users,status text);
create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create function auth.uid() returns uuid language sql stable as $$select nullif(auth.jwt()->>'sub','')::uuid$$;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text,owner_id text default auth.uid()::text,metadata jsonb,unique(bucket_id,name));
alter table storage.objects enable row level security;
grant select on storage.objects to anon;grant select,insert on storage.objects to authenticated;
create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;
