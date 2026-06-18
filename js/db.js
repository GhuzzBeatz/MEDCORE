/**
 * MedCore JSON data layer with sync metadata support.
 * Keeps API compatibility with previous implementation.
 */
const fs = require('fs')
const path = require('path')
const { randomBytes } = require('crypto')

const CONFIG_TABLE = 'config'
const META_FIELDS = new Set(['_row_id', '_updated_at', '_deleted_at', '_version', '_source_client'])

function getDataDir() {
  try {
    const envDir = String(process.env.MEDCORE_DATA_DIR || '').trim()
    if (envDir) return envDir
  } catch (_) {}

  try {
    const arg = process.argv.find((a) => String(a || '').startsWith('--data-dir='))
    if (arg) return arg.replace('--data-dir=', '')
  } catch (_) {}
  return path.join(__dirname, '..', 'data')
}

const DATA_DIR = getDataDir()
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

function nowIso() {
  return new Date().toISOString()
}

function nowText() {
  return new Date().toLocaleString('sv-SE')
}

function getSourceClient() {
  try {
    const envId = String(process.env.MEDCORE_DEVICE_ID || '').trim()
    if (envId) return envId
  } catch (_) {}

  try {
    const arg = process.argv.find((a) => String(a || '').startsWith('--device-id='))
    if (arg) return arg.replace('--device-id=', '').trim()
  } catch (_) {}

  return ''
}

function toIsoOrFallback(value, fallback = nowIso()) {
  const dt = new Date(value)
  if (!Number.isFinite(dt.getTime())) return fallback
  return dt.toISOString()
}

function asPositiveInt(value, fallback = 1) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.floor(n)
}

function readFileJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (_) {
    return fallback
  }
}

function writeFileJson(filePath, data) {
  if (!fs.existsSync(path.dirname(filePath))) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
}

function simpleHash(text) {
  const str = String(text || '')
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

function safeRowId(tableName, row, idx) {
  if (row && row._row_id !== undefined && row._row_id !== null && String(row._row_id).trim()) {
    return String(row._row_id).trim()
  }
  if (row && row.id !== undefined && row.id !== null && String(row.id).trim()) {
    return String(row.id).trim()
  }
  return `legacy_${tableName}_${simpleHash(JSON.stringify(row || {}))}_${idx}`
}

function stripMeta(row) {
  const obj = row && typeof row === 'object' && !Array.isArray(row) ? { ...row } : {}
  META_FIELDS.forEach((k) => { delete obj[k] })
  return obj
}

function normalizeConfigObject(raw) {
  const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {}
  cfg.__sync_updated_at = toIsoOrFallback(cfg.__sync_updated_at, nowIso())
  cfg.__sync_version = asPositiveInt(cfg.__sync_version, 1)
  cfg.__sync_deleted_at = cfg.__sync_deleted_at ? toIsoOrFallback(cfg.__sync_deleted_at, nowIso()) : null
  return cfg
}

function normalizeRow(tableName, rawRow, idx) {
  const row = rawRow && typeof rawRow === 'object' && !Array.isArray(rawRow) ? { ...rawRow } : {}
  const rowId = safeRowId(tableName, row, idx)
  const payload = stripMeta(row)
  if ((payload.id === undefined || payload.id === null || String(payload.id).trim() === '') && /^\d+$/.test(rowId)) {
    payload.id = Number(rowId)
  }
  payload._row_id = rowId
  payload._updated_at = toIsoOrFallback(row._updated_at, nowIso())
  payload._deleted_at = row._deleted_at ? toIsoOrFallback(row._deleted_at, payload._updated_at) : null
  payload._version = asPositiveInt(row._version, 1)
  payload._source_client = String(row._source_client || '')
  return payload
}

function loadListRaw(tableName) {
  const filePath = path.join(DATA_DIR, `${tableName}.json`)
  const raw = readFileJson(filePath, [])
  const list = Array.isArray(raw) ? raw : []
  const normalized = list.map((row, idx) => normalizeRow(tableName, row, idx))
  writeFileJson(filePath, normalized)
  return normalized
}

function saveListRaw(tableName, list) {
  const normalized = (Array.isArray(list) ? list : []).map((row, idx) => normalizeRow(tableName, row, idx))
  writeFileJson(path.join(DATA_DIR, `${tableName}.json`), normalized)
  notificarSync_()
}

function loadConfigRaw() {
  const filePath = path.join(DATA_DIR, `${CONFIG_TABLE}.json`)
  const cfg = normalizeConfigObject(readFileJson(filePath, {}))
  writeFileJson(filePath, cfg)
  return cfg
}

function saveConfigRaw(cfg) {
  const normalized = normalizeConfigObject(cfg)
  writeFileJson(path.join(DATA_DIR, `${CONFIG_TABLE}.json`), normalized)
  notificarSync_()
}

function bumpConfigVersion(cfg) {
  const next = normalizeConfigObject(cfg)
  next.__sync_version = asPositiveInt(next.__sync_version, 1) + 1
  next.__sync_updated_at = nowIso()
  return next
}

function lerJSON(nome, padrao = [], options = {}) {
  if (nome === CONFIG_TABLE) {
    return loadConfigRaw()
  }

  const includeDeleted = !!(options && options.includeDeleted)
  const list = loadListRaw(nome)
  if (includeDeleted) return list
  return list.filter((item) => !item._deleted_at)
}

function salvarJSON(nome, dados) {
  try {
    if (nome === CONFIG_TABLE) {
      saveConfigRaw(dados)
      return
    }
    saveListRaw(nome, Array.isArray(dados) ? dados : [])
  } catch (err) {
    throw new Error(`Erro ao salvar ${nome}: ${err.message}`)
  }
}

function notificarSync_() {
  try {
    const { ipcRenderer } = require('electron')
    ipcRenderer.send('medcore-sync:request')
  } catch (_) {}
}

function nextId(lista) {
  const arr = Array.isArray(lista) ? lista : []
  const used = new Set(
    arr
      .map((item) => Number(item && item.id))
      .filter((n) => Number.isFinite(n) && n > 0)
  )

  // ID global (timestamp + aleatorio) para evitar colisao entre PCs.
  for (let i = 0; i < 30; i++) {
    const base = Date.now() * 1000
    const rnd = Math.floor(Math.random() * 1000)
    const candidate = base + rnd
    if (!used.has(candidate)) return candidate
  }

  // Fallback deterministico se, por algum motivo, houver colisao repetida.
  const maxId = arr.reduce((max, item) => {
    const n = Number(item && item.id)
    if (!Number.isFinite(n)) return max
    return n > max ? n : max
  }, Date.now() * 1000)
  return maxId + 1
}

function nextRowId(tableName) {
  const suffix = randomBytes(4).toString('hex')
  return `${tableName}_${Date.now().toString(36)}_${suffix}`
}

function upsertById(tableName, incoming) {
  const raw = loadListRaw(tableName)
  const rawId = incoming && incoming.id !== undefined ? Number(incoming.id) : NaN
  const hasId = Number.isFinite(rawId)
  const id = hasId ? rawId : null
  const now = nowIso()
  const idx = raw.findIndex((item) => Number(item.id) === Number(id) && !item._deleted_at)

  if (idx >= 0) {
    const current = raw[idx]
    const currentPayload = stripMeta(current)
    const nextPayload = stripMeta({ ...current, ...incoming })
    if (JSON.stringify(currentPayload) === JSON.stringify(nextPayload)) {
      return current
    }

    raw[idx] = normalizeRow(tableName, {
      ...current,
      ...incoming,
      _row_id: current._row_id || String(current.id),
      _updated_at: now,
      _deleted_at: null,
      _version: asPositiveInt(current._version, 1) + 1,
      _source_client: getSourceClient()
    }, idx)
    saveListRaw(tableName, raw)
    return raw[idx]
  }

  const newId = hasId ? id : nextId(raw)
  const newRowId = (incoming && incoming._row_id !== undefined && incoming._row_id !== null && String(incoming._row_id).trim())
    ? String(incoming._row_id).trim()
    : nextRowId(tableName)
  const created = normalizeRow(tableName, {
    ...incoming,
    id: newId,
    _row_id: newRowId,
    criado_em: incoming && incoming.criado_em ? incoming.criado_em : nowText(),
    _updated_at: now,
    _deleted_at: null,
    _version: 1,
    _source_client: getSourceClient()
  }, raw.length)
  raw.push(created)
  saveListRaw(tableName, raw)
  return created
}

function softDeleteById(tableName, id) {
  const raw = loadListRaw(tableName)
  const idx = raw.findIndex((item) => Number(item.id) === Number(id) && !item._deleted_at)
  if (idx < 0) return false

  const current = raw[idx]
  const stamp = nowIso()
  raw[idx] = normalizeRow(tableName, {
    ...current,
    _updated_at: stamp,
    _deleted_at: stamp,
    _version: asPositiveInt(current._version, 1) + 1,
    _source_client: getSourceClient()
  }, idx)
  saveListRaw(tableName, raw)
  return true
}

function listActive(tableName) {
  return lerJSON(tableName, [], { includeDeleted: false })
}

function getById(tableName, id) {
  const nid = Number(id)
  return listActive(tableName).find((item) => Number(item.id) === nid) || null
}

function markConfigChanged(mutator) {
  const cfg = loadConfigRaw()
  const changed = typeof mutator === 'function' ? mutator(cfg) : cfg
  saveConfigRaw(bumpConfigVersion(changed))
}

// CONFIG
function getConfig(chave, padrao = '') {
  const cfg = loadConfigRaw()
  return cfg[chave] !== undefined ? cfg[chave] : padrao
}

function setConfig(chave, valor) {
  markConfigChanged((cfg) => {
    cfg[chave] = String(valor)
    return cfg
  })
}

// MEDICOS
function listarMedicos(apenasAtivos = false) {
  let lista = listActive('medicos')
  if (apenasAtivos) lista = lista.filter((m) => Number(m.ativo) !== 0)
  return lista.sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || '')))
}

function getMedico(id) {
  return getById('medicos', id)
}

function inserirMedico(d) {
  upsertById('medicos', {
    nome: d.nome,
    crm: d.crm || '',
    especialidade: d.especialidade || '',
    telefone: d.telefone || '',
    email: d.email || '',
    ativo: 1,
    criado_em: nowText()
  })
}

function atualizarMedico(d) {
  upsertById('medicos', {
    id: d.id,
    nome: d.nome,
    crm: d.crm || '',
    especialidade: d.especialidade || '',
    telefone: d.telefone || '',
    email: d.email || '',
    ativo: Number(d.ativo)
  })
}

function deletarMedico(id) {
  softDeleteById('medicos', id)
}

// PACIENTES
function listarPacientes(busca = '') {
  let lista = listActive('pacientes')
  if (busca) {
    const b = String(busca || '').toLowerCase()
    lista = lista.filter((p) =>
      String(p.nome || '').toLowerCase().includes(b)
      || String(p.cpf || '').toLowerCase().includes(b)
      || String(p.telefone || '').toLowerCase().includes(b)
    )
  }
  return lista.sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || '')))
}

function getPaciente(id) {
  return getById('pacientes', id)
}

function inserirPaciente(d) {
  upsertById('pacientes', {
    ...d,
    criado_em: nowText()
  })
}

function atualizarPaciente(d) {
  upsertById('pacientes', { ...d })
}

function deletarPaciente(id) {
  softDeleteById('pacientes', id)
}

// AGENDA
function listarAgenda(filtros = {}) {
  let lista = listActive('agenda')
  if (filtros.data) lista = lista.filter((a) => a.data === filtros.data)
  if (filtros.medico_id) lista = lista.filter((a) => String(a.medico_id) === String(filtros.medico_id))
  if (filtros.status) lista = lista.filter((a) => a.status === filtros.status)
  if (filtros.mes) lista = lista.filter((a) => String(a.data || '').startsWith(filtros.mes))
  return lista.sort((a, b) => String(a.data || '') .concat(String(a.hora || '')).localeCompare(String(b.data || '').concat(String(b.hora || ''))))
}

function getAgendamento(id) {
  return getById('agenda', id)
}

function inserirAgendamento(d) {
  upsertById('agenda', {
    ...d,
    status: d.status || 'Agendado',
    criado_em: nowText()
  })
}

function atualizarAgendamento(d) {
  upsertById('agenda', {
    id: d.id,
    data: d.data,
    hora: d.hora,
    medico_id: d.medico_id,
    medico_nome: d.medico_nome,
    tipo: d.tipo,
    convenio: d.convenio,
    valor: d.valor,
    status: d.status,
    obs: d.obs
  })
}

function atualizarStatusAgenda(id, status) {
  const current = getAgendamento(id)
  if (!current) return
  upsertById('agenda', { ...current, id: current.id, status })
}

function deletarAgendamento(id) {
  softDeleteById('agenda', id)
}

// PRONTUARIO
function listarProntuarios(paciente_id) {
  const nid = Number(paciente_id)
  return listActive('prontuarios')
    .filter((p) => Number(p.paciente_id) === nid)
    .sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')))
}

function getProntuario(id) {
  return getById('prontuarios', id)
}

function inserirProntuario(d) {
  upsertById('prontuarios', {
    ...d,
    criado_em: nowText()
  })
}

function atualizarProntuario(d) {
  upsertById('prontuarios', { ...d })
}

function deletarProntuario(id) {
  softDeleteById('prontuarios', id)
}

// ASO
function listarAsos(busca = '') {
  let lista = listActive('asos')
  if (busca) {
    const b = String(busca || '').toLowerCase()
    lista = lista.filter((a) =>
      String(a.paciente_nome || '').toLowerCase().includes(b)
      || String(a.empresa || '').toLowerCase().includes(b)
    )
  }
  return lista.sort((a, b) => String(b.criado_em || '').localeCompare(String(a.criado_em || '')))
}

function inserirAso(d) {
  upsertById('asos', {
    ...d,
    criado_em: nowText()
  })
}

function deletarAso(id) {
  softDeleteById('asos', id)
}

// FINANCEIRO
function listarFinanceiro(filtros = {}) {
  let lista = listActive('financeiro')
  if (filtros.mes) lista = lista.filter((l) => String(l.data || '').startsWith(filtros.mes))
  if (filtros.tipo) lista = lista.filter((l) => l.tipo === filtros.tipo)
  return lista.sort((a, b) => {
    const byDate = String(b.data || '').localeCompare(String(a.data || ''))
    if (byDate !== 0) return byDate
    return Number(b.id || 0) - Number(a.id || 0)
  })
}

function inserirFinanceiro(d) {
  upsertById('financeiro', {
    ...d,
    criado_em: nowText()
  })
}

function atualizarFinanceiro(d) {
  const atual = getById('financeiro', d.id) || {}
  upsertById('financeiro', {
    ...atual,
    ...d,
    id: d.id
  })
}

function deletarFinanceiro(id) {
  softDeleteById('financeiro', id)
}

// ESTOQUE
function listarEstoque(busca = '') {
  let lista = listActive('estoque')
  if (busca) {
    const b = String(busca || '').toLowerCase()
    lista = lista.filter((e) =>
      String(e.nome || '').toLowerCase().includes(b)
      || String(e.categoria || '').toLowerCase().includes(b)
    )
  }
  return lista.sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || '')))
}

function getEstoqueItem(id) {
  return getById('estoque', id)
}

function inserirEstoque(d) {
  upsertById('estoque', {
    ...d,
    criado_em: nowText()
  })
}

function atualizarEstoque(d) {
  upsertById('estoque', { ...d })
}

function deletarEstoque(id) {
  softDeleteById('estoque', id)
}

// DASHBOARD
function getDashStats() {
  const hoje = new Date().toISOString().split('T')[0]
  const mes = hoje.slice(0, 7)
  const agenda = listActive('agenda')
  const financeiro = listActive('financeiro')
  const estoque = listActive('estoque')
  const receitasMes = financeiro
    .filter((f) => f.tipo === 'Receita' && String(f.data || '').startsWith(mes))
    .reduce((soma, f) => soma + Number(f.valor || 0), 0)
  const despesasMes = financeiro
    .filter((f) => f.tipo === 'Despesa' && String(f.data || '').startsWith(mes))
    .reduce((soma, f) => soma + Number(f.valor || 0), 0)

  return {
    totalPacientes: listActive('pacientes').length,
    totalMedicos: listActive('medicos').filter((m) => Number(m.ativo) !== 0).length,
    consultasHoje: agenda.filter((a) => a.data === hoje).length,
    consultasMes: agenda.filter((a) => String(a.data || '').startsWith(mes)).length,
    faturamentoMes: receitasMes,
    alertasEstoque: estoque.filter((e) => Number(e.quantidade || 0) <= Number(e.qtd_minima || 0)).length,
    agendaHoje: agenda.filter((a) => a.data === hoje).sort((a, b) => String(a.hora || '').localeCompare(String(b.hora || ''))),
    receitasMes,
    despesasMes
  }
}

// MEDICAMENTOS
function listarMedicamentos(busca = '') {
  let lista = listActive('medicamentos')
  if (busca) {
    const b = String(busca || '').toLowerCase()
    lista = lista.filter((m) => String(m.nome || '').toLowerCase().includes(b))
  }
  return lista.sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || '')))
}

function inserirMedicamento(d) {
  const lista = listActive('medicamentos')
  if (lista.some((m) => String(m.nome || '').toLowerCase() === String(d.nome || '').toLowerCase())) return false
  upsertById('medicamentos', {
    nome: d.nome,
    posologia: d.posologia || '',
    quantidade: d.quantidade || '',
    uso_continuo: d.uso_continuo || 0,
    criado_em: nowText()
  })
  return true
}

function atualizarMedicamento(d) {
  upsertById('medicamentos', {
    id: d.id,
    nome: d.nome,
    posologia: d.posologia || '',
    quantidade: d.quantidade || '',
    uso_continuo: d.uso_continuo || 0
  })
}

function deletarMedicamento(id) {
  softDeleteById('medicamentos', id)
}

// EXAMES
function listarExames(busca = '') {
  let lista = listActive('exames_banco')
  if (busca) {
    const b = String(busca || '').toLowerCase()
    lista = lista.filter((e) =>
      String(e.nome || '').toLowerCase().includes(b)
      || String(e.categoria || '').toLowerCase().includes(b)
    )
  }
  return lista.sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || '')))
}

function inserirExame(d) {
  const lista = listActive('exames_banco')
  const exists = lista.some((e) =>
    String(e.nome || '').toLowerCase() === String(d.nome || '').toLowerCase()
    && String(e.categoria || '') === String(d.categoria || '')
  )
  if (exists) return false

  upsertById('exames_banco', {
    nome: d.nome,
    categoria: d.categoria || '',
    instrucoes: d.instrucoes || '',
    criado_em: nowText()
  })
  return true
}

function atualizarExame(d) {
  upsertById('exames_banco', {
    id: d.id,
    nome: d.nome,
    categoria: d.categoria || '',
    instrucoes: d.instrucoes || ''
  })
}

function deletarExame(id) {
  softDeleteById('exames_banco', id)
}

// SOLICITACOES
function listarSolicitacoes(paciente_id) {
  return listActive('solicitacoes_exames')
    .filter((s) => Number(s.paciente_id) === Number(paciente_id))
    .sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')))
}

function inserirSolicitacao(d) {
  upsertById('solicitacoes_exames', {
    ...d,
    criado_em: nowText()
  })
}

function deletarSolicitacao(id) {
  softDeleteById('solicitacoes_exames', id)
}

// LOCAIS
function listarLocais() {
  return listActive('locais').sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || '')))
}

function inserirLocal(d) {
  upsertById('locais', {
    nome: d.nome,
    endereco: d.endereco || '',
    obs: d.obs || '',
    criado_em: nowText()
  })
}

function atualizarLocal(d) {
  upsertById('locais', {
    id: d.id,
    nome: d.nome,
    endereco: d.endereco || '',
    obs: d.obs || ''
  })
}

function deletarLocal(id) {
  softDeleteById('locais', id)
}

// RECEITUARIOS
function salvarReceituario(d) {
  upsertById('receituarios_salvos', {
    ...d,
    criado_em: nowText()
  })
}

function listarReceituarios(paciente_id) {
  let lista = listActive('receituarios_salvos')
  if (paciente_id) lista = lista.filter((r) => Number(r.paciente_id) === Number(paciente_id))
  return lista.sort((a, b) => String(b.criado_em || '').localeCompare(String(a.criado_em || '')))
}

module.exports = {
  getConfig, setConfig,
  listarMedicos, getMedico, inserirMedico, atualizarMedico, deletarMedico,
  listarPacientes, getPaciente, inserirPaciente, atualizarPaciente, deletarPaciente,
  listarAgenda, getAgendamento, inserirAgendamento, atualizarAgendamento, atualizarStatusAgenda, deletarAgendamento,
  listarProntuarios, getProntuario, inserirProntuario, atualizarProntuario, deletarProntuario,
  listarAsos, inserirAso, deletarAso,
  listarFinanceiro, inserirFinanceiro, atualizarFinanceiro, deletarFinanceiro,
  listarEstoque, getEstoqueItem, inserirEstoque, atualizarEstoque, deletarEstoque,
  listarMedicamentos, inserirMedicamento, atualizarMedicamento, deletarMedicamento,
  listarExames, inserirExame, atualizarExame, deletarExame,
  listarSolicitacoes, inserirSolicitacao, deletarSolicitacao,
  salvarReceituario, listarReceituarios,
  listarLocais, inserirLocal, atualizarLocal, deletarLocal,
  getDashStats,
  lerJSON, salvarJSON
}
