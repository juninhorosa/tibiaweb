#!/usr/bin/env bash
# Sobe tudo dentro de um GitHub Codespace: cliente web + servidor OT + pontes.
#
#   bash webdeploy/start-codespace.sh
#
set -euo pipefail
cd "$(dirname "$0")"

# ultimo build do WASM que passou (pode ser fixado com RUN_ID=...)
CLIENT_DIR="/workspaces/client-build/build-emscripten-web"

if [ -z "${CODESPACE_NAME:-}" ]; then
  echo "Isto precisa rodar dentro de um codespace." >&2
  exit 1
fi

# 1. bundle do cliente (baixa uma vez; o disco do codespace persiste)
if [ ! -f "${CLIENT_DIR}/otclient.wasm" ]; then
  # sem RUN_ID explicito, pega o ultimo build que passou
  RUN_ID="${RUN_ID:-$(curl -s -H "Authorization: Bearer ${GITHUB_TOKEN}"     "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/build-web.yml/runs?status=success&per_page=1"     | grep -oE '"id": ?[0-9]+' | head -1 | grep -oE '[0-9]+')}"
  if [ -z "${RUN_ID}" ]; then
    echo "Nenhum build concluido com sucesso encontrado." >&2
    exit 1
  fi
  echo "==> baixando o bundle do cliente (build ${RUN_ID})"
  ART=$(curl -s -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/runs/${RUN_ID}/artifacts" \
    | grep -oE '"id": ?[0-9]+' | head -1 | grep -oE '[0-9]+')
  if [ -z "${ART}" ]; then
    echo "Nenhum artefato no build ${RUN_ID} (expirou? o retention e 14 dias)." >&2
    exit 1
  fi
  mkdir -p /workspaces/client-build
  curl -sL -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/artifacts/${ART}/zip" -o /tmp/web.zip
  unzip -o -q /tmp/web.zip -d /workspaces/client-build
else
  echo "==> bundle do cliente ja presente"
fi

# 2. .env com o hostname publico do mundo do jogo
echo "==> gerando .env"
node codespaces/setup.mjs > /dev/null

# 3. servidor OT + as duas pontes WebSocket/TCP
echo "==> subindo servidor (a primeira vez baixa o mapa; leva alguns minutos)"
docker compose -f docker-compose.yml -f docker-compose.codespaces.yml up -d

# 4. cliente estatico com COOP/COEP
pkill -f "client/serve.mjs" 2>/dev/null || true
CLIENT_DIR="${CLIENT_DIR}" nohup node client/serve.mjs > /tmp/client-serve.log 2>&1 &

# 5. tentar abrir as portas sozinho -- a visibilidade nao sobrevive a
# um restart do codespace, e refazer isso na mao toda vez e um convite
# a esquecer e perder tempo depurando um 302.
if command -v gh >/dev/null 2>&1; then
  echo "==> ajustando visibilidade das portas"
  for p in 7171 8443 8080; do
    gh codespace ports visibility "${p}:public" -c "${CODESPACE_NAME}" 2>/dev/null       && echo "    ${p} -> public"       || echo "    ${p} -> falhou (faca na aba Portas)"
  done
else
  echo "==> gh nao instalado; abra as portas na aba Portas"
fi

D="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
cat <<TXT

================================================================
  Abra o cliente:

      https://${CODESPACE_NAME}-8080.${D}

  Na tela de login:

      servidor : ${CODESPACE_NAME}-7171.${D}
      porta    : 443

  PORTAS: 7171, 8443 e 8080 precisam estar PUBLIC.

  Isso reseta A CADA restart do codespace -- a marcacao do
  devcontainer.json nao e honrada e a visibilidade nao persiste.
  Porta privada responde 302 (redirect de login) e o cliente WASM
  nao manda token nenhum, entao a pagina simplesmente nao abre.

  O script ja tentou abrir sozinho acima. Se falhou, faca na aba
  "Portas": botao direito em cada uma > Visibilidade da porta >
  Public. Deixe a 8081 privada: ela e interna, so o proxy /api
  precisa dela.

  Acompanhe o servidor:
      docker compose -f docker-compose.yml -f docker-compose.codespaces.yml logs -f canary
================================================================
TXT
