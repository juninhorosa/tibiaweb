// Ponte WebSocket <-> TCP para o OTClient WASM.
// O navegador nao abre socket TCP cru; o cliente web monta a URL
// wss://<host>:<porta> (ver src/framework/net/webconnection.cpp).
// Este processo aceita a conexao WebSocket e repassa byte a byte
// para o servidor OT em TCP.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import net from "node:net";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 7171);
const TARGET_HOST = process.env.TARGET_HOST || "127.0.0.1";
const TARGET_PORT = Number(process.env.TARGET_PORT || 7171);
const CERT_PATH = process.env.CERT_PATH;
const KEY_PATH = process.env.KEY_PATH;

const handler = (req, res) => {
  // healthcheck; tambem serve para aceitar cert self-signed no navegador
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("otclient ws-proxy ok\n");
};

// O cliente WASM em Release monta sempre wss://. Se CERT_PATH/KEY_PATH
// existirem, terminamos TLS aqui. Em plataformas que ja fazem TLS na borda
// (Fly.io, Railway, Cloudflare Tunnel), rode sem cert.
const useTls = Boolean(CERT_PATH && KEY_PATH);
const httpServer = useTls
  ? https.createServer(
      { cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) },
      handler
    )
  : http.createServer(handler);

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  const peer = req.socket.remoteAddress;
  const tcp = net.createConnection({ host: TARGET_HOST, port: TARGET_PORT });
  tcp.setNoDelay(true);

  // Bytes que chegarem antes do TCP abrir ficam na fila.
  const pending = [];
  let open = false;
  let done = false;

  tcp.on("connect", () => {
    open = true;
    for (const chunk of pending) tcp.write(chunk);
    pending.length = 0;
    console.log(`[+] ${peer} -> ${TARGET_HOST}:${TARGET_PORT}`);
  });

  tcp.on("data", (data) => {
    if (ws.readyState === ws.OPEN) ws.send(data, { binary: true });
  });

  ws.on("message", (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (open) tcp.write(buf);
    else pending.push(buf);
  });

  const shutdown = (why) => {
    if (done) return;
    done = true;
    console.log(`[-] ${peer} encerrado (${why})`);
    tcp.destroy();
    if (ws.readyState === ws.OPEN) ws.close();
  };

  tcp.on("error", (e) => shutdown(`tcp: ${e.message}`));
  tcp.on("close", () => shutdown("tcp fechou"));
  ws.on("error", (e) => shutdown(`ws: ${e.message}`));
  ws.on("close", () => shutdown("ws fechou"));
});

httpServer.listen(PORT, "0.0.0.0", () => {
  const scheme = useTls ? "wss" : "ws";
  console.log(`ws-proxy ${scheme}://0.0.0.0:${PORT}  ->  ${TARGET_HOST}:${TARGET_PORT}`);
});
