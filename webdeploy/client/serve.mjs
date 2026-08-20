// Servidor estatico para o bundle WASM.
//
// Existe por causa de uma restricao dura: o bundle usa pthreads, que dependem
// de SharedArrayBuffer, que o navegador so libera sob cross-origin isolation.
// Sem os dois headers abaixo a pagina nem inicia. E por isso que GitHub Pages
// nao serve para hospedar isto -- ele nao permite headers customizados.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.env.CLIENT_DIR || "/workspaces/client-build/build-emscripten-web";
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".json": "application/json",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const send = (code, body, extra = {}) => {
    res.writeHead(code, {
      // sem estes dois, crossOriginIsolated === false e o wasm nao sobe
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
      ...extra,
    });
    if (body && body.pipe) body.pipe(res);
    else res.end(body);
  };

  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel === "/") rel = "/otclient.html";

  // impede escapar da raiz via ../
  const file = path.join(ROOT, rel);
  if (!file.startsWith(path.resolve(ROOT))) return send(403, "forbidden");

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(404, `nao encontrado: ${rel}\n`);
    send(200, fs.createReadStream(file), {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Content-Length": st.size,
    });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`cliente servido em :${PORT}  (raiz: ${ROOT})`);
  if (!fs.existsSync(ROOT)) {
    console.log(`AVISO: ${ROOT} nao existe -- baixe o artefato do build antes.`);
  }
});
