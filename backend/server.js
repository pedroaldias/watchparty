'use strict';

/**
 * WatchParty - backend
 *  - Socket.io: salas, sincronização (play/pause/seek), chat, participantes
 *  - Proxy de streaming do Google Drive (com suporte a Range, protegido por sala)
 *  - Serve o frontend compilado (../frontend/dist) se ele existir
 *
 * Tudo que é configurável vem de variáveis de ambiente (veja .env.example).
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const cors = require('cors');
const express = require('express');
const { Server } = require('socket.io');

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I
const FILE_ID_RE = /^[A-Za-z0-9_-]{10,120}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ROOM_ID_RE = /^[A-Z0-9]{4,12}$/;

/** Aceita um ID puro ou links do Drive (/file/d/ID, ?id=ID). Retorna null se inválido. */
function parseFileId(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (FILE_ID_RE.test(text)) return text;
  const byPath = /\/d\/([A-Za-z0-9_-]{10,120})/.exec(text);
  if (byPath) return byPath[1];
  try {
    const id = new URL(text).searchParams.get('id');
    if (id && FILE_ID_RE.test(id)) return id;
  } catch {
    /* não era uma URL */
  }
  return null;
}

function normalizeRoomId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim().toUpperCase();
  return ROOM_ID_RE.test(id) ? id : null;
}

function cleanName(value) {
  if (typeof value !== 'string') return 'Visitante';
  // remove caracteres de controle e espaços repetidos
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return name || 'Visitante';
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Limitador simples: no máximo `limit` eventos a cada `windowMs`. */
function makeBucket(limit, windowMs) {
  let hits = [];
  return () => {
    const now = Date.now();
    hits = hits.filter((t) => now - t < windowMs);
    if (hits.length >= limit) return false;
    hits.push(now);
    return true;
  };
}

function createDriveFromEnv() {
  const { google } = require('googleapis');
  const scopes = ['https://www.googleapis.com/auth/drive.readonly'];
  let authOptions;

  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    authOptions = { credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON), scopes };
  } else {
    const keyFile = process.env.GOOGLE_CREDENTIALS_FILE || path.join(__dirname, 'credentials.json');
    if (!fs.existsSync(keyFile)) {
      console.warn(`[aviso] Credenciais do Google não encontradas em ${keyFile}. O streaming não vai funcionar.`);
    }
    authOptions = { keyFile, scopes };
  }
  return google.drive({ version: 'v3', auth: new google.auth.GoogleAuth(authOptions) });
}

// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------

function createServer({ drive, config = {} } = {}) {
  const cfg = {
    isProd: process.env.NODE_ENV === 'production',
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    accessCode: process.env.ACCESS_CODE || '',
    maxRoomSize: Number(process.env.MAX_ROOM_SIZE) || 8,
    maxRooms: Number(process.env.MAX_ROOMS) || 100,
    maxStreamsPerIp: Number(process.env.MAX_STREAMS_PER_IP) || 8,
    maxChunkBytes: 8 * 1024 * 1024, // tamanho máximo de cada resposta de vídeo
    reconnectGraceMs: 10_000, // tempo para o usuário voltar antes de sair da sala
    emptyRoomTtlMs: 30 * 60_000,
    tickMs: 5000, // intervalo da correção de deriva
    ...config,
  };

  const driveClient = drive || createDriveFromEnv();
  const rooms = new Map();

  // ---- CORS / origem ------------------------------------------------------
  /** Origem permitida? Sem Origin (curl, mesma origem em alguns casos) ou mesma origem sempre passa. */
  function originAllowed(origin, host) {
    if (!origin) return true;
    try {
      if (new URL(origin).host === host) return true;
    } catch {
      return false;
    }
    if (cfg.allowedOrigins.includes(origin)) return true;
    return cfg.allowedOrigins.length === 0 && !cfg.isProd; // em dev, tudo liberado
  }

  const app = express();
  app.set('trust proxy', 1); // Render/Cloudflare ficam na frente
  app.disable('x-powered-by');
  app.use(cors((req, cb) => cb(null, { origin: originAllowed(req.headers.origin, req.headers.host) })));

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: (origin, cb) => cb(null, !!origin && (cfg.allowedOrigins.includes(origin) || (!cfg.allowedOrigins.length && !cfg.isProd))) },
    allowRequest: (req, cb) => cb(null, originAllowed(req.headers.origin, req.headers.host)),
    maxHttpBufferSize: 20_000, // mensagens pequenas; barra payloads abusivos
  });

  // ---- Google Drive: metadados com cache -----------------------------------
  const metaCache = new Map(); // fileId -> { size, mimeType, name, exp }
  async function getFileMeta(fileId) {
    const cached = metaCache.get(fileId);
    if (cached && cached.exp > Date.now()) return cached;
    const { data } = await driveClient.files.get({ fileId, fields: 'id,name,size,mimeType' });
    const meta = {
      size: parseInt(data.size, 10),
      mimeType: data.mimeType || '',
      name: data.name || 'Vídeo',
      exp: Date.now() + 10 * 60_000,
    };
    metaCache.set(fileId, meta);
    return meta;
  }

  // ---- Salas ---------------------------------------------------------------
  function currentTime(room) {
    const s = room.state;
    return s.playing ? s.time + (Date.now() - s.updatedAt) / 1000 : s.time;
  }
  const snapshot = (room) => ({ playing: room.state.playing, time: currentTime(room) });
  const membersOf = (room) => [...room.members.values()].map((m) => ({ id: m.clientId, name: m.name }));
  const broadcastMembers = (room) => io.to(room.id).emit('members', membersOf(room));
  const systemMessage = (room, text) => io.to(room.id).emit('chat', { system: true, text, ts: Date.now() });

  function newRoomId() {
    for (let tries = 0; tries < 20; tries++) {
      let id = '';
      for (let i = 0; i < 6; i++) id += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!rooms.has(id)) return id;
    }
    return null;
  }

  function removeMember(room, clientId, { announce = true } = {}) {
    const member = room.members.get(clientId);
    if (!member) return;
    clearTimeout(member.timer);
    room.members.delete(clientId);
    if (announce) systemMessage(room, `${member.name} saiu da sala`);
    broadcastMembers(room);
    if (room.members.size === 0) {
      room.state = { ...snapshot(room), playing: false, updatedAt: Date.now() }; // congela o vídeo
      room.emptySince = Date.now();
    }
  }

  function leaveCurrentRoom(socket, { immediate }) {
    const { roomId, clientId } = socket.data;
    if (!roomId) return;
    socket.data.roomId = null;
    socket.leave(roomId);
    const room = rooms.get(roomId);
    const member = room && room.members.get(clientId);
    if (!member || member.socketId !== socket.id) return; // já foi assumido por outra conexão
    if (immediate) return removeMember(room, clientId);
    member.timer = setTimeout(() => removeMember(room, clientId), cfg.reconnectGraceMs); // dá tempo de reconectar
    member.timer.unref?.();
  }

  io.on('connection', (socket) => {
    const reply = (ack) => (typeof ack === 'function' ? ack : () => {});
    const chatBucket = makeBucket(5, 3000);
    const controlBucket = makeBucket(20, 5000);
    let lastCreate = 0;

    socket.on('createRoom', async (payload, ack) => {
      const done = reply(ack);
      try {
        if (!payload || typeof payload !== 'object') return done({ ok: false, error: 'INVALID_REQUEST' });
        if (Date.now() - lastCreate < 3000) return done({ ok: false, error: 'TOO_FAST' });
        lastCreate = Date.now();
        if (cfg.accessCode && !safeEqual(payload.accessCode ?? '', cfg.accessCode)) return done({ ok: false, error: 'BAD_ACCESS_CODE' });
        if (rooms.size >= cfg.maxRooms) return done({ ok: false, error: 'SERVER_BUSY' });

        const fileId = parseFileId(payload.video);
        if (!fileId) return done({ ok: false, error: 'INVALID_LINK' });

        let meta;
        try {
          meta = await getFileMeta(fileId);
        } catch (err) {
          console.warn('[drive] arquivo inacessível:', err.message);
          return done({ ok: false, error: 'VIDEO_UNAVAILABLE' });
        }
        if (!meta.mimeType.startsWith('video/') || !Number.isFinite(meta.size)) return done({ ok: false, error: 'NOT_VIDEO' });

        const id = newRoomId();
        if (!id) return done({ ok: false, error: 'SERVER_BUSY' });
        rooms.set(id, {
          id,
          fileId,
          title: meta.name,
          createdAt: Date.now(),
          emptySince: Date.now(),
          state: { playing: false, time: 0, updatedAt: Date.now() },
          members: new Map(),
        });
        done({ ok: true, roomId: id });
      } catch (err) {
        console.error('createRoom:', err);
        done({ ok: false, error: 'INTERNAL' });
      }
    });

    socket.on('joinRoom', (payload, ack) => {
      const done = reply(ack);
      if (!payload || typeof payload !== 'object') return done({ ok: false, error: 'INVALID_REQUEST' });
      const roomId = normalizeRoomId(payload.roomId);
      const clientId = payload.clientId;
      if (!roomId || typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId)) return done({ ok: false, error: 'INVALID_REQUEST' });

      const room = rooms.get(roomId);
      if (!room) return done({ ok: false, error: 'ROOM_NOT_FOUND' });

      const name = cleanName(payload.name);
      const existing = room.members.get(clientId);

      if (!existing && room.members.size >= cfg.maxRoomSize) return done({ ok: false, error: 'ROOM_FULL' });

      // Se estava em outra sala, sai dela primeiro
      if (socket.data.roomId && socket.data.roomId !== roomId) leaveCurrentRoom(socket, { immediate: true });

      if (existing) {
        // Reconexão (ou segunda aba do mesmo usuário): assume a vaga existente
        clearTimeout(existing.timer);
        if (existing.socketId !== socket.id) io.sockets.sockets.get(existing.socketId)?.leave(roomId);
        existing.socketId = socket.id;
        existing.name = name;
      } else {
        room.members.set(clientId, { clientId, name, socketId: socket.id, timer: null });
        socket.to(roomId).emit('chat', { system: true, text: `${name} entrou na sala`, ts: Date.now() });
      }

      socket.data.roomId = roomId;
      socket.data.clientId = clientId;
      socket.join(roomId);
      broadcastMembers(room);
      done({
        ok: true,
        room: { id: room.id, fileId: room.fileId, title: room.title },
        state: snapshot(room),
        members: membersOf(room),
      });
    });

    socket.on('leaveRoom', () => leaveCurrentRoom(socket, { immediate: true }));

    socket.on('control', (payload) => {
      const room = rooms.get(socket.data.roomId);
      const member = room && room.members.get(socket.data.clientId);
      if (!member || !payload || typeof payload !== 'object') return;
      if (!controlBucket()) return;

      const { action } = payload;
      const time = Number(payload.time);
      if (!['play', 'pause', 'seek'].includes(action) || !Number.isFinite(time) || time < 0 || time > 1e6) return;

      const playing = action === 'play' ? true : action === 'pause' ? false : room.state.playing;
      room.state = { playing, time, updatedAt: Date.now() };
      socket.to(room.id).emit('state', { action, playing, time, by: member.name });
    });

    socket.on('chat', (payload) => {
      const room = rooms.get(socket.data.roomId);
      const member = room && room.members.get(socket.data.clientId);
      if (!member || !payload || typeof payload.text !== 'string') return;
      const text = payload.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
      if (!text || text.length > 500 || !chatBucket()) return;
      io.to(room.id).emit('chat', { id: crypto.randomUUID(), clientId: member.clientId, name: member.name, text, ts: Date.now() });
    });

    socket.on('disconnect', () => leaveCurrentRoom(socket, { immediate: false }));
  });

  // Correção de deriva: de tempos em tempos manda a posição "oficial" para quem está assistindo
  const tickTimer = setInterval(() => {
    for (const room of rooms.values()) {
      if (room.state.playing && room.members.size) io.to(room.id).emit('tick', snapshot(room));
    }
  }, cfg.tickMs);

  // Limpeza de salas vazias
  const cleanupTimer = setInterval(() => {
    for (const [id, room] of rooms) {
      if (room.members.size === 0 && Date.now() - room.emptySince > cfg.emptyRoomTtlMs) rooms.delete(id);
    }
  }, 60_000);
  tickTimer.unref();
  cleanupTimer.unref();

  // ---- HTTP -----------------------------------------------------------------
  app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
  app.get('/api/config', (_req, res) => res.json({ requiresCode: !!cfg.accessCode }));

  const streamsByIp = new Map();

  /**
   * Streaming do Drive com suporte a Range (necessário para o Safari/iPhone e para seek).
   * Só funciona para (fileId, sala) válidos: não é um proxy aberto.
   */
  app.get('/api/stream/:fileId', async (req, res) => {
    const { fileId } = req.params;
    if (!FILE_ID_RE.test(fileId)) return res.status(400).json({ error: 'invalid_file' });
    const room = rooms.get(normalizeRoomId(String(req.query.room || '')));
    if (!room || room.fileId !== fileId) return res.status(403).json({ error: 'forbidden' });

    const ip = req.ip;
    const active = streamsByIp.get(ip) || 0;
    if (active >= cfg.maxStreamsPerIp) return res.status(429).set('Retry-After', '2').json({ error: 'too_many_streams' });
    streamsByIp.set(ip, active + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (streamsByIp.get(ip) || 1) - 1;
      if (n <= 0) streamsByIp.delete(ip);
      else streamsByIp.set(ip, n);
    };
    res.on('close', release);

    let upstream;
    res.on('close', () => upstream?.destroy());

    try {
      const meta = await getFileMeta(fileId);
      const size = meta.size;
      if (!(size > 0)) return res.status(404).json({ error: 'empty_file' });

      // Interpreta o cabeçalho Range (sem Range = começa do zero)
      let start = 0;
      let end = size - 1;
      const header = req.headers.range;
      if (header) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(header);
        if (!m || (m[1] === '' && m[2] === '')) return res.status(416).set('Content-Range', `bytes */${size}`).end();
        if (m[1] === '') {
          start = Math.max(0, size - parseInt(m[2], 10)); // bytes=-N (últimos N bytes)
        } else {
          start = parseInt(m[1], 10);
          if (m[2] !== '') end = Math.min(parseInt(m[2], 10), size - 1);
        }
      }
      if (start >= size || start > end) return res.status(416).set('Content-Range', `bytes */${size}`).end();
      end = Math.min(end, start + cfg.maxChunkBytes - 1); // responde em pedaços; o navegador pede o resto

      const response = await driveClient.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream', headers: { Range: `bytes=${start}-${end}` } },
      );
      upstream = response.data;
      if (res.destroyed) return upstream.destroy();

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': meta.mimeType.startsWith('video/') ? meta.mimeType : 'video/mp4',
        'Cache-Control': 'private, max-age=300',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      });
      upstream.on('error', (err) => {
        console.warn('[drive] erro no stream:', err.message);
        res.destroy();
      });
      upstream.pipe(res);
    } catch (err) {
      console.error('[drive] erro no streaming:', err.message);
      if (!res.headersSent) res.status(502).json({ error: 'upstream_error' });
      else res.destroy();
    }
  });

  // ---- Frontend compilado (modo "tudo num servidor") -------------------------
  const dist = path.join(__dirname, '..', 'frontend', 'dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  return { app, server, io, rooms, cfg };
}

module.exports = { createServer, parseFileId };

if (require.main === module) {
  const { server, cfg } = createServer();
  const port = Number(process.env.PORT) || 3001;
  server.listen(port, () => {
    console.log(`WatchParty rodando na porta ${port} (${cfg.isProd ? 'produção' : 'desenvolvimento'})`);
    if (cfg.isProd && !cfg.allowedOrigins.length) console.log('CORS: só mesma origem. Defina ALLOWED_ORIGINS se o frontend estiver em outro domínio.');
  });
}
