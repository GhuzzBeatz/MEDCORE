const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const https = require('https')
const http = require('http')
const { execFileSync } = require('child_process')
const { spawn } = require('child_process')

const SUPABASE_URL = 'https://wpkaaxarresldcstaatj.supabase.co'
const SUPABASE_KEY = 'sb_publishable_G3I0XMI3dPG1Skkw9iFm9Q_1Ng6MVG0'
const LICENSE_CACHE_MAX_MS = 48 * 60 * 60 * 1000
const UPDATE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

module.exports = function setup(config) {
  const { app, ipcMain, getDataDir, appId, manifestUrl } = config

  // ── SUPABASE RPC ────────────────────────────────────────
  function supabaseRpc(fn, payload = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(`/rest/v1/rpc/${fn}`, SUPABASE_URL)
      const body = Buffer.from(JSON.stringify(payload), 'utf8')
      const client = url.protocol === 'http:' ? http : https
      const req = client.request(url, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          authorization: `Bearer ${SUPABASE_KEY}`,
          'content-type': 'application/json',
          'content-length': body.length
        }
      }, res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let json = null
          try { json = raw ? JSON.parse(raw) : null } catch (e) {}
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(json?.message || json?.error || raw || `HTTP ${res.statusCode}`))
            return
          }
          resolve(json)
        })
      })
      req.on('error', reject)
      req.setTimeout(20000, () => req.destroy(new Error('Tempo limite ao validar licença.')))
      req.write(body)
      req.end()
    })
  }

  // ── DEVICE INFO ─────────────────────────────────────────
  function machineGuid() {
    if (process.platform !== 'win32') return ''
    try {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true, timeout: 3000 })
      const m = out.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i)
      return m ? m[1].trim() : ''
    } catch (e) { return '' }
  }

  function getDeviceInfo() {
    const base = [machineGuid(), os.hostname(), os.userInfo().username, os.platform(), os.arch()].join('|')
    return {
      device_hash: crypto.createHash('sha256').update(`ghz-license-v1|${base}`).digest('hex'),
      device_name: os.hostname(),
      device_os: `${os.type()} ${os.release()} ${os.arch()}`,
      app_version: app.getVersion()
    }
  }

  // ── LICENSE STATE ───────────────────────────────────────
  function statePath() { return path.join(getDataDir(), 'license-state.json') }

  function readState() {
    try { return JSON.parse(fs.readFileSync(statePath(), 'utf8') || '{}') } catch (e) { return {} }
  }

  function saveState(patch = {}) {
    const dir = getDataDir()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const s = { active: false, license_key: '', customer_name: '', activated_at: '', last_validated_at: '', last_error: '', ...readState(), ...patch }
    fs.writeFileSync(statePath(), JSON.stringify(s, null, 2), 'utf8')
    return s
  }

  function cacheValid(s) {
    if (!s) s = readState()
    if (!s.active || !s.license_key) return false
    const t = Date.parse(s.last_validated_at || s.activated_at || '')
    return Number.isFinite(t) && Date.now() - t <= LICENSE_CACHE_MAX_MS
  }

  // ── LICENSE ACTIVATE / VALIDATE ─────────────────────────
  async function activate(key) {
    const k = String(key || '').trim().toUpperCase()
    const d = getDeviceInfo()
    const r = await supabaseRpc('ghz_activate_license', { p_license_key: k, p_device_hash: d.device_hash, p_device_name: d.device_name, p_device_os: d.device_os, p_app_version: d.app_version })
    if (!r?.ok) { saveState({ active: false, license_key: k, last_error: r?.message || 'Licença inválida.' }); return r || { ok: false, message: 'Licença inválida.' } }
    saveState({ active: true, license_key: k, customer_name: r.customer_name || '', activated_at: r.activated_at || new Date().toISOString(), last_validated_at: new Date().toISOString(), last_error: '' })
    return r
  }

  async function validate() {
    const s = readState()
    if (!s.license_key) return { ok: false, code: 'missing_license', message: 'Licença não ativada.' }
    const d = getDeviceInfo()
    const r = await supabaseRpc('ghz_validate_license', { p_license_key: s.license_key, p_device_hash: d.device_hash, p_device_name: d.device_name, p_device_os: d.device_os, p_app_version: d.app_version })
    if (!r?.ok) { saveState({ active: false, last_error: r?.message || 'Licença inválida.' }); return r || { ok: false, message: 'Licença inválida.' } }
    saveState({ active: true, customer_name: r.customer_name || s.customer_name || '', last_validated_at: new Date().toISOString(), last_error: '' })
    return r
  }

  // ── UPDATE STATE ────────────────────────────────────────
  function updateStatePath() { return path.join(getDataDir(), 'update-state.json') }
  function readUpdateState() { try { return JSON.parse(fs.readFileSync(updateStatePath(), 'utf8') || '{}') } catch (e) { return {} } }
  function saveUpdateState(patch) {
    const dir = getDataDir()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const s = { ...readUpdateState(), ...patch }
    fs.writeFileSync(updateStatePath(), JSON.stringify(s, null, 2), 'utf8')
    return s
  }

  function httpGet(url) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('http:') ? http : https
      const req = client.get(url, { headers: { 'User-Agent': `${appId}-updater` }, timeout: 20000 }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { httpGet(res.headers.location).then(resolve, reject); return }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return }
        const chunks = []
        res.setEncoding('utf8')
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve(chunks.join('')))
      })
      req.on('error', reject)
      req.on('timeout', () => req.destroy(new Error('Timeout')))
    })
  }

  function compareVersion(a, b) {
    const pa = (a || '').split('.').map(Number)
    const pb = (b || '').split('.').map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0
      if (x > y) return 1
      if (x < y) return -1
    }
    return 0
  }

  async function checkUpdate(source) {
    try {
      const raw = await httpGet(manifestUrl)
      const m = JSON.parse(raw)
      if (!m.version) throw new Error('Manifesto sem version')
      const current = app.getVersion()
      const newer = compareVersion(m.version, current) > 0
      const us = readUpdateState()
      saveUpdateState({
        last_checked_at: new Date().toISOString(),
        update_available: newer,
        pending_version: newer ? m.version : '',
        pending_download_url: newer ? m.download_url : '',
        pending_notes: newer ? (m.notes || '') : '',
        first_detected_at: newer ? (us.first_detected_at || new Date().toISOString()) : '',
        last_error: ''
      })
      return { ok: true, update_available: newer, current_version: current, latest_version: m.version, download_url: m.download_url, notes: m.notes }
    } catch (e) {
      saveUpdateState({ last_error: e.message })
      return { ok: false, error: e.message }
    }
  }

  function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
      const dir = path.dirname(dest)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const file = fs.createWriteStream(dest)
      const client = url.startsWith('http:') ? http : https
      const doReq = (u, redirects) => {
        if (redirects > 8) { reject(new Error('Muitos redirects')); return }
        client.get(u, { headers: { 'User-Agent': `${appId}-updater` }, timeout: 120000 }, res => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { doReq(res.headers.location, redirects + 1); return }
          if (res.statusCode !== 200) { file.close(); try { fs.unlinkSync(dest) } catch (e) {} reject(new Error(`HTTP ${res.statusCode}`)); return }
          res.pipe(file)
          file.on('finish', () => file.close(resolve))
        }).on('error', e => { file.close(); try { fs.unlinkSync(dest) } catch (x) {} reject(e) })
      }
      doReq(url, 0)
    })
  }

  async function downloadAndInstall() {
    const r = await checkUpdate('install-precheck')
    if (!r.update_available || !r.download_url) return { ok: false, message: 'Nenhuma atualização disponível.' }
    const tmpDir = path.join(os.tmpdir(), `${appId}_updates`)
    const fileName = r.download_url.split('/').pop() || `${appId}-setup.exe`
    const dest = path.join(tmpDir, fileName)
    await downloadFile(r.download_url, dest)
    const child = spawn(dest, [], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    setTimeout(() => app.quit(), 800)
    return { ok: true }
  }

  function weeklyCheck() {
    const us = readUpdateState()
    const last = Date.parse(us.last_checked_at || '')
    if (Number.isFinite(last) && Date.now() - last < UPDATE_WEEK_MS) return
    checkUpdate('startup-weekly').catch(() => {})
  }

  // ── IPC HANDLERS ────────────────────────────────────────
  ipcMain.handle('license:get-state', async () => ({ ...readState(), cache_valid: cacheValid() }))
  ipcMain.handle('license:device-info', async () => {
    const i = getDeviceInfo()
    return { device_hash_preview: i.device_hash.slice(0, 12), device_name: i.device_name, device_os: i.device_os }
  })
  ipcMain.handle('license:activate', async (e, { license_key }) => activate(license_key))
  ipcMain.handle('license:validate', async () => validate())

  ipcMain.handle('updates:get-state', async () => ({ ...readUpdateState(), current_version: app.getVersion() }))
  ipcMain.handle('updates:check', async () => checkUpdate('manual'))
  ipcMain.handle('updates:download-install', async () => downloadAndInstall())

  setTimeout(weeklyCheck, 4000)
}
