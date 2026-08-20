// Gera o config.lua do servidor a partir do nome do codespace.
//
// O Codespaces publica cada porta encaminhada como um hostname proprio
// (<nome>-<porta>.app.github.dev), sempre na 443. Como o cliente monta
// wss://<host>:<porta> literalmente, o gameProtocolPort precisa ser 443 --
// esse valor e o que ele usa na segunda conexao.
import fs from "node:fs";
import path from "node:path";

const NAME = process.env.CODESPACE_NAME;
const DOMAIN = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;

if (!NAME || !DOMAIN) {
  console.error("Isto precisa rodar DENTRO de um codespace.");
  console.error("CODESPACE_NAME e GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN nao estao definidos.");
  process.exit(1);
}

const loginHost = `${NAME}-7171.${DOMAIN}`;
const gameHost = `${NAME}-8443.${DOMAIN}`;
const PUBLIC_PORT = 443;

const configLua = `-- gerado por webdeploy/codespaces/setup.mjs
-- hostname derivado do nome do codespace: estavel entre restarts.

ip = "${gameHost}"
loginProtocolPort = 7171
gameProtocolPort = ${PUBLIC_PORT}
statusProtocolPort = 7171

mysqlHost = "mariadb"
mysqlUser = "canary"
mysqlPass = "canary"
mysqlDatabase = "canary"
mysqlPort = 3306
`;

const ROOT = path.join(import.meta.dirname, "..");
fs.writeFileSync(path.join(ROOT, "server", "config.lua"), configLua);
fs.writeFileSync(
  path.join(import.meta.dirname, "endpoints.json"),
  JSON.stringify({ login: loginHost, game: gameHost, port: PUBLIC_PORT }, null, 2)
);

console.log(`
================================================================
  Gerado: webdeploy/server/config.lua

  Na tela de login do cliente web:

      servidor : ${loginHost}
      porta    : ${PUBLIC_PORT}

  Mundo do jogo anunciado como ${gameHost}:${PUBLIC_PORT}

  IMPORTANTE: as duas portas precisam estar com visibilidade
  PUBLIC na aba Ports. O devcontainer.json ja pede isso, mas
  confira -- porta privada exige token no header, e o cliente
  WASM nao manda nenhum.

  Suba o servidor:

      docker compose -f docker-compose.yml -f docker-compose.codespaces.yml up -d
================================================================
`);
