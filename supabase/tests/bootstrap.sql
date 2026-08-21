\set ON_ERROR_STOP on

-- Minimal Supabase surface for running the production migration in a disposable
-- stock PostgreSQL database. This is test infrastructure, not a replacement for
-- the Supabase-managed auth and storage schemas.
create role authenticated nologin;
create role anon nologin;
create role service_role nologin bypassrls;

create schema auth;
create schema storage;

create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

create function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create table storage.buckets (
  id text primary key,
  name text not null unique,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id),
  name text not null,
  owner_id uuid,
  created_at timestamptz not null default now()
);

alter table storage.objects enable row level security;

create function storage.foldername(name text)
returns text[]
language sql
immutable
as $$
  select case
    when strpos(name, '/') = 0 then '{}'::text[]
    else string_to_array(regexp_replace(name, '/[^/]*$', ''), '/')
  end;
$$;

create publication supabase_realtime;

grant usage on schema auth, storage, public to authenticated, anon, service_role;
grant execute on function auth.uid() to authenticated, anon, service_role;
grant execute on function storage.foldername(text) to authenticated, anon, service_role;
