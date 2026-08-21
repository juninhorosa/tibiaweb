#!/bin/sh
# Baixa o bundle do cliente se ele nao estiver no volume e entao serve.
#
# Fica dentro do container de proposito: assim a peca inteira -- download e
# servico -- volta sozinha depois de cada hibernacao do codespace, sem
# depender de hook nem de alguem digitar comando.
set -eu

WASM="${CLIENT_DIR}/otclient.wasm"

if [ ! -f "${WASM}" ]; then
  if [ -z "${GITHUB_TOKEN:-}" ]; then
    echo "sem GITHUB_TOKEN: nao da para baixar o bundle; servindo o que houver"
  else
    echo "==> bundle ausente, baixando o ultimo build que passou"
    RUN_ID=$(curl -s -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/build-web.yml/runs?status=success&per_page=1" \
      | grep -oE '"id": ?[0-9]+' | head -1 | grep -oE '[0-9]+' || true)
    if [ -n "${RUN_ID}" ]; then
      # a API responde '"id": 123' COM espaco depois do dois-pontos
      ART=$(curl -s -H "Authorization: Bearer ${GITHUB_TOKEN}" \
        "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/runs/${RUN_ID}/artifacts" \
        | grep -oE '"id": ?[0-9]+' | head -1 | grep -oE '[0-9]+' || true)
      if [ -n "${ART}" ]; then
        mkdir -p /client
        curl -sL -H "Authorization: Bearer ${GITHUB_TOKEN}" \
          "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/artifacts/${ART}/zip" -o /tmp/web.zip
        unzip -o -q /tmp/web.zip -d /client
        echo "    bundle do build ${RUN_ID} instalado"
      else
        echo "    nenhum artefato no build ${RUN_ID} (expirou? retention e 14 dias)"
      fi
    else
      echo "    nenhum build concluido com sucesso encontrado"
    fi
  fi
fi

exec node /app/serve.mjs
