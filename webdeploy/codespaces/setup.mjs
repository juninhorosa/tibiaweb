// Gera o .env do compose a partir do nome do codespace.
//
// O Codespaces publica cada porta encaminhada como um hostname proprio
// (<nome>-<porta>.app.github.dev), sempre na 443. Como o cliente monta
// wss://<host>:<porta> literalmente, o CANARY_GAME_PORT precisa ser 443 --
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
const gameHost = `${NAME}-7172.${DOMAIN}`;
const PUBLIC_PORT = 443;

const ROOT = path.join(import.meta.dirname, "..");
fs.writeFileSync(path.join(ROOT, ".env"), `GAME_HOST=${gameHost}\n`);
fs.writeFileSync(
  path.join(import.meta.dirname, "endpoints.json"),
  JSON.stringify({ login: loginHost, game: gameHost, port: PUBLIC_PORT }, null, 2)
);

console.log(`
================================================================
  Gerado: webdeploy/.env  (GAME_HOST=${gameHost})

  Na tela de login do cliente web:

      servidor : ${loginHost}
      porta    : ${PUBLIC_PORT}

  ATENCAO: as duas portas precisam estar com visibilidade PUBLIC
  na aba Ports. O devcontainer.json pede isso, mas o GitHub NAO
  honra a marcacao automaticamente -- e preciso clicar. Porta
  privada responde 302 (redirect para login), e o cliente WASM
  nao manda token nenhum.

  Suba o servidor:

      docker compose -f docker-compose.yml -f docker-compose.codespaces.yml up -d
================================================================
`);
