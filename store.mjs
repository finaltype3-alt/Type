// Storage for Netlify: data is kept in Netlify Blobs on your own site (no Firebase).
// Endpoint: POST /api/store
import { getStore } from "@netlify/blobs";
import core from "../../lib/store-core.js";

const { createStore } = core;

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
