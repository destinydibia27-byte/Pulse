-- Volo automations table. Run this once in the Supabase SQL editor (Dashboard -> SQL Editor).
-- Safe to run again: every statement is idempotent.

create table if not exists public.volo_automations (
  id          text primary key,                 -- the app's automation id, for example "demo-0"
  user_id     text        not null,
  status      text        not null,             -- mirrors data->>'status' so the worker can filter cheaply
  version     integer     not null default 1,   -- optimistic-concurrency counter; every write bumps it
  data        jsonb       not null,             -- the full automation record
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists volo_automations_user_idx   on public.volo_automations (user_id);
create index if not exists volo_automations_status_idx on public.volo_automations (status);

-- Lock the table down. With row-level security ON and NO policies, the public (anon) key can read
-- and write nothing. Only the server-side secret key can, because that key bypasses RLS.
-- NEVER put the secret key in a NEXT_PUBLIC_ variable or in browser code.
alter table public.volo_automations enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Per-user recipients ("savings" -> 0x...). Added for multi-user use. Same rules: RLS on, no
-- policies, only the server-side secret key can touch it. Safe to run again.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.volo_recipients (
  user_id    text        not null,              -- the owner's wallet address, lower case
  label      text        not null,              -- for example "savings"
  address    text        not null,              -- checksummed 0x address
  updated_at timestamptz not null default now(),
  primary key (user_id, label)
);

alter table public.volo_recipients enable row level security;
revoke all on public.volo_recipients from anon, authenticated;
grant all on public.volo_recipients to service_role;
