// API de contas do Ravenhold -- e o login web service do jogo.
//
// O Canary NAO aceita login de protocolo moderno na porta TCP 7171: em
// protocollogin.cpp o ramo `else if (!oldProtocol)` desconecta sempre. Cliente
// 12+ tem de autenticar por HTTP, como faz o cliente oficial -- e o Canary nao
// embute esse servico. Ele mora aqui.
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

// O cliente mostra este texto na lista de personagens.
const VOCATION_NAMES = {
  0: "None",
  1: "Sorcerer",
  2: "Druid",
  3: "Paladin",
  4: "Knight",
  5: "Master Sorcerer",
  6: "Elder Druid",
  7: "Royal Paladin",
  8: "Elite Knight",
};

// Endereco do mundo. Vai na resposta do login: e por ele que o cliente abre a
// segunda conexao (wss://<endereco>:<porta>), nao pelo que foi digitado na
// tela. Por isso o host do login pode ser a origem da pagina e o do mundo,
// outro -- sao coisas separadas.
const GAME_HOST = process.env.GAME_HOST || "127.0.0.1";
const GAME_PORT = Number(process.env.GAME_PORT || 443);
const WORLD_NAME = process.env.WORLD_NAME || "Ravenhold";

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
    // email recebe o proprio nome da conta de proposito. No protocolo
    // moderno o Canary procura a conta pela coluna `email`
    // (account_repository_db.cpp:34), nao por `name`. Gravando o mesmo valor
    // nas duas, a pessoa entra com "raventeste" e o servidor encontra --
    // sem precisar pedir um e-mail de verdade que nao seria usado para nada.
    const [accIns] = await conn.query(
      `INSERT INTO accounts (name, password, email, type, creation)
       VALUES (?, ?, ?, 1, UNIX_TIMESTAMP())`,
      [account, hashPassword(password), account]
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


// ---------------------------------------------------------------------------
// Login web service (o que o cliente 12+ chama no lugar do login TCP)
//
// Contrato lido do proprio cliente:
//   pedido   src/framework/net/httplogin.cpp:305 -- {email,password,stayloggedin,type}
//   erro     httplogin.cpp:475 -- HTTP 200 com errorCode != 0 e errorMessage
//   sucesso  httplogin.cpp:482 -- precisa de "session" e "playdata"
//   campos   modules/client_entergame/entergame.lua:723 em diante
// ---------------------------------------------------------------------------

// Erro do login web service: vai com HTTP 200 de proposito. O cliente so olha
// dentro do corpo quando o status e 200 (httplogin.cpp:346); com 401 ele
// descarta o JSON e mostra "HTTP 401", escondendo a razao real.
const loginError = (mensagem, codigo = 3) => ({
  code: 200,
  body: { errorCode: codigo, errorMessage: mensagem },
});

async function loginWebService(body) {
  const descriptor = String(body.email || body.accountname || "").trim();
  const password = String(body.password || "");

  if (!descriptor || !password) {
    return loginError("Informe conta e senha.");
  }

  const conn = await pool.getConnection();
  try {
    const [accs] = await conn.query(
      "SELECT id, name, email, password, premdays, lastday FROM accounts WHERE email = ? OR name = ? LIMIT 1",
      [descriptor, descriptor]
    );
    if (!accs.length || accs[0].password !== hashPassword(password)) {
      // mesma mensagem para conta inexistente e senha errada: dizer qual dos
      // dois falhou entrega quais contas existem
      return loginError("Conta ou senha incorreta.");
    }
    const acc = accs[0];

    const [chars] = await conn.query(
      `SELECT name, level, vocation, looktype, lookhead, lookbody, looklegs, lookaddons
       FROM players WHERE account_id = ? AND deletion = 0 ORDER BY level DESC, name ASC`,
      [acc.id]
    );

    // O Canary reabre a conta a partir desta string no login do mundo
    // (protocolgame.cpp:1291 corta no primeiro caractere de nova linha) e
    // procura pela coluna `email`. Mandar acc.name aqui daria "conta nao
    // encontrada" mesmo com a senha certa. Com authType = "password" (o
    // padrao) a senha em claro dentro da sessao e o que o servidor confere.
    //
    // Contas criadas antes de o cadastro passar a gravar `email` ficaram com
    // a coluna vazia. Elas entram aqui (a busca aceita `name`), mas
    // quebrariam no login do mundo, onde so `email` e consultado. Preenchemos
    // na primeira vez que a conta loga -- e o unico momento em que sabemos
    // que a senha confere.
    let descritorCanary = acc.email;
    if (!descritorCanary) {
      await conn.query("UPDATE accounts SET email = ? WHERE id = ?", [acc.name, acc.id]);
      descritorCanary = acc.name;
      console.log(`[login] conta ${acc.name} estava sem email; preenchido`);
    }

    const premiumUntil = Number(acc.premdays) > 0
      ? Math.floor(Date.now() / 1000) + Number(acc.premdays) * 86400
      : 0;

    return {
      code: 200,
      body: {
        session: {
          sessionkey: descritorCanary + "\n" + password,
          lastlogintime: Number(acc.lastday || 0),
          ispremium: premiumUntil > 0,
          premiumuntil: premiumUntil,
          status: "active",
          returnernotification: false,
          showrewardnews: false,
          isreturner: false,
          fpstracking: false,
          optiontracking: false,
          tournamentticketpurchasestate: 0,
          emailcoderequest: false,
        },
        playdata: {
          worlds: [
            {
              id: 0,
              name: WORLD_NAME,
              externaladdress: GAME_HOST,
              externalport: GAME_PORT,
              externaladdressprotected: GAME_HOST,
              externalportprotected: GAME_PORT,
              externaladdressunprotected: GAME_HOST,
              externalportunprotected: GAME_PORT,
              previewstate: 0,
              location: "BRA",
              anticheatprotection: false,
              pvptype: 0,
              istournamentworld: false,
              restrictedstore: false,
              currenttournamentphase: 2,
            },
          ],
          characters: chars.map((c, i) => ({
            worldid: 0,
            name: c.name,
            level: Number(c.level || 1),
            vocation: VOCATION_NAMES[Number(c.vocation)] || "None",
            ismaincharacter: i === 0,
            dailyrewardstate: 0,
            ishidden: false,
            ismale: true,
            tutorial: false,
            outfitid: Number(c.looktype || 128),
            headcolor: Number(c.lookhead || 0),
            torsocolor: Number(c.lookbody || 0),
            legscolor: Number(c.looklegs || 0),
            detailcolor: Number(c.lookaddons || 0),
            addonsflags: Number(c.lookaddons || 0),
          })),
        },
      },
    };
  } catch (e) {
    console.error("[login]", e.message);
    return loginError("Falha no servidor de login.", 2);
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
    // /login e o caminho que o cliente chama; /api/login existe so para
    // testar da linha de comando sem passar pelo proxy do servidor estatico.
    if (req.method === "POST" && (url.pathname === "/login" || url.pathname === "/api/login")) {
      const { code, body } = await loginWebService(await readJson(req));
      return send(res, code, body);
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
