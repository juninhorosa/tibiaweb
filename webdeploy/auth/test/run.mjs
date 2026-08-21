import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./loader.mjs", import.meta.url);

process.env.PORT = "18081";
process.env.GAME_HOST = "miniature-happiness-6rjq64rj44rc46j7-8443.app.github.dev";
process.env.GAME_PORT = "443";
process.env.WORLD_NAME = "Ravenhold";

const alvo = process.argv[2];
await import(pathToFileURL(alvo).href);
await new Promise((r) => setTimeout(r, 300));

const chamar = async (rota, corpo) => {
  const r = await fetch("http://127.0.0.1:18081" + rota, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(corpo),
  });
  return { status: r.status, json: await r.json() };
};

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA") + "  " + nome + (ok ? "" : "  -> " + detalhe));
  if (!ok) falhas++;
};

// --- senha errada ----------------------------------------------------------
let r = await chamar("/login", { email: "raventeste", password: "errada", type: "login" });
conferir("senha errada devolve HTTP 200", r.status === 200, "status " + r.status);
conferir("senha errada traz errorCode != 0", r.json.errorCode > 0, JSON.stringify(r.json));

// --- login bom -------------------------------------------------------------
r = await chamar("/login", { email: "raventeste", password: "senha123", stayloggedin: true, type: "login" });
conferir("login bom devolve HTTP 200", r.status === 200, "status " + r.status);
const b = r.json;
conferir("tem session e playdata", !!b.session && !!b.playdata, JSON.stringify(b).slice(0, 200));
conferir("tem characters e worlds", !!b.playdata?.characters && !!b.playdata?.worlds, "");
conferir("sem errorCode", !b.errorCode, String(b.errorCode));

const sk = b.session?.sessionkey || "";
conferir("sessionkey e conta + nova-linha + senha", sk === "raventeste\nsenha123", JSON.stringify(sk));

const w = b.playdata?.worlds?.[0] || {};
conferir("mundo traz externaladdressprotected", w.externaladdressprotected === process.env.GAME_HOST, JSON.stringify(w.externaladdressprotected));
conferir("mundo traz externalportprotected 443", w.externalportprotected === 443, JSON.stringify(w.externalportprotected));

const c = b.playdata?.characters?.[0] || {};
conferir("personagem tem name", c.name === "Guardiao Corvo", JSON.stringify(c.name));
conferir("personagem aponta para worldid 0", c.worldid === 0, JSON.stringify(c.worldid));
conferir("vocacao virou texto", c.vocation === "Knight", JSON.stringify(c.vocation));
conferir("outfitid veio do looktype", c.outfitid === 131, JSON.stringify(c.outfitid));

// --- auto-reparo do email --------------------------------------------------
const { estado } = await import(pathToFileURL(new URL("./stub-mysql2.mjs", import.meta.url).pathname).href).catch(() => ({}));
console.log("\n  session completo:", JSON.stringify(b.session));
console.log("  primeiro personagem:", JSON.stringify(c));

console.log(falhas === 0 ? "\nTUDO PASSOU" : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
