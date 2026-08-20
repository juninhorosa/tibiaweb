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

### Publico e gratis (para jogar de fora)

O proxy fala WSS, que e HTTP upgrade — entao qualquer PaaS que aceite HTTPS
serve, sem precisar de TCP cru. Duas rotas:

- **Cloudflare Tunnel** (gratis, sem cartao): expoe a maquina local com
  hostname HTTPS. Precisa de dois hostnames, um por endpoint.
- **Fly.io**: um app pode expor 443 e 8443 com `handlers = ["tls"]`, e o TLS
  fica na borda — rode o proxy sem `CERT_PATH`/`KEY_PATH`.

## Teste do proxy

```
cd proxy && node smoke-test.mjs
```

Sobe um servidor TCP de eco, passa bytes pela ponte e confere o round-trip.
`smoke-tls.mjs` faz o mesmo em modo `wss`.
