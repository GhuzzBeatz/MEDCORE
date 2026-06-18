<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, X-MedCore-Token, X-MedCore-Admin');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }
date_default_timezone_set('America/Sao_Paulo');

const MEDCORE_TABLES = [
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
    'locais',
];

function respond(array $payload, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function br_datetime(DateTimeInterface $date): string
{
    return $date->setTimezone(new DateTimeZone('America/Sao_Paulo'))->format('Y-m-d\TH:i:sP');
}

function iso_now(): string
{
    return br_datetime(new DateTimeImmutable('now', new DateTimeZone('America/Sao_Paulo')));
}

function normalize_time(?string $value, ?string $fallback = null): string
{
    $fallback = $fallback ?: iso_now();
    $value = trim((string)$value);
    if ($value === '') return $fallback;

    try {
        return br_datetime(new DateTimeImmutable($value));
    } catch (Throwable $e) {
        return $fallback;
    }
}

function medcore_table_map(): array
{
    return [
        'config' => 'workspace_config_rows',
        'usuarios' => 'workspace_usuarios_rows',
        'medicos' => 'workspace_medicos_rows',
        'pacientes' => 'workspace_pacientes_rows',
        'agenda' => 'workspace_agenda_rows',
        'prontuarios' => 'workspace_prontuarios_rows',
        'asos' => 'workspace_asos_rows',
        'financeiro' => 'workspace_financeiro_rows',
        'estoque' => 'workspace_estoque_rows',
        'medicamentos' => 'workspace_medicamentos_rows',
        'exames_banco' => 'workspace_exames_banco_rows',
        'solicitacoes_exames' => 'workspace_solicitacoes_exames_rows',
        'receituarios_salvos' => 'workspace_receituarios_salvos_rows',
        'locais' => 'workspace_locais_rows',
    ];
}

function physical_table_name(string $logicalTable): string
{
    $map = medcore_table_map();
    if (!isset($map[$logicalTable])) {
        respond(['ok' => false, 'message' => 'Tabela invalida.'], 400);
    }
    return $map[$logicalTable];
}

function clean_workspace(string $value): string
{
    $value = strtoupper(trim($value));
    $value = str_replace('_', '-', $value);
    return preg_replace('/[^A-Z0-9_-]/', '', $value) ?? '';
}

function clean_canonical(string $value): string
{
    $value = str_replace('-', '', clean_workspace($value));
    $value = str_replace('O', '0', $value);
    return $value;
}

function read_config(): array
{
    return [
    'db_host' => 'localhost',
    'db_name' => 'ghzplugi_medcore',
    'db_user' => 'ghzplugi_mcapi',
    'db_pass' => '_tYTrE7EtH1AxdBQ5tYUe7wHZFBXWsdgAa7!',
    'api_token' => 'RYi4-zBUdJGV7ZGfEphFU0WHB-D5zApE7LEYjLlxgrk',
    'admin_token_hash' => '7001f49423927295e2394f9797a0890a018605cbbf60ccdfa91fbc94eacb96a8',
    'update_manifest_url' => 'https://raw.githubusercontent.com/ghzplugin/medcore/main/update-manifest.json',
];
}


function pdo(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) return $pdo;

    $config = read_config();
    $host = (string)($config['db_host'] ?? 'localhost');
    $name = (string)($config['db_name'] ?? '');
    $user = (string)($config['db_user'] ?? '');
    $pass = (string)($config['db_pass'] ?? '');
    if ($name === '' || $user === '') {
        respond(['ok' => false, 'message' => 'Banco MySQL nao configurado.'], 500);
    }

    $dsn = "mysql:host={$host};dbname={$name};charset=utf8mb4";
    $pdo = new PDO($dsn, $user, $pass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    return $pdo;
}

function require_auth(): void
{
    $config = read_config();
    $expected = (string)($config['api_token'] ?? '');
    $provided = (string)($_SERVER['HTTP_X_MEDCORE_TOKEN'] ?? '');
    if ($expected === '' || !hash_equals($expected, $provided)) {
        respond(['ok' => false, 'message' => 'Token invalido.'], 401);
    }
}

function read_input(): array
{
    $raw = file_get_contents('php://input') ?: '';
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function install_schema(): void
{
    $db = pdo();
    $schema = <<<'SQL'
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

SQL;

    $parts = array_filter(array_map('trim', preg_split('/;\s*[\r\n]+/', $schema) ?: []));
    foreach ($parts as $sql) {
        if ($sql !== '') $db->exec($sql);
    }

    migrate_legacy_workspace_rows();
}

function migrate_legacy_registry(): void
{
    $db = pdo();
    $metaKey = 'legacy_registry_migration_20260615';
    $stmt = $db->prepare('select meta_value from medcore_schema_meta where meta_key = ? limit 1');
    $stmt->execute([$metaKey]);
    if ($stmt->fetch()) return;

    try {
        $rows = $db->query('select workspace_key, canonical_key, created_at, created_by, created_email from medcore_workspaces')->fetchAll();
        $insert = $db->prepare(
            'insert into workspace_registry (workspace_key, workspace_key_canonical, created_at, created_by, last_user_id, last_user_email)
             values (?, ?, ?, ?, ?, ?)
             on duplicate key update last_user_id = values(last_user_id), last_user_email = values(last_user_email)'
        );
        foreach ($rows as $row) {
            $createdAt = normalize_time((string)($row['created_at'] ?? ''));
            $insert->execute([
                $row['workspace_key'],
                $row['canonical_key'],
                $createdAt,
                (string)($row['created_by'] ?? ''),
                (string)($row['created_by'] ?? ''),
                (string)($row['created_email'] ?? ''),
            ]);
        }
    } catch (Throwable $e) {
        // Tabela legada pode nao existir em instalacoes novas.
    }

    $done = iso_now();
    $stmt = $db->prepare(
        'insert into medcore_schema_meta (meta_key, meta_value, updated_at)
         values (?, ?, ?)
         on duplicate key update meta_value = values(meta_value), updated_at = values(updated_at)'
    );
    $stmt->execute([$metaKey, 'done', $done]);
}

function migrate_legacy_workspace_rows(): void
{
    $db = pdo();
    migrate_legacy_registry();
    $metaKey = 'legacy_split_migration_20260615';
    $stmt = $db->prepare('select meta_value from medcore_schema_meta where meta_key = ? limit 1');
    $stmt->execute([$metaKey]);
    if ($stmt->fetch()) return;

    try {
        $legacyRows = $db->query(
            'select workspace_key, table_name, row_id, record, updated_at, deleted_at, version, source_client, created_at
             from medcore_workspace_rows'
        )->fetchAll();
        $legacyInsert = $db->prepare(
            'insert into workspace_rows
             (workspace_key, table_name, row_id, record, updated_at, deleted_at, version, source_client, created_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?)
             on duplicate key update
                record = values(record),
                updated_at = values(updated_at),
                deleted_at = values(deleted_at),
                version = values(version),
                source_client = values(source_client)'
        );
        foreach ($legacyRows as $row) {
            $updatedAt = normalize_time((string)($row['updated_at'] ?? ''));
            $deletedAt = empty($row['deleted_at']) ? null : normalize_time((string)$row['deleted_at'], $updatedAt);
            $createdAt = normalize_time((string)($row['created_at'] ?? ''), $updatedAt);
            $legacyInsert->execute([
                $row['workspace_key'],
                $row['table_name'],
                $row['row_id'],
                $row['record'],
                $updatedAt,
                $deletedAt,
                (int)$row['version'],
                $row['source_client'],
                $createdAt,
            ]);
        }
    } catch (Throwable $e) {
        // Tabela legada pode nao existir em instalacoes novas.
    }

    $select = $db->prepare(
        'select workspace_key, row_id, record, updated_at, deleted_at, version, source_client, created_at
         from workspace_rows where table_name = ?'
    );

    foreach (medcore_table_map() as $logicalTable => $physicalTable) {
        $select->execute([$logicalTable]);
        $insert = $db->prepare(
            "insert into {$physicalTable}
             (workspace_key, row_id, record, updated_at, deleted_at, version, source_client, created_at)
             values (?, ?, ?, ?, ?, ?, ?, ?)
             on duplicate key update
                record = values(record),
                updated_at = values(updated_at),
                deleted_at = values(deleted_at),
                version = values(version),
                source_client = values(source_client)"
        );

        while ($row = $select->fetch()) {
            $updatedAt = normalize_time((string)($row['updated_at'] ?? ''));
            $deletedAt = empty($row['deleted_at']) ? null : normalize_time((string)$row['deleted_at'], $updatedAt);
            $createdAt = normalize_time((string)($row['created_at'] ?? ''), $updatedAt);
            $insert->execute([
                $row['workspace_key'],
                $row['row_id'],
                $row['record'],
                $updatedAt,
                $deletedAt,
                (int)$row['version'],
                $row['source_client'],
                $createdAt,
            ]);
        }
    }

    $done = iso_now();
    $stmt = $db->prepare(
        'insert into medcore_schema_meta (meta_key, meta_value, updated_at)
         values (?, ?, ?)
         on duplicate key update meta_value = values(meta_value), updated_at = values(updated_at)'
    );
    $stmt->execute([$metaKey, 'done', $done]);
}

function ensure_workspace(string $workspaceKey, array $user = []): void
{
    $key = clean_workspace($workspaceKey);
    if ($key === '') respond(['ok' => false, 'message' => 'Codigo da clinica invalido.'], 400);

    $now = iso_now();
    $userId = (string)($user['id'] ?? '');
    $userEmail = (string)($user['email'] ?? '');
    $userName = (string)($user['name'] ?? '');
    $db = pdo();

    $stmt = $db->prepare(
        'insert into workspace_registry (workspace_key, workspace_key_canonical, created_at, created_by, last_user_id, last_user_email)
         values (?, ?, ?, ?, ?, ?)
         on duplicate key update last_user_id = values(last_user_id), last_user_email = values(last_user_email)'
    );
    $stmt->execute([$key, clean_canonical($key), $now, $userId, $userId, $userEmail]);

    if ($userId !== '') {
        $stmt = $db->prepare(
            'insert into workspace_members (workspace_key, user_id, user_email, user_name, provider, first_login_at, last_login_at)
             values (?, ?, ?, ?, ?, ?, ?)
             on duplicate key update user_email = values(user_email), user_name = values(user_name), last_login_at = values(last_login_at)'
        );
        $stmt->execute([$key, $userId, $userEmail, $userName, 'mysql', $now, $now]);
    }
}

function action_health(): void
{
    try {
        install_schema();
        respond(['ok' => true, 'message' => 'MedCore MySQL API online.', 'time' => iso_now()]);
    } catch (Throwable $e) {
        respond(['ok' => false, 'message' => $e->getMessage()], 500);
    }
}

function action_workspace_resolve(array $input): void
{
    install_schema();
    $db = pdo();
    $workspace = clean_workspace((string)($input['workspace_key'] ?? ''));
    $canonical = clean_canonical((string)($input['canonical_key'] ?? $workspace));
    $candidates = $input['candidates'] ?? [];
    $values = [];
    foreach ((array)$candidates as $candidate) {
        $clean = clean_workspace((string)$candidate);
        if ($clean !== '') $values[$clean] = true;
    }
    if ($workspace !== '') $values[$workspace] = true;

    foreach (array_keys($values) as $candidate) {
        $stmt = $db->prepare('select workspace_key from workspace_registry where workspace_key = ? limit 1');
        $stmt->execute([$candidate]);
        $row = $stmt->fetch();
        if ($row && !empty($row['workspace_key'])) {
            respond(['ok' => true, 'workspace_key' => $row['workspace_key']]);
        }
    }

    if ($canonical !== '') {
        $stmt = $db->prepare('select workspace_key from workspace_registry where workspace_key_canonical = ? limit 1');
        $stmt->execute([$canonical]);
        $row = $stmt->fetch();
        if ($row && !empty($row['workspace_key'])) {
            respond(['ok' => true, 'workspace_key' => $row['workspace_key']]);
        }
    }

    respond(['ok' => true, 'workspace_key' => '']);
}

function action_workspace_create(array $input): void
{
    install_schema();
    ensure_workspace((string)($input['workspace_key'] ?? ''), (array)($input['user'] ?? []));
    respond(['ok' => true, 'workspace_key' => clean_workspace((string)$input['workspace_key'])]);
}

function action_workspace_access(array $input): void
{
    install_schema();
    $workspace = clean_workspace((string)($input['workspace_key'] ?? ''));
    if ($workspace === '') respond(['ok' => false, 'message' => 'Codigo da clinica invalido.'], 400);

    $db = pdo();
    $stmt = $db->prepare('select workspace_key from workspace_registry where workspace_key = ? limit 1');
    $stmt->execute([$workspace]);
    if (!$stmt->fetch()) {
        respond(['ok' => false, 'message' => 'Codigo da clinica nao encontrado.'], 404);
    }

    $user = (array)($input['user'] ?? []);
    $stmt = $db->prepare(
        'insert into workspace_logins (workspace_key, user_id, user_email, app_name, source, logged_at)
         values (?, ?, ?, ?, ?, ?)'
    );
    $stmt->execute([
        $workspace,
        (string)($user['id'] ?? ''),
        (string)($user['email'] ?? ''),
        'MedCore',
        (string)($input['device_id'] ?? ($_SERVER['HTTP_X_MEDCORE_CLIENT'] ?? '')),
        iso_now(),
    ]);

    respond(['ok' => true, 'workspace_key' => $workspace]);
}

function row_is_newer(array $incoming, ?array $current): bool
{
    if (!$current) return true;
    $incomingVersion = (int)($incoming['version'] ?? 1);
    $currentVersion = (int)($current['version'] ?? 1);
    if ($incomingVersion !== $currentVersion) return $incomingVersion > $currentVersion;
    return strcmp((string)($incoming['updated_at'] ?? ''), (string)($current['updated_at'] ?? '')) >= 0;
}

function action_rows_push(array $input): void
{
    install_schema();
    $workspace = clean_workspace((string)($input['workspace_key'] ?? ''));
    if ($workspace === '') respond(['ok' => false, 'message' => 'Codigo da clinica invalido.'], 400);
    ensure_workspace($workspace, (array)($input['user'] ?? []));

    $rows = $input['rows'] ?? [];
    if (!is_array($rows)) respond(['ok' => false, 'message' => 'Lista de linhas invalida.'], 400);

    $db = pdo();
    $db->beginTransaction();
    $accepted = 0;
    $prepared = [];

    try {
        foreach ($rows as $row) {
            if (!is_array($row)) continue;
            $table = (string)($row['table_name'] ?? '');
            if (!in_array($table, MEDCORE_TABLES, true)) continue;
            $rowId = trim((string)($row['row_id'] ?? ''));
            if ($rowId === '') continue;

            $physicalTable = physical_table_name($table);
            if (!isset($prepared[$physicalTable])) {
                $prepared[$physicalTable] = [
                    'select' => $db->prepare(
                        "select updated_at, version from {$physicalTable}
                         where workspace_key = ? and row_id = ? limit 1"
                    ),
                    'insert' => $db->prepare(
                        "insert into {$physicalTable}
                         (workspace_key, row_id, record, updated_at, deleted_at, version, source_client, created_at)
                         values (?, ?, ?, ?, ?, ?, ?, ?)"
                    ),
                    'update' => $db->prepare(
                        "update {$physicalTable}
                         set record = ?, updated_at = ?, deleted_at = ?, version = ?, source_client = ?
                         where workspace_key = ? and row_id = ?"
                    ),
                ];
            }

            $payload = $row['record'] ?? [];
            if (!is_array($payload)) $payload = [];
            $updatedAt = normalize_time((string)($row['updated_at'] ?? ''), iso_now());
            $deletedAt = empty($row['deleted_at']) ? null : normalize_time((string)$row['deleted_at'], $updatedAt);
            $version = max(1, (int)($row['version'] ?? 1));
            $sourceClient = (string)($row['source_client'] ?? '');

            $prepared[$physicalTable]['select']->execute([$workspace, $rowId]);
            $current = $prepared[$physicalTable]['select']->fetch() ?: null;
            if (!row_is_newer(['updated_at' => $updatedAt, 'version' => $version], $current)) {
                continue;
            }

            $recordJson = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            if ($current) {
                $prepared[$physicalTable]['update']->execute([$recordJson, $updatedAt, $deletedAt, $version, $sourceClient, $workspace, $rowId]);
            } else {
                $prepared[$physicalTable]['insert']->execute([$workspace, $rowId, $recordJson, $updatedAt, $deletedAt, $version, $sourceClient, iso_now()]);
            }
            $accepted++;
        }

        $db->commit();
    } catch (Throwable $e) {
        $db->rollBack();
        throw $e;
    }

    respond(['ok' => true, 'accepted' => $accepted, 'storage' => 'split_tables_brasilia']);
}

function action_rows_pull(array $input): void
{
    install_schema();
    $workspace = clean_workspace((string)($input['workspace_key'] ?? ''));
    if ($workspace === '') respond(['ok' => false, 'message' => 'Codigo da clinica invalido.'], 400);

    $tables = $input['tables'] ?? MEDCORE_TABLES;
    $sinceByTable = is_array($input['since_by_table'] ?? null) ? $input['since_by_table'] : [];
    $db = pdo();
    $rows = [];
    $maxUpdated = [];

    foreach ((array)$tables as $table) {
        $table = (string)$table;
        if (!in_array($table, MEDCORE_TABLES, true)) continue;
        $physicalTable = physical_table_name($table);
        $since = normalize_time((string)($sinceByTable[$table] ?? ''), '');

        if ($since !== '') {
            $stmt = $db->prepare(
                "select row_id, record, updated_at, deleted_at, version, source_client
                 from {$physicalTable}
                 where workspace_key = ? and updated_at > ?
                 order by updated_at asc, row_id asc"
            );
            $stmt->execute([$workspace, $since]);
        } else {
            $stmt = $db->prepare(
                "select row_id, record, updated_at, deleted_at, version, source_client
                 from {$physicalTable}
                 where workspace_key = ?
                 order by updated_at asc, row_id asc"
            );
            $stmt->execute([$workspace]);
        }

        $result = $stmt->fetchAll();
        foreach ($result as $row) {
            $record = json_decode((string)$row['record'], true);
            if (!is_array($record)) $record = [];
            $rows[] = [
                'table_name' => $table,
                'row_id' => $row['row_id'],
                'record' => $record,
                'updated_at' => $row['updated_at'],
                'deleted_at' => $row['deleted_at'],
                'version' => (int)$row['version'],
                'source_client' => $row['source_client'],
            ];
            if (empty($maxUpdated[$table]) || strcmp((string)$row['updated_at'], (string)$maxUpdated[$table]) > 0) {
                $maxUpdated[$table] = $row['updated_at'];
            }
        }
    }

    respond(['ok' => true, 'rows' => $rows, 'max_updated_by_table' => $maxUpdated, 'storage' => 'split_tables_brasilia']);
}


function admin_token_from_input(array $input): string
{
    return trim((string)($input['admin_token'] ?? ($_SERVER['HTTP_X_MEDCORE_ADMIN'] ?? '')));
}

function require_admin(array $input): void
{
    $config = read_config();
    $expectedHash = strtolower((string)($config['admin_token_hash'] ?? ''));
    $provided = admin_token_from_input($input);
    if ($expectedHash === '' || $provided === '') {
        respond(['ok' => false, 'message' => 'Token administrativo obrigatorio.'], 401);
    }
    $providedHash = hash('sha256', $provided);
    if (!hash_equals($expectedHash, $providedHash)) {
        respond(['ok' => false, 'message' => 'Token administrativo invalido.'], 401);
    }
}

function normalize_license_key(string $value): string
{
    return strtoupper(preg_replace('/[^A-Z0-9]/', '', $value) ?? '');
}

function format_license_key(string $raw): string
{
    $raw = normalize_license_key($raw);
    if (str_starts_with($raw, 'MEDCORE')) $raw = substr($raw, 7);
    $raw = substr($raw, 0, 16);
    return 'MEDCORE-' . implode('-', str_split($raw, 4));
}

function generate_license_key(): string
{
    return format_license_key(bin2hex(random_bytes(8)));
}

function generate_license_workspace_key(): string
{
    return 'LIC-' . strtoupper(substr(bin2hex(random_bytes(6)), 0, 12));
}

function license_public(array $license): array
{
    return [
        'license_key' => $license['license_key'] ?? '',
        'workspace_key' => $license['workspace_key'] ?? '',
        'customer_name' => $license['customer_name'] ?? '',
        'customer_email' => $license['customer_email'] ?? '',
        'status' => $license['status'] ?? '',
        'max_devices' => (int)($license['max_devices'] ?? 5),
        'expires_at' => $license['expires_at'] ?? null,
    ];
}

function load_license_by_key(string $licenseKey): ?array
{
    $db = pdo();
    $stmt = $db->prepare('select * from licenses where license_key = ? limit 1');
    $stmt->execute([format_license_key($licenseKey)]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function is_license_expired(?string $expiresAt): bool
{
    $expiresAt = trim((string)$expiresAt);
    if ($expiresAt === '') return false;
    try {
        $expires = new DateTimeImmutable($expiresAt);
        $now = new DateTimeImmutable('now', new DateTimeZone('America/Sao_Paulo'));
        return $expires < $now;
    } catch (Throwable $e) {
        return false;
    }
}

function record_license_event(?array $license, string $eventType, array $device, string $message = ''): void
{
    try {
        $db = pdo();
        $stmt = $db->prepare(
            'insert into license_events
             (license_id, license_key, event_type, device_hash, device_name, device_os, app_version, message, created_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $license['id'] ?? null,
            $license['license_key'] ?? ($device['license_key'] ?? null),
            $eventType,
            (string)($device['device_hash'] ?? ''),
            (string)($device['device_name'] ?? ''),
            (string)($device['device_os'] ?? ''),
            (string)($device['app_version'] ?? ''),
            $message,
            iso_now(),
        ]);
    } catch (Throwable $e) {
        // Auditoria nao deve derrubar o login do cliente.
    }
}

function validate_license_status(array $license, array $device = []): ?array
{
    $status = strtolower((string)($license['status'] ?? ''));
    if ($status !== 'active') {
        record_license_event($license, 'license_denied', $device, 'Licenca bloqueada/cancelada.');
        return ['code' => 'license_blocked', 'message' => 'Licenca bloqueada ou cancelada. Entre em contato com o suporte.'];
    }
    if (is_license_expired($license['expires_at'] ?? null)) {
        record_license_event($license, 'license_expired', $device, 'Licenca expirada.');
        return ['code' => 'license_expired', 'message' => 'Licenca expirada. Entre em contato com o suporte.'];
    }
    return null;
}

function latest_download_url(): string
{
    $config = read_config();
    $url = trim((string)($config['update_manifest_url'] ?? ''));
    if ($url === '') return '';
    $ctx = stream_context_create(['http' => ['timeout' => 5]]);
    $json = @file_get_contents($url, false, $ctx);
    if ($json === false) return '';
    $data = json_decode($json, true);
    return is_array($data) ? (string)($data['download_url'] ?? '') : '';
}

function action_license_create(array $input): void
{
    install_schema();
    require_admin($input);
    $db = pdo();
    $now = iso_now();
    $maxDevices = max(1, min(50, (int)($input['max_devices'] ?? 5)));
    $expiresAt = trim((string)($input['expires_at'] ?? ''));
    $expiresAt = $expiresAt === '' ? null : normalize_time($expiresAt, $now);

    for ($i = 0; $i < 10; $i++) {
        $licenseKey = generate_license_key();
        $workspaceKey = generate_license_workspace_key();
        try {
            $stmt = $db->prepare(
                'insert into licenses
                 (license_key, workspace_key, customer_name, customer_email, mercado_livre_order, status, max_devices, expires_at, notes, created_at, updated_at)
                 values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            );
            $stmt->execute([
                $licenseKey,
                $workspaceKey,
                trim((string)($input['customer_name'] ?? '')),
                trim((string)($input['customer_email'] ?? '')),
                trim((string)($input['mercado_livre_order'] ?? '')),
                'active',
                $maxDevices,
                $expiresAt,
                trim((string)($input['notes'] ?? '')),
                $now,
                $now,
            ]);
            ensure_workspace($workspaceKey, [
                'id' => 'license-generator',
                'email' => trim((string)($input['customer_email'] ?? '')),
                'name' => trim((string)($input['customer_name'] ?? '')),
            ]);
            $license = load_license_by_key($licenseKey);
            record_license_event($license, 'license_created', [], 'Licenca criada pelo gerador.');
            $downloadUrl = latest_download_url();
            $text = "Ola! Obrigado pela compra do MedCore.\n\n" .
                "Link do instalador: " . ($downloadUrl ?: 'consulte o link enviado pelo suporte') . "\n\n" .
                "Codigo de ativacao: {$licenseKey}\n\n" .
                "Instale, abra o app e clique em Entrar/Ativar.\n" .
                "Esta chave e individual e libera ate {$maxDevices} computadores.";
            respond([
                'ok' => true,
                'license_key' => $licenseKey,
                'workspace_key' => $workspaceKey,
                'download_url' => $downloadUrl,
                'message_text' => $text,
                'license' => license_public($license ?: []),
            ]);
        } catch (Throwable $e) {
            if ($i >= 9) throw $e;
        }
    }
}

function license_device_payload(array $input): array
{
    return [
        'license_key' => format_license_key((string)($input['license_key'] ?? '')),
        'device_hash' => trim((string)($input['device_hash'] ?? '')),
        'device_name' => substr(trim((string)($input['device_name'] ?? '')), 0, 190),
        'device_os' => substr(trim((string)($input['device_os'] ?? '')), 0, 190),
        'app_version' => substr(trim((string)($input['app_version'] ?? '')), 0, 64),
    ];
}

function action_license_activate(array $input): void
{
    install_schema();
    $device = license_device_payload($input);
    if ($device['license_key'] === 'MEDCORE-' || $device['device_hash'] === '') {
        respond(['ok' => false, 'code' => 'invalid_request', 'message' => 'Chave ou computador invalido.'], 400);
    }

    $db = pdo();
    $license = load_license_by_key($device['license_key']);
    if (!$license) {
        record_license_event(null, 'invalid_license', $device, 'Chave inexistente.');
        respond(['ok' => false, 'code' => 'invalid_license', 'message' => 'Chave de ativacao invalida.'], 404);
    }

    $statusError = validate_license_status($license, $device);
    if ($statusError) respond(['ok' => false, ...$statusError], 403);

    $now = iso_now();
    $db->beginTransaction();
    try {
        $stmt = $db->prepare('select * from license_devices where license_id = ? and device_hash = ? limit 1');
        $stmt->execute([(int)$license['id'], $device['device_hash']]);
        $existing = $stmt->fetch() ?: null;

        if ($existing) {
            if (strtolower((string)$existing['status']) !== 'active') {
                $db->commit();
                record_license_event($license, 'device_blocked', $device, 'Computador bloqueado.');
                respond(['ok' => false, 'code' => 'device_blocked', 'message' => 'Este computador esta bloqueado para esta licenca.'], 403);
            }
            $upd = $db->prepare('update license_devices set device_name = ?, device_os = ?, app_version = ?, last_seen_at = ?, updated_at = ? where id = ?');
            $upd->execute([$device['device_name'], $device['device_os'], $device['app_version'], $now, $now, (int)$existing['id']]);
            $db->commit();
            record_license_event($license, 'license_validated', $device, 'Computador ja ativado validado.');
            respond(['ok' => true, 'activated' => false, 'workspace_key' => $license['workspace_key'], 'license' => license_public($license)]);
        }

        $countStmt = $db->prepare("select count(*) as total from license_devices where license_id = ? and status = 'active'");
        $countStmt->execute([(int)$license['id']]);
        $activeTotal = (int)(($countStmt->fetch() ?: [])['total'] ?? 0);
        $maxDevices = max(1, (int)$license['max_devices']);
        if ($activeTotal >= $maxDevices) {
            $db->commit();
            record_license_event($license, 'device_limit_reached', $device, 'Limite de computadores atingido.');
            respond(['ok' => false, 'code' => 'limit_reached', 'message' => "Limite de computadores atingido ({$activeTotal}/{$maxDevices})."], 403);
        }

        $ins = $db->prepare(
            'insert into license_devices
             (license_id, device_hash, device_name, device_os, app_version, status, activated_at, last_seen_at, created_at, updated_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $ins->execute([(int)$license['id'], $device['device_hash'], $device['device_name'], $device['device_os'], $device['app_version'], 'active', $now, $now, $now, $now]);
        $db->commit();
        record_license_event($license, 'license_activated', $device, 'Novo computador ativado.');
        respond(['ok' => true, 'activated' => true, 'workspace_key' => $license['workspace_key'], 'license' => license_public($license)]);
    } catch (Throwable $e) {
        $db->rollBack();
        throw $e;
    }
}

function action_license_validate(array $input): void
{
    install_schema();
    $device = license_device_payload($input);
    $license = load_license_by_key($device['license_key']);
    if (!$license) {
        record_license_event(null, 'invalid_license', $device, 'Validacao com chave inexistente.');
        respond(['ok' => false, 'code' => 'invalid_license', 'message' => 'Chave de ativacao invalida.'], 404);
    }
    $statusError = validate_license_status($license, $device);
    if ($statusError) respond(['ok' => false, ...$statusError], 403);

    $db = pdo();
    $stmt = $db->prepare('select * from license_devices where license_id = ? and device_hash = ? limit 1');
    $stmt->execute([(int)$license['id'], $device['device_hash']]);
    $row = $stmt->fetch() ?: null;
    if (!$row) {
        record_license_event($license, 'device_not_activated', $device, 'Computador nao ativado.');
        respond(['ok' => false, 'code' => 'device_not_activated', 'message' => 'Este computador ainda nao esta ativado para esta chave.'], 403);
    }
    if (strtolower((string)$row['status']) !== 'active') {
        record_license_event($license, 'device_blocked', $device, 'Computador bloqueado.');
        respond(['ok' => false, 'code' => 'device_blocked', 'message' => 'Este computador esta bloqueado para esta licenca.'], 403);
    }
    $now = iso_now();
    $upd = $db->prepare('update license_devices set device_name = ?, device_os = ?, app_version = ?, last_seen_at = ?, updated_at = ? where id = ?');
    $upd->execute([$device['device_name'], $device['device_os'], $device['app_version'], $now, $now, (int)$row['id']]);
    record_license_event($license, 'license_validated', $device, 'Licenca validada.');
    respond(['ok' => true, 'workspace_key' => $license['workspace_key'], 'license' => license_public($license)]);
}

function action_license_devices(array $input): void
{
    install_schema();
    require_admin($input);
    $license = load_license_by_key((string)($input['license_key'] ?? ''));
    if (!$license) respond(['ok' => false, 'message' => 'Licenca nao encontrada.'], 404);
    $db = pdo();
    $stmt = $db->prepare('select device_hash, device_name, device_os, app_version, status, activated_at, last_seen_at from license_devices where license_id = ? order by activated_at asc');
    $stmt->execute([(int)$license['id']]);
    $devices = $stmt->fetchAll();
    $used = 0;
    foreach ($devices as $d) if (strtolower((string)$d['status']) === 'active') $used++;
    respond(['ok' => true, 'license' => license_public($license), 'used' => $used, 'max_devices' => (int)$license['max_devices'], 'devices' => $devices]);
}

function action_license_device_block(array $input): void
{
    install_schema();
    require_admin($input);
    $license = load_license_by_key((string)($input['license_key'] ?? ''));
    if (!$license) respond(['ok' => false, 'message' => 'Licenca nao encontrada.'], 404);
    $deviceHash = trim((string)($input['device_hash'] ?? ''));
    if ($deviceHash === '') respond(['ok' => false, 'message' => 'device_hash obrigatorio.'], 400);
    $status = strtolower((string)($input['status'] ?? 'blocked')) === 'active' ? 'active' : 'blocked';
    $db = pdo();
    $stmt = $db->prepare('update license_devices set status = ?, updated_at = ? where license_id = ? and device_hash = ?');
    $stmt->execute([$status, iso_now(), (int)$license['id'], $deviceHash]);
    record_license_event($license, $status === 'active' ? 'device_unblocked' : 'device_blocked_admin', ['device_hash' => $deviceHash], 'Status alterado pelo administrador.');
    respond(['ok' => true, 'status' => $status]);
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    respond(['ok' => true, 'message' => 'MedCore MySQL API. Use POST autenticado.']);
}

try {
    $input = read_input();
    $action = (string)($input['action'] ?? '');

    switch ($action) {
        case 'license_create':
            action_license_create($input);
            break;
        case 'license_activate':
            action_license_activate($input);
            break;
        case 'license_validate':
            action_license_validate($input);
            break;
        case 'license_devices':
            action_license_devices($input);
            break;
        case 'license_device_block':
            action_license_device_block($input);
            break;
    }

    require_auth();

    switch ($action) {
        case 'health':
            action_health();
            break;
        case 'workspace_resolve':
            action_workspace_resolve($input);
            break;
        case 'workspace_create':
            action_workspace_create($input);
            break;
        case 'workspace_access':
            action_workspace_access($input);
            break;
        case 'rows_push':
            action_rows_push($input);
            break;
        case 'rows_pull':
            action_rows_pull($input);
            break;
        default:
            respond(['ok' => false, 'message' => 'Acao invalida.'], 400);
    }
} catch (Throwable $e) {
    respond(['ok' => false, 'message' => $e->getMessage()], 500);
}

