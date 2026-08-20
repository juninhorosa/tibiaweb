// Prova empirica de que WebSocket binario atravessa o encaminhamento de
// portas do Codespaces. A documentacao do GitHub nao afirma isso em lugar
// nenhum, entao nao da para assumir -- e o mesmo teste que fizemos com o
// Cloudflare Tunnel antes de confiar nele.
//
// Rode DENTRO do codespace, com as portas ja publicas:
//   node proxy/test-forward.mjs
import net from "node:net";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import path from "node:path";

const NAME = process.env.CODESPACE_NAME;
const DOMAIN = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
if (!NAME || !DOMAIN) {
  console.error("rode dentro de um codespace");
  process.exit(1);
}

const PROXY_DIR = import.meta.dirname;

// eco TCP em 9999, fazendo o papel do servidor OT
const echo = net.createServer((s) => s.pipe(s));
await new Promise((r) => echo.listen(9999, "127.0.0.1", r));

const proxy = spawn(process.execPath, ["server.js"], {
  cwd: PROXY_DIR,
  env: { ...process.env, PORT: "7171", TARGET_HOST: "127.0.0.1", TARGET_PORT: "9999" },
  stdio: ["ignore", "pipe", "pipe"],
});
proxy.stdout.on("data", (d) => process.stdout.write("[proxy] " + d));

await new Promise((r) => setTimeout(r, 1500));

const URL = `wss://${NAME}-7171.${DOMAIN}:443`;
console.log("conectando em", URL);

// payload no formato de um pacote OT: prefixo de tamanho + binario
const payload = Buffer.from([0x0a, 0x00, 0x14, 0x00, 0xde, 0xad, 0xbe, 0xef, 0xff, 0x00, 0x7f]);

try {
  const ws = new WebSocket(URL);
  const got = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout 25s")), 25000);
    ws.on("open", () => { console.log("ws aberto"); ws.send(payload, { binary: true }); });
    ws.on("message", (m) => { clearTimeout(t); resolve(Buffer.from(m)); });
    ws.on("error", (e) => { clearTimeout(t); reject(e); });
  });
  console.log("enviado :", payload.toString("hex"));
  console.log("recebido:", got.toString("hex"));
  const ok = got.equals(payload);
  console.log(ok ? "RESULTADO: PASSOU" : "RESULTADO: FALHOU (bytes diferentes)");
  ws.close();
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.log("RESULTADO: FALHOU -", e.message);
  console.log("Se deu 401/403, a porta 7171 ainda esta privada na aba Ports.");
  process.exitCode = 1;
} finally {
  proxy.kill();
  echo.close();
}
