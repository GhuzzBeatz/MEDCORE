const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')
const { randomBytes, createHash } = require('crypto')
const { createClient } = require('@supabase/supabase-js')

app.setName('MedCore')

const OAUTH_REDIRECT_URL = 'https://medcore.local/auth/callback'
const DEFAULT_SUPABASE_URL = 'https://cdzbbqaehcrqoernigoc.supabase.co'
const DEFAULT_SUPABASE_PUBLISHABLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNkemJicWFlaGNycW9lcm5pZ29jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1NzE2MDIsImV4cCI6MjA4ODE0NzYwMn0.tI_Ru7d4vUySOFef_Q9gUDZNPN0Gnm2tDkVz9LYLosE'
const FORCE_EMBEDDED_SUPABASE_CONFIG = true
const CLOUD_SYNC_PROVIDER = 'mysql'
const DEFAULT_MYSQL_API_URL = 'https://ghzplugin.com.br/medcore-api/index.php'
const DEFAULT_MYSQL_API_TOKEN = 'RYi4-zBUdJGV7ZGfEphFU0WHB-D5zApE7LEYjLlxgrk'
const MYSQL_API_TIMEOUT_MS = 15000
const TABLE_NAMES = [
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
]
const ARRAY_TABLE_NAMES = TABLE_NAMES.filter((name) => name !== 'config')
const SYNC_REMOTE_TABLE_MAP = Object.freeze(TABLE_NAMES.reduce((acc, tableName) => {
  acc[tableName] = `workspace_${tableName}_rows`
  return acc
}, {}))
const LEGACY_SYNC_TABLES = Object.freeze([
  'workspace_rows',
  'workspace_snapshots',
  'workspace_members',
  'workspace_logins'
])
const SYNC_INTERVAL_MS = 10 * 60 * 1000
const SYNC_DEBOUNCE_MS = 15 * 1000
const SYNC_PULL_MIN_INTERVAL_MS = 2 * 60 * 1000
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000
const DIAGNOSTICS_LOG_INTERVAL_MS = 60 * 1000
const SYNC_FETCH_PAGE_SIZE = 1000
const SYNC_RPC_BATCH_SIZE = 200
const CONFIG_ROW_ID = '__config__'
const CONFIG_META_UPDATED_AT = '__sync_updated_at'
const CONFIG_META_VERSION = '__sync_version'
const CONFIG_META_DELETED_AT = '__sync_deleted_at'

let win = null
let painelWin = null
let oauthWin = null
let supabaseClient = null
let syncTimer = null
let syncDebounceTimer = null
let lastSupabaseConfigSignature = ''
let isQuittingNow = false
let currentUserCache = { signedIn: false, user: null, expiresAt: 0 }
let lastDiagnosticsLogAt = 0
const DEFAULT_TITLEBAR_HEIGHT = 24
const DEVICE_ID = getOrCreateDeviceId()
process.env.MEDCORE_DEVICE_ID = DEVICE_ID
const syncDiagnostics = {
  startedAt: nowIso(),
  total: 0,
  auth: 0,
  rpc: 0,
  byTarget: {},
  lastSyncAt: '',
  lastSyncReason: ''
}

function resolveWindowTheme(themeName) {
  const t = String(themeName || '').toLowerCase() === 'dark' ? 'dark' : 'light'
  if (t === 'dark') {
    return {
      name: 'dark',
      color: '#0f1117',
      symbolColor: '#f3f4f6'
    }
  }
  return {
    name: 'light',
    color: '#f4f6fb',
    symbolColor: '#111827'
  }
}

function sanitizeTitlebarHeight(height) {
  const n = Number(height)
  if (!Number.isFinite(n)) return DEFAULT_TITLEBAR_HEIGHT
  return Math.max(24, Math.min(36, Math.round(n)))
}

function applyWindowOverlay(themeName, requestedHeight) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) {
    return { applied: false }
  }

  const palette = resolveWindowTheme(themeName)
  const height = sanitizeTitlebarHeight(requestedHeight)

  win.setTitleBarOverlay({
    color: palette.color,
    symbolColor: palette.symbolColor,
    height
  })
  win.setBackgroundColor(palette.color)

  return {
    applied: true,
    theme: palette.name,
    overlayColor: palette.color,
    symbolColor: palette.symbolColor,
    height
  }
}

function getDataDir() {
  return app.isPackaged
    ? path.join(app.getPath('userData'), 'data')
    : path.join(__dirname, 'data')
}

function getMetaDir() {
  return path.join(app.getPath('userData'), 'meta')
}

function getSupabaseConfigPath() {
  return path.join(getMetaDir(), 'supabase_config.json')
}

function getSupabaseStoragePath() {
  return path.join(getMetaDir(), 'supabase_auth_storage.json')
}

function getRuntimeStatePath() {
  return path.join(getMetaDir(), 'runtime_state.json')
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true })
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (_) {
    return fallback
  }
}

function writeJsonFile(filePath, data) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
}

function nowIso() {
  return new Date().toISOString()
}

function toIsoOrFallback(value, fallback = nowIso()) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return fallback
  return date.toISOString()
}

function asPositiveInt(value, fallback = 1) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.floor(n)
}

function normalizeConfigSyncMeta(config) {
  const cfg = config && typeof config === 'object' && !Array.isArray(config) ? { ...config } : {}
  cfg[CONFIG_META_UPDATED_AT] = toIsoOrFallback(cfg[CONFIG_META_UPDATED_AT], nowIso())
  cfg[CONFIG_META_VERSION] = asPositiveInt(cfg[CONFIG_META_VERSION], 1)
  cfg[CONFIG_META_DELETED_AT] = cfg[CONFIG_META_DELETED_AT] ? toIsoOrFallback(cfg[CONFIG_META_DELETED_AT], nowIso()) : null
  return cfg
}

function stripConfigSyncMeta(config) {
  const out = config && typeof config === 'object' && !Array.isArray(config) ? { ...config } : {}
  delete out[CONFIG_META_UPDATED_AT]
  delete out[CONFIG_META_VERSION]
  delete out[CONFIG_META_DELETED_AT]
  return out
}

function safeRowId(tableName, record, idx) {
  if (record && record._row_id !== undefined && record._row_id !== null && String(record._row_id).trim()) {
    return String(record._row_id).trim()
  }

  if (record && record.id !== undefined && record.id !== null && String(record.id).trim()) {
    return String(record.id).trim()
  }

  const fallbackHash = Buffer.from(`${tableName}:${JSON.stringify(record || {})}:${idx}`, 'utf8')
    .toString('base64')
    .replace(/[=+/]/g, '')
    .slice(0, 18)
  return `legacy_${fallbackHash}_${idx}`
}

function stripRowSyncMeta(record) {
  const out = record && typeof record === 'object' && !Array.isArray(record) ? { ...record } : {}
  delete out._row_id
  delete out._updated_at
  delete out._deleted_at
  delete out._version
  delete out._source_client
  return out
}

function sanitizeArrayRecord(tableName, record, idx) {
  const src = record && typeof record === 'object' && !Array.isArray(record) ? { ...record } : {}
  const rowId = safeRowId(tableName, src, idx)
  const updatedAt = toIsoOrFallback(src._updated_at, nowIso())
  const deletedAt = src._deleted_at ? toIsoOrFallback(src._deleted_at, updatedAt) : null
  const version = asPositiveInt(src._version, 1)
  const clean = stripRowSyncMeta(src)

  if (clean.id === undefined || clean.id === null || String(clean.id).trim() === '') {
    const maybeNum = Number(rowId)
    if (Number.isFinite(maybeNum)) clean.id = maybeNum
  }

  clean._row_id = rowId
  clean._updated_at = updatedAt
  clean._deleted_at = deletedAt
  clean._version = version
  clean._source_client = String(src._source_client || '')
  return clean
}

function getDefaultSnapshot() {
  return {
    config: {},
    usuarios: [],
    medicos: [],
    pacientes: [],
    agenda: [],
    prontuarios: [],
    asos: [],
    financeiro: [],
    estoque: [],
    medicamentos: [],
    exames_banco: [],
    solicitacoes_exames: [],
    receituarios_salvos: [],
    locais: []
  }
}

function sanitizeSnapshot(input) {
  const src = input && typeof input === 'object' ? input : {}
  const out = getDefaultSnapshot()

  TABLE_NAMES.forEach((name) => {
    const value = src[name]
    if (name === 'config') {
      out[name] = normalizeConfigSyncMeta(value)
      return
    }

    if (Array.isArray(out[name])) {
      const list = Array.isArray(value) ? value : []
      out[name] = list.map((row, idx) => sanitizeArrayRecord(name, row, idx))
    } else {
      out[name] = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    }
  })

  return out
}

function readLocalSnapshot() {
  const dir = getDataDir()
  ensureDir(dir)
  const snapshot = getDefaultSnapshot()

  TABLE_NAMES.forEach((name) => {
    const file = path.join(dir, `${name}.json`)
    const fallback = Array.isArray(snapshot[name]) ? [] : {}
    snapshot[name] = readJsonFile(file, fallback)
  })

  return sanitizeSnapshot(snapshot)
}

function writeLocalSnapshot(snapshot) {
  const dir = getDataDir()
  ensureDir(dir)
  const safe = sanitizeSnapshot(snapshot)

  TABLE_NAMES.forEach((name) => {
    writeJsonFile(path.join(dir, `${name}.json`), safe[name])
  })
}

function snapshotToWorkspaceRows(snapshot) {
  const safe = sanitizeSnapshot(snapshot)
  const rows = []

  ARRAY_TABLE_NAMES.forEach((tableName) => {
    safe[tableName].forEach((item, idx) => {
      const row = sanitizeArrayRecord(tableName, item, idx)
      rows.push({
        table_name: tableName,
        row_id: String(row._row_id),
        record: stripRowSyncMeta(row),
        updated_at: row._updated_at,
        deleted_at: row._deleted_at || null,
        version: asPositiveInt(row._version, 1),
        source_client: String(row._source_client || '')
      })
    })
  })

  const cfg = normalizeConfigSyncMeta(safe.config)
  rows.push({
    table_name: 'config',
    row_id: CONFIG_ROW_ID,
    record: stripConfigSyncMeta(cfg),
    updated_at: cfg[CONFIG_META_UPDATED_AT],
    deleted_at: cfg[CONFIG_META_DELETED_AT] || null,
    version: asPositiveInt(cfg[CONFIG_META_VERSION], 1),
    source_client: ''
  })

  return rows
}

function workspaceRowsToSnapshot(rows) {
  const snapshot = getDefaultSnapshot()
  snapshot.config = normalizeConfigSyncMeta(snapshot.config)

  const grouped = {}
  ARRAY_TABLE_NAMES.forEach((tableName) => { grouped[tableName] = [] })

  ;(Array.isArray(rows) ? rows : []).forEach((row, idx) => {
    if (!row || typeof row !== 'object') return
    const tableName = String(row.table_name || '')
    if (!TABLE_NAMES.includes(tableName)) return

    if (tableName === 'config') {
      const cfg = row.record && typeof row.record === 'object' && !Array.isArray(row.record) ? { ...row.record } : {}
      cfg[CONFIG_META_UPDATED_AT] = toIsoOrFallback(row.updated_at, nowIso())
      cfg[CONFIG_META_VERSION] = asPositiveInt(row.version, 1)
      cfg[CONFIG_META_DELETED_AT] = row.deleted_at ? toIsoOrFallback(row.deleted_at, cfg[CONFIG_META_UPDATED_AT]) : null
      snapshot.config = normalizeConfigSyncMeta(cfg)
      return
    }

    const payload = row.record && typeof row.record === 'object' && !Array.isArray(row.record) ? { ...row.record } : {}
    payload._row_id = String(row.row_id || safeRowId(tableName, payload, idx))
    payload._updated_at = toIsoOrFallback(row.updated_at, nowIso())
    payload._deleted_at = row.deleted_at ? toIsoOrFallback(row.deleted_at, payload._updated_at) : null
    payload._version = asPositiveInt(row.version, 1)
    payload._source_client = String(row.source_client || '')
    grouped[tableName].push(payload)
  })

  ARRAY_TABLE_NAMES.forEach((tableName) => {
    snapshot[tableName] = grouped[tableName]
      .map((row, idx) => sanitizeArrayRecord(tableName, row, idx))
  })

  return sanitizeSnapshot(snapshot)
}

function mergeSnapshotsPreservingNewest(localSnapshot, remoteSnapshot) {
  const localRows = snapshotToWorkspaceRows(sanitizeSnapshot(localSnapshot))
  const remoteRows = snapshotToWorkspaceRows(sanitizeSnapshot(remoteSnapshot))
  const byKey = new Map()

  localRows.forEach((row) => {
    const key = `${row.table_name}::${row.row_id}`
    byKey.set(key, row)
  })

  remoteRows.forEach((row) => {
    const key = `${row.table_name}::${row.row_id}`
    const current = byKey.get(key)
    if (!current || isRowNewer(row, current)) {
      byKey.set(key, row)
    }
  })

  return workspaceRowsToSnapshot(Array.from(byKey.values()))
}

function mergeWorkspaceRowsIntoSnapshot(localSnapshot, remoteRows) {
  const localRows = snapshotToWorkspaceRows(sanitizeSnapshot(localSnapshot))
  const byKey = new Map()

  localRows.forEach((row) => {
    byKey.set(`${row.table_name}::${row.row_id}`, row)
  })

  ;(Array.isArray(remoteRows) ? remoteRows : []).forEach((row) => {
    const tableName = String(row && row.table_name ? row.table_name : '')
    const rowId = String(row && row.row_id ? row.row_id : '')
    if (!TABLE_NAMES.includes(tableName) || !rowId) return

    const key = `${tableName}::${rowId}`
    const current = byKey.get(key)
    if (!current || isRowNewer(row, current)) {
      byKey.set(key, row)
    }
  })

  return workspaceRowsToSnapshot(Array.from(byKey.values()))
}

function getRowsChangedAfter(snapshot, lastPushByTable, forceFullPush) {
  const lastMap = lastPushByTable && typeof lastPushByTable === 'object' && !Array.isArray(lastPushByTable) ? lastPushByTable : {}
  return snapshotToWorkspaceRows(snapshot).filter((row) => {
    const tableName = String(row.table_name || '')
    const updatedAt = new Date(row.updated_at || 0).getTime()
    const lastPushedAt = new Date(lastMap[tableName] || 0).getTime()
    if (forceFullPush) return true
    if (!Number.isFinite(updatedAt) || updatedAt <= lastPushedAt) return false
    if (tableName === 'config') return true
    const sourceClient = String(row.source_client || '')
    return !sourceClient || sourceClient === DEVICE_ID
  })
}

function getMaxUpdatedByTable(rows) {
  const out = {}
  ;(Array.isArray(rows) ? rows : []).forEach((row) => {
    const tableName = String(row && row.table_name ? row.table_name : '')
    const updatedAt = row && row.updated_at ? toIsoOrFallback(row.updated_at, '') : ''
    if (!tableName || !updatedAt) return
    out[tableName] = mergeIsoMap(out, { [tableName]: updatedAt })[tableName]
  })
  return out
}

function isRowNewer(candidate, current) {
  const candVersion = asPositiveInt(candidate && candidate.version, 1)
  const currVersion = asPositiveInt(current && current.version, 1)
  if (candVersion !== currVersion) return candVersion > currVersion

  const candAt = new Date(candidate && candidate.updated_at ? candidate.updated_at : 0).getTime()
  const currAt = new Date(current && current.updated_at ? current.updated_at : 0).getTime()
  if (candAt !== currAt) return candAt > currAt

  const candDeleted = !!(candidate && candidate.deleted_at)
  const currDeleted = !!(current && current.deleted_at)
  if (candDeleted !== currDeleted) return candDeleted

  const candSource = String(candidate && candidate.source_client ? candidate.source_client : '')
  const currSource = String(current && current.source_client ? current.source_client : '')
  return candSource > currSource
}

function normalizeSupabaseUrl(input) {
  const raw = String(input || '').trim()
  if (!raw) return ''

  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`

  try {
    const parsed = new URL(candidate)
    if (!String(parsed.hostname || '').toLowerCase().endsWith('.supabase.co')) {
      return ''
    }
    return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, '')
  } catch (_) {
    return ''
  }
}

function readSupabaseConfig() {
  if (FORCE_EMBEDDED_SUPABASE_CONFIG) {
    return {
      url: DEFAULT_SUPABASE_URL,
      anonKey: DEFAULT_SUPABASE_PUBLISHABLE_KEY
    }
  }

  const raw = readJsonFile(getSupabaseConfigPath(), {})
  const url = normalizeSupabaseUrl(raw.url) || DEFAULT_SUPABASE_URL
  const anonKey = String(raw.anonKey || '').trim() || DEFAULT_SUPABASE_PUBLISHABLE_KEY
  return { url, anonKey }
}

function saveSupabaseConfig(url, anonKey) {
  if (FORCE_EMBEDDED_SUPABASE_CONFIG) {
    writeJsonFile(getSupabaseConfigPath(), {
      url: DEFAULT_SUPABASE_URL,
      anonKey: DEFAULT_SUPABASE_PUBLISHABLE_KEY
    })
    supabaseClient = null
    lastSupabaseConfigSignature = ''
    return
  }

  writeJsonFile(getSupabaseConfigPath(), {
    url: normalizeSupabaseUrl(url),
    anonKey: String(anonKey || '').trim()
  })
  supabaseClient = null
  lastSupabaseConfigSignature = ''
}

function ensureDefaultSupabaseConfig() {
  if (FORCE_EMBEDDED_SUPABASE_CONFIG) {
    writeJsonFile(getSupabaseConfigPath(), {
      url: DEFAULT_SUPABASE_URL,
      anonKey: DEFAULT_SUPABASE_PUBLISHABLE_KEY
    })
    return
  }

  const filePath = getSupabaseConfigPath()
  const raw = readJsonFile(filePath, {})
  const normalizedUrl = normalizeSupabaseUrl(raw.url)
  const hasUrl = normalizedUrl.length > 0
  const hasAnonKey = String(raw.anonKey || '').trim().length > 0

  if (!hasUrl || !hasAnonKey) {
    writeJsonFile(filePath, {
      url: hasUrl ? normalizedUrl : DEFAULT_SUPABASE_URL,
      anonKey: hasAnonKey ? String(raw.anonKey || '').trim() : DEFAULT_SUPABASE_PUBLISHABLE_KEY
    })
  }
}

function readRuntimeState() {
  return readJsonFile(getRuntimeStatePath(), {
    workspaceKey: '',
    lastSyncAt: '',
    lastRemotePullAt: '',
    lastPullByTable: {},
    lastPushByTable: {}
  })
}

function mergeIsoMap(currentMap, nextMap) {
  const out = currentMap && typeof currentMap === 'object' && !Array.isArray(currentMap) ? { ...currentMap } : {}
  Object.entries(nextMap && typeof nextMap === 'object' ? nextMap : {}).forEach(([key, value]) => {
    if (!value) return
    const currentTime = new Date(out[key] || 0).getTime()
    const nextTime = new Date(value).getTime()
    if (!Number.isFinite(currentTime) || !out[key] || nextTime > currentTime) {
      out[key] = value
    }
  })
  return out
}

function recordSupabaseCall(kind, target, amount = 1) {
  const count = Math.max(1, Number(amount) || 1)
  const name = `${String(kind || 'api')}:${String(target || 'unknown')}`
  syncDiagnostics.total += count
  syncDiagnostics.byTarget[name] = (syncDiagnostics.byTarget[name] || 0) + count
  if (kind === 'auth') syncDiagnostics.auth += count
  if (kind === 'rpc') syncDiagnostics.rpc += count
}

function getSyncDiagnosticsSnapshot() {
  const elapsedMs = Math.max(0, Date.now() - new Date(syncDiagnostics.startedAt).getTime())
  return {
    startedAt: syncDiagnostics.startedAt,
    elapsedMinutes: Math.round(elapsedMs / 6000) / 10,
    total: syncDiagnostics.total,
    auth: syncDiagnostics.auth,
    rpc: syncDiagnostics.rpc,
    byTarget: { ...syncDiagnostics.byTarget },
    lastSyncAt: syncDiagnostics.lastSyncAt,
    lastSyncReason: syncDiagnostics.lastSyncReason
  }
}

function maybeLogSyncDiagnostics(reason) {
  const now = Date.now()
  if (now - lastDiagnosticsLogAt < DIAGNOSTICS_LOG_INTERVAL_MS) return
  lastDiagnosticsLogAt = now
  console.log('[cloud-diagnostics]', reason || 'sync', JSON.stringify(getSyncDiagnosticsSnapshot()))
}

async function checkSupabaseHealth(url) {
  const base = String(url || '').replace(/\/+$/, '')
  const healthUrl = `${base}/auth/v1/health`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 7000)

  try {
    // Probe de conectividade: se houver resposta HTTP (200/401/404 etc),
    // a URL/base está acessivel; erro aqui deve ser DNS/rede/TLS.
    await fetch(healthUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: ctrl.signal
    })
    return { ok: true }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err)
    return {
      ok: false,
      message: `Nao foi possivel conectar ao Supabase. Verifique a URL do projeto e sua internet.\nDetalhe tecnico: ${msg}`
    }
  } finally {
    clearTimeout(timer)
  }
}

function isMysqlCloudMode() {
  return String(CLOUD_SYNC_PROVIDER || '').toLowerCase() === 'mysql'
}

function getMysqlApiConfig() {
  return {
    url: String(process.env.MEDCORE_MYSQL_API_URL || DEFAULT_MYSQL_API_URL || '').trim().replace(/\/+$/, ''),
    token: String(process.env.MEDCORE_MYSQL_API_TOKEN || DEFAULT_MYSQL_API_TOKEN || '').trim()
  }
}

function getMysqlPseudoUser() {
  return {
    id: `device:${DEVICE_ID}`,
    email: 'medcore@mysql.local',
    user_metadata: {
      full_name: 'MedCore MySQL'
    }
  }
}

function mysqlUserPayload(user) {
  const src = user || getMysqlPseudoUser()
  return {
    id: String(src.id || `device:${DEVICE_ID}`),
    email: String(src.email || 'medcore@mysql.local'),
    name: String((src.user_metadata && (src.user_metadata.full_name || src.user_metadata.name)) || '')
  }
}

async function mysqlApiRequest(action, payload = {}, options = {}) {
  const cfg = getMysqlApiConfig()
  const skipApiToken = !!(options && options.skipApiToken)
  if (!cfg.url || (!skipApiToken && (!cfg.token || cfg.token.includes('COLE_SEU_TOKEN')))) {
    throw new Error('API MySQL do MedCore ainda nao esta configurada neste instalador.')
  }
  if (typeof fetch !== 'function') {
    throw new Error('Este Electron nao possui fetch no processo principal.')
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), MYSQL_API_TIMEOUT_MS)
  recordSupabaseCall('api', `mysql:${action}`)

  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(skipApiToken ? {} : { 'X-MedCore-Token': cfg.token }),
        'X-MedCore-Client': DEVICE_ID
      },
      body: JSON.stringify({
        action,
        device_id: DEVICE_ID,
        ...(payload && typeof payload === 'object' ? payload : {})
      }),
      signal: ctrl.signal
    })

    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch (_) {
      throw new Error(`Resposta invalida da API MySQL (${res.status}).`)
    }

    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.message) || `Erro HTTP ${res.status} na API MySQL.`)
    }

    return data
  } catch (err) {
    const msg = err && err.message ? err.message : String(err)
    if (msg.toLowerCase().includes('abort')) {
      throw new Error('Tempo esgotado ao conectar na API MySQL do MedCore.')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function checkMysqlApiHealth() {
  try {
    await mysqlApiRequest('health', {})
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      message: `Nao foi possivel conectar na API MySQL do MedCore.\nDetalhe tecnico: ${err && err.message ? err.message : String(err)}`
    }
  }
}


function readWindowsMachineGuid() {
  if (process.platform !== 'win32') return ''
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000
    })
    const match = String(out || '').match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i)
    return match ? match[1].trim() : ''
  } catch (_) {
    return ''
  }
}

function getLicenseDeviceInfo() {
  const machineGuid = readWindowsMachineGuid()
  const hostname = os.hostname() || 'computador'
  const platform = `${process.platform}-${process.arch}`
  const release = os.release() || ''
  const basis = [
    'medcore-license-v1',
    machineGuid || DEVICE_ID,
    hostname,
    platform,
    release
  ].join('|')

  return {
    device_hash: createHash('sha256').update(basis).digest('hex'),
    device_name: hostname,
    device_os: `${platform} ${release}`.trim(),
    app_version: app.getVersion()
  }
}

function normalizeLicenseKey(value) {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!raw) return ''
  const body = raw.startsWith('MEDCORE') ? raw.slice(7) : raw
  const clean = body.slice(0, 16)
  if (clean.length < 16) return raw
  return `MEDCORE-${clean.slice(0, 4)}-${clean.slice(4, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}`
}

function getLicenseStatePath() {
  return path.join(getMetaDir(), 'license_state.json')
}

function readLicenseState() {
  return readJsonFile(getLicenseStatePath(), {})
}

function saveLicenseState(state) {
  writeJsonFile(getLicenseStatePath(), {
    ...readLicenseState(),
    ...(state && typeof state === 'object' ? state : {})
  })
}

async function activateLicenseOnline(licenseKey, mode = 'activate') {
  const key = normalizeLicenseKey(licenseKey)
  if (!key) throw new Error('Digite a chave de ativacao.')
  const device = getLicenseDeviceInfo()
  const action = mode === 'validate' ? 'license_validate' : 'license_activate'
  const data = await mysqlApiRequest(action, {
    license_key: key,
    ...device
  }, { skipApiToken: true })
  const workspaceKey = normalizeWorkspaceKey(data.workspace_key || (data.license && data.license.workspace_key) || '')
  if (!workspaceKey) throw new Error('A licenca foi validada, mas nao retornou o workspace da clinica.')
  const user = {
    id: `license:${key}`,
    email: 'medcore@license.local',
    user_metadata: { full_name: 'MedCore Licenca' }
  }
  await enterMysqlWorkspaceSession(user, workspaceKey, 'license_enter', { create: true })
  saveLicenseState({
    license_key: key,
    workspace_key: workspaceKey,
    customer_name: data.license && data.license.customer_name ? data.license.customer_name : '',
    activated_at: data.activated ? nowIso() : (readLicenseState().activated_at || nowIso()),
    last_validated_at: nowIso(),
    device_name: device.device_name
  })
  return {
    ok: true,
    licenseKey: key,
    workspaceKey,
    activated: !!data.activated,
    license: data.license || {},
    device: { device_name: device.device_name, device_os: device.device_os }
  }
}

function saveRuntimeState(state) {
  const current = readRuntimeState()
  const next = {
    ...current,
    ...(state && typeof state === 'object' ? state : {})
  }
  writeJsonFile(getRuntimeStatePath(), next)
}

function normalizeWorkspaceKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/_/g, '-')
    .replace(/[^A-Z0-9_-]/g, '')
}

function canonicalWorkspaceKey(value) {
  const normalized = normalizeWorkspaceKey(value).replace(/-/g, '')
  if (!normalized) return ''
  if (normalized.startsWith('EMP')) {
    return `EMP${normalized.slice(3).replace(/O/g, '0')}`
  }
  return normalized.replace(/O/g, '0')
}

function formatWorkspaceFromCanonical(canonical) {
  const raw = String(canonical || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (raw.startsWith('EMP') && raw.length === 15) {
    const s = raw.slice(3)
    return `EMP-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`
  }
  return raw
}

function getWorkspaceCandidates(value) {
  const normalized = normalizeWorkspaceKey(value)
  const compact = normalized.replace(/-/g, '')
  const canonical = canonicalWorkspaceKey(normalized)
  const canonicalFormatted = formatWorkspaceFromCanonical(canonical)
  const oVariantCompact = canonical.replace(/0/g, 'O')
  const oVariantFormatted = formatWorkspaceFromCanonical(oVariantCompact)

  const out = new Set()
  ;[normalized, compact, canonical, canonicalFormatted, oVariantCompact, oVariantFormatted]
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .forEach((v) => out.add(v))

  return Array.from(out)
}

function getWorkspaceDataTableName(tableName) {
  return SYNC_REMOTE_TABLE_MAP[String(tableName || '').trim()] || ''
}

function getDeviceIdPath() {
  return path.join(getMetaDir(), 'device_id.txt')
}

function getOrCreateDeviceId() {
  const file = getDeviceIdPath()
  try {
    const existing = String(fs.readFileSync(file, 'utf8') || '').trim()
    if (existing) return existing
  } catch (_) {}

  const created = `mc_${randomBytes(8).toString('hex')}`
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, created, 'utf8')
  return created
}

function simpleUser(user) {
  if (!user) return null
  return {
    id: user.id,
    email: user.email || '',
    name: (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name)) || '',
    avatarUrl: (user.user_metadata && user.user_metadata.avatar_url) || ''
  }
}

function createFileStorage(storageFile) {
  ensureDir(path.dirname(storageFile))
  let cache = readJsonFile(storageFile, {})

  function flush() {
    fs.writeFileSync(storageFile, JSON.stringify(cache, null, 2), 'utf8')
  }

  return {
    getItem: (key) => {
      const value = cache[key]
      return value === undefined ? null : value
    },
    setItem: (key, value) => {
      cache[key] = value
      flush()
    },
    removeItem: (key) => {
      delete cache[key]
      flush()
    }
  }
}

function getSupabaseClientStrict() {
  const cfg = readSupabaseConfig()
  const url = String(cfg.url || '').trim()
  const anonKey = String(cfg.anonKey || '').trim()

  if (!url || !anonKey) {
    throw new Error('Configure URL e Anon Key do Supabase na tela de login.')
  }

  const signature = `${url}::${anonKey}`
  if (supabaseClient && lastSupabaseConfigSignature === signature) {
    return supabaseClient
  }

  const storage = createFileStorage(getSupabaseStoragePath())
  supabaseClient = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage
    }
  })
  lastSupabaseConfigSignature = signature
  currentUserCache = { signedIn: false, user: null, expiresAt: 0 }
  return supabaseClient
}

function getSupabaseClientOptional() {
  try {
    return getSupabaseClientStrict()
  } catch (_) {
    return null
  }
}

async function getCurrentUser(options = {}) {
  const force = !!(options && options.force)
  if (!force && currentUserCache.expiresAt > Date.now()) {
    return {
      signedIn: currentUserCache.signedIn,
      user: currentUserCache.user
    }
  }

  const client = getSupabaseClientOptional()
  if (!client) {
    return { signedIn: false, user: null }
  }

  try {
    recordSupabaseCall('auth', 'getSession')
    const { data: sessionData } = await client.auth.getSession()
    const sessionUser = sessionData && sessionData.session && sessionData.session.user
    if (sessionUser) {
      currentUserCache = {
        signedIn: true,
        user: sessionUser,
        expiresAt: Date.now() + AUTH_CACHE_TTL_MS
      }
      return { signedIn: true, user: sessionUser }
    }
  } catch (_) {}

  recordSupabaseCall('auth', 'getUser')
  const { data, error } = await client.auth.getUser()
  if (error || !data || !data.user) {
    currentUserCache = { signedIn: false, user: null, expiresAt: Date.now() + 30 * 1000 }
    return { signedIn: false, user: null }
  }

  currentUserCache = {
    signedIn: true,
    user: data.user,
    expiresAt: Date.now() + AUTH_CACHE_TTL_MS
  }
  return { signedIn: true, user: data.user }
}

function chunkArray(list, chunkSize) {
  const arr = Array.isArray(list) ? list : []
  const out = []
  for (let i = 0; i < arr.length; i += chunkSize) {
    out.push(arr.slice(i, i + chunkSize))
  }
  return out
}

function isMissingRelationError(err) {
  const msg = String((err && err.message) || '').toLowerCase()
  const code = String((err && err.code) || '').toUpperCase()
  if (code === '42P01') return true
  if (code === 'PGRST205') return true
  return msg.includes('does not exist')
    || msg.includes('relation')
    || msg.includes('could not find')
    || msg.includes('not found in the schema cache')
}

function isSupabaseSetupHintError(message) {
  const msg = String(message || '')
  if (
    msg.includes('workspace_snapshots')
    || msg.includes('workspace_members')
    || msg.includes('workspace_logins')
    || msg.includes('workspace_rows')
    || msg.includes('workspace_registry')
    || msg.includes('workspace_merge_table_rows')
  ) {
    return true
  }
  return msg.includes('workspace_') && msg.includes('_rows')
}

function isLikelyNetworkSyncError(message) {
  const msg = String(message || '').toLowerCase()
  return msg.includes('fetch failed')
    || msg.includes('failed to fetch')
    || msg.includes('network')
    || msg.includes('internet')
    || msg.includes('enotfound')
    || msg.includes('eai_again')
    || msg.includes('err_internet_disconnected')
    || msg.includes('timed out')
    || msg.includes('dns')
}

async function ensureWorkspaceRegistryRecord(client, workspaceKey, user) {
  const canonical = canonicalWorkspaceKey(workspaceKey)
  const now = nowIso()
  const payload = {
    workspace_key: workspaceKey,
    workspace_key_canonical: canonical,
    created_by: user && user.id ? user.id : null,
    created_at: now,
    last_user_id: user && user.id ? user.id : null,
    last_user_email: user && user.email ? user.email : ''
  }

  recordSupabaseCall('insert', 'workspace_registry')
  const { error: insertErr } = await client
    .from('workspace_registry')
    .insert(payload)

  if (insertErr && insertErr.code !== '23505') {
    throw new Error(`Erro ao registrar codigo da clinica: ${insertErr.message}`)
  }

  recordSupabaseCall('update', 'workspace_registry')
  const { error: updateErr } = await client
    .from('workspace_registry')
    .update({
      workspace_key_canonical: canonical,
      last_user_id: payload.last_user_id,
      last_user_email: payload.last_user_email
    })
    .eq('workspace_key', workspaceKey)

  if (updateErr) {
    throw new Error(`Erro ao atualizar cadastro do codigo da clinica: ${updateErr.message}`)
  }
}

async function resolveWorkspaceKeyFromRegistry(client, inputKey) {
  const candidates = getWorkspaceCandidates(inputKey)
  const canonical = canonicalWorkspaceKey(inputKey)

  if (candidates.length > 0) {
    recordSupabaseCall('select', 'workspace_registry')
    const { data, error } = await client
      .from('workspace_registry')
      .select('workspace_key')
      .in('workspace_key', candidates)
      .limit(1)

    if (error) throw new Error(`Erro ao validar codigo da clinica: ${error.message}`)
    if (Array.isArray(data) && data[0] && data[0].workspace_key) {
      return normalizeWorkspaceKey(data[0].workspace_key)
    }
  }

  if (canonical) {
    recordSupabaseCall('select', 'workspace_registry')
    const { data, error } = await client
      .from('workspace_registry')
      .select('workspace_key')
      .eq('workspace_key_canonical', canonical)
      .limit(1)

    if (error) throw new Error(`Erro ao validar codigo da clinica: ${error.message}`)
    if (Array.isArray(data) && data[0] && data[0].workspace_key) {
      return normalizeWorkspaceKey(data[0].workspace_key)
    }
  }

  return ''
}

async function resolveWorkspaceKeyFromLegacyTables(client, inputKey) {
  const candidates = getWorkspaceCandidates(inputKey)
  if (candidates.length === 0) return ''

  const searchPlans = []
  const splitConfigTable = getWorkspaceDataTableName('config')
  if (splitConfigTable) {
    searchPlans.push({ table: splitConfigTable, column: 'workspace_key' })
  }
  LEGACY_SYNC_TABLES.forEach((table) => {
    searchPlans.push({ table, column: 'workspace_key' })
  })

  for (const plan of searchPlans) {
    recordSupabaseCall('select', plan.table)
    const { data, error } = await client
      .from(plan.table)
      .select(plan.column)
      .in(plan.column, candidates)
      .limit(1)

    if (error) continue
    if (Array.isArray(data) && data[0] && data[0][plan.column]) {
      return normalizeWorkspaceKey(data[0][plan.column])
    }
  }

  return ''
}

async function resolveExistingWorkspaceKey(client, inputKey, user) {
  const normalized = normalizeWorkspaceKey(inputKey)
  if (!normalized) return ''

  const fromRegistry = await resolveWorkspaceKeyFromRegistry(client, normalized)
  if (fromRegistry) return fromRegistry

  const fromLegacy = await resolveWorkspaceKeyFromLegacyTables(client, normalized)
  if (fromLegacy) {
    await ensureWorkspaceRegistryRecord(client, fromLegacy, user)
    return fromLegacy
  }

  return ''
}

async function registerWorkspaceAccess(client, workspaceKey, user) {
  const stamp = nowIso()
  const userName = (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name)) || ''
  const memberPayload = {
    workspace_key: workspaceKey,
    user_id: user.id,
    user_email: user.email || '',
    user_name: userName,
    provider: 'google',
    first_login_at: stamp,
    last_login_at: stamp
  }

  recordSupabaseCall('insert', 'workspace_members')
  const { error: insertErr } = await client
    .from('workspace_members')
    .insert(memberPayload)

  if (insertErr && insertErr.code !== '23505') {
    throw new Error(`Erro ao registrar membro do codigo da clinica: ${insertErr.message}`)
  }

  recordSupabaseCall('update', 'workspace_members')
  const { error: updateErr } = await client
    .from('workspace_members')
    .update({
      user_email: memberPayload.user_email,
      user_name: memberPayload.user_name,
      provider: 'google',
      last_login_at: stamp
    })
    .eq('workspace_key', workspaceKey)
    .eq('user_id', user.id)

  if (updateErr) {
    throw new Error(`Erro ao atualizar membro do codigo da clinica: ${updateErr.message}`)
  }

  recordSupabaseCall('insert', 'workspace_logins')
  const { error: logErr } = await client
    .from('workspace_logins')
    .insert({
      workspace_key: workspaceKey,
      user_id: user.id,
      user_email: user.email || '',
      app_name: 'MedCore Desktop',
      source: 'desktop_login',
      logged_at: stamp
    })

  if (logErr) {
    throw new Error(`Erro ao registrar log de login: ${logErr.message}`)
  }
}

async function mergeRowsIntoWorkspace(client, workspaceKey, user, rows, syncSource) {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) return

  const normalizedRows = list.map((row) => ({
    table_name: String(row.table_name || ''),
    row_id: String(row.row_id || ''),
    record: row.record && typeof row.record === 'object' && !Array.isArray(row.record) ? row.record : {},
    updated_at: toIsoOrFallback(row.updated_at, nowIso()),
    deleted_at: row.deleted_at ? toIsoOrFallback(row.deleted_at, nowIso()) : null,
    version: asPositiveInt(row.version, 1),
    source_client: String(row.source_client || '')
  })).filter((row) => row.table_name && row.row_id)

  const grouped = new Map()
  normalizedRows.forEach((row) => {
    const tableName = String(row.table_name || '').trim()
    if (!getWorkspaceDataTableName(tableName)) return
    const item = {
      row_id: row.row_id,
      record: row.record,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at,
      version: row.version,
      source_client: row.source_client
    }
    if (!grouped.has(tableName)) grouped.set(tableName, [])
    grouped.get(tableName).push(item)
  })

  for (const [tableName, tableRows] of grouped.entries()) {
    const chunks = chunkArray(tableRows, SYNC_RPC_BATCH_SIZE)
    for (const chunk of chunks) {
      recordSupabaseCall('rpc', `workspace_merge_table_rows:${tableName}`)
      const { error } = await client.rpc('workspace_merge_table_rows', {
        p_workspace_key: workspaceKey,
        p_table_name: tableName,
        p_rows: chunk,
        p_user_id: user.id,
        p_user_email: user.email || '',
        p_source_client: DEVICE_ID,
        p_sync_source: String(syncSource || 'sync')
      })

      if (error) {
        throw new Error(`Erro ao sincronizar dados da tabela ${tableName}: ${error.message}`)
      }
    }
  }
}

async function fetchWorkspaceRows(client, workspaceKey, sinceByTable = {}) {
  const allRows = []
  const maxUpdatedByTable = {}

  for (const tableName of TABLE_NAMES) {
    const remoteTable = getWorkspaceDataTableName(tableName)
    if (!remoteTable) continue

    let offset = 0
    while (true) {
      let query = client
        .from(remoteTable)
        .select('row_id,record,updated_at,deleted_at,version,source_client')
        .eq('workspace_key', workspaceKey)
        .order('updated_at', { ascending: true })
        .order('row_id', { ascending: true })
        .range(offset, offset + SYNC_FETCH_PAGE_SIZE - 1)

      const since = sinceByTable && sinceByTable[tableName] ? toIsoOrFallback(sinceByTable[tableName], '') : ''
      if (since) {
        query = query.gt('updated_at', since)
      }

      recordSupabaseCall('select', remoteTable)
      const { data, error } = await query

      if (error) {
        throw new Error(`Erro ao baixar dados da tabela ${tableName}: ${error.message}`)
      }

      const page = Array.isArray(data) ? data : []
      page.forEach((row) => {
        allRows.push({
          table_name: tableName,
          row_id: row.row_id,
          record: row.record,
          updated_at: row.updated_at,
          deleted_at: row.deleted_at,
          version: row.version,
          source_client: row.source_client
        })
        maxUpdatedByTable[tableName] = mergeIsoMap(maxUpdatedByTable, { [tableName]: row.updated_at })[tableName]
      })

      if (page.length < SYNC_FETCH_PAGE_SIZE) break
      offset += SYNC_FETCH_PAGE_SIZE
    }
  }

  return { rows: allRows, maxUpdatedByTable }
}

async function ensureWorkspaceSeededFromLegacy(client, workspaceKey, user) {
  const configTable = getWorkspaceDataTableName('config')
  recordSupabaseCall('select', configTable)
  const { data: existingConfig, error: existsErr } = await client
    .from(configTable)
    .select('workspace_key')
    .eq('workspace_key', workspaceKey)
    .limit(1)

  if (existsErr) {
    throw new Error(`Erro ao verificar dados do codigo da clinica: ${existsErr.message}`)
  }
  if (Array.isArray(existingConfig) && existingConfig.length > 0) return false

  let seed = getDefaultSnapshot()

  recordSupabaseCall('select', 'workspace_rows')
  const { data: legacyRows, error: legacyRowsErr } = await client
    .from('workspace_rows')
    .select('table_name,row_id,record,updated_at,deleted_at,version,source_client')
    .eq('workspace_key', workspaceKey)

  if (legacyRowsErr && !isMissingRelationError(legacyRowsErr)) {
    throw new Error(`Erro ao ler dados legados por linha do codigo da clinica: ${legacyRowsErr.message}`)
  }

  if (Array.isArray(legacyRows) && legacyRows.length > 0) {
    seed = workspaceRowsToSnapshot(legacyRows)
  } else {
    recordSupabaseCall('select', 'workspace_snapshots')
    const { data: snap, error: snapErr } = await client
      .from('workspace_snapshots')
      .select('data')
      .eq('workspace_key', workspaceKey)
      .maybeSingle()

    if (snapErr && snapErr.code !== 'PGRST116' && !isMissingRelationError(snapErr)) {
      throw new Error(`Erro ao ler backup legado do codigo da clinica: ${snapErr.message}`)
    }

    if (snap && snap.data) {
      seed = sanitizeSnapshot(snap.data)
    }
  }

  seed.config.sync_workspace_key = workspaceKey
  seed.config.workspace_key = workspaceKey
  seed.config[CONFIG_META_VERSION] = asPositiveInt(seed.config[CONFIG_META_VERSION], 1) + 1
  seed.config[CONFIG_META_UPDATED_AT] = nowIso()

  await mergeRowsIntoWorkspace(client, workspaceKey, user, snapshotToWorkspaceRows(seed), 'seed_from_legacy')
  return true
}

async function pullWorkspaceToLocal(client, workspaceKey, options = {}) {
  const state = readRuntimeState()
  const previousWorkspace = normalizeWorkspaceKey(state.workspaceKey)
  const forceFullPull = !!(options && options.forceFull) || previousWorkspace !== workspaceKey
  const lastPullByTable = forceFullPull ? {} : (state.lastPullByTable || {})
  const { rows: remoteRows, maxUpdatedByTable } = await fetchWorkspaceRows(client, workspaceKey, lastPullByTable)
  const localSnapshot = readLocalSnapshot()
  let mergedSnapshot = localSnapshot

  if (remoteRows.length > 0) {
    mergedSnapshot = mergeWorkspaceRowsIntoSnapshot(localSnapshot, remoteRows)
    mergedSnapshot.config.sync_workspace_key = workspaceKey
    mergedSnapshot.config.workspace_key = workspaceKey
    mergedSnapshot.config[CONFIG_META_UPDATED_AT] = toIsoOrFallback(mergedSnapshot.config[CONFIG_META_UPDATED_AT], nowIso())
    mergedSnapshot.config[CONFIG_META_VERSION] = asPositiveInt(mergedSnapshot.config[CONFIG_META_VERSION], 1)
    writeLocalSnapshot(mergedSnapshot)
  }

  const stamp = nowIso()
  const nextPullByTable = mergeIsoMap(lastPullByTable, maxUpdatedByTable)
  if (forceFullPull) {
    TABLE_NAMES.forEach((tableName) => {
      if (!nextPullByTable[tableName]) nextPullByTable[tableName] = stamp
    })
  }

  saveRuntimeState({
    workspaceKey,
    lastRemotePullAt: stamp,
    lastPullByTable: nextPullByTable
  })

  return { pulledRows: remoteRows.length, lastPullByTable: nextPullByTable }
}

async function resolveExistingWorkspaceKeyMysql(inputKey) {
  const normalized = normalizeWorkspaceKey(inputKey)
  if (!normalized) return ''

  const data = await mysqlApiRequest('workspace_resolve', {
    workspace_key: normalized,
    candidates: getWorkspaceCandidates(normalized),
    canonical_key: canonicalWorkspaceKey(normalized)
  })

  return normalizeWorkspaceKey(data.workspace_key || '')
}

async function createMysqlWorkspace(workspaceKey, user) {
  const key = normalizeWorkspaceKey(workspaceKey)
  if (!key) throw new Error('Codigo da clinica invalido.')
  await mysqlApiRequest('workspace_create', {
    workspace_key: key,
    canonical_key: canonicalWorkspaceKey(key),
    user: mysqlUserPayload(user)
  })
}

async function registerMysqlWorkspaceAccess(workspaceKey, user) {
  const key = normalizeWorkspaceKey(workspaceKey)
  if (!key) throw new Error('Codigo da clinica invalido.')
  await mysqlApiRequest('workspace_access', {
    workspace_key: key,
    canonical_key: canonicalWorkspaceKey(key),
    user: mysqlUserPayload(user)
  })
}

async function mergeRowsIntoMysql(workspaceKey, user, rows, syncSource) {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) return

  const normalizedRows = list.map((row) => ({
    table_name: String(row.table_name || ''),
    row_id: String(row.row_id || ''),
    record: row.record && typeof row.record === 'object' && !Array.isArray(row.record) ? row.record : {},
    updated_at: toIsoOrFallback(row.updated_at, nowIso()),
    deleted_at: row.deleted_at ? toIsoOrFallback(row.deleted_at, nowIso()) : null,
    version: asPositiveInt(row.version, 1),
    source_client: String(row.source_client || '')
  })).filter((row) => TABLE_NAMES.includes(row.table_name) && row.row_id)

  const chunks = chunkArray(normalizedRows, SYNC_RPC_BATCH_SIZE)
  for (const chunk of chunks) {
    await mysqlApiRequest('rows_push', {
      workspace_key: workspaceKey,
      user: mysqlUserPayload(user),
      sync_source: String(syncSource || 'sync'),
      rows: chunk
    })
  }
}

async function fetchMysqlWorkspaceRows(workspaceKey, sinceByTable = {}) {
  const data = await mysqlApiRequest('rows_pull', {
    workspace_key: workspaceKey,
    tables: TABLE_NAMES,
    since_by_table: sinceByTable && typeof sinceByTable === 'object' ? sinceByTable : {}
  })

  const rows = (Array.isArray(data.rows) ? data.rows : []).map((row) => ({
    table_name: String(row.table_name || ''),
    row_id: String(row.row_id || ''),
    record: row.record && typeof row.record === 'object' && !Array.isArray(row.record) ? row.record : {},
    updated_at: toIsoOrFallback(row.updated_at, nowIso()),
    deleted_at: row.deleted_at ? toIsoOrFallback(row.deleted_at, nowIso()) : null,
    version: asPositiveInt(row.version, 1),
    source_client: String(row.source_client || '')
  })).filter((row) => TABLE_NAMES.includes(row.table_name) && row.row_id)

  const maxUpdatedByTable = data.max_updated_by_table && typeof data.max_updated_by_table === 'object'
    ? data.max_updated_by_table
    : getMaxUpdatedByTable(rows)

  return { rows, maxUpdatedByTable }
}

async function pullMysqlWorkspaceToLocal(workspaceKey, options = {}) {
  const state = readRuntimeState()
  const previousWorkspace = normalizeWorkspaceKey(state.workspaceKey)
  const forceFullPull = !!(options && options.forceFull) || previousWorkspace !== workspaceKey
  const lastPullByTable = forceFullPull ? {} : (state.lastPullByTable || {})
  const { rows: remoteRows, maxUpdatedByTable } = await fetchMysqlWorkspaceRows(workspaceKey, lastPullByTable)
  const localSnapshot = readLocalSnapshot()
  let mergedSnapshot = localSnapshot

  if (remoteRows.length > 0) {
    mergedSnapshot = mergeWorkspaceRowsIntoSnapshot(localSnapshot, remoteRows)
    mergedSnapshot.config.sync_workspace_key = workspaceKey
    mergedSnapshot.config.workspace_key = workspaceKey
    mergedSnapshot.config[CONFIG_META_UPDATED_AT] = toIsoOrFallback(mergedSnapshot.config[CONFIG_META_UPDATED_AT], nowIso())
    mergedSnapshot.config[CONFIG_META_VERSION] = asPositiveInt(mergedSnapshot.config[CONFIG_META_VERSION], 1)
    writeLocalSnapshot(mergedSnapshot)
  }

  const stamp = nowIso()
  const nextPullByTable = mergeIsoMap(lastPullByTable, maxUpdatedByTable)
  if (forceFullPull) {
    TABLE_NAMES.forEach((tableName) => {
      if (!nextPullByTable[tableName]) nextPullByTable[tableName] = stamp
    })
  }

  saveRuntimeState({
    workspaceKey,
    lastRemotePullAt: stamp,
    lastPullByTable: nextPullByTable
  })

  return { pulledRows: remoteRows.length, lastPullByTable: nextPullByTable }
}

async function syncWorkspaceRowsMysql(reason) {
  const state = readRuntimeState()
  const workspaceKey = normalizeWorkspaceKey(state.workspaceKey)
  if (!workspaceKey) return { ok: false, skipped: true, reason: 'workspace_missing' }

  const user = getMysqlPseudoUser()
  const snapshot = readLocalSnapshot()
  if (String(snapshot.config.sync_workspace_key || '') !== workspaceKey || String(snapshot.config.workspace_key || '') !== workspaceKey) {
    snapshot.config.sync_workspace_key = workspaceKey
    snapshot.config.workspace_key = workspaceKey
    snapshot.config[CONFIG_META_VERSION] = asPositiveInt(snapshot.config[CONFIG_META_VERSION], 1) + 1
    snapshot.config[CONFIG_META_UPDATED_AT] = nowIso()
    writeLocalSnapshot(snapshot)
  }

  const lastPushByTable = state.lastPushByTable || {}
  const forceFullPush = !lastPushByTable || Object.keys(lastPushByTable).length === 0
  const rowsToPush = getRowsChangedAfter(snapshot, lastPushByTable, forceFullPush)
  if (rowsToPush.length > 0) {
    await mergeRowsIntoMysql(workspaceKey, user, rowsToPush, reason || 'auto')
  }

  const lastRemotePullAt = new Date(state.lastRemotePullAt || 0).getTime()
  const hasPullHistory = !!(state.lastPullByTable && Object.keys(state.lastPullByTable).length > 0)
  const shouldPullRemote = !hasPullHistory
    || reason === 'workspace_enter'
    || reason === 'auto_create_first_access'
    || reason === 'interval'
    || !Number.isFinite(lastRemotePullAt)
    || Date.now() - lastRemotePullAt >= SYNC_PULL_MIN_INTERVAL_MS

  let pullResult = { pulledRows: 0 }
  if (shouldPullRemote) {
    pullResult = await pullMysqlWorkspaceToLocal(workspaceKey, { forceFull: !hasPullHistory })
  }

  const stamp = nowIso()
  const nextPushByTable = mergeIsoMap(lastPushByTable, getMaxUpdatedByTable(rowsToPush))
  saveRuntimeState({
    workspaceKey,
    lastSyncAt: stamp,
    lastPushByTable: nextPushByTable
  })

  syncDiagnostics.lastSyncAt = stamp
  syncDiagnostics.lastSyncReason = reason || 'auto'
  maybeLogSyncDiagnostics(reason || 'auto')

  return {
    ok: true,
    provider: 'mysql',
    syncedAt: stamp,
    pushedRows: rowsToPush.length,
    pulledRows: pullResult.pulledRows || 0,
    diagnostics: getSyncDiagnosticsSnapshot()
  }
}

async function enterMysqlWorkspaceSession(user, workspaceKey, reason, options = {}) {
  const state = readRuntimeState()
  const previousWorkspace = normalizeWorkspaceKey(state.workspaceKey)
  if (previousWorkspace !== workspaceKey) {
    saveRuntimeState({
      workspaceKey,
      lastSyncAt: '',
      lastRemotePullAt: '',
      lastPullByTable: {},
      lastPushByTable: {}
    })
  } else {
    saveRuntimeState({ workspaceKey })
  }

  if (options && options.create) {
    await createMysqlWorkspace(workspaceKey, user)
  }
  await registerMysqlWorkspaceAccess(workspaceKey, user)
  await pullMysqlWorkspaceToLocal(workspaceKey, { forceFull: previousWorkspace !== workspaceKey })
  startAutoSync()
  await runSync(reason || 'workspace_enter')
}

async function getLinkedWorkspaceForUserMysql() {
  const state = readRuntimeState()
  return normalizeWorkspaceKey(state.workspaceKey || '')
}

let syncInFlight = null
let syncPending = false

async function syncWorkspaceRows(reason) {
  if (isMysqlCloudMode()) {
    return syncWorkspaceRowsMysql(reason)
  }

  const state = readRuntimeState()
  const workspaceKey = normalizeWorkspaceKey(state.workspaceKey)
  if (!workspaceKey) return { ok: false, skipped: true, reason: 'workspace_missing' }

  const client = getSupabaseClientOptional()
  if (!client) return { ok: false, skipped: true, reason: 'supabase_missing' }

  const { signedIn, user } = await getCurrentUser()
  if (!signedIn || !user) return { ok: false, skipped: true, reason: 'auth_missing' }

  const snapshot = readLocalSnapshot()
  if (String(snapshot.config.sync_workspace_key || '') !== workspaceKey || String(snapshot.config.workspace_key || '') !== workspaceKey) {
    snapshot.config.sync_workspace_key = workspaceKey
    snapshot.config.workspace_key = workspaceKey
    snapshot.config[CONFIG_META_VERSION] = asPositiveInt(snapshot.config[CONFIG_META_VERSION], 1) + 1
    snapshot.config[CONFIG_META_UPDATED_AT] = nowIso()
    writeLocalSnapshot(snapshot)
  }

  const lastPushByTable = state.lastPushByTable || {}
  const forceFullPush = !lastPushByTable || Object.keys(lastPushByTable).length === 0
  const rowsToPush = getRowsChangedAfter(snapshot, lastPushByTable, forceFullPush)
  if (rowsToPush.length > 0) {
    await mergeRowsIntoWorkspace(client, workspaceKey, user, rowsToPush, reason || 'auto')
  }

  const lastRemotePullAt = new Date(state.lastRemotePullAt || 0).getTime()
  const hasPullHistory = !!(state.lastPullByTable && Object.keys(state.lastPullByTable).length > 0)
  const shouldPullRemote = !hasPullHistory
    || reason === 'workspace_enter'
    || reason === 'auto_create_first_access'
    || reason === 'interval'
    || !Number.isFinite(lastRemotePullAt)
    || Date.now() - lastRemotePullAt >= SYNC_PULL_MIN_INTERVAL_MS

  let pullResult = { pulledRows: 0 }
  if (shouldPullRemote) {
    pullResult = await pullWorkspaceToLocal(client, workspaceKey, { forceFull: !hasPullHistory })
  }

  const stamp = nowIso()
  const nextPushByTable = mergeIsoMap(lastPushByTable, getMaxUpdatedByTable(rowsToPush))
  saveRuntimeState({
    workspaceKey,
    lastSyncAt: stamp,
    lastPushByTable: nextPushByTable
  })

  syncDiagnostics.lastSyncAt = stamp
  syncDiagnostics.lastSyncReason = reason || 'auto'
  maybeLogSyncDiagnostics(reason || 'auto')

  return {
    ok: true,
    syncedAt: stamp,
    pushedRows: rowsToPush.length,
    pulledRows: pullResult.pulledRows || 0,
    diagnostics: getSyncDiagnosticsSnapshot()
  }
}

function runSync(reason) {
  if (syncInFlight) {
    syncPending = true
    return syncInFlight
  }

  syncPending = false
  syncInFlight = syncWorkspaceRows(reason)
    .then((result) => {
      notifyRenderer('medcore-sync:event', {
        ok: true,
        state: 'online',
        message: '',
        ...result
      })
      return result
    })
    .catch((err) => {
      const msg = err && err.message ? err.message : String(err)
      if (isLikelyNetworkSyncError(msg)) {
        notifyRenderer('medcore-sync:event', {
          ok: false,
          state: 'offline',
          message: 'Sem internet. Os dados voltam a sincronizar automaticamente quando a conexao retornar.'
        })
      } else {
        notifyRenderer('medcore-sync:event', {
          ok: false,
          state: 'error',
          message: msg
        })
      }
      throw err
    })
    .finally(() => {
      syncInFlight = null
      if (syncPending) {
        syncPending = false
        runSync('queued_change').catch(() => {})
      }
    })
  return syncInFlight
}

async function enterWorkspaceSession(client, user, workspaceKey, reason) {
  const state = readRuntimeState()
  const previousWorkspace = normalizeWorkspaceKey(state.workspaceKey)
  if (previousWorkspace !== workspaceKey) {
    saveRuntimeState({
      workspaceKey,
      lastSyncAt: '',
      lastRemotePullAt: '',
      lastPullByTable: {},
      lastPushByTable: {}
    })
  } else {
    saveRuntimeState({ workspaceKey })
  }

  await ensureWorkspaceRegistryRecord(client, workspaceKey, user)
  await registerWorkspaceAccess(client, workspaceKey, user)
  await ensureWorkspaceSeededFromLegacy(client, workspaceKey, user)
  await pullWorkspaceToLocal(client, workspaceKey, { forceFull: previousWorkspace !== workspaceKey })
  startAutoSync()
  await runSync(reason || 'workspace_enter')
}

async function getLinkedWorkspaceForUser(client, userId) {
  recordSupabaseCall('select', 'workspace_members')
  const { data, error } = await client
    .from('workspace_members')
    .select('workspace_key, last_login_at')
    .eq('user_id', userId)
    .order('last_login_at', { ascending: false })
    .limit(1)

  if (error) {
    throw new Error(`Erro ao buscar workspace vinculado: ${error.message}`)
  }

  if (!Array.isArray(data) || data.length === 0) return ''
  const rawKey = normalizeWorkspaceKey(data[0].workspace_key)
  const resolved = await resolveWorkspaceKeyFromRegistry(client, rawKey)
  return normalizeWorkspaceKey(resolved || rawKey)
}

function generateWorkspaceKeyForNewClinic() {
  const p1 = randomBytes(2).toString('hex').toUpperCase()
  const p2 = randomBytes(2).toString('hex').toUpperCase()
  const p3 = randomBytes(2).toString('hex').toUpperCase()
  return `EMP-${p1}-${p2}-${p3}`
}

function notifyRenderer(channel, payload) {
  if (!win || win.isDestroyed()) return
  win.webContents.send(channel, payload)
}

function clearSyncTimers() {
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
  if (syncDebounceTimer) {
    clearTimeout(syncDebounceTimer)
    syncDebounceTimer = null
  }
}

function startAutoSync() {
  clearSyncTimers()
  syncTimer = setInterval(() => {
    runSync('interval').catch(() => {})
  }, SYNC_INTERVAL_MS)
}

async function openGoogleAuthWindow() {
  const client = getSupabaseClientStrict()
  const { data, error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: OAUTH_REDIRECT_URL,
      skipBrowserRedirect: true,
      queryParams: {
        prompt: 'select_account'
      }
    }
  })

  if (error) {
    throw new Error(error.message)
  }

  if (!data || !data.url) {
    throw new Error('Nao foi possivel abrir o login do Google.')
  }

  if (oauthWin && !oauthWin.isDestroyed()) {
    oauthWin.close()
  }

  oauthWin = new BrowserWindow({
    width: 520,
    height: 760,
    minWidth: 420,
    minHeight: 600,
    title: 'Login Google - MedCore',
    autoHideMenuBar: true,
    parent: win || undefined,
    modal: !!win,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    }
  })

  let finished = false

  const finishAuth = async (targetUrl) => {
    if (finished) return
    finished = true

    try {
      const parsed = new URL(targetUrl)
      const hashParams = new URLSearchParams(String(parsed.hash || '').replace(/^#/, ''))
      const authError = parsed.searchParams.get('error_description')
        || parsed.searchParams.get('error')
        || hashParams.get('error_description')
        || hashParams.get('error')
      if (authError) {
        throw new Error(authError)
      }

      const code = parsed.searchParams.get('code')
      const accessToken = hashParams.get('access_token')
      const refreshToken = hashParams.get('refresh_token')

      let authUser = null

      if (code) {
        recordSupabaseCall('auth', 'exchangeCodeForSession')
        const { data: sessionData, error: exchangeErr } = await client.auth.exchangeCodeForSession(code)
        if (exchangeErr) {
          throw new Error(exchangeErr.message)
        }
        authUser = sessionData && sessionData.user ? sessionData.user : null
      } else if (accessToken && refreshToken) {
        recordSupabaseCall('auth', 'setSession')
        const { data: sessionData, error: setErr } = await client.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken
        })
        if (setErr) {
          throw new Error(setErr.message)
        }
        authUser = sessionData && sessionData.user ? sessionData.user : null
      } else {
        throw new Error('Nao recebemos o codigo de confirmacao do Google.')
      }

      if (!authUser) {
        recordSupabaseCall('auth', 'getUser')
        const { data: userData, error: userErr } = await client.auth.getUser()
        if (userErr) throw new Error(userErr.message)
        authUser = userData && userData.user ? userData.user : null
      }

      if (!authUser) {
        throw new Error('Login Google concluido, mas nao foi possivel ler o usuario autenticado.')
      }

      currentUserCache = {
        signedIn: true,
        user: authUser,
        expiresAt: Date.now() + AUTH_CACHE_TTL_MS
      }
      notifyRenderer('supabase-auth:event', {
        ok: true,
        user: simpleUser(authUser)
      })
    } catch (err) {
      notifyRenderer('supabase-auth:event', {
        ok: false,
        message: err && err.message ? err.message : String(err)
      })
    } finally {
      if (oauthWin && !oauthWin.isDestroyed()) {
        oauthWin.close()
      }
      oauthWin = null
    }
  }

  const intercept = (event, targetUrl) => {
    if (String(targetUrl || '').startsWith(OAUTH_REDIRECT_URL)) {
      event.preventDefault()
      finishAuth(targetUrl)
      return true
    }
    return false
  }

  oauthWin.webContents.on('will-redirect', intercept)
  oauthWin.webContents.on('will-navigate', intercept)

  oauthWin.on('closed', () => {
    if (!finished) {
      notifyRenderer('supabase-auth:event', {
        ok: false,
        message: 'Login cancelado antes de concluir.'
      })
    }
    oauthWin = null
  })

  oauthWin.webContents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
    if (!isMainFrame || finished) return

    finished = true
    const desc = String(description || '')
    const url = String(validatedUrl || '')
    const isDnsError = code === -105 || /ERR_NAME_NOT_RESOLVED/i.test(desc)

    notifyRenderer('supabase-auth:event', {
      ok: false,
      message: isDnsError
        ? `Nao foi possivel abrir o login Google porque o dominio do Supabase nao foi encontrado.\nVerifique a URL do projeto em Supabase > Project Settings > API.\nURL atual: ${url || '(vazia)'}.`
        : `Falha ao abrir login Google (${code}): ${desc || 'erro desconhecido'}.`
    })

    if (oauthWin && !oauthWin.isDestroyed()) oauthWin.close()
    oauthWin = null
  })

  await oauthWin.loadURL(data.url)
}

function createWindow() {
  const dir = getDataDir()
  process.env.MEDCORE_DATA_DIR = dir
  ensureDir(dir)
  ensureDir(getMetaDir())
  const startupTheme = resolveWindowTheme('light')
  const isWindows = process.platform === 'win32'

  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    title: 'MedCore',
    backgroundColor: startupTheme.color,
    autoHideMenuBar: true,
    show: false,
    ...(isWindows
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: {
            color: startupTheme.color,
            symbolColor: startupTheme.symbolColor,
            height: DEFAULT_TITLEBAR_HEIGHT
          }
        }
      : {}),
    webPreferences: {
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      contextIsolation: false,
      webSecurity: false,
      additionalArguments: ['--data-dir=' + dir]
    }
  })

  win.loadFile('index.html')

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  setTimeout(() => {
    if (win && !win.isVisible()) win.show()
  }, 4000)

  win.on('page-title-updated', (e) => e.preventDefault())
}

ipcMain.handle('supabase-config:get', async () => {
  if (isMysqlCloudMode()) {
    return {
      ok: true,
      url: getMysqlApiConfig().url,
      anonKey: '',
      locked: true,
      provider: 'mysql'
    }
  }

  const cfg = readSupabaseConfig()
  return {
    ok: true,
    url: cfg.url || '',
    anonKey: cfg.anonKey || '',
    locked: FORCE_EMBEDDED_SUPABASE_CONFIG
  }
})

ipcMain.handle('supabase-config:set', async (event, payload) => {
  if (isMysqlCloudMode()) {
    return {
      ok: true,
      url: getMysqlApiConfig().url,
      message: 'Conexao MySQL integrada automaticamente neste instalador.'
    }
  }

  if (FORCE_EMBEDDED_SUPABASE_CONFIG) {
    ensureDefaultSupabaseConfig()
    return {
      ok: true,
      url: DEFAULT_SUPABASE_URL,
      message: 'Conexao Supabase integrada automaticamente neste instalador.'
    }
  }

  const url = String((payload && payload.url) || '').trim()
  const anonKey = String((payload && payload.anonKey) || '').trim()

  if (!url || !anonKey) {
    return { ok: false, message: 'Preencha URL e Anon Key.' }
  }

  const normalizedUrl = normalizeSupabaseUrl(url)
  if (!normalizedUrl) {
    return {
      ok: false,
      message: 'URL invalida. Use a Project URL do Supabase (ex: https://SEU-PROJETO.supabase.co).'
    }
  }

  const health = await checkSupabaseHealth(normalizedUrl)
  if (!health.ok) {
    return { ok: false, message: health.message }
  }

  saveSupabaseConfig(normalizedUrl, anonKey)
  return { ok: true, url: normalizedUrl }
})

ipcMain.handle('supabase-auth:status', async () => {
  if (isMysqlCloudMode()) {
    return {
      ok: true,
      configured: true,
      signedIn: true,
      provider: 'mysql',
      user: simpleUser(getMysqlPseudoUser())
    }
  }

  const cfg = readSupabaseConfig()
  const configured = !!(cfg.url && cfg.anonKey)

  if (!configured) {
    return {
      ok: true,
      configured: false,
      signedIn: false,
      user: null
    }
  }

  try {
    const { signedIn, user } = await getCurrentUser()
    return {
      ok: true,
      configured: true,
      signedIn,
      user: simpleUser(user)
    }
  } catch (err) {
    return {
      ok: false,
      configured: true,
      signedIn: false,
      message: err && err.message ? err.message : String(err)
    }
  }
})

ipcMain.handle('supabase-auth:google-start', async () => {
  if (isMysqlCloudMode()) {
    const user = getMysqlPseudoUser()
    notifyRenderer('supabase-auth:event', {
      ok: true,
      user: simpleUser(user)
    })
    return { ok: true, provider: 'mysql' }
  }

  try {
    const cfg = readSupabaseConfig()
    const health = await checkSupabaseHealth(cfg.url || '')
    if (!health.ok) {
      return { ok: false, message: health.message }
    }

    await openGoogleAuthWindow()
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      message: err && err.message ? err.message : String(err)
    }
  }
})

ipcMain.handle('supabase-auth:signout', async () => {
  if (isMysqlCloudMode()) {
    saveRuntimeState({ workspaceKey: '' })
    clearSyncTimers()
    return { ok: true, provider: 'mysql' }
  }

  try {
    const client = getSupabaseClientStrict()
    recordSupabaseCall('auth', 'signOut')
    const { error } = await client.auth.signOut()
    if (error) throw new Error(error.message)

    currentUserCache = { signedIn: false, user: null, expiresAt: 0 }
    saveRuntimeState({ workspaceKey: '' })
    clearSyncTimers()
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      message: err && err.message ? err.message : String(err)
    }
  }
})

ipcMain.handle('workspace:linked', async () => {
  if (isMysqlCloudMode()) {
    const workspaceKey = await getLinkedWorkspaceForUserMysql()
    return {
      ok: true,
      workspaceKey: workspaceKey || '',
      hasLinkedWorkspace: !!workspaceKey,
      provider: 'mysql',
      user: simpleUser(getMysqlPseudoUser())
    }
  }

  try {
    const client = getSupabaseClientStrict()
    const { signedIn, user } = await getCurrentUser()
    if (!signedIn || !user) {
      return { ok: false, message: 'Faca login com Google primeiro.' }
    }

    const workspaceKey = await getLinkedWorkspaceForUser(client, user.id)
    return {
      ok: true,
      workspaceKey: workspaceKey || '',
      hasLinkedWorkspace: !!workspaceKey,
      user: simpleUser(user)
    }
  } catch (err) {
    return {
      ok: false,
      message: err && err.message ? err.message : String(err)
    }
  }
})

ipcMain.handle('workspace:create-new', async () => {
  if (isMysqlCloudMode()) {
    try {
      const user = getMysqlPseudoUser()
      let workspaceKey = ''
      for (let i = 0; i < 15; i++) {
        const candidate = generateWorkspaceKeyForNewClinic()
        const exists = await resolveExistingWorkspaceKeyMysql(candidate)
        if (!exists) {
          workspaceKey = candidate
          break
        }
      }

      if (!workspaceKey) {
        return { ok: false, message: 'Nao foi possivel gerar um novo codigo da clinica. Tente novamente.' }
      }

      await enterMysqlWorkspaceSession(user, workspaceKey, 'auto_create_first_access', { create: true })
      return {
        ok: true,
        provider: 'mysql',
        workspaceKey,
        autoCreated: true,
        isNewWorkspace: true,
        user: simpleUser(user)
      }
    } catch (err) {
      return { ok: false, message: err && err.message ? err.message : String(err) }
    }
  }

  try {
    const client = getSupabaseClientStrict()
    const { signedIn, user } = await getCurrentUser()
    if (!signedIn || !user) {
      return { ok: false, message: 'Faca login com Google primeiro.' }
    }

    let workspaceKey = ''
    for (let i = 0; i < 15; i++) {
      const candidate = generateWorkspaceKeyForNewClinic()
      const exists = await resolveExistingWorkspaceKey(client, candidate, user)
      if (!exists) {
        workspaceKey = candidate
        break
      }
    }

    if (!workspaceKey) {
      return { ok: false, message: 'Nao foi possivel gerar um novo codigo da clinica. Tente novamente.' }
    }

    await enterWorkspaceSession(client, user, workspaceKey, 'auto_create_first_access')

    return {
      ok: true,
      workspaceKey,
      autoCreated: true,
      isNewWorkspace: true,
      user: simpleUser(user)
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err)
    if (isSupabaseSetupHintError(msg)) {
      return {
        ok: false,
        message: `${msg}\n\nDica: rode o arquivo supabase/setup.sql no SQL Editor do Supabase.`
      }
    }
    return { ok: false, message: msg }
  }
})

ipcMain.handle('workspace:enter', async (event, payload) => {
  if (isMysqlCloudMode()) {
    try {
      const inputWorkspaceKey = normalizeWorkspaceKey(payload && payload.workspaceKey)
      if (!inputWorkspaceKey) {
        return { ok: false, message: 'Digite o codigo da clinica.' }
      }

      const user = getMysqlPseudoUser()
      let resolvedWorkspaceKey = await resolveExistingWorkspaceKeyMysql(inputWorkspaceKey)
      let shouldCreate = false

      if (!resolvedWorkspaceKey) {
        const snapshot = readLocalSnapshot()
        const savedKey = normalizeWorkspaceKey(snapshot.config.sync_workspace_key || snapshot.config.workspace_key || readRuntimeState().workspaceKey)
        const localRows = snapshotToWorkspaceRows(snapshot).filter((row) => row.table_name !== 'config')
        if (savedKey === inputWorkspaceKey && localRows.length > 0) {
          resolvedWorkspaceKey = inputWorkspaceKey
          shouldCreate = true
        }
      }

      if (!resolvedWorkspaceKey) {
        return {
          ok: false,
          message: 'Codigo da clinica nao encontrado no servidor MySQL. Confira o codigo ou crie uma nova clinica.'
        }
      }

      await enterMysqlWorkspaceSession(user, resolvedWorkspaceKey, 'workspace_enter', { create: shouldCreate })

      return {
        ok: true,
        provider: 'mysql',
        workspaceKey: resolvedWorkspaceKey,
        isNewWorkspace: shouldCreate,
        user: simpleUser(user)
      }
    } catch (err) {
      return { ok: false, message: err && err.message ? err.message : String(err) }
    }
  }

  try {
    const inputWorkspaceKey = normalizeWorkspaceKey(payload && payload.workspaceKey)
    if (!inputWorkspaceKey) {
      return { ok: false, message: 'Digite o codigo da clinica.' }
    }

    const client = getSupabaseClientStrict()
    const { signedIn, user } = await getCurrentUser()
    if (!signedIn || !user) {
      return { ok: false, message: 'Faca login com Google primeiro.' }
    }

    const resolvedWorkspaceKey = await resolveExistingWorkspaceKey(client, inputWorkspaceKey, user)
    if (!resolvedWorkspaceKey) {
      return {
        ok: false,
        message: 'Codigo da clinica nao encontrado. Confira o codigo com a recepcao/administrador.'
      }
    }

    await enterWorkspaceSession(client, user, resolvedWorkspaceKey, 'workspace_enter')

    return {
      ok: true,
      workspaceKey: resolvedWorkspaceKey,
      isNewWorkspace: false,
      user: simpleUser(user)
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err)
    if (isSupabaseSetupHintError(msg)) {
      return {
        ok: false,
        message: `${msg}\n\nDica: rode o arquivo supabase/setup.sql no SQL Editor do Supabase.`
      }
    }
    return { ok: false, message: msg }
  }
})


ipcMain.handle('license:activate', async (event, payload) => {
  if (!isMysqlCloudMode()) {
    return { ok: false, message: 'Licenciamento por chave esta disponivel apenas na versao MySQL.' }
  }
  try {
    return await activateLicenseOnline(payload && payload.licenseKey, 'activate')
  } catch (err) {
    return { ok: false, message: err && err.message ? err.message : String(err) }
  }
})

ipcMain.handle('license:validate-saved', async () => {
  if (!isMysqlCloudMode()) {
    return { ok: false, message: 'Licenciamento por chave esta disponivel apenas na versao MySQL.' }
  }
  try {
    const state = readLicenseState()
    const key = normalizeLicenseKey(state.license_key || '')
    if (!key) return { ok: false, missing: true, message: 'Nenhuma chave salva.' }
    return await activateLicenseOnline(key, 'validate')
  } catch (err) {
    return { ok: false, message: err && err.message ? err.message : String(err) }
  }
})

ipcMain.handle('window-theme:set', async (event, payload) => {
  try {
    const theme = String((payload && payload.theme) || 'light')
    const height = payload && payload.height
    const applied = applyWindowOverlay(theme, height)
    return { ok: true, ...applied }
  } catch (err) {
    return {
      ok: false,
      message: err && err.message ? err.message : String(err)
    }
  }
})

ipcMain.on('medcore-sync:request', () => {
  if (syncDebounceTimer) clearTimeout(syncDebounceTimer)
  syncDebounceTimer = setTimeout(() => {
    runSync('local_change').catch(() => {})
  }, SYNC_DEBOUNCE_MS)
})

ipcMain.handle('medcore-sync:diagnostics', async () => getSyncDiagnosticsSnapshot())

// SALVAR PDF
ipcMain.handle('salvar-pdf', async (event, { htmlContent, nomeArquivo }) => {
  try {
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      defaultPath: nomeArquivo,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (canceled || !filePath) return { sucesso: false, motivo: 'cancelado' }

    const pdfWin = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    })

    await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent))
    const pdfBuffer = await pdfWin.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 }
    })
    pdfWin.destroy()

    fs.writeFileSync(filePath, pdfBuffer)
    return { sucesso: true, caminho: filePath }
  } catch (err) {
    return { sucesso: false, motivo: 'erro', mensagem: err.message }
  }
})

// SALVAR CSV
ipcMain.handle('salvar-csv', async (event, { conteudo, nomeArquivo }) => {
  try {
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      defaultPath: nomeArquivo,
      filters: [{ name: 'Excel/CSV', extensions: ['csv'] }]
    })
    if (canceled || !filePath) return { sucesso: false, motivo: 'cancelado' }

    fs.writeFileSync(filePath, conteudo, 'utf8')
    return { sucesso: true, caminho: filePath }
  } catch (err) {
    return { sucesso: false, motivo: 'erro', mensagem: err.message }
  }
})

// ABRIR PAINEL TV
ipcMain.handle('abrir-painel-tv', async () => {
  try {
    if (painelWin && !painelWin.isDestroyed()) {
      painelWin.focus()
      return { sucesso: true }
    }

    const dir = getDataDir()
    painelWin = new BrowserWindow({
      title: 'MedCore - Painel de Chamada',
      fullscreen: false,
      width: 1280,
      height: 720,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: true,
        nodeIntegrationInSubFrames: true,
        contextIsolation: false,
        webSecurity: false,
        additionalArguments: ['--data-dir=' + dir]
      }
    })

    painelWin.loadFile('pages/painel_tv.html')
    painelWin.on('closed', () => { painelWin = null })
    return { sucesso: true }
  } catch (err) {
    return { sucesso: false, mensagem: err.message }
  }
})

// CHAMAR PACIENTE (salva chamada.json)
ipcMain.handle('chamar-paciente', async (event, dados) => {
  try {
    const chamadaFile = path.join(getDataDir(), 'chamada.json')
    const chamada = { ...dados, id: Date.now() }
    fs.writeFileSync(chamadaFile, JSON.stringify(chamada), 'utf8')
    return { sucesso: true }
  } catch (err) {
    return { sucesso: false, mensagem: err.message }
  }
})

// SALVAR ARQUIVO GENERICO
ipcMain.handle('salvar-arquivo', async (event, { conteudo, nomeArquivo, extensao = 'json', filtro = 'Arquivo' }) => {
  try {
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      defaultPath: nomeArquivo,
      filters: [{ name: filtro, extensions: [extensao] }]
    })
    if (canceled || !filePath) return { sucesso: false, motivo: 'cancelado' }

    fs.writeFileSync(filePath, conteudo, 'utf8')
    return { sucesso: true, caminho: filePath }
  } catch (e) {
    return { sucesso: false, erro: e.message }
  }
})

app.whenReady().then(() => {
  const dataDir = getDataDir()
  process.env.MEDCORE_DATA_DIR = dataDir
  ensureDir(dataDir)
  ensureDir(getMetaDir())
  ensureDefaultSupabaseConfig()
  createWindow()
})

app.on('before-quit', (event) => {
  if (isQuittingNow) return
  clearSyncTimers()
  const state = readRuntimeState()
  if (!state.workspaceKey) return

  // tentativa final de sync sem bloquear fechamento por muito tempo
  event.preventDefault()
  isQuittingNow = true
  runSync('app_close')
    .catch(() => {})
    .finally(() => {
      app.exit(0)
    })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

