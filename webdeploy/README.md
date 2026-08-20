# OTClient no navegador — guia do stack

## Arquitetura

```
navegador                Cloudflare Pages          proxy WSS            servidor OT
[otclient.wasm]  <---->  [estatico + _headers]
       |
       +-- wss://host:7171 ----------------------> [proxy-login] --TCP--> canary:7171
       +-- wss://host:8443 ----------------------> [proxy-game]  --TCP--> canary:8443
```

Tres restricoes que definem tudo:

1. **`wss://` obrigatorio.** Em build Release o cliente monta a URL como
   `wss://<host>:<porta>` — ver `src/framework/net/webconnection.cpp:96`.
   Nao ha como usar `ws://` sem recompilar em Debug.
2. **COOP/COEP obrigatorios.** O bundle usa pthreads, que dependem de
   `SharedArrayBuffer`. Sem os headers de `pages/_headers` a pagina nem inicia.
   Por isso **GitHub Pages nao serve** — ele nao permite headers customizados.
   Cloudflare Pages e Netlify permitem.
3. **Duas conexoes.** Login e mundo do jogo sao endpoints separados. O
   `gameProtocolPort` do `config.lua` e o que o cliente vai usar na segunda
   conexao, entao ele precisa ser uma porta que o proxy exponha.

## Passo 1 — compilar o WASM (no GitHub Actions, nao na sua maquina)

O build local via `Dockerfile.browser.sh` consome ~20 GB (emsdk + vcpkg
compilando todas as dependencias para wasm32). O workflow
`.github/workflows/build-web.yml` faz isso de graca no runner do GitHub.

```
gh auth login
gh repo create <seu-usuario>/tibiaweb --public --source=. --remote=origin --push
gh workflow run "Build Web (WASM)"
```

Acompanhe com `gh run watch`. Ao terminar, baixe o bundle:

```
gh run download --name otclient-web-<sha> --dir ./web-build
```

## Passo 2 — assets (spr/dat)

O bundle **nao inclui sprites**. Conforme `data/things/README.md`, voce cria
`data/things/<versao>/` com os arquivos e recompila. Para 12+ o formato e
`catalog-content.json` + assets; para versoes antigas, `Tibia.spr` + `Tibia.dat`.

Esses arquivos sao propriedade da CipSoft e nao acompanham nenhum dos repos —
voce precisa obte-los por conta propria. A versao escolhida tem que bater com
a que o servidor anuncia.

## Passo 3 — hospedar o cliente (Cloudflare Pages, gratis)

```
npx wrangler pages deploy ./web-build --project-name tibiaweb
```

O `_headers` ja e copiado para dentro do bundle pelo workflow. Confirme no
DevTools que `crossOriginIsolated === true` no console — se for `false`, os
headers nao chegaram e o cliente nao vai carregar.

## Passo 4 — servidor + proxy

### Local (para testar)

```
cd webdeploy
docker compose up -d
```

O certificado em `proxy/certs/` e self-signed: abra `https://localhost:7171` e
`https://localhost:8443` uma vez em cada e aceite o aviso, senao o navegador
recusa o `wss://` silenciosamente.

No `config.lua` do Canary:

```lua
ip = "localhost"
loginProtocolPort = 7171
gameProtocolPort = 8443
```

### Publico e gratis — Cloudflare Tunnel

Quick tunnel nao pede conta, dominio nem cartao. Cada execucao sorteia um
hostname novo em `*.trycloudflare.com`, publicado em HTTPS/443. O cloudflared
termina TLS na borda da Cloudflare, entao os proxies rodam sem certificado —
o cliente continua enxergando `wss://`, que e o que o build Release exige.

Sao dois tuneis porque sao dois endpoints (login e mundo do jogo).

```
cd webdeploy
node tunnel/start.mjs          # deixe rodando; imprime os dois hostnames
```

Isso gera `server/config.lua` ja com o hostname do tunel do mundo. **Rode
antes do compose** — se `server/config.lua` nao existir, o Docker cria um
diretorio com esse nome no lugar do arquivo.

Em outro terminal:

```
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d
```

Na tela de login do cliente, use o hostname `login` impresso pelo script e a
porta **443**.

#### Restricao de versao

O endereco do mundo so trafega como hostname quando
`g_game.getClientVersion() > 1010` (`modules/gamelib/protocollogin.lua:206`).
Abaixo disso o protocolo manda um IPv4 de 4 bytes e o hostname do tunel nao
cabe. Ou seja: **13.x com Canary funciona, 8.6 nao** — sem patchear o cliente.

#### Limitacoes do quick tunnel

- O hostname muda a cada restart. Quando isso acontecer, rode o script de novo
  e reinicie o canary para reler o `config.lua`.
- O servidor roda na sua maquina: se ela desligar, o jogo cai.

### Tudo na nuvem — GitHub Codespaces (recomendado para testar)

Nao pede cartao, traz Docker com disco proprio e nao depende da sua maquina
ficar ligada. Cada porta encaminhada vira um hostname proprio publicado na
443:

```
https://<nome-do-codespace>-7171.app.github.dev   -> login
https://<nome-do-codespace>-8443.app.github.dev   -> mundo do jogo
```

Como a porta vai no **hostname** e a publicacao e sempre na 443, os dois
endpoints se encaixam direto no formato `wss://host:porta` que o cliente
monta. E o hostname e estavel entre restarts, diferente do quick tunnel.

Dentro do codespace:

```
cd webdeploy
node codespaces/test-forward.mjs     # confirma que wss binario atravessa
node codespaces/setup.mjs            # gera server/config.lua
docker compose -f docker-compose.yml -f docker-compose.codespaces.yml up -d
```

**Rode o teste antes de qualquer outra coisa.** A documentacao do GitHub nao
afirma em lugar nenhum que WebSocket funciona pelo `app.github.dev` — o teste
existe para nao descobrirmos isso depois de montar o servidor inteiro.

Ressalvas:

- As duas portas precisam estar com visibilidade **public** na aba Ports.
  Porta privada exige token no header, e o cliente WASM nao manda nenhum.
- O codespace hiberna apos ~30 min ocioso. Serve para testar, nao para 24/7.
- A cota gratuita e cobrada em core-hours: numa maquina de 2 nucleos, 1 hora
  real consome 2. Confira o valor atual na sua pagina de billing.

Para 24/7 de verdade, o caminho e uma VM (Oracle Cloud Always Free e a opcao
gratuita permanente). O stack nao muda: o proxy fala WSS, entao funciona atras
de qualquer coisa que termine HTTPS.

## Teste do proxy

```
cd proxy && node smoke-test.mjs
```

Sobe um servidor TCP de eco, passa bytes pela ponte e confere o round-trip.
`smoke-tls.mjs` faz o mesmo em modo `wss`.
