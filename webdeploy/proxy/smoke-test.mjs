import net from "node:net";
import { WebSocket } from "ws";
import { spawn } from "node:child_process";

// servidor TCP de eco, simulando o OT server
const echo = net.createServer((s) => s.pipe(s));
await new Promise((r) => echo.listen(9999, "127.0.0.1", r));

const proxy = spawn(process.execPath, ["server.js"], {
  cwd: import.meta.dirname,
  env: { ...process.env, PORT: "9998", TARGET_HOST: "127.0.0.1", TARGET_PORT: "9999" },
  stdio: ["ignore", "pipe", "pipe"],
});
proxy.stdout.on("data", (d) => process.stdout.write("[proxy] " + d));

await new Promise((r) => setTimeout(r, 800));

const ws = new WebSocket("ws://127.0.0.1:9998");
const payload = Buffer.from([0x0a, 0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);

const result = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("timeout")), 5000);
  ws.on("open", () => ws.send(payload, { binary: true }));
  ws.on("message", (m) => { clearTimeout(t); resolve(Buffer.from(m)); });
  ws.on("error", reject);
});

const ok = result.equals(payload);
console.log("enviado :", payload.toString("hex"));
console.log("recebido:", result.toString("hex"));
console.log(ok ? "RESULTADO: PASSOU" : "RESULTADO: FALHOU");
ws.close(); proxy.kill(); echo.close();
process.exit(ok ? 0 : 1);
