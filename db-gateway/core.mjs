/**
 * API Test Studio — database gateway core
 * ----------------------------------------
 * A browser can't open a database connection, and shouldn't hold one open if
 * it could. This module is the small piece that can: it takes a connection
 * the user typed into the app, runs ONE read-only operation, and returns
 * plain JSON. It is shared by both places the gateway runs:
 *
 *   - db-gateway/server.mjs   on the user's own computer (reaches VPN/private DBs)
 *   - worker/worker.js        on Cloudflare (reaches internet-facing DBs)
 *
 * Each runtime passes in the drivers it can load (see `createGateway`), so the
 * rules below — what counts as read-only, how tables are previewed, how errors
 * are worded — are written once.
 *
 * Operations (all POST, JSON in / JSON out):
 *   test     {connection}                          -> {ok, type, version, readOnly}
 *   schema   {connection}                          -> {tables:[{schema, name, columns:[{name,type}]}]}
 *   preview  {connection, table, schema?, where?, limit?} -> {columns, rows, rowCount, truncated, ms}
 *   query    {connection, query, limit?}           -> {columns, rows, rowCount, truncated, ms}
 *
 * `connection` is {type, url}: type is postgres | mysql | mongodb | mssql and
 * url is that database's usual connection string. Nothing here stores or logs
 * it; it lives for the length of one request.
 *
 * Read-only is enforced three ways, because "view access" must mean it:
 *   1. SQL must be a single SELECT/WITH/SHOW/EXPLAIN/DESCRIBE statement with
 *      no data-changing keyword anywhere outside string literals.
 *   2. PostgreSQL and MySQL run it inside a READ ONLY transaction; SQL Server
 *      runs it inside a transaction that is always rolled back.
 *   3. MongoDB allows find/aggregate only, and refuses $out/$merge stages.
 * A database user with read-only grants is still the best guarantee; the app
 * says so when connecting.
 */

export const DB_TYPES = {
  postgres: "PostgreSQL",
  mysql: "MySQL / MariaDB",
  mongodb: "MongoDB",
  mssql: "SQL Server",
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const TIMEOUT_MS = 15000;

export class GatewayError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/* ---------------------------------------------------------------------------
 * Read-only SQL guard
 * ------------------------------------------------------------------------- */
const ALLOWED_FIRST = new Set(["select", "with", "show", "explain", "describe", "desc", "values", "table"]);
/* REPLACE() and friends are ordinary SELECT functions, so they're not here;
   MySQL's REPLACE INTO is still stopped by the read-only transaction. */
const WRITE_WORDS = /\b(insert|update|delete|merge|upsert|drop|alter|create|truncate|rename|grant|revoke|copy|call|exec|execute|lock|vacuum|reindex|cluster|set|reset|load|handler|install|uninstall|attach|detach|into|outfile|dumpfile|pg_sleep|sleep|benchmark|waitfor|dblink|lo_import|lo_export|pg_read_file|pg_write_file|xp_cmdshell|sp_executesql|openrowset|opendatasource|bulk)\b/i;

/* Blank out string literals, quoted identifiers and comments so a keyword
   inside 'quotes' doesn't trip the guard and one inside a comment can't hide. */
function stripSql(sql) {
  return String(sql)
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`(?:[^`]|``)*`/g, "``")
    .replace(/\[(?:[^\]])*\]/g, "[]")
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''");
}

export function assertReadOnlySql(sql) {
  const raw = String(sql || "").trim();
  if (!raw) throw new GatewayError("Type a query first.");
  if (raw.length > 20000) throw new GatewayError("That query is too long (20,000 characters at most).");
  const s = stripSql(raw).trim().replace(/;\s*$/, "");
  if (s.includes(";")) throw new GatewayError("Run one query at a time — remove the extra “;”.");
  const first = (s.match(/^[\s(]*([A-Za-z]+)/) || [])[1];
  if (!first || !ALLOWED_FIRST.has(first.toLowerCase())) {
    throw new GatewayError("Only look-up queries are allowed here (SELECT, WITH, SHOW, EXPLAIN, DESCRIBE). This connection can't change data.");
  }
  const bad = s.match(WRITE_WORDS);
  if (bad) throw new GatewayError(`“${bad[1].toUpperCase()}” isn't allowed — this connection is read-only.`);
  return raw.replace(/;\s*$/, "");
}

/* ---------------------------------------------------------------------------
 * MongoDB guard. A query is JSON:
 *   {"collection":"users","filter":{"age":{"$gt":20}},"projection":{},"sort":{}}
 *   {"collection":"users","pipeline":[{"$match":{...}}]}
 * ------------------------------------------------------------------------- */
export function parseMongoQuery(q) {
  let o = q;
  if (typeof q === "string") {
    try { o = JSON.parse(q); } catch (e) {
      throw new GatewayError('MongoDB queries are JSON, like {"collection":"users","filter":{"name":"Ana"}}');
    }
  }
  if (!o || typeof o !== "object" || !o.collection) throw new GatewayError('Say which collection, like {"collection":"users"}');
  const banned = JSON.stringify(o).match(/"\$(out|merge|function|accumulator|where)"/);
  if (banned) throw new GatewayError(`“$${banned[1]}” isn't allowed — this connection is read-only.`);
  if (o.pipeline && !Array.isArray(o.pipeline)) throw new GatewayError("“pipeline” must be a list of stages.");
  return o;
}

/* ---------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------- */
function clampLimit(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(x), MAX_LIMIT);
}
function validIdent(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 128 && !/[\u0000]/.test(name);
}
function quoteIdent(type, name) {
  if (type === "mysql") return "`" + name.replace(/`/g, "``") + "`";
  if (type === "mssql") return "[" + name.replace(/]/g, "]]") + "]";
  return '"' + name.replace(/"/g, '""') + '"';
}
/* JSON can't carry BigInt, Buffer or Date as-is; make every value printable. */
function plain(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString();
  if (typeof Buffer !== "undefined" && Buffer.isBuffer && Buffer.isBuffer(v)) return `<${v.length} bytes>`;
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  if (typeof v === "object") {
    if (v._bsontype === "ObjectId" || v._bsontype === "ObjectID") return String(v);
    if (typeof v.toHexString === "function") return v.toHexString();
    if (Array.isArray(v)) return v.map(plain);
    const o = {};
    for (const k of Object.keys(v)) o[k] = plain(v[k]);
    return o;
  }
  return v;
}
function shape(rows, columns, limit, started) {
  const truncated = rows.length > limit;
  const kept = rows.slice(0, limit).map(r => {
    const o = {};
    for (const k of Object.keys(r)) o[k] = plain(r[k]);
    return o;
  });
  const cols = columns && columns.length ? columns
    : [...new Set(kept.flatMap(r => Object.keys(r)))];
  return { columns: cols, rows: kept, rowCount: kept.length, truncated, ms: Date.now() - started };
}

/* Turn driver errors into something a newcomer can act on. Never echoes the
   connection string. */
export function friendlyError(e, conn) {
  if (e instanceof GatewayError) return e;
  const code = e && (e.code || (e.cause && e.cause.code)) || "";
  const msg = String((e && e.message) || e || "");
  let host = "";
  try { host = new URL(conn && conn.url).hostname; } catch (_) {}
  if (/ECONNREFUSED/.test(code + msg)) return new GatewayError(`Couldn't reach the database${host ? " at " + host : ""}. Is it running, and are you on the right network or VPN?`, 502);
  if (/ENOTFOUND|EAI_AGAIN/.test(code + msg)) return new GatewayError(`There's no server called ${host || "that"} — check the address.`, 502);
  if (/ETIMEDOUT|timeout|timed out/i.test(code + msg)) return new GatewayError("The database took too long to answer. It may be behind a firewall or VPN this gateway can't reach.", 504);
  if (/password|authentication|Access denied|Login failed|auth failed|not authorized/i.test(msg)) return new GatewayError("The database didn't accept that username or password.", 401);
  if (/database .* does not exist|Unknown database|Cannot open database/i.test(msg)) return new GatewayError("That database name doesn't exist on the server.", 404);
  if (/relation .* does not exist|Table .* doesn't exist|Invalid object name|ns not found/i.test(msg)) return new GatewayError("That table doesn't exist, or your database user can't see it.", 404);
  if (/read-only|read only|cannot execute .* in a read-only transaction/i.test(msg)) return new GatewayError("Blocked: this connection is read-only.", 403);
  if (/permission denied|SELECT command denied|not authorized on/i.test(msg)) return new GatewayError("Your database user isn't allowed to look at that.", 403);
  if (/ssl|tls|certificate/i.test(msg)) return new GatewayError("The secure (SSL) connection failed. Try adding ?sslmode=require (Postgres) or check the server's certificate settings.", 502);
  // A syntax error is the user's own query talking — pass it through, it's useful.
  return new GatewayError(msg.slice(0, 400) || "The database returned an error.", 400);
}

/* ---------------------------------------------------------------------------
 * Adapters. Each knows how to connect, run read-only SQL and list tables.
 * `drivers` holds whatever the runtime could load:
 *   { pg, mysql, mongodb, mssql }   (pg = require("pg"), mysql = require("mysql2/promise"), …)
 * ------------------------------------------------------------------------- */
const adapters = {
  postgres: {
    async open(d, url) {
      if (!d.pg) throw new GatewayError("PostgreSQL isn't available in this gateway.", 501);
      const Client = d.pg.Client || (d.pg.default && d.pg.default.Client);
      const client = new Client({ connectionString: url, connectionTimeoutMillis: TIMEOUT_MS, statement_timeout: TIMEOUT_MS, query_timeout: TIMEOUT_MS + 2000 });
      await client.connect();
      return client;
    },
    async close(c) { try { await c.end(); } catch (_) {} },
    async read(c, sql, params = []) {
      await c.query("BEGIN READ ONLY");
      try {
        await c.query(`SET LOCAL statement_timeout = ${TIMEOUT_MS}`);
        const r = await c.query(sql, params);
        const res = Array.isArray(r) ? r[r.length - 1] : r;
        return { rows: res.rows || [], columns: (res.fields || []).map(f => f.name) };
      } finally { try { await c.query("ROLLBACK"); } catch (_) {} }
    },
    async version(c) { const r = await this.read(c, "SELECT version() AS v"); return String(r.rows[0].v).split(" on ")[0]; },
    schemaSql: `SELECT table_schema AS s, table_name AS t, column_name AS c, data_type AS ty
                FROM information_schema.columns
                WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_schema NOT LIKE 'pg_toast%'
                ORDER BY table_schema, table_name, ordinal_position`,
    previewSql(table, schema, where, limit) {
      const from = (schema ? quoteIdent("postgres", schema) + "." : "") + quoteIdent("postgres", table);
      const w = where ? ` WHERE CAST(${quoteIdent("postgres", where.column)} AS TEXT) = $1` : "";
      return { sql: `SELECT * FROM ${from}${w} LIMIT ${limit + 1}`, params: where ? [String(where.value)] : [] };
    },
  },

  mysql: {
    async open(d, url) {
      if (!d.mysql) throw new GatewayError("MySQL isn't available in this gateway.", 501);
      const m = d.mysql.createConnection ? d.mysql : d.mysql.default;
      return m.createConnection({ uri: url, connectTimeout: TIMEOUT_MS, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
    },
    async close(c) { try { await c.end(); } catch (_) {} },
    async read(c, sql, params = []) {
      await c.query("START TRANSACTION READ ONLY");
      try {
        try { await c.query(`SET SESSION MAX_EXECUTION_TIME = ${TIMEOUT_MS}`); } catch (_) {} // MySQL 5.7+; MariaDB ignores
        const [rows, fields] = await c.query({ sql, values: params, timeout: TIMEOUT_MS });
        return { rows: Array.isArray(rows) ? rows : [], columns: (fields || []).map(f => f.name) };
      } finally { try { await c.query("ROLLBACK"); } catch (_) {} }
    },
    async version(c) { const r = await this.read(c, "SELECT VERSION() AS v"); return "MySQL " + r.rows[0].v; },
    schemaSql: `SELECT table_schema AS s, table_name AS t, column_name AS c, data_type AS ty
                FROM information_schema.columns
                WHERE table_schema = DATABASE()
                ORDER BY table_name, ordinal_position`,
    previewSql(table, schema, where, limit) {
      const from = (schema ? quoteIdent("mysql", schema) + "." : "") + quoteIdent("mysql", table);
      const w = where ? ` WHERE CAST(${quoteIdent("mysql", where.column)} AS CHAR) = ?` : "";
      return { sql: `SELECT * FROM ${from}${w} LIMIT ${limit + 1}`, params: where ? [String(where.value)] : [] };
    },
  },

  mssql: {
    async open(d, url) {
      if (!d.mssql) throw new GatewayError("SQL Server needs the gateway on your computer (the Cloudflare one can't reach it).", 501);
      const m = d.mssql.ConnectionPool ? d.mssql : d.mssql.default;
      const pool = new m.ConnectionPool(url);
      pool.config.requestTimeout = TIMEOUT_MS;
      pool.config.connectionTimeout = TIMEOUT_MS;
      await pool.connect();
      pool.__m = m;
      return pool;
    },
    async close(c) { try { await c.close(); } catch (_) {} },
    async read(c, sql, params = []) {
      // SQL Server has no READ ONLY transaction; run inside one that is always rolled back.
      const tx = new c.__m.Transaction(c);
      await tx.begin();
      try {
        const req = new c.__m.Request(tx);
        params.forEach((p, i) => req.input("p" + (i + 1), p));
        const r = await req.query(sql);
        const rows = r.recordset || [];
        return { rows, columns: rows.columns ? Object.keys(rows.columns) : [] };
      } finally { try { await tx.rollback(); } catch (_) {} }
    },
    async version(c) { const r = await this.read(c, "SELECT @@VERSION AS v"); return String(r.rows[0].v).split("\n")[0]; },
    schemaSql: `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS ty
                FROM INFORMATION_SCHEMA.COLUMNS
                ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
    previewSql(table, schema, where, limit) {
      const from = (schema ? quoteIdent("mssql", schema) + "." : "") + quoteIdent("mssql", table);
      const w = where ? ` WHERE CAST(${quoteIdent("mssql", where.column)} AS NVARCHAR(MAX)) = @p1` : "";
      return { sql: `SELECT TOP ${limit + 1} * FROM ${from}${w}`, params: where ? [String(where.value)] : [] };
    },
  },
};

/* MongoDB doesn't speak SQL, so it gets its own small adapter. */
const mongo = {
  async open(d, url) {
    if (!d.mongodb) throw new GatewayError("MongoDB needs the gateway on your computer (the Cloudflare one can't reach it).", 501);
    const M = d.mongodb.MongoClient ? d.mongodb : d.mongodb.default;
    const client = new M.MongoClient(url, { serverSelectionTimeoutMS: TIMEOUT_MS, connectTimeoutMS: TIMEOUT_MS, readPreference: "secondaryPreferred" });
    await client.connect();
    return client;
  },
  async close(c) { try { await c.close(); } catch (_) {} },
  db(c) { return c.db(); },   // the database named in the URL
  async version(c) { const info = await this.db(c).admin().command({ buildInfo: 1 }).catch(() => null); return "MongoDB " + (info ? info.version : ""); },
  async schema(c) {
    const db = this.db(c);
    const cols = await db.listCollections({}, { nameOnly: true }).toArray();
    const out = [];
    for (const col of cols.filter(x => !x.name.startsWith("system.")).slice(0, 200)) {
      const doc = await db.collection(col.name).findOne({}, { maxTimeMS: TIMEOUT_MS });
      out.push({ schema: db.databaseName, name: col.name,
        columns: doc ? Object.keys(doc).map(k => ({ name: k, type: Array.isArray(doc[k]) ? "array" : doc[k] === null ? "null" : typeof doc[k] === "object" ? (doc[k]._bsontype || "object") : typeof doc[k] })) : [] });
    }
    return out;
  },
  async find(c, q, limit) {
    const col = this.db(c).collection(q.collection);
    if (q.pipeline) return col.aggregate([...q.pipeline, { $limit: limit + 1 }], { maxTimeMS: TIMEOUT_MS }).toArray();
    return col.find(q.filter || {}, { projection: q.projection, sort: q.sort, limit: limit + 1, maxTimeMS: TIMEOUT_MS }).toArray();
  },
};

/* ---------------------------------------------------------------------------
 * The gateway
 * ------------------------------------------------------------------------- */
export function createGateway(drivers) {
  function connOf(body) {
    const c = body && body.connection;
    if (!c || !DB_TYPES[c.type]) throw new GatewayError("Pick a database type: PostgreSQL, MySQL, MongoDB or SQL Server.");
    if (!c.url || typeof c.url !== "string") throw new GatewayError("Paste the database's connection string.");
    return c;
  }
  async function withConn(conn, fn) {
    const isMongo = conn.type === "mongodb";
    const a = isMongo ? mongo : adapters[conn.type];
    let client;
    try {
      client = await a.open(drivers, conn.url);
      return await fn(a, client);
    } catch (e) {
      throw friendlyError(e, conn);
    } finally {
      if (client) await a.close(client);
    }
  }

  return {
    types: () => Object.keys(DB_TYPES).filter(t =>
      t === "postgres" ? !!drivers.pg : t === "mysql" ? !!drivers.mysql : t === "mongodb" ? !!drivers.mongodb : !!drivers.mssql),

    async test(body) {
      const conn = connOf(body);
      return withConn(conn, async (a, c) => ({ ok: true, type: conn.type, version: await a.version(c), readOnly: true }));
    },

    async schema(body) {
      const conn = connOf(body);
      return withConn(conn, async (a, c) => {
        if (conn.type === "mongodb") return { tables: await a.schema(c) };
        const r = await a.read(c, a.schemaSql);
        const map = new Map();
        for (const row of r.rows) {
          const s = row.s ?? row.S, t = row.t ?? row.T, col = row.c ?? row.C, ty = row.ty ?? row.TY;
          const key = s + "." + t;
          if (!map.has(key)) map.set(key, { schema: s, name: t, columns: [] });
          map.get(key).columns.push({ name: col, type: ty });
        }
        return { tables: [...map.values()].slice(0, 500) };
      });
    },

    async preview(body) {
      const conn = connOf(body);
      const limit = clampLimit(body.limit);
      if (!validIdent(body.table)) throw new GatewayError("Pick a table to look at.");
      if (body.schema != null && !validIdent(body.schema)) throw new GatewayError("That schema name isn't valid.");
      const where = body.where && body.where.column != null ? body.where : null;
      if (where && !validIdent(where.column)) throw new GatewayError("Pick a column to search in.");
      const started = Date.now();
      return withConn(conn, async (a, c) => {
        if (conn.type === "mongodb") {
          const filter = where ? { [where.column]: where.value } : {};
          const rows = await a.find(c, { collection: body.table, filter }, limit);
          // A number typed into the box should still find a numeric field.
          if (where && !rows.length && where.value !== "" && !isNaN(Number(where.value))) {
            const again = await a.find(c, { collection: body.table, filter: { [where.column]: Number(where.value) } }, limit);
            return shape(again, null, limit, started);
          }
          return shape(rows, null, limit, started);
        }
        const q = a.previewSql(body.table, body.schema || null, where, limit);
        const r = await a.read(c, q.sql, q.params);
        return shape(r.rows, r.columns, limit, started);
      });
    },

    async query(body) {
      const conn = connOf(body);
      const limit = clampLimit(body.limit);
      const started = Date.now();
      if (conn.type === "mongodb") {
        const q = parseMongoQuery(body.query);
        return withConn(conn, async (a, c) => shape(await a.find(c, q, limit), null, limit, started));
      }
      const sql = assertReadOnlySql(body.query);
      return withConn(conn, async (a, c) => {
        const r = await a.read(c, sql);
        return shape(r.rows, r.columns, limit, started);
      });
    },
  };
}

/* Route a request body to an operation; shared by both HTTP front-ends. */
export async function handleDbOp(gateway, op, body) {
  if (!["test", "schema", "preview", "query"].includes(op)) throw new GatewayError("Unknown database action.", 404);
  return gateway[op](body || {});
}
