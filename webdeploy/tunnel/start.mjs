// Sobe dois Cloudflare Quick Tunnels e gera o config.lua do servidor.
//
// Por que dois: o OTClient abre duas conexoes. A primeira vai para o login
// server, no host:porta que voce digita na tela. O login responde com o
// endereco do mundo, e o cliente abre a segunda conexao para
// wss://<esse endereco>:<essa porta>.
//
// Quick tunnel nao precisa de conta nem dominio, mas o hostname e sorteado
// a cada execucao -- por isso o config.lua e gerado aqui, depois que os
// tuneis sobem, e nao antes.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, "..");

// porta local -> rotulo. O cloudflared publica cada uma em https/443.
const ENDPOINTS = [
  { name: "login", localPort: 7171 },
  { name: "game", localPort: 8443 },
];

const children = [];

function startTunnel({ name, localPort }) {
  return new Promise((resolve, reject) => {
    const cf = spawn(
      "cloudflared",
      ["tunnel", "--url", `http://localhost:${localPort}`, "--no-autoupdate"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    children.push(cf);

    const timer = setTimeout(
      () => reject(new Error(`${name}: tunel nao respondeu em 60s`)),
      60000
    );

    let settled = false;
    const scan = (chunk) => {
      const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        const host = m[0].replace("https://", "");
        console.log(`  ${name.padEnd(5)} -> ${host}`);
        resolve({ name, host, localPort });
      }
    };

    // o cloudflared imprime a URL no stderr
    cf.stderr.on("data", scan);
    cf.stdout.on("data", scan);
    cf.on("error", reject);
    cf.on("exit", (code) => {
      if (!settled) reject(new Error(`${name}: cloudflared saiu com ${code}`));
    });
  });
}

console.log("subindo tuneis...");
const results = await Promise.all(ENDPOINTS.map(startTunnel));
const login = results.find((r) => r.name === "login");
const game = results.find((r) => r.name === "game");

// Cloudflare publica tudo em 443. O CANARY_GAME_PORT precisa ser 443 porque
// esse valor e o que o cliente usa literalmente na segunda conexao.
const PUBLIC_PORT = 443;

fs.writeFileSync(path.join(ROOT, ".env"), `GAME_HOST=${game.host}
`);
fs.writeFileSync(
  path.join(HERE, "endpoints.json"),
  JSON.stringify({ login: login.host, game: game.host, port: PUBLIC_PORT }, null, 2)
);

console.log(`
================================================================
  Tuneis no ar. Gerado: webdeploy/.env

  Na tela de login do cliente web, digite:

      servidor : ${login.host}
      porta    : ${PUBLIC_PORT}

  O mundo do jogo sera anunciado como ${game.host}:${PUBLIC_PORT}.

  Suba o servidor em outro terminal:

      docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d

  Lembre: o cliente precisa de client version > 1010 para aceitar
  hostname no lugar de IP (protocollogin.lua:206).

  Ctrl+C encerra os tuneis.
================================================================
`);

const stop = () => {
  console.log("\nencerrando tuneis...");
  for (const c of children) c.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
