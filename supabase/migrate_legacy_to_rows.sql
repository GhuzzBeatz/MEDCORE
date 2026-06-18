-- MedCore - migracao legado -> modelo mais seguro (tabelas separadas por categoria)
-- Execute APOS rodar supabase/setup.sql
-- Nao apaga tabelas antigas.

begin;

create or replace function public._mc_try_timestamptz(p_text text)
returns timestamptz
language plpgsql
immutable
as $$
begin
  if p_text is null or btrim(p_text) = '' then
    return null;
  end if;
  return p_text::timestamptz;
exception when others then
  return null;
end;
$$;

-- =========================================================
-- 1) Garante workspace_registry deduplicado
-- =========================================================
with all_keys as (
  select
    workspace_key,
    last_user_id as user_id,
    last_user_email as user_email,
    updated_at as seen_at
  from public.workspace_snapshots
  where workspace_key is not null and btrim(workspace_key) <> ''

  union all

  select
    workspace_key,
    user_id,
    user_email,
    last_login_at as seen_at
  from public.workspace_members
  where workspace_key is not null and btrim(workspace_key) <> ''

  union all

  select
    workspace_key,
    user_id,
    user_email,
    logged_at as seen_at
  from public.workspace_logins
  where workspace_key is not null and btrim(workspace_key) <> ''
),
normalized as (
  select
    workspace_key,
    case
      when left(regexp_replace(upper(workspace_key), '[^A-Z0-9]', '', 'g'), 3) = 'EMP'
        then 'EMP' || replace(substr(regexp_replace(upper(workspace_key), '[^A-Z0-9]', '', 'g'), 4), 'O', '0')
      else replace(regexp_replace(upper(workspace_key), '[^A-Z0-9]', '', 'g'), 'O', '0')
    end as workspace_key_canonical,
    user_id as last_user_id,
    user_email as last_user_email,
    seen_at
  from all_keys
),
ranked as (
  select
    n.*,
    row_number() over (
      partition by n.workspace_key_canonical
      order by
        (n.workspace_key ~ '^EMP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$') desc,
        n.seen_at desc nulls last,
        n.workspace_key asc
    ) as rn
  from normalized n
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

-- =========================================================
-- 2) Migra snapshots JSON -> tabelas separadas
-- =========================================================
insert into public.workspace_config_rows (
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
select
  ws.workspace_key,
  '__config__' as row_id,
  (
    coalesce(ws.data->'config', '{}'::jsonb)
      - '__sync_updated_at'
      - '__sync_version'
      - '__sync_deleted_at'
  ) as record,
  coalesce(
    public._mc_try_timestamptz(ws.data->'config'->>'__sync_updated_at'),
    ws.updated_at,
    now()
  ) as updated_at,
  public._mc_try_timestamptz(ws.data->'config'->>'__sync_deleted_at') as deleted_at,
  greatest(
    case
      when coalesce(ws.data->'config'->>'__sync_version', '') ~ '^[0-9]+$'
        then (ws.data->'config'->>'__sync_version')::bigint
      else 1
    end,
    1
  ) as version,
  'legacy_snapshot' as source_client,
  ws.last_user_id,
  ws.last_user_email,
  coalesce(ws.last_sync_source, 'legacy_import')
from public.workspace_snapshots ws
where ws.workspace_key is not null
on conflict (workspace_key, row_id) do update
set
  record = excluded.record,
  updated_at = excluded.updated_at,
  deleted_at = excluded.deleted_at,
  version = excluded.version,
  source_client = excluded.source_client,
  last_user_id = excluded.last_user_id,
  last_user_email = excluded.last_user_email,
  last_sync_source = excluded.last_sync_source
where
  excluded.version > workspace_config_rows.version
  or (
    excluded.version = workspace_config_rows.version
    and workspace_config_rows.deleted_at is null
    and excluded.updated_at > workspace_config_rows.updated_at
  )
  or (
    excluded.version = workspace_config_rows.version
    and workspace_config_rows.deleted_at is null
    and excluded.updated_at = workspace_config_rows.updated_at
    and excluded.deleted_at is not null
  );

do $$
declare
  v_name text;
  v_target text;
begin
  foreach v_name in array array[
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
    v_target := public.workspace_data_table_name(v_name);

    execute format($sql$
      with expanded as (
        select
          ws.workspace_key,
          ws.updated_at as snap_updated_at,
          ws.last_user_id,
          ws.last_user_email,
          ws.last_sync_source,
          e.value as rec,
          e.ordinality as ord
        from public.workspace_snapshots ws
        cross join lateral jsonb_array_elements(coalesce(ws.data -> %L, '[]'::jsonb)) with ordinality as e(value, ordinality)
      ),
      prepared as (
        select
          workspace_key,
          coalesce(
            nullif(rec->>'_row_id', ''),
            nullif(rec->>'id', ''),
            'legacy_' || substr(md5(workspace_key || ':' || %L || ':' || ord::text || ':' || rec::text), 1, 24)
          ) as row_id,
          (
            rec
              - '_row_id'
              - '_updated_at'
              - '_deleted_at'
              - '_version'
              - '_source_client'
          ) as record,
          coalesce(
            public._mc_try_timestamptz(rec->>'_updated_at'),
            snap_updated_at,
            now()
          ) as updated_at,
          public._mc_try_timestamptz(rec->>'_deleted_at') as deleted_at,
          greatest(
            case
              when coalesce(rec->>'_version', '') ~ '^[0-9]+$'
                then (rec->>'_version')::bigint
              else 1
            end,
            1
          ) as version,
          coalesce(nullif(rec->>'_source_client', ''), 'legacy_snapshot') as source_client,
          last_user_id,
          last_user_email,
          coalesce(last_sync_source, 'legacy_import') as last_sync_source
        from expanded
      )
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
      select
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
      from prepared
      on conflict (workspace_key, row_id) do update
      set
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
    $sql$, v_name, v_name, v_target, v_target, v_target, v_target, v_target, v_target, v_target, v_target);
  end loop;
end
$$;

-- =========================================================
-- 3) Se workspace_rows existir, aplica por cima (mais recente por versao/data)
-- =========================================================
do $$
declare
  v_name text;
  v_target text;
begin
  if to_regclass('public.workspace_rows') is null then
    return;
  end if;

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
    v_target := public.workspace_data_table_name(v_name);

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
      select
        wr.workspace_key,
        wr.row_id,
        wr.record,
        wr.updated_at,
        wr.deleted_at,
        greatest(coalesce(wr.version, 1), 1) as version,
        coalesce(wr.source_client, 'legacy_rows'),
        wr.last_user_id,
        wr.last_user_email,
        coalesce(wr.last_sync_source, 'legacy_rows_import')
      from public.workspace_rows wr
      where wr.table_name = %L
      on conflict (workspace_key, row_id) do update
      set
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
    $sql$, v_target, v_name, v_target, v_target, v_target, v_target, v_target, v_target, v_target);
  end loop;
end
$$;

drop function if exists public._mc_try_timestamptz(text);

commit;
