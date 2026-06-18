create table if not exists workspace_registry (
  workspace_key varchar(64) not null,
  workspace_key_canonical varchar(64) not null,
  created_at varchar(32) not null,
  created_by varchar(128) null,
  last_user_id varchar(128) null,
  last_user_email varchar(190) null,
  primary key (workspace_key),
  unique key uq_workspace_registry_canonical (workspace_key_canonical),
  key idx_workspace_registry_created_by (created_by),
  key idx_workspace_registry_last_user_id (last_user_id)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists workspace_members (
  workspace_key varchar(64) not null,
  user_id varchar(128) not null,
  user_email varchar(190) null,
  user_name varchar(190) null,
  provider varchar(32) not null default 'mysql',
  first_login_at varchar(32) not null,
  last_login_at varchar(32) not null,
  primary key (workspace_key, user_id),
  key idx_workspace_members_user (user_id)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists workspace_logins (
  id bigint unsigned not null auto_increment,
  workspace_key varchar(64) not null,
  user_id varchar(128) null,
  user_email varchar(190) null,
  app_name varchar(128) null,
  source varchar(128) null,
  logged_at varchar(32) not null,
  primary key (id),
  key idx_workspace_logins_workspace (workspace_key),
  key idx_workspace_logins_user (user_id)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists medcore_schema_meta (
  meta_key varchar(128) not null,
  meta_value varchar(255) not null,
  updated_at varchar(32) not null,
  primary key (meta_key)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists workspace_config_rows (
  workspace_key varchar(64) not null,
  row_id varchar(190) not null,
  record longtext not null,
  updated_at varchar(32) not null,
  deleted_at varchar(32) null,
  version bigint not null default 1,
  source_client varchar(128) null,
  last_user_id varchar(128) null,
  last_user_email varchar(190) null,
  last_sync_source varchar(128) null,
  created_at varchar(32) not null,
  primary key (workspace_key, row_id),
  key idx_ws_config_workspace (workspace_key),
  key idx_ws_config_workspace_updated (workspace_key, updated_at)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists workspace_usuarios_rows (
  workspace_key varchar(64) not null,
  row_id varchar(190) not null,
  record longtext not null,
  updated_at varchar(32) not null,
  deleted_at varchar(32) null,
  version bigint not null default 1,
  source_client varchar(128) null,
  last_user_id varchar(128) null,
  last_user_email varchar(190) null,
  last_sync_source varchar(128) null,
  created_at varchar(32) not null,
  primary key (workspace_key, row_id),
  key idx_ws_usuarios_workspace (workspace_key),
  key idx_ws_usuarios_workspace_updated (workspace_key, updated_at)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists workspace_medicos_rows (
  workspace_key varchar(64) not null,
  row_id varchar(190) not null,
  record longtext not null,
  updated_at varchar(32) not null,
  deleted_at varchar(32) null,
  version bigint not null default 1,
  source_client varchar(128) null,
  last_user_id varchar(128) null,
  last_user_email varchar(190) null,
  last_sync_source varchar(128) null,
  created_at varchar(32) not null,
  primary key (workspace_key, row_id),
  key idx_ws_medicos_workspace (workspace_key),
  key idx_ws_medicos_workspace_updated (workspace_key, updated_at)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists workspace_pacientes_rows (
  workspace_key varchar(64) not null,
  row_id varchar(190) not null,
  record longtext not null,
  updated_at varchar(32) not null,
  deleted_at varchar(32) null,
  version bigint not null default 1,
  source_client varchar(128) null,
  last_user_id varchar(128) null,
  last_user_email varchar(190) null,
  last_sync_source varchar(128) null,
  created_at varchar(32) not null,
  primary key (workspace_key, row_id),
  key idx_ws_pacientes_workspace (workspace_key),
  key idx_ws_pacientes_workspace_updated (workspace_key, updated_at)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists workspace_agenda_rows (
  workspace_key varchar(64) not null,
  row_id varchar(190) not null,
  record longtext not null,
  updated_at varchar(32) not null,
  deleted_at varchar(32) null,
  version bigint not null default 1,
  source_client varchar(128) null,
  last_user_id varchar(128) null,
  last_user_email varchar(190) null,
  last_sync_source varchar(128) null,
  created_at varchar(32) not null,
  primary key (workspace_key, row_id),
  key idx_ws_agenda_workspace (workspace_key),
  key idx_ws_agenda_workspace_updated (workspace_key, updated_at)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists workspace_prontuarios_rows (
  workspace_key varchar(64) not null,
  row_id varchar(190) not null,
  record longtext not null,
  updated_at varchar(32) not null,
  deleted_at varchar(32) null,
  version bigint not null default 1,
  source_client varchar(128) null,
  last_user_id varchar(128) null,
  last_user_email varchar(190) null,
  last_sync_source varchar(128) null,
  created_at varchar(32) not null,
  primary key (workspace_key, row_id),
  key idx_ws_prontuarios_workspace (workspace_key),
  key idx_ws_prontuarios_workspace_updated (workspace_key, updated_at)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists workspace_asos_rows (
  workspace_key varchar(64) not null,
  row_id varchar(190) not null,
  record longtext not null,
  updated_at varchar(32) not null,
  deleted_at varchar(32) null,
  version bigint not null default 1,
  source_client varchar(128) null,
  last_user_id varchar(128) null,
  last_user_email varchar(190) null,
  last_sync_source varchar(128) null,
  created_at varchar(32) not null,
  primary key (workspace_key, row_id),
  key idx_ws_asos_workspace (workspace_key),
  key idx_ws_asos_workspace_updated (workspace_key, updated_at)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists workspace_financeiro_rows (
  workspace_key varchar(64) not null,
  row_id varchar(190) not null,
  record longtext not null,
  updated_at varchar(32) not null,
  deleted_at varchar(32) null,
  version bigint not null default 1,
  source_client varchar(128) null,
  last_user_id varchar(128) null,
  last_user_email varchar(190) null,
  last_sync_source varchar(128) null,
  created_at varchar(32) not null,
  primary key (workspace_key, row_id),
  key idx_ws_financeiro_workspace (workspace_key),
  key idx_ws_financeiro_workspace_updated (workspace_key, updated_at)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists workspace_estoque_rows (
  workspace_key varchar(64) not null,
  row_id varchar(190) not null,
  record longtext not null,
  updated_at varchar(32) not null,
  deleted_at varchar(32) null,
  version bigint not null default 1,
  source_client varchar(128) null,
  last_user_id varchar(128) null,
  last_user_email varchar(190) null,
  last_sync_source varchar(128) null,
  created_at varchar(32) not null,
  primary key (workspace_key, row_id),
  key idx_ws_estoque_workspace (workspace_key),
  key idx_ws_estoque_workspace_updated (workspace_key, updated_at)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists workspace_medicamentos_rows (
  workspace_key varchar(64) not null,
  row_id varchar(190) not null,
  record longtext not null,
  updated_at varchar(32) not null,
  deleted_at varchar(32) null,
  version bigint not null default 1,
  source_client varchar(128) null,
  last_user_id varchar(128) null,
  last_user_email varchar(190) null,
  last_sync_source varchar(128) null,
  created_at varchar(32) not null,
  primary key (workspace_key, row_id),
  key idx_ws_medicamentos_workspace (workspace_key),
  key idx_ws_medicamentos_workspace_updated (workspace_key, updated_at)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists workspace_exames_banco_rows (
  workspace_key varchar(64) not null,
  row_id varchar(190) not null,
  record longtext not null,
  updated_at varchar(32) not null,
  deleted_at varchar(32) null,
  version bigint not null default 1,
  source_client varchar(128) null,
  last_user_id varchar(128) null,
  last_user_email varchar(190) null,
  last_sync_source varchar(128) null,
  created_at varchar(32) not null,
  primary key (workspace_key, row_id),
  key idx_ws_exames_banco_workspace (workspace_key),
  key idx_ws_exames_banco_workspace_updated (workspace_key, updated_at)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists workspace_solicitacoes_exames_rows (
  workspace_key varchar(64) not null,
  row_id varchar(190) not null,
  record longtext not null,
  updated_at varchar(32) not null,
  deleted_at varchar(32) null,
  version bigint not null default 1,
  source_client varchar(128) null,
  last_user_id varchar(128) null,
  last_user_email varchar(190) null,
  last_sync_source varchar(128) null,
  created_at varchar(32) not null,
  primary key (workspace_key, row_id),
  key idx_ws_solicitacoes_exames_workspace (workspace_key),
  key idx_ws_solicitacoes_exames_workspace_updated (workspace_key, updated_at)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists workspace_receituarios_salvos_rows (
  workspace_key varchar(64) not null,
  row_id varchar(190) not null,
  record longtext not null,
  updated_at varchar(32) not null,
  deleted_at varchar(32) null,
  version bigint not null default 1,
  source_client varchar(128) null,
  last_user_id varchar(128) null,
  last_user_email varchar(190) null,
  last_sync_source varchar(128) null,
  created_at varchar(32) not null,
  primary key (workspace_key, row_id),
  key idx_ws_receituarios_salvos_workspace (workspace_key),
  key idx_ws_receituarios_salvos_workspace_updated (workspace_key, updated_at)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists workspace_locais_rows (
  workspace_key varchar(64) not null,
  row_id varchar(190) not null,
  record longtext not null,
  updated_at varchar(32) not null,
  deleted_at varchar(32) null,
  version bigint not null default 1,
  source_client varchar(128) null,
  last_user_id varchar(128) null,
  last_user_email varchar(190) null,
  last_sync_source varchar(128) null,
  created_at varchar(32) not null,
  primary key (workspace_key, row_id),
  key idx_ws_locais_workspace (workspace_key),
  key idx_ws_locais_workspace_updated (workspace_key, updated_at)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists workspace_rows (
  workspace_key varchar(64) not null,
  table_name varchar(64) not null,
  row_id varchar(190) not null,
  record longtext not null,
  updated_at varchar(32) not null,
  deleted_at varchar(32) null,
  version bigint not null default 1,
  source_client varchar(128) null,
  last_user_id varchar(128) null,
  last_user_email varchar(190) null,
  last_sync_source varchar(128) null,
  created_at varchar(32) not null,
  primary key (workspace_key, table_name, row_id),
  key idx_workspace_rows_workspace_table (workspace_key, table_name),
  key idx_workspace_rows_workspace_updated (workspace_key, updated_at)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists medcore_workspaces (
  workspace_key varchar(64) not null,
  canonical_key varchar(64) not null,
  created_by varchar(128) null,
  created_email varchar(190) null,
  created_at varchar(32) not null,
  updated_at varchar(32) not null,
  primary key (workspace_key),
  unique key uq_medcore_workspaces_canonical (canonical_key),
  key idx_medcore_workspaces_updated (updated_at)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists medcore_workspace_rows (
  workspace_key varchar(64) not null,
  table_name varchar(64) not null,
  row_id varchar(190) not null,
  record longtext not null,
  updated_at varchar(32) not null,
  deleted_at varchar(32) null,
  version bigint not null default 1,
  source_client varchar(128) null,
  created_at varchar(32) not null,
  primary key (workspace_key, table_name, row_id),
  key idx_medcore_rows_workspace_table_updated (workspace_key, table_name, updated_at),
  key idx_medcore_rows_workspace_updated (workspace_key, updated_at)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;


create table if not exists licenses (
  id bigint unsigned not null auto_increment,
  license_key varchar(64) not null,
  workspace_key varchar(64) not null,
  customer_name varchar(190) null,
  customer_email varchar(190) null,
  mercado_livre_order varchar(128) null,
  status varchar(32) not null default 'active',
  max_devices int not null default 5,
  expires_at varchar(32) null,
  notes text null,
  created_at varchar(32) not null,
  updated_at varchar(32) not null,
  primary key (id),
  unique key uq_licenses_key (license_key),
  unique key uq_licenses_workspace (workspace_key),
  key idx_licenses_status (status),
  key idx_licenses_customer_email (customer_email)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists license_devices (
  id bigint unsigned not null auto_increment,
  license_id bigint unsigned not null,
  device_hash varchar(128) not null,
  device_name varchar(190) null,
  device_os varchar(190) null,
  app_version varchar(64) null,
  status varchar(32) not null default 'active',
  activated_at varchar(32) not null,
  last_seen_at varchar(32) not null,
  created_at varchar(32) not null,
  updated_at varchar(32) not null,
  primary key (id),
  unique key uq_license_devices_hash (license_id, device_hash),
  key idx_license_devices_license_status (license_id, status),
  constraint fk_license_devices_license foreign key (license_id) references licenses(id) on delete cascade
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists license_events (
  id bigint unsigned not null auto_increment,
  license_id bigint unsigned null,
  license_key varchar(64) null,
  event_type varchar(64) not null,
  device_hash varchar(128) null,
  device_name varchar(190) null,
  device_os varchar(190) null,
  app_version varchar(64) null,
  message text null,
  created_at varchar(32) not null,
  primary key (id),
  key idx_license_events_license (license_id, created_at),
  key idx_license_events_key (license_key),
  key idx_license_events_type (event_type)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;
