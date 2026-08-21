// Banco falso: so o suficiente para exercitar /login e /register.
import crypto from "node:crypto";
const sha1 = (p) => crypto.createHash("sha1").update(p).digest("hex");

export const estado = {
  contas: [
    { id: 7, name: "raventeste", email: "", password: sha1("senha123"), premdays: 0, lastday: 0 },
  ],
  jogadores: [
    { id: 42, account_id: 7, name: "Guardiao Corvo", level: 8, vocation: 4,
      looktype: 131, lookhead: 78, lookbody: 88, looklegs: 3, lookaddons: 0, deletion: 0 },
  ],
  updates: [],
};

function responder(sql, params) {
  const s = sql.replace(/\s+/g, " ").trim();
  if (s.startsWith("SELECT id, name, email, password")) {
    const d = params[0];
    return [estado.contas.filter((c) => c.email === d || c.name === d)];
  }
  if (s.startsWith("UPDATE accounts SET email")) {
    estado.updates.push(params);
    const c = estado.contas.find((x) => x.id === params[1]);
    if (c) c.email = params[0];
    return [{ affectedRows: 1 }];
  }
  if (s.startsWith("SELECT name, level, vocation")) {
    return [estado.jogadores.filter((p) => p.account_id === params[0] && p.deletion === 0)];
  }
  if (s.startsWith("SELECT 1")) return [[{ 1: 1 }]];
  throw new Error("consulta nao prevista no stub: " + s.slice(0, 70));
}

const conexao = {
  async query(sql, params = []) { return responder(sql, params); },
  release() {},
  async beginTransaction() {}, async commit() {}, async rollback() {},
};

export function createPool() {
  return { async getConnection() { return conexao; }, async query(s, p) { return responder(s, p); } };
}
export default { createPool };
