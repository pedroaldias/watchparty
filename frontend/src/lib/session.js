// Identidade persistente do navegador: o "clientId" permite reconectar e manter a mesma vaga na sala.
const read = (key) => {
  try { return localStorage.getItem(key) } catch { return null }
}
const write = (key, value) => {
  try { localStorage.setItem(key, value) } catch { /* modo privado: segue sem salvar */ }
}

function randomId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, '')
  return Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('')
}

export function getClientId() {
  let id = read('wp_clientId')
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    id = randomId()
    write('wp_clientId', id)
  }
  return id
}

export const getSavedName = () => read('wp_name') || ''
export const saveName = (name) => write('wp_name', name)

// Código da sala no endereço: ?sala=ABC123
export const getRoomFromUrl = () => (new URLSearchParams(window.location.search).get('sala') || '').toUpperCase().slice(0, 12)

export function setRoomInUrl(roomId) {
  const url = new URL(window.location.href)
  if (roomId) url.searchParams.set('sala', roomId)
  else url.searchParams.delete('sala')
  window.history.replaceState({}, '', url)
}

export const inviteLink = (roomId) => `${window.location.origin}${window.location.pathname}?sala=${roomId}`
