import { io } from 'socket.io-client'
import { SERVER_URL } from './config'

// Uma única conexão para o app inteiro. Reconecta sozinha; a sala trata de reentrar.
export const socket = io(SERVER_URL, {
  autoConnect: false,
  reconnectionDelay: 500,
  reconnectionDelayMax: 4000,
})

// Envia um evento e espera a resposta do servidor (com tempo limite).
export function request(event, payload, timeoutMs = 10000) {
  return new Promise((resolve) => {
    socket.timeout(timeoutMs).emit(event, payload, (err, res) => {
      resolve(err ? { ok: false, error: 'TIMEOUT' } : res)
    })
  })
}

export const ERROR_TEXT = {
  ROOM_NOT_FOUND: 'Sala não encontrada. Confira o código ou peça um link novo.',
  ROOM_FULL: 'A sala está cheia.',
  INVALID_LINK: 'Link ou ID do Google Drive inválido.',
  VIDEO_UNAVAILABLE: 'Não consegui acessar esse vídeo. Confirme que o arquivo está compartilhado com a conta de serviço do servidor.',
  NOT_VIDEO: 'Esse arquivo do Drive não é um vídeo.',
  BAD_ACCESS_CODE: 'Código de acesso incorreto.',
  TOO_FAST: 'Calma! Tente de novo em alguns segundos.',
  SERVER_BUSY: 'O servidor está cheio de salas agora. Tente mais tarde.',
  TIMEOUT: 'O servidor não respondeu. Verifique a conexão e tente de novo.',
  INVALID_REQUEST: 'Pedido inválido. Recarregue a página e tente de novo.',
}
export const errorText = (code) => ERROR_TEXT[code] || 'Algo deu errado. Tente de novo.'
