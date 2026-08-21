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


// Proxy de mesma origem para o GitHub.
//
// Existe como remedio: o download dos assets vai para codeload.github.com, que
// pode ser barrado pelo nosso proprio Cross-Origin-Embedder-Policy. Servindo
// pela mesma origem, CORS e COEP deixam de ser questao.
//
// Restrito a tres hosts do GitHub de proposito -- nao aceita URL arbitraria,
// que transformaria isto num proxy aberto.
const GH_HOSTS = {
  raw: "https://raw.githubusercontent.com",
  api: "https://api.github.com",
  codeload: "https://codeload.github.com",
};

async function proxyGitHub(req, res, rel) {
  const m = rel.match(/^\/gh\/(raw|api|codeload)\/(.*)$/);
  if (!m) return false;
  const [, key, rest] = m;
  const url = `${GH_HOSTS[key]}/${rest}${new URL(req.url, "http://x").search}`;
  try {
    const up = await fetch(url, { headers: { "user-agent": "ravenhold-proxy" } });
    const buf = Buffer.from(await up.arrayBuffer());
    res.writeHead(up.status, {
      "Content-Type": up.headers.get("content-type") || "application/octet-stream",
      "Content-Length": buf.length,
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`proxy falhou: ${e.message}
`);
  }
  return true;
}


// Proxy para a API de contas, servida pela mesma origem do cliente.
// O cliente WASM faz HTTP.post para /api/... -- mesma origem significa
// nenhuma dor de cabeca com CORS nem com COEP.
//
// /login entra na mesma regra e e o mais importante dos dois: e o login web
// service que o cliente 12+ exige (o Canary nao tem um). Servi-lo da origem
// da pagina evita CORS e evita que o nosso proprio COEP: require-corp barre a
// resposta -- que e o que aconteceria apontando o cliente para outro host.
const AUTH_ORIGIN = process.env.AUTH_ORIGIN || "http://127.0.0.1:8081";

async function proxyAuth(req, res, rel) {
  if (!rel.startsWith("/api/") && rel !== "/login") return false;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    const up = await fetch(AUTH_ORIGIN + rel, {
      method: req.method,
      headers: { "content-type": req.headers["content-type"] || "application/json" },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const buf = Buffer.from(await up.arrayBuffer());
    res.writeHead(up.status, {
      "Content-Type": up.headers.get("content-type") || "application/json",
      "Content-Length": buf.length,
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: `api indisponivel: ${e.message}` }));
  }
  return true;
}

// Diz ao cliente qual e a URL do login web service.
//
// O cliente WASM nao tem como ler window.location -- nada em src/framework
// expoe a origem da pagina para o Lua. Entao quem informa o endereco somos
// nos, e o bundle deixa de carregar o nome do codespace gravado dentro dele.
//
// A ORIGEM do valor importa. O header Host nao serve: o encaminhamento do
// Codespaces o reescreve para "localhost:8080" antes de chegar aqui, e
// responder isso seria PIOR que nao responder nada -- o cliente trocaria o
// endereco correto que veio no bundle por um que nao existe, e o login
// pararia de funcionar. Por isso a ordem e CLIENT_HOST (gerado pelo setup a
// partir do nome do codespace), depois x-forwarded-host, e o Host so no fim,
// ja descartando qualquer variante de localhost.
const CLIENT_VERSION = Number(process.env.CLIENT_VERSION || 1525);
const CLIENT_HOST = process.env.CLIENT_HOST || "";

const ehLocal = (h) => {
  const semPorta = String(h).split(":")[0].toLowerCase();
  return semPorta === "localhost" || semPorta === "127.0.0.1" || semPorta === "[" || semPorta === "";
};

function descobrirHost(req) {
  const encaminhado = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  for (const candidato of [CLIENT_HOST, encaminhado, req.headers.host]) {
    if (candidato && !ehLocal(candidato)) return candidato;
  }
  return null;
}

function serveConfig(req, res, rel) {
  if (rel !== "/api/config") return false;
  const host = descobrirHost(req);
  const body = JSON.stringify({
    ok: true,
    loginUrl: host ? `https://${host}/login` : null,
    clientVersion: CLIENT_VERSION,
  });
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  res.end(body);
  return true;
}

const server = http.createServer(async (req, res) => {
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
  if (serveConfig(req, res, rel)) return;
  if (await proxyAuth(req, res, rel)) return;
  if (await proxyGitHub(req, res, rel)) return;
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
