# 🍿 WatchParty

Assista a vídeos do Google Drive em sincronia com os amigos (play, pause e seek sincronizados), com chat,
lista de participantes e legendas. Funciona no Safari do iPhone, no Android e no computador, e pode ser
instalado na tela inicial (PWA).

Como funciona: o servidor (Node + Socket.io) guarda o estado de cada sala e faz o streaming do vídeo a partir
do Drive; o site (React) só mostra o player. Cada sala toca **um** vídeo, escolhido por quem a cria.

---

## 1. Antes de tudo: o Google Drive

1. O arquivo `backend/credentials.json` (chave da *service account*) **não está neste pacote**. Coloque o seu
   nesse caminho. Ele nunca deve ir para o GitHub nem ser enviado a ninguém (já está no `.gitignore`).
   Se essa chave já foi enviada para algum lugar público, gere uma nova no Google Cloud e apague a antiga.
2. Abra o `credentials.json`, copie o valor de `client_email` e **compartilhe o vídeo no Drive com esse e-mail**
   (permissão de leitor). Sem isso a criação da sala falha com "Não consegui acessar esse vídeo".
3. O vídeo precisa ser **MP4 com vídeo H.264 e áudio AAC** para tocar no iPhone. MKV, AVI e outros não tocam no Safari.

## 2. Usar agora, no seu computador (o jeito mais rápido)

```bash
npm run setup      # instala tudo (uma vez)
npm run build      # compila o site (refaça se mudar o frontend)
npm start          # sobe tudo em http://localhost:3001
```

Para os amigos entrarem de fora da sua rede, abra um túnel HTTPS em outro terminal:

```bash
cloudflared tunnel --url http://localhost:3001
```

Abra o endereço `https://….trycloudflare.com` que ele mostrar, crie a sala e use o botão **Convidar**.
Esse endereço muda a cada vez que o túnel é reiniciado, e o seu computador precisa ficar ligado.

Desenvolvimento do frontend com recarga automática: `npm start` num terminal e, em outro,
`cd frontend && npm run dev` (abre em http://localhost:5173, já conectado ao backend).

## 3. Colocar no ar

### Opção A (recomendada): tudo num serviço só, no Render
O backend já serve o site compilado, então não precisa de Vercel nem de CORS.

1. Suba o projeto para um repositório no GitHub (sem `credentials.json`).
2. No Render: **New → Web Service** → escolha o repositório.
3. Configure:
   - **Build Command:** `npm run setup && npm run build`
   - **Start Command:** `npm start`
   - **Environment variables:**
     - `NODE_ENV` = `production`
     - `GOOGLE_CREDENTIALS_JSON` = o conteúdo inteiro do `credentials.json`
     - `ACCESS_CODE` = uma senha para criar salas (opcional, mas recomendado)
4. Abra o endereço `https://seu-app.onrender.com`.

### Opção B: site na Vercel + servidor no Render
1. Render: igual à opção A, mas defina também `ALLOWED_ORIGINS` = `https://seu-site.vercel.app`.
2. Vercel: **Add New → Project**, **Root Directory** = `frontend`, e a variável
   `VITE_SERVER_URL` = `https://seu-app.onrender.com` (sem barra no final).
3. Se mudar o endereço do site, atualize `ALLOWED_ORIGINS` no Render.

### Atenção ao plano grátis do Render
O vídeo passa pelo servidor. No plano grátis o serviço "dorme" após alguns minutos sem uso (o primeiro acesso
demora cerca de um minuto para acordar), e a banda e a CPU são limitadas, então vários amigos assistindo ao mesmo
tempo podem engasgar. Para sessões com muita gente, use um plano pago.

## 4. Variáveis de ambiente do servidor

| Variável | Para quê |
| --- | --- |
| `PORT` | Porta (o Render define sozinho; padrão 3001) |
| `NODE_ENV` | `production` no Render. Em produção, só aceita a própria origem e as de `ALLOWED_ORIGINS` |
| `ALLOWED_ORIGINS` | Sites autorizados a falar com o servidor (só se o site estiver em outro domínio) |
| `GOOGLE_CREDENTIALS_JSON` | Conteúdo do `credentials.json` (alternativa: o arquivo `backend/credentials.json`) |
| `ACCESS_CODE` | Se definido, é exigido para criar salas |
| `MAX_ROOM_SIZE` | Pessoas por sala (padrão 8) |
| `MAX_ROOMS` | Salas simultâneas (padrão 100) |
| `MAX_STREAMS_PER_IP` | Conexões de vídeo simultâneas por IP (padrão 8) |

## 5. Segurança (o que já está feito)

- O streaming só funciona para quem informa uma **sala existente** e o vídeo daquela sala. Não é um proxy aberto.
- Link/ID do Drive validado; só arquivos de vídeo; respostas em pedaços de até 8 MB; limite de conexões por IP.
- Mensagens de chat limitadas (500 caracteres, 5 a cada 3 segundos) e exibidas como texto puro.
- Comandos de sincronização validados e limitados em taxa.
- CORS e WebSocket só aceitam a própria origem e as listadas em `ALLOWED_ORIGINS` (em produção).
- Nenhuma chave no frontend. Credenciais por variável de ambiente.
- Quem tem o código/link da sala entra nela: compartilhe só com os amigos.
- As salas ficam na memória: se o servidor reiniciar, elas somem (basta criar outra).

## 6. Testes manuais (iPhone e Android)

Use dois ou mais aparelhos, um deles um iPhone, todos pelo endereço HTTPS.

1. **Criar e convidar:** no aparelho A, crie a sala e toque em **Convidar**. Abra o link no aparelho B.
2. **Entrar (iPhone):** toque em **Toque para entrar**. O vídeo não deve abrir em tela cheia sozinho.
3. **Play, pause e seek:** de cada aparelho, dê play, pause e arraste a barra. Os outros devem acompanhar em ~1 segundo,
   sem ficar "pulando" ou pausando sozinhos.
4. **Entrada tardia:** com o vídeo tocando, entre com um terceiro aparelho. Ele deve cair no ponto certo.
5. **Chat e lista:** envie mensagens dos dois lados; confira os nomes na lista "Na sala".
6. **Legenda:** ative "Português (BR)" no menu de legendas do player.
7. **Reconexão:** ligue o modo avião por alguns segundos e desligue. Deve aparecer "Reconectando…" e voltar sozinho, na mesma vaga.
8. **Bloqueio do navegador:** se aparecer "O navegador pausou o vídeo", toque em **Sincronizar**.
9. **Erros:** abra `?sala=ZZZZZZ` (sala inexistente) e tente criar sala com um link qualquer. Devem aparecer mensagens claras.
10. **PWA:** iPhone → Compartilhar → **Adicionar à Tela de Início**. Android (Chrome) → menu ⋮ → **Instalar app**.
    Depois de instalado, abra pelo ícone e entre numa sala pelo link.
11. **Rotação:** gire o aparelho; o layout deve se ajustar (vídeo ao lado do chat na horizontal).

## 7. Estrutura

```
backend/server.js        salas, sincronização, chat, proxy do Drive, serve o site
backend/test/smoke.js    testes automáticos do servidor (npm test)
frontend/src/            React: Home (criar/entrar), CoWatchRoom (player, sync, chat)
frontend/public/         ícones, manifest (PWA) e legenda-pt.vtt
```

A legenda é o arquivo único `frontend/public/legenda-pt.vtt` (a mesma para todas as salas). Para trocá-la, substitua o arquivo.
