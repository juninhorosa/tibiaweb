#!/usr/bin/env bash
# Sobe tudo dentro de um GitHub Codespace: cliente web + servidor OT + pontes.
#
#   bash webdeploy/start-codespace.sh
#
set -euo pipefail
cd "$(dirname "$0")"

CLIENT_DIR="/workspaces/client-build/build-emscripten-web"
PUBLIC_PORTS="7171 7172 8080"   # a 8081 fica privada: so o proxy /api a alcanca

if [ -z "${CODESPACE_NAME:-}" ]; then
  echo "Isto precisa rodar dentro de um codespace." >&2
  exit 1
fi

DOMAIN="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"

# ---------------------------------------------------------------------------
# 0. gh -- so serve para publicar as portas no fim. Fica com timeout e nunca
#    derruba o script: rodando dentro do postStartCommand, um apt-get travado
#    esperando entrada segurava tudo e os servicos nunca subiam.
# ---------------------------------------------------------------------------
instalar_gh() {
  command -v gh >/dev/null 2>&1 && return 0
  echo "==> instalando o gh (com timeout)"
  timeout 60 bash -c '
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null
    echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
    sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gh >/dev/null 2>&1
  ' >/dev/null 2>&1 || echo "    gh nao instalado; publique as portas na aba Portas"
  return 0
}

# ---------------------------------------------------------------------------
# 1. bundle do cliente (baixa uma vez; o disco do codespace persiste)
# ---------------------------------------------------------------------------
if [ ! -f "${CLIENT_DIR}/otclient.wasm" ]; then
  # sem RUN_ID explicito, pega o ultimo build que passou
  RUN_ID="${RUN_ID:-$(curl -s -H "Authorization: Bearer ${GITHUB_TOKEN}" "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/build-web.yml/runs?status=success&per_page=1" | grep -oE '"id": ?[0-9]+' | head -1 | grep -oE '[0-9]+')}"
  if [ -z "${RUN_ID}" ]; then
    echo "Nenhum build concluido com sucesso encontrado." >&2
    exit 1
  fi
  echo "==> baixando o bundle do cliente (build ${RUN_ID})"
  # a API responde '"id": 123' COM espaco depois do dois-pontos --
  # um padrao sem o espaco opcional nunca casa e ART sai vazio
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

# ---------------------------------------------------------------------------
# 2. .env com o hostname publico do mundo do jogo
# ---------------------------------------------------------------------------
echo "==> gerando .env"
node codespaces/setup.mjs > /dev/null

# ---------------------------------------------------------------------------
# 3. servidor OT + pontes WebSocket/TCP + API de contas
# ---------------------------------------------------------------------------
echo "==> subindo servidor (a primeira vez baixa o mapa; leva alguns minutos)"
docker compose -f docker-compose.yml -f docker-compose.codespaces.yml up -d

# O cliente estatico agora e um container (servico "client" no compose), com
# restart: unless-stopped como os demais. Antes era um "nohup node ... &"
# solto, e era justamente a peca que sumia a cada hibernacao.

# ---------------------------------------------------------------------------
# 5. publicar as portas
#
# A visibilidade fica presa ao ENCAMINHAMENTO, nao a porta. Quando um processo
# novo passa a escutar, o encaminhamento e recriado -- e nasce privado. Por
# isso isto roda depois dos servicos subirem, e por isso esperamos cada porta
# responder antes de publicar: pedir visibilidade para um encaminhamento que
# ainda nao existe e aceito pelo gh sem efeito nenhum.
#
# E mesmo assim conferimos de fora. Uma automacao que mente e pior que
# nenhuma: da a entender que esta tudo certo, e o 401 so aparece depois,
# numa tela em branco.
# ---------------------------------------------------------------------------
wait_listening() {
  local port="$1" i
  for i in $(seq 1 30); do
    if curl -sS -o /dev/null --max-time 2 "http://127.0.0.1:${port}/" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

is_public() {
  local port="$1" code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    "https://${CODESPACE_NAME}-${port}.${DOMAIN}/" 2>/dev/null || echo 000)
  # privada devolve 302 (redirect de login) ou 401; publica devolve 200
  [ "${code}" = "200" ]
}

instalar_gh
echo "==> publicando as portas"
PENDENTES=""
for p in ${PUBLIC_PORTS}; do
  if ! wait_listening "${p}"; then
    echo "    ${p}: nada escutando -- o servico nao subiu"
    PENDENTES="${PENDENTES} ${p}"
    continue
  fi
  if command -v gh >/dev/null 2>&1; then
    gh codespace ports visibility "${p}:public" -c "${CODESPACE_NAME}" >/dev/null 2>&1 || true
  fi
  if is_public "${p}"; then
    echo "    ${p}: publica"
  else
    echo "    ${p}: AINDA PRIVADA"
    PENDENTES="${PENDENTES} ${p}"
  fi
done

cat <<TXT

================================================================
  Abra o cliente:

      https://${CODESPACE_NAME}-8080.${DOMAIN}

  Servidor, porta e protocolo ja vao fixos na tela de login.
  Crie a conta pelo botao "Criar conta".

  Dica: no seletor de idioma, clique DUAS vezes na bandeira --
  o canvas do cliente costuma ignorar o clique simples.

  Acompanhe o servidor:
      docker compose -f docker-compose.yml -f docker-compose.codespaces.yml logs -f canary
TXT

if [ -n "${PENDENTES}" ]; then
  cat <<TXT

  !! PORTAS AINDA PRIVADAS:${PENDENTES}

  Abra na aba "Portas": botao direito em cada uma > Visibilidade
  da porta > Public. Sem isso a pagina responde 401 e nao carrega.
  A 8081 deve continuar privada.
TXT
fi

echo "================================================================"
