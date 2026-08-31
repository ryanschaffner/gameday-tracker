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
const MAX_SUBS = 200;                    // cap stored push subscriptions per share

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,x-edit-key",
  "Access-Control-Max-Age": "86400",
};

// ============================================================================
// Web Push (VAPID + RFC 8291 aes128gcm) — WebCrypto only, no dependencies.
// VAPID keys come from env vars you set on the Worker (see SHARING-SETUP.md):
//   VAPID_PUBLIC       base64url raw public key (also handed to browsers to subscribe)
//   VAPID_PRIVATE_JWK  the private key as a JSON string (JWK)
//   VAPID_SUBJECT      e.g. "mailto:you@example.com"
// If these aren't set, push is simply inert (subscribe still stores, sends are skipped).
// ============================================================================
function _b64urlToBytes(s){ s=s.replace(/-/g,"+").replace(/_/g,"/"); const pad=s.length%4; if(pad) s+="=".repeat(4-pad);
  const bin=atob(s); const o=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) o[i]=bin.charCodeAt(i); return o; }
function _bytesToB64url(bytes){ let bin=""; const b=new Uint8Array(bytes); for(let i=0;i<b.length;i++) bin+=String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
function _utf8(s){ return new TextEncoder().encode(s); }
function _concat(...arrs){ let len=0; arrs.forEach(a=>len+=a.length); const o=new Uint8Array(len); let n=0; arrs.forEach(a=>{o.set(a,n);n+=a.length;}); return o; }
async function _signVapidJwt(audience, subject, privateJwk){
  const header={typ:"JWT",alg:"ES256"}; const now=Math.floor(Date.now()/1000);
  const payload={aud:audience, exp:now+12*60*60, sub:subject};
  const enc=(o)=>_bytesToB64url(_utf8(JSON.stringify(o)));
  const signingInput=enc(header)+"."+enc(payload);
  const key=await crypto.subtle.importKey("jwk", privateJwk, {name:"ECDSA",namedCurve:"P-256"}, false, ["sign"]);
  const sig=await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"}, key, _utf8(signingInput));
  return signingInput+"."+_bytesToB64url(new Uint8Array(sig));
}
async function _hkdf(salt, ikm, info, length){
  const key=await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"HKDF",hash:"SHA-256",salt,info}, key, length*8);
  return new Uint8Array(bits);
}
async function _encryptPayload(payloadBytes, p256dhB64, authB64){
  const clientPub=_b64urlToBytes(p256dhB64); const authSecret=_b64urlToBytes(authB64);
  const eph=await crypto.subtle.generateKey({name:"ECDH",namedCurve:"P-256"}, true, ["deriveBits"]);
  const asPubRaw=new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const clientKey=await crypto.subtle.importKey("raw", clientPub, {name:"ECDH",namedCurve:"P-256"}, false, []);
  const shared=new Uint8Array(await crypto.subtle.deriveBits({name:"ECDH", public:clientKey}, eph.privateKey, 256));
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const info1=_concat(_utf8("WebPush: info\0"), clientPub, asPubRaw);
  const ikm=await _hkdf(authSecret, shared, info1, 32);
  const cek=await _hkdf(salt, ikm, _utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce=await _hkdf(salt, ikm, _utf8("Content-Encoding: nonce\0"), 12);
  const plaintext=_concat(payloadBytes, new Uint8Array([0x02]));
  const aesKey=await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM", iv:nonce}, aesKey, plaintext));
  const rs=4096; const header=new Uint8Array(16+4+1+asPubRaw.length);
  header.set(salt,0); header[16]=(rs>>>24)&0xff; header[17]=(rs>>>16)&0xff; header[18]=(rs>>>8)&0xff; header[19]=rs&0xff;
  header[20]=asPubRaw.length; header.set(asPubRaw,21);
  return _concat(header, ct);
}
function _vapidCfg(env){
  if(!env.VAPID_PUBLIC || !env.VAPID_PRIVATE_JWK) return null;
  let jwk; try{ jwk=JSON.parse(env.VAPID_PRIVATE_JWK); }catch(e){ return null; }
  return { pub:env.VAPID_PUBLIC, jwk, subject:env.VAPID_SUBJECT||"mailto:coach@example.com" };
}
// Send one push. Returns the HTTP status (or 0 on thrown error) so the caller can prune dead subs.
async function _sendOne(cfg, subscription, payloadObj){
  try{
    const url=new URL(subscription.endpoint); const audience=url.origin;
    const jwt=await _signVapidJwt(audience, cfg.subject, cfg.jwk);
    const body=await _encryptPayload(_utf8(JSON.stringify(payloadObj)), subscription.keys.p256dh, subscription.keys.auth);
    const r=await fetch(subscription.endpoint, { method:"POST", headers:{
      "Authorization":"vapid t="+jwt+", k="+cfg.pub,
      "Content-Encoding":"aes128gcm", "Content-Type":"application/octet-stream",
      "TTL":"600", "Urgency":"high" }, body });
    return r.status;
  }catch(e){ return 0; }
}
// Send to a filtered set of a share's subscribers; prune any that come back 404/410 (gone).
async function pushToShare(env, id, filterFn, payloadObj){
  const cfg=_vapidCfg(env); if(!cfg) return; // push not configured — silently skip
  const raw=await env.GAMEDAY.get("subs:"+id); if(!raw) return;
  let list; try{ list=JSON.parse(raw); }catch(e){ return; }
  if(!Array.isArray(list)||!list.length) return;
  const targets=list.filter(filterFn);
  if(!targets.length) return;
  const dead=new Set();
  for(const s of targets){
    const st=await _sendOne(cfg, s.sub, payloadObj);
    if(st===404||st===410) dead.add(s.sub.endpoint);
  }
  if(dead.size){
    const pruned=list.filter(s=>!dead.has(s.sub.endpoint));
    await env.GAMEDAY.put("subs:"+id, JSON.stringify(pruned), { expirationTtl: TTL_SECONDS });
  }
}
// Detect notifiable changes between the previous and new snapshot for a given team's latest game:
// newly-added goals, and a game transitioning to started or ended. Returns {goals:[...], started, ended}.
function diffForNotifications(oldData, newData){
  const out={ perTeam:{} };
  const teamsNew=(newData&&newData.teams)||[];
  const teamsOld=(oldData&&oldData.teams)||[];
  teamsNew.forEach(tn=>{
    const to=teamsOld.find(t=>t.id===tn.id);
    const gNew=(tn.games&&tn.games.length)?tn.games[tn.games.length-1]:null;
    if(!gNew) return;
    const gOld=(to&&to.games)?to.games.find(x=>x.id===gNew.id):null;
    const info={ teamName:tn.name||"Team", newGoals:[], started:false, ended:false, opp:gNew.opp||"" };
    // new goals = goals in gNew not present (by id) in gOld
    const oldGoalIds=new Set(((gOld&&gOld.goals)||[]).map(x=>x.id));
    (gNew.goals||[]).forEach(gl=>{ if(!oldGoalIds.has(gl.id)) info.newGoals.push(gl); });
    // start/end via a coach-set phase field if present, else clock heuristic
    const phaseOld=gOld&&gOld.phase, phaseNew=gNew.phase;
    if(phaseOld!=="live" && phaseNew==="live") info.started=true;
    if(phaseOld!=="finish" && phaseNew==="finish") info.ended=true;
    if(info.newGoals.length||info.started||info.ended) out.perTeam[tn.id]=info;
  });
  return out;
}

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
  async fetch(request, env, ctx) {
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
          let oldData = null;
          if (existing) {
            const rec = JSON.parse(existing);
            if (rec.editKeyHash !== incomingHash) return bad("wrong edit key", 403);
            oldData = rec.data;
          }
          const rec = { editKeyHash: incomingHash, data: body.data, updatedAt: Date.now() };
          await env.GAMEDAY.put("snap:" + id, JSON.stringify(rec), { expirationTtl: TTL_SECONDS });

          // Notify followers of new goals / game start / game end (compare old vs new snapshot).
          try {
            const diff = diffForNotifications(oldData, body.data);
            const teamIds = Object.keys(diff.perTeam);
            if (teamIds.length && ctx && ctx.waitUntil) {
              ctx.waitUntil((async () => {
                for (const tid of teamIds) {
                  const info = diff.perTeam[tid];
                  const rosterFor = (pid) => {
                    const t = (body.data.teams||[]).find(x=>x.id===tid);
                    const p = t && (t.roster||[]).find(r=>r.id===pid);
                    return p ? (p.name||"").split(/\s+/)[0] : "";
                  };
                  const flt = (s) => s.role==="follower" && s.teamId===tid;
                  for (const gl of info.newGoals) {
                    const sc = gl.scorer ? rosterFor(gl.scorer) : "";
                    const tm = (gl.minute!=null) ? (gl.minute+"' ") : "";
                    await pushToShare(env, id, flt, {
                      title: "⚽ "+info.teamName+" scored!",
                      body: tm + (sc ? sc + " scores" : "Goal") + (info.opp?(" vs "+info.opp):""),
                      tag: "goal-"+gl.id, url: "parents.html?s="+id
                    });
                  }
                  if (info.started) await pushToShare(env, id, flt, { title: info.teamName+" — kickoff", body: "The game just started"+(info.opp?(" vs "+info.opp):"")+".", tag:"start-"+tid, url:"parents.html?s="+id });
                  if (info.ended) await pushToShare(env, id, flt, { title: info.teamName+" — full time", body: "The game has ended.", tag:"end-"+tid, url:"parents.html?s="+id });
                }
              })());
            }
          } catch (e) { /* never let notification logic break publishing */ }

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
          await env.GAMEDAY.delete("subs:" + id);
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
          scorer: String(f.scorer || "").slice(0, 64),
          assist: String(f.assist || "").slice(0, 64),
          minute: (typeof f.minute === "number" && isFinite(f.minute)) ? f.minute : null,
          period: (typeof f.period === "number" && isFinite(f.period)) ? (f.period | 0) : null,
          label: String(f.label || "").slice(0, 80),
          by: String(f.by || "").slice(0, 40),
        };
        const raw = await env.GAMEDAY.get("flags:" + id);
        let list = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(list)) list = [];
        list.push(clean);
        if (list.length > MAX_FLAGS) list = list.slice(list.length - MAX_FLAGS);
        await env.GAMEDAY.put("flags:" + id, JSON.stringify(list), { expirationTtl: TTL_SECONDS });

        // Notify the coach's device(s) that a flag came in.
        if (ctx && ctx.waitUntil) {
          const icon = clean.type==="goal"?"⚽":(clean.type==="sub"?"⇄":(clean.type==="tired"?"😓":(clean.type==="shot"?"🥅":(clean.type==="save"?"🧤":"•"))));
          ctx.waitUntil(pushToShare(env, id, s=>s.role==="coach", {
            title: icon+" New "+clean.type+" flag",
            body: (clean.by?clean.by+": ":"")+(clean.label||clean.type),
            tag: "flag", url: "index.html"
          }));
        }
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

      // ---- /vapid  → the public key browsers need to subscribe (open) ----
      if (parts[0] === "vapid" && parts.length === 1 && request.method === "GET") {
        const cfg = _vapidCfg(env);
        return json({ ok: true, publicKey: cfg ? cfg.pub : null, enabled: !!cfg });
      }

      // ---- /subscribe/:id  (open; a device registers for notifications on this share) ----
      // body: { subscription, role:"coach"|"follower", teamId? }
      // Coaches must prove the edit key (so only you can register as the coach recipient).
      if (parts[0] === "subscribe" && parts.length === 2) {
        const id = parts[1];
        if (!validId(id)) return bad("bad id");
        if (request.method !== "POST") return bad("method not allowed", 405);
        const snap = await env.GAMEDAY.get("snap:" + id);
        if (!snap) return bad("not found", 404);
        const body = await request.json().catch(() => null);
        if (!body || !body.subscription || !body.subscription.endpoint || !body.subscription.keys) return bad("missing subscription");
        const role = body.role === "coach" ? "coach" : "follower";
        if (role === "coach") {
          const rec = JSON.parse(snap);
          if (rec.editKeyHash !== await sha256Hex(request.headers.get("x-edit-key") || "")) return bad("wrong edit key", 403);
        }
        const entry = {
          sub: { endpoint: String(body.subscription.endpoint).slice(0, 512),
                 keys: { p256dh: String(body.subscription.keys.p256dh||"").slice(0,200),
                         auth: String(body.subscription.keys.auth||"").slice(0,100) } },
          role, teamId: String(body.teamId || "").slice(0, 64), at: Date.now()
        };
        const raw = await env.GAMEDAY.get("subs:" + id);
        let list = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(list)) list = [];
        // de-dupe by endpoint (a device re-subscribing updates its role/team)
        list = list.filter(s => s.sub.endpoint !== entry.sub.endpoint);
        list.push(entry);
        if (list.length > MAX_SUBS) list = list.slice(list.length - MAX_SUBS);
        await env.GAMEDAY.put("subs:" + id, JSON.stringify(list), { expirationTtl: TTL_SECONDS });
        return json({ ok: true });
      }

      // ---- /unsubscribe/:id  (open; remove a device by endpoint) ----
      if (parts[0] === "unsubscribe" && parts.length === 2) {
        const id = parts[1];
        if (!validId(id)) return bad("bad id");
        if (request.method !== "POST") return bad("method not allowed", 405);
        const body = await request.json().catch(() => null);
        if (!body || !body.endpoint) return bad("missing endpoint");
        const raw = await env.GAMEDAY.get("subs:" + id);
        if (raw) {
          let list = JSON.parse(raw);
          list = list.filter(s => s.sub.endpoint !== body.endpoint);
          await env.GAMEDAY.put("subs:" + id, JSON.stringify(list), { expirationTtl: TTL_SECONDS });
        }
        return json({ ok: true });
      }

      return bad("not found", 404);
    } catch (e) {
      return bad("server error: " + (e && e.message ? e.message : "unknown"), 500);
    }
  },
};
