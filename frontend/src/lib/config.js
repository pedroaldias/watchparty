// Endereço do servidor. Vazio = mesma origem (modo "tudo num servidor" e desenvolvimento local).
export const SERVER_URL = (import.meta.env.VITE_SERVER_URL || window.location.origin).replace(/\/$/, '')

// Vídeo preenchido por padrão no formulário (troque por qualquer link/ID do Drive).
export const DEFAULT_VIDEO = '101po230x9u9siYlKB_vfU-wl3ZCoFN2a'
