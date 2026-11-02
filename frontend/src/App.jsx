import { useEffect, useState } from 'react'
import CoWatchRoom from './CoWatchRoom'
import Home from './Home'
import { socket } from './lib/socket'
import { getRoomFromUrl, setRoomInUrl } from './lib/session'

export default function App() {
  const [session, setSession] = useState(null) // { roomId, name } quando está dentro de uma sala
  const [invitedRoom, setInvitedRoom] = useState(getRoomFromUrl) // sala vinda do link (?sala=ABC123)

  // Uma conexão para o app todo; ela reconecta sozinha se cair.
  useEffect(() => {
    socket.connect()
    return () => socket.disconnect()
  }, [])

  const enterRoom = (roomId, name) => {
    setRoomInUrl(roomId) // o endereço vira o link de convite
    setSession({ roomId, name })
  }

  const leaveRoom = () => {
    setRoomInUrl('')
    setInvitedRoom('')
    setSession(null)
  }

  if (session) return <CoWatchRoom roomId={session.roomId} name={session.name} onLeave={leaveRoom} />
  return <Home initialRoom={invitedRoom} onEnter={enterRoom} />
}
