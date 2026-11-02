import { useEffect, useState } from 'react'
import { DEFAULT_VIDEO, SERVER_URL } from './lib/config'
import { getSavedName, saveName } from './lib/session'
import { errorText, request } from './lib/socket'

const field =
  'w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-3 text-base text-white placeholder-gray-500 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/40'

export default function Home({ initialRoom, onEnter }) {
  const [mode, setMode] = useState(initialRoom ? 'join' : 'create')
  const [name, setName] = useState(getSavedName)
  const [video, setVideo] = useState(DEFAULT_VIDEO)
  const [code, setCode] = useState(initialRoom)
  const [accessCode, setAccessCode] = useState('')
  const [requiresCode, setRequiresCode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // O servidor pode exigir um código de acesso para criar salas
  useEffect(() => {
    fetch(`${SERVER_URL}/api/config`)
      .then((r) => r.json())
      .then((c) => setRequiresCode(!!c.requiresCode))
      .catch(() => {})
  }, [])

  async function submit(e) {
    e.preventDefault()
    setError('')
    const cleanName = name.trim()
    if (!cleanName) return setError('Digite seu nome para entrar.')
    saveName(cleanName)

    if (mode === 'join') {
      const roomId = code.trim().toUpperCase()
      if (!/^[A-Z0-9]{4,12}$/.test(roomId)) return setError('Código da sala inválido.')
      return onEnter(roomId, cleanName)
    }

    setBusy(true)
    const res = await request('createRoom', { video, accessCode })
    setBusy(false)
    if (!res.ok) return setError(errorText(res.error))
    onEnter(res.roomId, cleanName)
  }

  const tab = (id, label) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === id}
      onClick={() => { setMode(id); setError('') }}
      className={`flex-1 rounded-md py-2 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400 ${
        mode === id ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'
      }`}
    >
      {label}
    </button>
  )

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-gray-950 px-4 py-[max(1rem,env(safe-area-inset-top))] text-white">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">🍿 WatchParty</h1>
          <p className="mt-1 text-sm text-gray-400">Assistam juntos, cada um no seu aparelho.</p>
        </div>

        <div role="tablist" className="flex gap-1 rounded-lg bg-gray-900 p-1">
          {tab('create', 'Criar sala')}
          {tab('join', 'Entrar com código')}
        </div>

        <label className="block text-sm text-gray-300">
          Seu nome
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} autoComplete="nickname" className={`${field} mt-1`} placeholder="Como os amigos vão te ver" />
        </label>

        {mode === 'create' ? (
          <>
            <label className="block text-sm text-gray-300">
              Link ou ID do vídeo no Google Drive
              <input value={video} onChange={(e) => setVideo(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} className={`${field} mt-1`} placeholder="https://drive.google.com/file/d/..." />
            </label>
            {requiresCode && (
              <label className="block text-sm text-gray-300">
                Código de acesso do servidor
                <input value={accessCode} onChange={(e) => setAccessCode(e.target.value)} type="password" autoComplete="off" className={`${field} mt-1`} />
              </label>
            )}
          </>
        ) : (
          <label className="block text-sm text-gray-300">
            Código da sala
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={12} autoCapitalize="characters" autoCorrect="off" spellCheck={false} className={`${field} mt-1 text-center font-mono text-xl tracking-[0.3em]`} placeholder="ABC123" />
          </label>
        )}

        {error && <p role="alert" className="rounded-md bg-red-950/60 px-3 py-2 text-sm text-red-300">{error}</p>}

        <button type="submit" disabled={busy} className="w-full rounded-md bg-indigo-600 py-3 text-base font-bold shadow-md transition-colors hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-300 disabled:opacity-60">
          {busy ? 'Criando sala…' : mode === 'create' ? 'Criar sala' : 'Entrar na sala'}
        </button>
      </form>
    </main>
  )
}
