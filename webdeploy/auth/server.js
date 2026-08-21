// API de contas do Ravenhold.
//
// Cria conta e personagem direto no banco do Canary. O personagem NAO e
// montado do zero: a tabela players tem 98 colunas, e um INSERT minimo
// deixaria o char sem equipamento, sem vocacao coerente e em posicao
// invalida. Em vez disso copiamos uma linha-modelo de um dos personagens de
// teste que o CANARY_TEST_ACCOUNTS cria, trocando apenas nome e conta.
import http from "node:http";
import crypto from "node:crypto";
import mysql from "mysql2/promise";

const PORT = Number(process.env.PORT || 8081);
const pool = mysql.createPool({
  host: process.env.DB_HOST || "mariadb",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "canary",
  password: process.env.DB_PASSWORD || "canary",
  database: process.env.DB_NAME || "canary",
  connectionLimit: 5,
  waitForConnections: true,
});

// O Canary guarda a senha como SHA1 em hex.
const hashPassword = (p) => crypto.createHash("sha1").update(p).digest("hex");

const VOCATIONS = {
  sorcerer: 1,
  druid: 2,
  paladin: 3,
  knight: 4,
};

// Regras de nome do Tibia: letras e espacos simples, comeca com maiuscula.
function validateCharacterName(name) {
  if (typeof name !== "string") return "Nome invalido.";
  const n = name.trim();
  if (n.length < 3 || n.length > 25) return "O nome deve ter entre 3 e 25 caracteres.";
  if (!/^[A-Za-z]+(?: [A-Za-z]+)*$/.test(n)) return "Use apenas letras e espacos simples.";
  if (/ {2,}/.test(n)) return "Nao use espacos duplos.";
  return null;
}

function validateAccount(acc) {
  if (typeof acc !== "string") return "Conta invalida.";
  const a = acc.trim();
  if (a.length < 3 || a.length > 32) return "A conta deve ter entre 3 e 32 caracteres.";
  if (!/^[A-Za-z0-9_]+$/.test(a)) return "Use apenas letras, numeros e underscore.";
  return null;
}

function validatePassword(pw) {
  if (typeof pw !== "string") return "Senha invalida.";
  if (pw.length < 6 || pw.length > 64) return "A senha deve ter entre 6 e 64 caracteres.";
  return null;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new Error("payload grande demais");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

// Colunas de players, para montar o INSERT ... SELECT sem depender de
// conhecer o schema inteiro.
let playerColumnsCache = null;
async function playerColumns(conn) {
  if (playerColumnsCache) return playerColumnsCache;
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'players'`
  );
  playerColumnsCache = rows.map((r) => r.COLUMN_NAME).filter((c) => c !== "id");
  return playerColumnsCache;
}

async function register(body) {
  const account = String(body.account || "").trim();
  const password = String(body.password || "");
  const character = String(body.character || "").trim();
  const vocationKey = String(body.vocation || "knight").toLowerCase();

  for (const err of [
    validateAccount(account),
    validatePassword(password),
    validateCharacterName(character),
  ]) {
    if (err) return { code: 400, body: { ok: false, error: err } };
  }

  const vocation = VOCATIONS[vocationKey];
  if (!vocation) {
    return { code: 400, body: { ok: false, error: "Vocacao invalida." } };
  }

  const conn = await pool.getConnection();
  try {
    const [accDup] = await conn.query("SELECT id FROM accounts WHERE name = ?", [account]);
    if (accDup.length) {
      return { code: 409, body: { ok: false, error: "Essa conta ja existe." } };
    }
    const [charDup] = await conn.query("SELECT id FROM players WHERE name = ?", [character]);
    if (charDup.length) {
      return { code: 409, body: { ok: false, error: "Esse nome de personagem ja esta em uso." } };
    }

    // modelo: o personagem de teste de menor nivel naquela vocacao
    const [tpl] = await conn.query(
      "SELECT id, name FROM players WHERE vocation = ? ORDER BY level ASC, id ASC LIMIT 1",
      [vocation]
    );
    if (!tpl.length) {
      return {
        code: 503,
        body: {
          ok: false,
          error: "Nao ha personagem-modelo para essa vocacao no banco. O servidor foi criado sem contas de teste?",
        },
      };
    }

    await conn.beginTransaction();
    const [accIns] = await conn.query(
      `INSERT INTO accounts (name, password, email, type, creation)
       VALUES (?, ?, '', 1, UNIX_TIMESTAMP())`,
      [account, hashPassword(password)]
    );
    const accountId = accIns.insertId;

    const cols = await playerColumns(conn);
    const overrides = {
      name: character,
      account_id: accountId,
      online: 0,
      deletion: 0,
      lastlogin: 0,
      lastip: 0,
    };
    const selectList = cols
      .map((c) => (c in overrides ? "?" : `\`${c}\``))
      .join(", ");
    const params = cols.filter((c) => c in overrides).map((c) => overrides[c]);

    await conn.query(
      `INSERT INTO players (${cols.map((c) => `\`${c}\``).join(", ")})
       SELECT ${selectList} FROM players WHERE id = ?`,
      [...params, tpl[0].id]
    );

    await conn.commit();
    return {
      code: 201,
      body: { ok: true, account, character, vocation: vocationKey, template: tpl[0].name },
    };
  } catch (e) {
    try { await conn.rollback(); } catch {}
    console.error("[register]", e.message);
    return { code: 500, body: { ok: false, error: "Falha ao criar a conta." } };
  } finally {
    conn.release();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      await pool.query("SELECT 1");
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/register") {
      const { code, body } = await register(await readJson(req));
      return send(res, code, body);
    }
    return send(res, 404, { ok: false, error: "rota desconhecida" });
  } catch (e) {
    return send(res, 400, { ok: false, error: e.message });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`auth api :${PORT}`));
