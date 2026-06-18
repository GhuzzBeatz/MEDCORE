-- MedCore Supabase setup (modelo mais seguro: tabela separada por categoria)
-- Execute este arquivo inteiro no SQL Editor do Supabase.

create extension if not exists pgcrypto;

-- =========================================================
-- Tabelas legadas (mantidas para migracao/compatibilidade)
-- =========================================================
create table if not exists public.workspace_snapshots (
  workspace_key text primary key,
  revision bigint not null default 0,
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  last_user_id uuid references auth.users(id),
  last_user_email text,
  last_sync_source text
);

create table if not exists public.workspace_rows (
  workspace_key text not null,
  table_name text not null,
  row_id text not null,
  record jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz null,
  version bigint not null default 1,
  source_client text,
  last_user_id uuid references auth.users(id),
  last_user_email text,
  last_sync_source text,
  primary key (workspace_key, table_name, row_id)
);

-- =========================================================
-- Cadastro de codigo da clinica + membros + logins
-- =========================================================
create table if not exists public.workspace_registry (
  workspace_key text primary key,
  workspace_key_canonical text not null unique,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  last_user_id uuid references auth.users(id),
  last_user_email text
);

create table if not exists public.workspace_members (
  workspace_key text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  user_email text,
  user_name text,
  provider text not null default 'google',
  first_login_at timestamptz not null default now(),
  last_login_at timestamptz not null default now(),
  primary key (workspace_key, user_id)
);

create table if not exists public.workspace_logins (
  id bigint generated always as identity primary key,
  workspace_key text not null,
  user_id uuid references auth.users(id) on delete set null,
  user_email text,
  app_name text,
  source text,
  logged_at timestamptz not null default now()
);

create index if not exists idx_workspace_members_user on public.workspace_members(user_id);
create index if not exists idx_workspace_logins_workspace on public.workspace_logins(workspace_key);
create index if not exists idx_workspace_logins_user on public.workspace_logins(user_id);
create index if not exists idx_workspace_registry_canonical on public.workspace_registry(workspace_key_canonical);
create index if not exists idx_workspace_registry_created_by on public.workspace_registry(created_by);
create index if not exists idx_workspace_registry_last_user_id on public.workspace_registry(last_user_id);
create index if not exists idx_workspace_rows_workspace_table on public.workspace_rows(workspace_key, table_name);
create index if not exists idx_workspace_rows_workspace_updated on public.workspace_rows(workspace_key, updated_at desc);
create index if not exists idx_workspace_rows_last_user_id on public.workspace_rows(last_user_id);
create index if not exists idx_workspace_snapshots_created_by on public.workspace_snapshots(created_by);
create index if not exists idx_workspace_snapshots_last_user_id on public.workspace_snapshots(last_user_id);

-- =========================================================
-- RLS (base)
-- =========================================================
alter table public.workspace_snapshots enable row level security;
alter table public.workspace_rows enable row level security;
alter table public.workspace_registry enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_logins enable row level security;

drop policy if exists members_select_own on public.workspace_members;
create policy members_select_own on public.workspace_members
for select to authenticated
using (user_id = (select auth.uid()));

drop policy if exists members_insert_own on public.workspace_members;
create policy members_insert_own on public.workspace_members
for insert to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists members_update_own on public.workspace_members;
create policy members_update_own on public.workspace_members
for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists logins_insert_self on public.workspace_logins;
create policy logins_insert_self on public.workspace_logins
for insert to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists logins_select_self on public.workspace_logins;
create policy logins_select_self on public.workspace_logins
for select to authenticated
using (user_id = (select auth.uid()));

drop policy if exists registry_select_authenticated on public.workspace_registry;
create policy registry_select_authenticated on public.workspace_registry
for select to authenticated
using (true);

drop policy if exists registry_insert_authenticated on public.workspace_registry;
create policy registry_insert_authenticated on public.workspace_registry
for insert to authenticated
with check (
  created_by = (select auth.uid())
  or created_by is null
);

drop policy if exists registry_update_authenticated on public.workspace_registry;
create policy registry_update_authenticated on public.workspace_registry
for update to authenticated
using (
  created_by = (select auth.uid())
  or exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_key = workspace_registry.workspace_key
      and wm.user_id = (select auth.uid())
  )
)
with check (
  created_by = (select auth.uid())
  or exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_key = workspace_registry.workspace_key
      and wm.user_id = (select auth.uid())
  )
);

drop policy if exists snapshots_select_member on public.workspace_snapshots;
create policy snapshots_select_member on public.workspace_snapshots
for select to authenticated
using (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_key = workspace_snapshots.workspace_key
      and wm.user_id = (select auth.uid())
  )
);

drop policy if exists snapshots_insert_authenticated on public.workspace_snapshots;
create policy snapshots_insert_authenticated on public.workspace_snapshots
for insert to authenticated
with check (created_by = (select auth.uid()));

drop policy if exists snapshots_update_member on public.workspace_snapshots;
create policy snapshots_update_member on public.workspace_snapshots
for update to authenticated
using (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_key = workspace_snapshots.workspace_key
      and wm.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_key = workspace_snapshots.workspace_key
      and wm.user_id = (select auth.uid())
  )
);

drop policy if exists rows_select_member on public.workspace_rows;
create policy rows_select_member on public.workspace_rows
for select to authenticated
using (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_key = workspace_rows.workspace_key
      and wm.user_id = (select auth.uid())
  )
);

drop policy if exists rows_insert_member on public.workspace_rows;
create policy rows_insert_member on public.workspace_rows
for insert to authenticated
with check (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_key = workspace_rows.workspace_key
      and wm.user_id = (select auth.uid())
  )
);

drop policy if exists rows_update_member on public.workspace_rows;
create policy rows_update_member on public.workspace_rows
for update to authenticated
using (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_key = workspace_rows.workspace_key
      and wm.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_key = workspace_rows.workspace_key
      and wm.user_id = (select auth.uid())
  )
);

-- =========================================================
-- Mapeamento de tabela logica -> tabela fisica separada
-- =========================================================
create or replace function public.workspace_data_table_name(p_table_name text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case trim(lower(coalesce(p_table_name, '')))
    when 'config' then 'workspace_config_rows'
    when 'usuarios' then 'workspace_usuarios_rows'
    when 'medicos' then 'workspace_medicos_rows'
    when 'pacientes' then 'workspace_pacientes_rows'
    when 'agenda' then 'workspace_agenda_rows'
    when 'prontuarios' then 'workspace_prontuarios_rows'
    when 'asos' then 'workspace_asos_rows'
    when 'financeiro' then 'workspace_financeiro_rows'
    when 'estoque' then 'workspace_estoque_rows'
    when 'medicamentos' then 'workspace_medicamentos_rows'
    when 'exames_banco' then 'workspace_exames_banco_rows'
    when 'solicitacoes_exames' then 'workspace_solicitacoes_exames_rows'
    when 'receituarios_salvos' then 'workspace_receituarios_salvos_rows'
    when 'locais' then 'workspace_locais_rows'
    else null
  end
$$;

-- =========================================================
-- Cria tabelas separadas e RLS por categoria
-- =========================================================
do $$
declare
  v_name text;
  v_table text;
begin
  foreach v_name in array array[
    'config',
    'usuarios',
    'medicos',
    'pacientes',
    'agenda',
    'prontuarios',
    'asos',
    'financeiro',
    'estoque',
    'medicamentos',
    'exames_banco',
    'solicitacoes_exames',
    'receituarios_salvos',
    'locais'
  ] loop
    v_table := public.workspace_data_table_name(v_name);

    execute format($fmt$
      create table if not exists public.%I (
        workspace_key text not null,
        row_id text not null,
        record jsonb not null default '{}'::jsonb,
        updated_at timestamptz not null default now(),
        deleted_at timestamptz null,
        version bigint not null default 1,
        source_client text,
        last_user_id uuid references auth.users(id),
        last_user_email text,
        last_sync_source text,
        primary key (workspace_key, row_id)
      )
    $fmt$, v_table);

    execute format(
      'create index if not exists %I on public.%I(workspace_key)',
      'idx_wsd_' || v_name || '_wk',
      v_table
    );

    execute format(
      'create index if not exists %I on public.%I(workspace_key, updated_at desc)',
      'idx_wsd_' || v_name || '_wk_upd',
      v_table
    );

    execute format(
      'create index if not exists %I on public.%I(last_user_id)',
      'idx_wsd_' || v_name || '_last_user_id',
      v_table
    );

    execute format('alter table public.%I enable row level security', v_table);

    execute format('drop policy if exists %I on public.%I', 'wsd_sel_' || v_name, v_table);
    execute format($fmt$
      create policy %I on public.%I
      for select to authenticated
      using (
        exists (
          select 1
          from public.workspace_members wm
          where wm.workspace_key = %I.workspace_key
            and wm.user_id = (select auth.uid())
        )
      )
    $fmt$, 'wsd_sel_' || v_name, v_table, v_table);

    execute format('drop policy if exists %I on public.%I', 'wsd_ins_' || v_name, v_table);
    execute format($fmt$
      create policy %I on public.%I
      for insert to authenticated
      with check (
        exists (
          select 1
          from public.workspace_members wm
          where wm.workspace_key = %I.workspace_key
            and wm.user_id = (select auth.uid())
        )
      )
    $fmt$, 'wsd_ins_' || v_name, v_table, v_table);

    execute format('drop policy if exists %I on public.%I', 'wsd_upd_' || v_name, v_table);
    execute format($fmt$
      create policy %I on public.%I
      for update to authenticated
      using (
        exists (
          select 1
          from public.workspace_members wm
          where wm.workspace_key = %I.workspace_key
            and wm.user_id = (select auth.uid())
        )
      )
      with check (
        exists (
          select 1
          from public.workspace_members wm
          where wm.workspace_key = %I.workspace_key
            and wm.user_id = (select auth.uid())
        )
      )
    $fmt$, 'wsd_upd_' || v_name, v_table, v_table, v_table);
  end loop;
end
$$;

-- =========================================================
-- RPC robusta para merge por tabela separada
-- =========================================================
create or replace function public.workspace_merge_table_rows(
  p_workspace_key text,
  p_table_name text,
  p_rows jsonb,
  p_user_id uuid,
  p_user_email text,
  p_source_client text,
  p_sync_source text default 'sync'
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_row jsonb;
  v_row_id text;
  v_record jsonb;
  v_updated_at timestamptz;
  v_deleted_at timestamptz;
  v_version bigint;
  v_table text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  if not exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_key = p_workspace_key
      and wm.user_id = auth.uid()
  ) then
    raise exception 'workspace_access_denied';
  end if;

  v_table := public.workspace_data_table_name(p_table_name);
  if v_table is null then
    raise exception 'invalid_table_name:%', p_table_name;
  end if;

  if p_rows is null then
    return;
  end if;

  for v_row in
    select value
    from jsonb_array_elements(p_rows)
  loop
    v_row_id := trim(coalesce(v_row->>'row_id', ''));
    v_record := coalesce(v_row->'record', '{}'::jsonb);
    v_updated_at := coalesce((v_row->>'updated_at')::timestamptz, now());
    v_deleted_at := nullif(v_row->>'deleted_at', '')::timestamptz;
    v_version := greatest(coalesce((v_row->>'version')::bigint, 1), 1);

    if v_row_id = '' then
      continue;
    end if;

    execute format($sql$
      insert into public.%I (
        workspace_key,
        row_id,
        record,
        updated_at,
        deleted_at,
        version,
        source_client,
        last_user_id,
        last_user_email,
        last_sync_source
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      on conflict (workspace_key, row_id)
      do update set
        record = excluded.record,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at,
        version = excluded.version,
        source_client = excluded.source_client,
        last_user_id = excluded.last_user_id,
        last_user_email = excluded.last_user_email,
        last_sync_source = excluded.last_sync_source
      where
        excluded.version > %I.version
        or (
          excluded.version = %I.version
          and %I.deleted_at is null
          and excluded.updated_at > %I.updated_at
        )
        or (
          excluded.version = %I.version
          and %I.deleted_at is null
          and excluded.updated_at = %I.updated_at
          and excluded.deleted_at is not null
        )
    $sql$, v_table, v_table, v_table, v_table, v_table, v_table, v_table, v_table)
    using
      p_workspace_key,
      v_row_id,
      v_record,
      v_updated_at,
      v_deleted_at,
      v_version,
      coalesce(nullif(v_row->>'source_client', ''), p_source_client),
      p_user_id,
      p_user_email,
      p_sync_source;
  end loop;
end;
$$;

revoke execute on function public.workspace_merge_table_rows(text, text, jsonb, uuid, text, text, text) from public;
revoke execute on function public.workspace_merge_table_rows(text, text, jsonb, uuid, text, text, text) from anon;
grant execute on function public.workspace_merge_table_rows(text, text, jsonb, uuid, text, text, text) to authenticated;
grant execute on function public.workspace_merge_table_rows(text, text, jsonb, uuid, text, text, text) to service_role;

-- =========================================================
-- Grants explicitos Data API (compativel com mudanca 2026)
-- =========================================================
do $$
declare
  r record;
begin
  for r in
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_type = 'BASE TABLE'
      and left(table_name, 10) = 'workspace_'
  loop
    execute format('revoke all on table public.%I from anon', r.table_name);
    execute format('grant select, insert, update, delete on table public.%I to authenticated', r.table_name);
    execute format('grant select, insert, update, delete on table public.%I to service_role', r.table_name);
  end loop;
end
$$;

alter default privileges for role postgres in schema public
  revoke all on tables from anon;
alter default privileges for role postgres in schema public
  revoke all on tables from public;
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke all on sequences from anon;
alter default privileges for role postgres in schema public
  revoke all on sequences from public;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke execute on functions from anon;
alter default privileges for role postgres in schema public
  revoke execute on functions from public;
alter default privileges for role postgres in schema public
  grant execute on functions to authenticated, service_role;

-- Opcional: se sua instalacao criar tabelas como role supabase_admin,
-- rode estes comandos manualmente no SQL Editor para espelhar os mesmos defaults:
-- alter default privileges for role supabase_admin in schema public revoke all on tables from anon;
-- alter default privileges for role supabase_admin in schema public revoke all on tables from public;
-- alter default privileges for role supabase_admin in schema public grant select, insert, update, delete on tables to authenticated, service_role;
-- alter default privileges for role supabase_admin in schema public revoke all on sequences from anon;
-- alter default privileges for role supabase_admin in schema public revoke all on sequences from public;
-- alter default privileges for role supabase_admin in schema public grant usage, select on sequences to authenticated, service_role;
-- alter default privileges for role supabase_admin in schema public revoke execute on functions from anon;
-- alter default privileges for role supabase_admin in schema public revoke execute on functions from public;
-- alter default privileges for role supabase_admin in schema public grant execute on functions to authenticated, service_role;

-- =========================================================
-- Migra codigos legados para registry (dedup por canonical)
-- =========================================================
with raw as (
  select
    ws.workspace_key,
    ws.last_user_id,
    ws.last_user_email,
    ws.updated_at,
    ws.revision,
    case
      when left(regexp_replace(upper(ws.workspace_key), '[^A-Z0-9]', '', 'g'), 3) = 'EMP'
        then 'EMP' || replace(substr(regexp_replace(upper(ws.workspace_key), '[^A-Z0-9]', '', 'g'), 4), 'O', '0')
      else replace(regexp_replace(upper(ws.workspace_key), '[^A-Z0-9]', '', 'g'), 'O', '0')
    end as workspace_key_canonical
  from public.workspace_snapshots ws
  where ws.workspace_key is not null
    and btrim(ws.workspace_key) <> ''
),
ranked as (
  select
    raw.*,
    row_number() over (
      partition by raw.workspace_key_canonical
      order by
        (raw.workspace_key ~ '^EMP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$') desc,
        raw.updated_at desc nulls last,
        raw.revision desc nulls last,
        raw.workspace_key asc
    ) as rn
  from raw
)
insert into public.workspace_registry (
  workspace_key,
  workspace_key_canonical,
  last_user_id,
  last_user_email
)
select
  r.workspace_key,
  r.workspace_key_canonical,
  r.last_user_id,
  r.last_user_email
from ranked r
where r.rn = 1
on conflict (workspace_key_canonical) do update
set
  last_user_id = coalesce(excluded.last_user_id, workspace_registry.last_user_id),
  last_user_email = coalesce(excluded.last_user_email, workspace_registry.last_user_email);
