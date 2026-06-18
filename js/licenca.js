const LS_KEY_MC = '@MEDCORE:licenca'
const SESSION_KEY_MC = '@MEDCORE:license_session_ok'

function normalizarChaveMC(key) {
  const raw = String(key || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!raw) return ''
  const body = raw.startsWith('MEDCORE') ? raw.slice(7) : raw
  if (body.length < 16) return raw
  return `MEDCORE-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}`
}

function licencaAtivaMC() {
  try { return sessionStorage.getItem(SESSION_KEY_MC) === '1' }
  catch(e) { return false }
}

function getLicencaSalvaMC() {
  try { return localStorage.getItem(LS_KEY_MC) || '' }
  catch(e) { return '' }
}

function salvarLicencaMC(key) {
  localStorage.setItem(LS_KEY_MC, normalizarChaveMC(key))
}

function salvarSessaoLicencaMC(key) {
  salvarLicencaMC(key)
  sessionStorage.setItem(SESSION_KEY_MC, '1')
}

function limparSessaoLicencaMC() {
  try { sessionStorage.removeItem(SESSION_KEY_MC) } catch(e) {}
}
