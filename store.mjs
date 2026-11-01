// Storage for Netlify (single file). Data is kept in Netlify Blobs on your own site, no Firebase.
// Endpoint: POST /api/store
import { getStore } from "@netlify/blobs";
/*
  Storage core for the typing exam (replaces Firebase).

  The browser page talks to ONE endpoint: POST /api/store
  This file holds the access rules, so the same rules apply whether the data is kept in
    - Netlify Blobs  (netlify/functions/store.mjs), or
    - SQLite         (server.js, for any ordinary Node host).

  Collections:  exams/<code>   locks/<key>   results/<key>
*/
import crypto from "node:crypto";

const DAY = 864e5;
const EXAM_DAYS = 7;            // same as DAYS in index.html
const GRACE_MS = 60 * 1000;     // small allowance for network delay when submitting
const MAX_DOC_CHARS = 300000;
const PATH_RE = /^(exams|locks|results)\/([A-Za-z0-9_-]{1,400})$/;
const CID_RE = /^[a-f0-9]{32,64}$/;
const CODE_RE = /^[A-Z0-9]{1,20}$/;
const OPS = {
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
const denied = (m) => new HttpError(403, "permission-denied", m || "Not allowed.");

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const safeEq = (a, b) =>
  crypto.timingSafeEqual(Buffer.from(sha(a)), Buffer.from(sha(b)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeAuth(cfg) {
  // Stateless signed token, so it also works on serverless hosts.
  const key = crypto
    .createHash("sha256")
    .update("octs-admin|" + (cfg.secret || "") + "|" + cfg.adminPassword)
    .digest();
  const sign = (p) => crypto.createHmac("sha256", key).update(p).digest("base64url");
  return {
    issue() {
      const p = Buffer.from(
        JSON.stringify({ a: 1, exp: Date.now() + 12 * 3600 * 1000 })
      ).toString("base64url");
      return p + "." + sign(p);
    },
    verify(t) {
      if (!t || typeof t !== "string") return false;
      const i = t.indexOf(".");
      if (i < 1) return false;
      const p = t.slice(0, i);
      const s = t.slice(i + 1);
      const e = sign(p);
      if (s.length !== e.length) return false;
      if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return false;
      try {
        const o = JSON.parse(Buffer.from(p, "base64url").toString());
        return o.a === 1 && o.exp > Date.now();
      } catch (e2) {
        return false;
      }
    }
  };
}

function parsePath(p) {
  const m = PATH_RE.exec(String(p || ""));
  if (!m) throw new HttpError(400, "bad-path", "Invalid path.");
  return { coll: m[1], id: m[2] };
}

/*
  cfg     = { adminName, adminPassword, secret }
  adapter = { get(path), set(path,obj), del(path), setIfAbsent(path,obj)->bool, list(coll,prefix?)->[{id,data}] }
*/
function createStore(cfg, adapter) {
  const auth = makeAuth(cfg);
  const adminName = String(cfg.adminName).trim().toLowerCase();

  async function run(hdr, body) {
    if (!body || typeof body !== "object") throw new HttpError(400, "bad-request", "Bad request.");

    const authz = String(hdr.authorization || "");
    const isAdmin = authz.startsWith("Bearer ") && auth.verify(authz.slice(7));
    const cid = CID_RE.test(hdr.candidateId || "") ? hdr.candidateId : "";
    const cidHash = cid ? sha("cid|" + cid) : "";
    const needAdmin = () => {
      if (!isAdmin) throw new HttpError(401, "unauthenticated", "Admin login required.");
    };
    const ownsLock = (lock) => !!(lock && cidHash && lock.uidHash === cidHash);

    switch (body.action) {
      case "login": {
        const n = String(body.name || "").trim().toLowerCase();
        const p = String(body.password || "");
        const okName = safeEq(n, adminName);
        const okPass = safeEq(p, cfg.adminPassword);
        if (!(okName && okPass)) {
          await sleep(700);
          throw new HttpError(401, "auth/invalid-credential", "Wrong name or password.");
        }
        return { token: auth.issue() };
      }

      case "get": {
        const { coll, id } = parsePath(body.path);
        const d = await adapter.get(body.path);
        if (coll === "exams") return { data: d || null };
        if (coll === "locks") {
          if (!d) return { data: null };
          const { uidHash, ...rest } = d;
          // never reveal the owner's secret id to anybody else
          return { data: { ...rest, uid: cidHash && uidHash === cidHash ? cid : "" } };
        }
        // results
        if (isAdmin) return { data: d || null };
        if (!ownsLock(await adapter.get("locks/" + id))) throw denied();
        return { data: d || null };
      }

      case "set": {
        const { coll, id } = parsePath(body.path);
        const data = body.data;
        if (!data || typeof data !== "object" || Array.isArray(data))
          throw new HttpError(400, "bad-request", "Invalid data.");
        if (JSON.stringify(data).length > MAX_DOC_CHARS)
          throw new HttpError(413, "too-large", "Document too large.");
        if (coll === "exams") {
          needAdmin();
          await adapter.set(body.path, data);
          return { ok: true };
        }
        if (coll === "locks") throw denied("Locks can only be created by acquire.");
        // results
        if (isAdmin) {
          await adapter.set(body.path, data);
          return { ok: true };
        }
        const lock = await adapter.get("locks/" + id);
        if (!ownsLock(lock)) throw denied();
        const code = String(lock.code || "");
        if (data.code !== code || !id.startsWith(code + "_")) throw denied();
        const exam = await adapter.get("exams/" + code);
        if (!exam) throw denied();
        const prev = await adapter.get(body.path);
        if (prev && prev.status === "submitted") throw denied("Already submitted.");
        const mins = Number(exam.mins) || 0;
        if (Date.now() > Number(lock.at) + mins * 60000 + GRACE_MS)
          throw denied("The exam time is over.");
        await adapter.set(body.path, data);
        return { ok: true };
      }

      case "delete": {
        needAdmin();
        parsePath(body.path);
        await adapter.del(body.path);
        return { ok: true };
      }

      case "acquire": {
        const { coll, id } = parsePath(body.path);
        if (coll !== "locks") throw new HttpError(400, "bad-path", "Invalid path.");
        if (!cidHash) throw new HttpError(400, "no-candidate-id", "Missing candidate id.");
        const code = String(body.code || "");
        if (!CODE_RE.test(code) || !id.startsWith(code + "_")) throw denied();
        const exam = await adapter.get("exams/" + code);
        if (!exam) throw denied();
        if (Date.now() > Number(exam.at) + EXAM_DAYS * DAY) throw denied("Exam expired.");
        if (Array.isArray(exam.allowed) && exam.allowed.length && !exam.allowed.includes(id))
          throw denied("Roll number not allowed.");
        const ok = await adapter.setIfAbsent(body.path, {
          holder: String(body.holder || "").slice(0, 200),
          code,
          uidHash: cidHash,
          at: Date.now()
        });
        return { acquired: !!ok };
      }

      case "query": {
        needAdmin();
        const coll = body.collection;
        if (coll !== "exams" && coll !== "results")
          throw new HttpError(400, "bad-request", "Invalid collection.");
        const where = Array.isArray(body.where) ? body.where : [];
        for (const w of where) {
          if (!Array.isArray(w) || w.length !== 3 || typeof w[0] !== "string" || !OPS[w[1]])
            throw new HttpError(400, "bad-request", "Invalid filter.");
        }
        let prefix;
        if (coll === "results") {
          const c = where.find((w) => w[0] === "code" && w[1] === "==");
          if (c && CODE_RE.test(String(c[2]))) prefix = "results/" + c[2] + "_";
        }
        let items = await adapter.list(coll, prefix);
        for (const [f, op, v] of where)
          items = items.filter((it) => it.data && it.data[f] !== undefined && OPS[op](it.data[f], v));
        if (Array.isArray(body.orderBy) && typeof body.orderBy[0] === "string") {
          const f = body.orderBy[0];
          const dir = body.orderBy[1] === "desc" ? -1 : 1;
          items = items.filter((it) => it.data && it.data[f] !== undefined);
          items.sort((a, b) => ((a.data[f] > b.data[f]) - (a.data[f] < b.data[f])) * dir);
        }
        return { docs: items.map((it) => ({ id: it.id, data: it.data })) };
      }

      default:
        throw new HttpError(400, "bad-request", "Unknown action.");
    }
  }

  return {
    async handle(hdr, body) {
      try {
        return { status: 200, body: await run(hdr || {}, body) };
      } catch (e) {
        if (e instanceof HttpError)
          return { status: e.status, body: { error: e.message, code: e.code } };
        console.error("Storage error:", e && e.message);
        return { status: 500, body: { error: "Storage error.", code: "internal" } };
      }
    }
  };
}


// ---------- Netlify Blobs storage + HTTP handler ----------
function blobAdapter(store) {
  const json = (o) => JSON.stringify(o);
  return {
    async get(path) {
      return (await store.get(path, { type: "json" })) ?? null;
    },
    async set(path, obj) {
      await store.set(path, json(obj));
    },
    async del(path) {
      await store.delete(path);
    },
    // Create only if it does not exist yet (the one-time roll-number lock).
    async setIfAbsent(path, obj) {
      if (await store.get(path)) return false;
      const r = await store.set(path, json(obj), { onlyIfNew: true });
      return r && typeof r.modified === "boolean" ? r.modified : true;
    },
    async list(coll, prefix) {
      const { blobs } = await store.list({ prefix: prefix || coll + "/" });
      const out = [];
      for (let i = 0; i < blobs.length; i += 25) {
        const chunk = blobs.slice(i, i + 25);
        const vals = await Promise.all(
          chunk.map((b) => store.get(b.key, { type: "json" }).catch(() => null))
        );
        chunk.forEach((b, j) => {
          if (vals[j]) out.push({ id: b.key.slice(coll.length + 1), data: vals[j] });
        });
      }
      return out;
    }
  };
}

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });

export default async (req) => {
  if (req.method !== "POST") return reply({ error: "Method not allowed." }, 405);

  let body = null;
  try {
    body = await req.json();
  } catch (e) {}

  const store = createStore(
    {
      // Same admin name and password as before. Override on Netlify with environment variables.
      adminName: process.env.ADMIN_USERNAME || "institution_admin",
      adminPassword: process.env.ADMIN_PASSWORD || "OC&S11749",
      secret: process.env.SESSION_SECRET || ""
    },
    blobAdapter(getStore({ name: "octs-exam", consistency: "strong" }))
  );

  const r = await store.handle(
    {
      authorization: req.headers.get("authorization"),
      candidateId: req.headers.get("x-candidate-id")
    },
    body
  );
  return reply(r.body, r.status);
};

export const config = { path: "/api/store" };
