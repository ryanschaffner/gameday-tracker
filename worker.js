/*
 * Game Day Tracker — sharing backend (Cloudflare Worker)
 *
 * Model: view-only sharing + assistant flag queue ("A+").
 *  - The coach's phone is the source of truth. It PUBLISHES a snapshot of all teams.
 *  - Assistants READ the snapshot (no key needed) and may POST small "flags"
 *    (e.g. "sub me", "goal", "tired"). Flags never touch the coach's data — they
 *    land in a separate list the coach's phone reads and confirms.
 *  - Only the coach's phone can overwrite the snapshot or read/clear flags: it holds
 *    a secret editKey, sent as the "x-edit-key" header. Reading the snapshot is open.
 *
 * Storage (KV binding: GAMEDAY):
 *   snap:<id>   -> { editKeyHash, data, updatedAt }   (the published teams)
 *   flags:<id>  -> [ { id, at, ...flag } ]            (assistant-raised flags)
 *
 * Endpoints (all JSON):
 *   GET    /health
 *   GET    /snap/:id                 -> { data, updatedAt }            (open)
 *   PUT    /snap/:id                 body {editKey,data}               (creates or updates; editKey required)
 *   DELETE /snap/:id                 header x-edit-key                 (stop sharing)
 *   POST   /flag/:id                 body {flag}                       (open; assistants raise a flag)
 *   GET    /flags/:id                header x-edit-key                 -> { flags }
 *   POST   /flags/:id/clear          header x-edit-key  body {ids?}    (clear some/all flags)
 *
 * Notes:
 *  - editKey is never stored in the clear; we store a SHA-256 hash and compare hashes.
 *  - snapshots and flags are written with a 60-day TTL so abandoned shares self-clean.
 *  - flag POSTs are lightly rate-limited by capping the stored list length.
 */

const TTL_SECONDS = 60 * 60 * 24 * 60; // 60 days
const MAX_FLAGS = 200;                  // hard cap so an abusive client can't grow the list forever
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024; // 2 MB — far above a realistic multi-team store

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,x-edit-key",
  "Access-Control-Max-Age": "86400",
};

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });
}
function bad(msg, status = 400) { return json({ ok: false, error: msg }, status); }

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Validate a share id: only the characters our app generates, bounded length.
function validId(id) { return typeof id === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(id); }

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // e.g. ["snap","abc123"]

    try {
      if (parts.length === 1 && parts[0] === "health") return json({ ok: true });

      if (!env.GAMEDAY) return bad("KV binding GAMEDAY is missing — check the Worker's bindings.", 500);

      // ---- /snap/:id ----
      if (parts[0] === "snap" && parts.length === 2) {
        const id = parts[1];
        if (!validId(id)) return bad("bad id");

        if (request.method === "GET") {
          const raw = await env.GAMEDAY.get("snap:" + id);
          if (!raw) return bad("not found", 404);
          const rec = JSON.parse(raw);
          return json({ ok: true, data: rec.data, updatedAt: rec.updatedAt });
        }

        if (request.method === "PUT") {
          const body = await request.json().catch(() => null);
          if (!body || typeof body.editKey !== "string" || body.data == null) return bad("missing editKey or data");
          const serialized = JSON.stringify(body.data);
          if (serialized.length > MAX_SNAPSHOT_BYTES) return bad("snapshot too large", 413);

          const existing = await env.GAMEDAY.get("snap:" + id);
          const incomingHash = await sha256Hex(body.editKey);
          if (existing) {
            const rec = JSON.parse(existing);
            if (rec.editKeyHash !== incomingHash) return bad("wrong edit key", 403);
          }
          const rec = { editKeyHash: incomingHash, data: body.data, updatedAt: Date.now() };
          await env.GAMEDAY.put("snap:" + id, JSON.stringify(rec), { expirationTtl: TTL_SECONDS });
          return json({ ok: true, updatedAt: rec.updatedAt });
        }

        if (request.method === "DELETE") {
          const key = request.headers.get("x-edit-key") || "";
          const existing = await env.GAMEDAY.get("snap:" + id);
          if (existing) {
            const rec = JSON.parse(existing);
            if (rec.editKeyHash !== await sha256Hex(key)) return bad("wrong edit key", 403);
          }
          await env.GAMEDAY.delete("snap:" + id);
          await env.GAMEDAY.delete("flags:" + id);
          return json({ ok: true });
        }
        return bad("method not allowed", 405);
      }

      // ---- /flag/:id  (assistants raise a flag; open, but capped) ----
      if (parts[0] === "flag" && parts.length === 2) {
        const id = parts[1];
        if (!validId(id)) return bad("bad id");
        if (request.method !== "POST") return bad("method not allowed", 405);

        // Only accept flags for a share that actually exists.
        const snap = await env.GAMEDAY.get("snap:" + id);
        if (!snap) return bad("not found", 404);

        const body = await request.json().catch(() => null);
        if (!body || !body.flag || typeof body.flag !== "object") return bad("missing flag");
        const f = body.flag;
        // Whitelist the fields we store — never trust arbitrary shape from an open endpoint.
        const clean = {
          id: "f_" + Math.random().toString(36).slice(2, 10),
          at: Date.now(),
          type: String(f.type || "note").slice(0, 24),
          teamId: String(f.teamId || "").slice(0, 64),
          gameId: String(f.gameId || "").slice(0, 64),
          pid: String(f.pid || "").slice(0, 64),
          label: String(f.label || "").slice(0, 80),
          by: String(f.by || "").slice(0, 40),
        };
        const raw = await env.GAMEDAY.get("flags:" + id);
        let list = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(list)) list = [];
        list.push(clean);
        if (list.length > MAX_FLAGS) list = list.slice(list.length - MAX_FLAGS);
        await env.GAMEDAY.put("flags:" + id, JSON.stringify(list), { expirationTtl: TTL_SECONDS });
        return json({ ok: true });
      }

      // ---- /flags/:id  and  /flags/:id/clear  (coach only) ----
      if (parts[0] === "flags" && (parts.length === 2 || (parts.length === 3 && parts[2] === "clear"))) {
        const id = parts[1];
        if (!validId(id)) return bad("bad id");

        const snap = await env.GAMEDAY.get("snap:" + id);
        if (!snap) return bad("not found", 404);
        const rec = JSON.parse(snap);
        const key = request.headers.get("x-edit-key") || "";
        if (rec.editKeyHash !== await sha256Hex(key)) return bad("wrong edit key", 403);

        if (parts.length === 2 && request.method === "GET") {
          const raw = await env.GAMEDAY.get("flags:" + id);
          return json({ ok: true, flags: raw ? JSON.parse(raw) : [] });
        }
        if (parts.length === 3 && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          if (Array.isArray(body.ids) && body.ids.length) {
            const raw = await env.GAMEDAY.get("flags:" + id);
            let list = raw ? JSON.parse(raw) : [];
            const drop = new Set(body.ids);
            list = list.filter(f => !drop.has(f.id));
            await env.GAMEDAY.put("flags:" + id, JSON.stringify(list), { expirationTtl: TTL_SECONDS });
          } else {
            await env.GAMEDAY.delete("flags:" + id); // clear all
          }
          return json({ ok: true });
        }
        return bad("method not allowed", 405);
      }

      return bad("not found", 404);
    } catch (e) {
      return bad("server error: " + (e && e.message ? e.message : "unknown"), 500);
    }
  },
};
