-- Run this ONCE in your own Supabase project SQL Editor.
-- Only authenticated owners can access their own data.
create table if not exists public.studio_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);
create table if not exists public.studio_snapshots (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null,
  version bigint not null,
  created_at timestamptz not null default now()
);
create index if not exists studio_snapshots_owner_created_idx on public.studio_snapshots(user_id, created_at desc);
alter table public.studio_state enable row level security;
alter table public.studio_snapshots enable row level security;
revoke all on public.studio_state from anon;
revoke all on public.studio_snapshots from anon;
grant select on public.studio_state to authenticated;
grant select on public.studio_snapshots to authenticated;
-- Writes only through the atomic RPC below. Users cannot directly overwrite state or snapshots.
create or replace function public.save_studio_state(expected_version bigint, new_data jsonb)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare owner_id uuid := (select auth.uid()); current_version bigint; next_version bigint;
begin
  if owner_id is null then raise exception 'Not signed in'; end if;
  if new_data is null or jsonb_typeof(new_data->'shows') <> 'array' or jsonb_typeof(new_data->'archive') <> 'array' then
    raise exception 'Invalid studio data';
  end if;
  if octet_length(new_data::text) > 5000000 then raise exception 'Studio data exceeds 5 MB'; end if;
  perform pg_advisory_xact_lock(hashtextextended(owner_id::text, 0));
  select version into current_version from public.studio_state where user_id = owner_id for update;
  if current_version is null then
    if expected_version <> 0 then raise exception 'VERSION_CONFLICT'; end if;
    next_version := 1;
    insert into public.studio_state(user_id,data,version) values(owner_id,new_data,next_version);
  else
    if current_version <> expected_version then raise exception 'VERSION_CONFLICT'; end if;
    next_version := current_version+1;
    update public.studio_state set data=new_data,version=next_version,updated_at=now() where user_id=owner_id;
  end if;
  insert into public.studio_snapshots(user_id,data,version) values(owner_id,new_data,next_version);
  -- Retain the most recent 30 snapshots per account.
  delete from public.studio_snapshots where user_id=owner_id and id not in
    (select id from public.studio_snapshots where user_id=owner_id order by id desc limit 30);
  return next_version;
end $$;
revoke all on function public.save_studio_state(bigint,jsonb) from public,anon;
grant execute on function public.save_studio_state(bigint,jsonb) to authenticated;
create policy "Owner can read own state" on public.studio_state for select to authenticated using (user_id=(select auth.uid()));
create policy "Owner can read own snapshots" on public.studio_snapshots for select to authenticated using (user_id=(select auth.uid()));
