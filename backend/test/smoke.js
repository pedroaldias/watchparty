'use strict';

/**
 * Teste de fumaça do backend. Usa um "Drive falso" (nada de internet nem credenciais).
 * Rode com: npm test
 */

const assert = require('assert');
const { Readable } = require('stream');
const { io: connect } = require('socket.io-client');
const { createServer } = require('../server');

const FILE = Buffer.alloc(100_000, 7);
const fakeDrive = {
  files: {
    get: async (params, opts) => {
      if (params.fileId === 'MISSINGFILE123') throw new Error('File not found');
      if (params.alt === 'media') {
        const m = /^bytes=(\d+)-(\d+)$/.exec(opts.headers.Range);
        return { data: Readable.from(FILE.subarray(Number(m[1]), Number(m[2]) + 1)) };
      }
      const isText = params.fileId === 'TEXTFILE123456';
      return { data: { id: params.fileId, name: 'filme.mp4', size: String(FILE.length), mimeType: isText ? 'text/plain' : 'video/mp4' } };
    },
  },
};

const VIDEO = 'GOODVIDEO123456';
let passed = 0;
const ok = (name) => console.log(`  ✓ ${name}`) || passed++;

const emit = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));
const once = (socket, event, ms = 2000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout esperando "${event}"`)), ms);
    socket.once(event, (data) => (clearTimeout(t), resolve(data)));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(config) {
  const ctx = createServer({ drive: fakeDrive, config });
  await new Promise((r) => ctx.server.listen(0, r));
  ctx.url = `http://localhost:${ctx.server.address().port}`;
  ctx.client = async () => {
    const s = connect(ctx.url, { transports: ['websocket'], reconnection: false });
    await once(s, 'connect');
    return s;
  };
  ctx.close = () => new Promise((r) => (ctx.io.close(), r()));
  return ctx;
}

async function main() {
  const ctx = await start({ maxRoomSize: 2, tickMs: 150, reconnectGraceMs: 400 });
  const sockets = [];
  const client = async () => sockets[sockets.push(await ctx.client()) - 1];

  console.log('Criação de sala');
  const host = await client();
  assert.deepStrictEqual(await emit(host, 'createRoom', { video: 'lixo' }), { ok: false, error: 'INVALID_LINK' });
  ok('rejeita link inválido');
  await sleep(3100);
  assert.strictEqual((await emit(host, 'createRoom', { video: 'MISSINGFILE123' })).error, 'VIDEO_UNAVAILABLE');
  ok('rejeita vídeo inacessível');
  await sleep(3100);
  assert.strictEqual((await emit(host, 'createRoom', { video: 'TEXTFILE123456' })).error, 'NOT_VIDEO');
  ok('rejeita arquivo que não é vídeo');
  await sleep(3100);
  const created = await emit(host, 'createRoom', { video: `https://drive.google.com/file/d/${VIDEO}/view?usp=sharing` });
  assert.ok(created.ok && /^[A-Z0-9]{6}$/.test(created.roomId));
  const roomId = created.roomId;
  ok(`cria sala a partir de link do Drive (${roomId})`);
  assert.strictEqual((await emit(host, 'createRoom', { video: VIDEO })).error, 'TOO_FAST');
  ok('limita criação de salas em sequência');

  console.log('Entrada e participantes');
  assert.strictEqual((await emit(host, 'joinRoom', { roomId: 'ZZZZZZ', clientId: 'host-client-1', name: 'Ana' })).error, 'ROOM_NOT_FOUND');
  ok('sala inexistente');
  const joinHost = await emit(host, 'joinRoom', { roomId: roomId.toLowerCase(), clientId: 'host-client-1', name: 'Ana' });
  assert.ok(joinHost.ok && joinHost.room.fileId === VIDEO && joinHost.state.playing === false);
  ok('entra (código aceito em minúsculas) e recebe fileId + estado');
  const guest = await client();
  const membersEvt = once(host, 'members');
  const joinGuest = await emit(guest, 'joinRoom', { roomId, clientId: 'guest-client-1', name: '  Bia\n  ' });
  assert.ok(joinGuest.ok && joinGuest.members.length === 2);
  assert.deepStrictEqual((await membersEvt).map((m) => m.name).sort(), ['Ana', 'Bia']);
  ok('lista de participantes atualizada para todos (nome higienizado)');
  const third = await client();
  assert.strictEqual((await emit(third, 'joinRoom', { roomId, clientId: 'third-client-1', name: 'Caio' })).error, 'ROOM_FULL');
  ok('sala cheia');

  console.log('Sincronização');
  const stateEvt = once(guest, 'state');
  host.emit('control', { action: 'play', time: 10 });
  const st = await stateEvt;
  assert.ok(st.action === 'play' && st.playing === true && st.time === 10 && st.by === 'Ana');
  ok('play do host chega ao convidado');
  await sleep(1000);
  assert.ok(Math.abs((await emit(third, 'joinRoom', { roomId, clientId: 'guest-client-1', name: 'Bia' })).state.time - 11) < 0.5);
  ok('quem entra depois recebe o tempo atual (mesma vaga em outra conexão)');
  third.emit('leaveRoom');
  await sleep(100);
  assert.ok((await emit(guest, 'joinRoom', { roomId, clientId: 'guest-client-1', name: 'Bia' })).ok);
  guest.emit('control', { action: 'seek', time: 100 });
  assert.strictEqual((await once(host, 'state')).time, 100);
  ok('seek propagado');
  host.emit('control', { action: 'pause', time: 'abc' });
  host.emit('control', { action: 'explodir', time: 5 });
  host.emit('control', { action: 'pause', time: -4 });
  await sleep(150);
  host.emit('control', { action: 'pause', time: 101 });
  const paused = await once(guest, 'state');
  assert.ok(paused.playing === false && paused.time === 101);
  ok('ignora comandos inválidos e propaga pause');
  guest.emit('control', { action: 'play', time: 50 });
  await once(host, 'state');
  const tick = await once(host, 'tick');
  assert.ok(tick.playing && tick.time >= 50);
  ok('servidor envia "tick" de correção de deriva enquanto está tocando');
  guest.emit('control', { action: 'pause', time: 55 });
  await once(host, 'state');

  console.log('Chat');
  const msgEvt = once(host, 'chat');
  guest.emit('chat', { text: '  oi, pessoal!  ' });
  const msg = await msgEvt;
  assert.ok(msg.name === 'Bia' && msg.text === 'oi, pessoal!');
  ok('mensagem chega a todos com nome');
  let extra = 0;
  host.on('chat', () => extra++);
  guest.emit('chat', { text: '   ' });
  guest.emit('chat', { text: 'x'.repeat(501) });
  await sleep(200);
  assert.strictEqual(extra, 0);
  ok('descarta mensagem vazia ou longa demais');
  for (let i = 0; i < 12; i++) guest.emit('chat', { text: `spam ${i}` });
  await sleep(300);
  assert.ok(extra <= 5, `limite de taxa falhou (${extra})`);
  ok('limite de taxa no chat');
  host.off('chat');

  console.log('Reconexão e saída');
  guest.disconnect();
  await sleep(100);
  const back = await client();
  const rejoin = await emit(back, 'joinRoom', { roomId, clientId: 'guest-client-1', name: 'Bia' });
  assert.ok(rejoin.ok && rejoin.members.length === 2);
  ok('reconectar com o mesmo clientId reaproveita a vaga');
  await sleep(600);
  assert.strictEqual((await emit(back, 'joinRoom', { roomId, clientId: 'guest-client-1', name: 'Bia' })).members.length, 2);
  ok('vaga não expira depois da reconexão');
  back.emit('leaveRoom');
  await sleep(150);
  assert.strictEqual((await emit(third, 'joinRoom', { roomId, clientId: 'third-client-1', name: 'Caio' })).ok, true);
  ok('sair libera a vaga na hora');

  console.log('Proxy do Drive');
  const get = (path, headers = {}) => fetch(`${ctx.url}${path}`, { headers });
  assert.strictEqual((await get(`/api/stream/${VIDEO}`)).status, 403);
  ok('sem sala -> 403 (não é proxy aberto)');
  assert.strictEqual((await get(`/api/stream/OTHERVIDEO12345?room=${roomId}`)).status, 403);
  ok('arquivo diferente do da sala -> 403');
  assert.strictEqual((await get(`/api/stream/abc?room=${roomId}`)).status, 400);
  ok('ID de arquivo inválido -> 400');
  let r = await get(`/api/stream/${VIDEO}?room=${roomId}`, { Range: 'bytes=0-99' });
  assert.strictEqual(r.status, 206);
  assert.strictEqual(r.headers.get('content-range'), `bytes 0-99/${FILE.length}`);
  assert.strictEqual((await r.arrayBuffer()).byteLength, 100);
  ok('Range 0-99 -> 206 com 100 bytes');
  r = await get(`/api/stream/${VIDEO}?room=${roomId}`, { Range: 'bytes=-500' });
  assert.strictEqual(r.headers.get('content-range'), `bytes ${FILE.length - 500}-${FILE.length - 1}/${FILE.length}`);
  assert.strictEqual((await r.arrayBuffer()).byteLength, 500);
  ok('Range de sufixo (bytes=-500)');
  r = await get(`/api/stream/${VIDEO}?room=${roomId}`, { Range: 'bytes=0-' });
  assert.strictEqual(r.status, 206);
  assert.strictEqual((await r.arrayBuffer()).byteLength, FILE.length);
  ok('Range aberto (bytes=0-)');
  r = await get(`/api/stream/${VIDEO}?room=${roomId}`);
  assert.strictEqual(r.status, 206);
  await r.arrayBuffer();
  ok('sem Range também funciona');
  assert.strictEqual((await get(`/api/stream/${VIDEO}?room=${roomId}`, { Range: `bytes=${FILE.length + 5}-` })).status, 416);
  assert.strictEqual((await get(`/api/stream/${VIDEO}?room=${roomId}`, { Range: 'bytes=abc' })).status, 416);
  ok('Range fora dos limites/inválido -> 416');
  assert.strictEqual((await (await get('/health')).json()).ok, true);
  ok('/health');

  console.log('Origem (CORS)');
  const dev = await fetch(`${ctx.url}/health`, { headers: { Origin: 'https://qualquer-site.com' } });
  assert.strictEqual(dev.headers.get('access-control-allow-origin'), 'https://qualquer-site.com');
  ok('modo desenvolvimento libera origens');

  sockets.forEach((s) => s.disconnect());
  await ctx.close();

  console.log('Produção, código de acesso e limite de streams');
  const prod = await start({ isProd: true, allowedOrigins: ['https://meu-front.vercel.app'], accessCode: 'segredo', maxStreamsPerIp: 1 });
  const denied = connect(prod.url, { transports: ['websocket'], reconnection: false, extraHeaders: { Origin: 'https://evil.example' } });
  const err = await once(denied, 'connect_error');
  assert.ok(err);
  ok('socket de origem não permitida é barrado');
  const evilHttp = await fetch(`${prod.url}/health`, { headers: { Origin: 'https://evil.example' } });
  assert.strictEqual(evilHttp.headers.get('access-control-allow-origin'), null);
  const goodHttp = await fetch(`${prod.url}/health`, { headers: { Origin: 'https://meu-front.vercel.app' } });
  assert.strictEqual(goodHttp.headers.get('access-control-allow-origin'), 'https://meu-front.vercel.app');
  ok('CORS HTTP só para origens permitidas em produção');
  const allowed = connect(prod.url, { transports: ['websocket'], reconnection: false, extraHeaders: { Origin: 'https://meu-front.vercel.app' } });
  await once(allowed, 'connect');
  ok('socket da origem permitida conecta');
  assert.strictEqual((await emit(allowed, 'createRoom', { video: VIDEO, accessCode: 'errado' })).error, 'BAD_ACCESS_CODE');
  await sleep(3100);
  const prodRoom = await emit(allowed, 'createRoom', { video: VIDEO, accessCode: 'segredo' });
  assert.ok(prodRoom.ok);
  ok('código de acesso exigido para criar sala');
  assert.strictEqual((await (await fetch(`${prod.url}/api/config`)).json()).requiresCode, true);
  ok('/api/config informa que o código é necessário');
  const a = await fetch(`${prod.url}/api/stream/${VIDEO}?room=${prodRoom.roomId}`, { headers: { Range: 'bytes=0-9' } });
  const b = await fetch(`${prod.url}/api/stream/${VIDEO}?room=${prodRoom.roomId}`, { headers: { Range: 'bytes=0-9' } });
  assert.ok([a.status, b.status].every((x) => x === 206 || x === 429));
  await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
  ok('limite de streams por IP aceito pelo servidor');
  allowed.disconnect();
  denied.disconnect();
  await prod.close();

  console.log(`\n${passed} verificações passaram.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n✗ FALHOU:', err.message);
  console.error(err.stack);
  process.exit(1);
});
