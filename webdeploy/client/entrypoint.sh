#!/bin/sh
# Baixa o bundle do cliente e o mantem atualizado, depois serve.
#
# Fica dentro do container de proposito: assim a peca inteira -- download e
# servico -- volta sozinha depois de cada hibernacao do codespace, sem
# depender de hook nem de alguem digitar comando.
#
# Guarda o id do build baixado num marcador e compara com o ultimo build que
# passou. Sem isso, um bundle recem-compilado nunca chegava ao ar: a
# verificacao antiga so olhava se o arquivo existia.
set -eu

WASM="${CLIENT_DIR}/otclient.wasm"
MARCADOR="/client/.build-id"

baixar() {
  run_id="$1"
  ART=$(curl -s -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/artifacts" \
    | grep -oE '"id": ?[0-9]+' | head -1 | grep -oE '[0-9]+' || true)
  if [ -z "${ART}" ]; then
    echo "    build ${run_id} sem artefato (expirou? retention e 14 dias)"
    return 1
  fi
  mkdir -p /client
  curl -sL -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/artifacts/${ART}/zip" -o /tmp/web.zip
  unzip -o -q /tmp/web.zip -d /client
  echo "${run_id}" > "${MARCADOR}"
  echo "    bundle do build ${run_id} instalado"
  return 0
}

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "sem GITHUB_TOKEN: servindo o bundle que houver"
else
  ULTIMO=$(curl -s -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/build-web.yml/runs?status=success&per_page=1" \
    | grep -oE '"id": ?[0-9]+' | head -1 | grep -oE '[0-9]+' || true)
  ATUAL=$(cat "${MARCADOR}" 2>/dev/null || echo "")

  if [ -z "${ULTIMO}" ]; then
    echo "nao consegui consultar os builds; servindo o bundle que houver"
  elif [ ! -f "${WASM}" ]; then
    echo "==> bundle ausente, baixando build ${ULTIMO}"
    baixar "${ULTIMO}" || true
  elif [ "${ULTIMO}" != "${ATUAL}" ]; then
    echo "==> build novo (${ATUAL:-desconhecido} -> ${ULTIMO}), atualizando"
    baixar "${ULTIMO}" || true
  else
    echo "==> bundle ja esta no build ${ATUAL}"
  fi
fi

exec node /app/serve.mjs
