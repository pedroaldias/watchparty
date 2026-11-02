import { useCallback, useEffect, useRef, useState } from 'react'
import { SERVER_URL } from './lib/config'
import { getClientId, inviteLink } from './lib/session'
import { errorText, request, socket } from './lib/socket'

// Diferença (em segundos) aceita entre o seu vídeo e a posição "oficial" da sala.
const DRIFT_TOLERANCE = 1.5
// Depois de aplicar um comando remoto, ignora eventos do player por este tempo (evita eco).
const SUPPRESS_MS = 800

// Estado "oficial" da sala, ancorado no relógio local: { playing, time, at }
const INITIAL_STATE = { playing: false, time: 0, at: 0 }
const expectedTime = (st) => (st.playing ? st.time + (Date.now() - st.at) / 1000 : st.time)

export default function CoWatchRoom({ roomId, name, onLeave }) {
  const [clientId] = useState(getClientId)
  const videoRef = useRef(null)
  const chatEndRef = useRef(null)
  const stateRef = useRef(INITIAL_STATE)
  const enteredRef = useRef(false) // já tocou em "Entrar" (libera o play no iPhone)
  const suppressUntil = useRef(0)
  const copiedTimer = useRef(null)

  const [info, setInfo] = useState(null) // { id, fileId, title } depois de entrar na sala
  const [fatal, setFatal] = useState('')
  const [connected, setConnected] = useState(false)
  const [entered, setEntered] = useState(false)
  const [needTap, setNeedTap] = useState(false) // o navegador bloqueou o play automático
  const [videoError, setVideoError] = useState(false)
  const [members, setMembers] = useState([])
  const [messages, setMessages] = useState([])
  const [chatText, setChatText] = useState('')
  const [copied, setCopied] = useState(false)

  // ---- Sincronização --------------------------------------------------------

  const tryPlay = useCallback((video) => {
    const result = video.play()
    if (result && result.catch) {
      result.catch((err) => {
        if (err.name === 'NotAllowedError') setNeedTap(true) // pede um toque do usuário
      })
    }
  }, [])

  // Leva o player local para o estado oficial da sala (posição + tocando/pausado).
  const syncTo = useCallback(
    (tolerance) => {
      const video = videoRef.current
      if (!video || !enteredRef.current) return

      // Só "silencia" os eventos do player quando NÓS mexemos nele; se não há nada a corrigir,
      // uma ação real do usuário logo em seguida não pode ser ignorada.
      const mute = () => { suppressUntil.current = Date.now() + SUPPRESS_MS }

      const seek = () => {
        const target = expectedTime(stateRef.current)
        if (Math.abs(video.currentTime - target) > tolerance) {
          mute()
          video.currentTime = target
        }
      }
      if (video.readyState >= 1) seek()
      else video.addEventListener('loadedmetadata', seek, { once: true })

      if (stateRef.current.playing) {
        if (video.paused) {
          mute()
          tryPlay(video)
        }
      } else if (!video.paused) {
        mute()
        video.pause()
      }
    },
    [tryPlay],
  )

  // Ação feita por VOCÊ no player -> avisa a sala (ignora o que foi causado por comandos remotos).
  function emitLocal(action) {
    const video = videoRef.current
    if (!video || !enteredRef.current || Date.now() < suppressUntil.current) return
    const st = stateRef.current
    const time = video.currentTime
    const expected = expectedTime(st)
    if (action === 'play' && st.playing && Math.abs(time - expected) < DRIFT_TOLERANCE) return
    if (action === 'pause' && !st.playing && Math.abs(time - st.time) < DRIFT_TOLERANCE) return
    if (action === 'seek' && Math.abs(time - expected) < 0.5) return

    stateRef.current = { playing: action === 'play' ? true : action === 'pause' ? false : st.playing, time, at: Date.now() }
    socket.emit('control', { action, time })
  }

  // ---- Conexão com a sala -----------------------------------------------------

  useEffect(() => {
    let cancelled = false

    // Roda na primeira conexão e em TODA reconexão (o servidor devolve o estado atual).
    async function join() {
      const res = await request('joinRoom', { roomId, name, clientId })
      if (cancelled) return
      if (!res.ok) return setFatal(errorText(res.error))
      setFatal('')
      setInfo(res.room)
      setMembers(res.members)
      setConnected(true)
      stateRef.current = { playing: res.state.playing, time: res.state.time, at: Date.now() }
      syncTo(0.3)
    }

    const onDisconnect = () => setConnected(false)
    const onState = (s) => {
      stateRef.current = { playing: s.playing, time: s.time, at: Date.now() }
      syncTo(s.action === 'seek' ? 0.3 : DRIFT_TOLERANCE)
    }
    const onTick = (s) => {
      stateRef.current = { playing: s.playing, time: s.time, at: Date.now() }
      const video = videoRef.current
      // Se o seu vídeo está carregando (buffering), não força um seek que só atrasaria mais
      if (video && video.readyState >= 3 && !video.seeking) syncTo(DRIFT_TOLERANCE)
    }
    const onChat = (msg) => setMessages((prev) => [...prev.slice(-199), msg])

    socket.on('connect', join)
    socket.on('disconnect', onDisconnect)
    socket.on('state', onState)
    socket.on('tick', onTick)
    socket.on('members', setMembers)
    socket.on('chat', onChat)
    if (socket.connected) join()

    return () => {
      cancelled = true
      socket.off('connect', join)
      socket.off('disconnect', onDisconnect)
      socket.off('state', onState)
      socket.off('tick', onTick)
      socket.off('members', setMembers)
      socket.off('chat', onChat)
      clearTimeout(copiedTimer.current)
    }
  }, [roomId, name, clientId, syncTo])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  // ---- Ações da interface ---------------------------------------------------------

  // O toque em "Entrar" é o gesto que o Safari exige para liberar o play do vídeo.
  function enter() {
    const video = videoRef.current
    if (!video) return
    enteredRef.current = true
    setEntered(true)
    suppressUntil.current = Date.now() + 2500

    // Se a sala está pausada, destrava o player sem deixar o som escapar
    const silent = !stateRef.current.playing
    if (silent) video.muted = true
    const finish = () => {
      if (silent) video.muted = false
      syncTo(0.3)
    }
    const result = video.play()
    if (result && result.then) result.then(finish, finish)
    else finish()
  }

  function resync() {
    setNeedTap(false)
    syncTo(0.3)
  }

  function sendChat(e) {
    e.preventDefault()
    const text = chatText.trim()
    if (!text || !connected) return
    socket.emit('chat', { text })
    setChatText('')
  }

  async function invite() {
    const url = inviteLink(roomId)
    try {
      if (navigator.share) await navigator.share({ title: 'WatchParty', text: `Vem assistir comigo! Sala ${roomId}`, url })
      else await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch (err) {
      if (err.name === 'AbortError') return // fechou a janela de compartilhar
      window.prompt('Copie o link da sala:', url)
      return
    }
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), 2000)
  }

  function leave() {
    socket.emit('leaveRoom')
    onLeave()
  }

  // ---- Tela ---------------------------------------------------------------------------

  if (fatal) {
    return (
      <main className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-gray-950 px-6 text-center text-white">
        <p role="alert" className="max-w-sm text-gray-200">{fatal}</p>
        <button onClick={onLeave} className="rounded-md bg-indigo-600 px-5 py-3 font-bold hover:bg-indigo-500">
          Voltar ao início
        </button>
      </main>
    )
  }

  const streamUrl = info ? `${SERVER_URL}/api/stream/${info.fileId}?room=${roomId}` : undefined
  const button = 'rounded-md px-3 py-2 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-300'

  return (
    <div className="flex h-[100dvh] flex-col bg-gray-950 text-white md:flex-row">
      {/* Coluna do vídeo */}
      <section className="flex flex-col md:min-w-0 md:flex-1">
        <header className="flex items-center gap-2 border-b border-gray-800 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{info?.title || 'Conectando…'}</p>
            <p className="text-xs text-gray-400">
              Sala <span className="font-mono tracking-widest text-indigo-300">{roomId}</span>
            </p>
          </div>
          <button onClick={invite} className={`${button} bg-indigo-600 hover:bg-indigo-500`}>
            {copied ? 'Link copiado!' : 'Convidar'}
          </button>
          <button onClick={leave} className={`${button} bg-gray-800 text-gray-200 hover:bg-gray-700`}>
            Sair
          </button>
        </header>

        {info && !connected && (
          <p role="status" className="bg-amber-500/90 px-3 py-1 text-center text-xs font-semibold text-black">
            Conexão perdida. Reconectando…
          </p>
        )}

        <div className="relative bg-black md:flex md:flex-1 md:items-center md:justify-center">
          <video
            ref={videoRef}
            src={streamUrl}
            controls
            playsInline
            preload="metadata"
            className="block aspect-video max-h-[45dvh] w-full bg-black md:max-h-[calc(100dvh-5rem)]"
            onPlay={() => emitLocal('play')}
            onPause={() => emitLocal('pause')}
            onSeeked={() => emitLocal('seek')}
            onLoadedData={() => setVideoError(false)}
            onError={() => setVideoError(true)}
          >
            <track kind="subtitles" src="/legenda-pt.vtt" srcLang="pt" label="Português (BR)" default />
          </video>

          {!entered && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 px-4 text-center">
              {info ? (
                <>
                  <button onClick={enter} className="rounded-full bg-indigo-600 px-8 py-4 text-lg font-bold shadow-lg hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-300">
                    ▶ Toque para entrar
                  </button>
                  <p className="text-sm text-gray-300">
                    {members.length} {members.length === 1 ? 'pessoa na sala' : 'pessoas na sala'}
                  </p>
                </>
              ) : (
                <p className="text-gray-300">Conectando à sala…</p>
              )}
            </div>
          )}

          {needTap && entered && (
            <div className="absolute inset-x-2 top-2 flex items-center justify-between gap-2 rounded-md bg-indigo-700 px-3 py-2 text-sm shadow-lg">
              <span>O navegador pausou o vídeo.</span>
              <button onClick={resync} className="rounded bg-white px-3 py-1 font-bold text-indigo-700">Sincronizar</button>
            </div>
          )}
        </div>

        {videoError && (
          <p role="alert" className="bg-red-950/70 px-3 py-2 text-sm text-red-200">
            Não consegui carregar o vídeo. Ele precisa ser MP4 (H.264) e estar compartilhado com a conta de serviço do servidor.
          </p>
        )}
      </section>

      {/* Chat e participantes */}
      <aside className="flex min-h-0 flex-1 flex-col border-t border-gray-800 bg-gray-900 md:w-80 md:flex-none md:border-l md:border-t-0">
        <div className="flex flex-wrap gap-1.5 border-b border-gray-800 px-3 py-2">
          <span className="mr-1 text-xs text-gray-400">Na sala ({members.length}):</span>
          {members.map((m) => (
            <span key={m.id} className={`rounded-full px-2 py-0.5 text-xs ${m.id === clientId ? 'bg-indigo-600' : 'bg-gray-800 text-gray-200'}`}>
              {m.name}
            </span>
          ))}
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {messages.length === 0 && <p className="mt-4 text-center text-sm text-gray-500">Nenhuma mensagem ainda. Diga oi!</p>}
          {messages.map((m, i) =>
            m.system ? (
              <p key={i} className="text-center text-xs text-gray-500">{m.text}</p>
            ) : (
              <div key={m.id} className={`max-w-[85%] break-words rounded-lg px-3 py-2 text-sm ${m.clientId === clientId ? 'ml-auto bg-indigo-700' : 'bg-gray-800'}`}>
                {m.clientId !== clientId && <span className="mb-0.5 block text-xs font-bold text-indigo-300">{m.name}</span>}
                {m.text}
              </div>
            ),
          )}
          <div ref={chatEndRef} />
        </div>

        <form onSubmit={sendChat} className="flex gap-2 border-t border-gray-800 bg-gray-950 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <input
            value={chatText}
            onChange={(e) => setChatText(e.target.value)}
            maxLength={500}
            enterKeyHint="send"
            autoComplete="off"
            placeholder="Digite sua mensagem…"
            className="min-w-0 flex-1 rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-base text-white placeholder-gray-500 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/40"
          />
          <button type="submit" disabled={!connected} className="rounded-md bg-indigo-600 px-4 font-bold hover:bg-indigo-500 disabled:opacity-50">
            Enviar
          </button>
        </form>
      </aside>
    </div>
  )
}
