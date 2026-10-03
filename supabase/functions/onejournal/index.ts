import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { Buffer } from "node:buffer";
import catalog from "./catalog.json" with { type: "json" };

// The existing browser modules also provide globals when evaluated by Deno.
(globalThis as any).window = globalThis;
await import("./_shared/state.js");
await import("./_shared/dice-rules.js");
await import("./_shared/server-core.js");
const { createServerCore } = (globalThis as any).OnejournalCore;
const url = Deno.env.get("SUPABASE_URL") || "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const encodedKey = Deno.env.get("ONEJOURNAL_ENCRYPTION_KEY") || "";
const key = Buffer.from(encodedKey, "base64");
if (key.length !== 32 || !url || !anonKey || !serviceKey) throw new Error("Missing Onejournal server configuration");
const origins = new Set((Deno.env.get("ONEJOURNAL_ALLOWED_ORIGINS") || "").split(",").map(x => x.trim()).filter(Boolean));

function encryptSecret(secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}
function decryptSecret(ciphertext: string) {
  const data = Buffer.from(ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
}
async function rpc(name: string, body: object) {
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Database ${name} failed (${response.status}): ${await response.text()}`);
  return response.json();
}
const repository = {
  get: () => rpc("onejournal_read", {}),
  compareAndSwap: (expected: number, document: object, publicChange: boolean) =>
    rpc("onejournal_cas", { expected_revision: expected, document, notify_public: publicChange })
};
const avatarBucket = "onejournal-avatars";
const avatarStorage = {
  async get(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid avatar id");
    const response = await fetch(`${url}/storage/v1/object/authenticated/${avatarBucket}/${id}.jpg`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      if ([400, 404].includes(response.status) && error?.error === "not_found" && error?.message === "Object not found") return null;
      throw new Error(`Avatar download failed (${response.status})`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 65536) throw new Error("Avatar exceeds size limit");
    return `data:image/jpeg;base64,${bytes.toString("base64")}`;
  },
  async put(id: string, dataUrl: string) {
    const previous = await this.get(id);
    if (previous) {
      if (previous !== dataUrl) throw new Error("Avatar hash collision");
      return;
    }
    const bytes = Buffer.from(dataUrl.slice(23), "base64");
    const response = await fetch(`${url}/storage/v1/object/${avatarBucket}/${id}.jpg`, {
      method: "POST", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000" },
      body: bytes
    });
    if (!response.ok) {
      if (await this.get(id) === dataUrl) return;
      throw new Error(`Avatar upload failed (${response.status}): ${await response.text()}`);
    }
  }
};
const mapBucket = "onejournal-maps";
const mapStorage = {
  async get(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid map image id");
    const response = await fetch(`${url}/storage/v1/object/authenticated/${mapBucket}/${id}.jpg`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      if ([400, 404].includes(response.status) && error?.error === "not_found" && error?.message === "Object not found") return null;
      throw new Error(`Map download failed (${response.status})`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 2 * 1024 * 1024) throw new Error("Map exceeds size limit");
    return `data:image/jpeg;base64,${bytes.toString("base64")}`;
  },
  async put(id: string, dataUrl: string) {
    const previous = await this.get(id);
    if (previous) {
      if (previous !== dataUrl) throw new Error("Map hash collision");
      return;
    }
    const bytes = Buffer.from(dataUrl.slice(23), "base64");
    const response = await fetch(`${url}/storage/v1/object/${mapBucket}/${id}.jpg`, {
      method: "POST", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000" },
      body: bytes
    });
    if (!response.ok) {
      if (await this.get(id) === dataUrl) return;
      throw new Error(`Map upload failed (${response.status}): ${await response.text()}`);
    }
  }
};
const travelMapBucket = "onejournal-travel-maps";
const travelMapStorage = {
  async getManifest() {
    const response = await fetch(`${url}/storage/v1/object/authenticated/${travelMapBucket}/manifest.json`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }, cache: "no-store"
    });
    if (!response.ok) throw new Error(`Travel map manifest download failed (${response.status})`);
    const text = await response.text();
    if (text.length > 16384) throw new Error("Travel map manifest exceeds size limit");
    return JSON.parse(text);
  },
  async get(path: string) {
    if (!/^(eriador|podrozy)-[a-f0-9]{64}\.jpg$/.test(path)) throw new Error("Invalid travel map path");
    const response = await fetch(`${url}/storage/v1/object/authenticated/${travelMapBucket}/${path}`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }, cache: "no-store"
    });
    if (!response.ok) throw new Error(`Travel map download failed (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 20 * 1024 * 1024) throw new Error("Travel map exceeds size limit");
    return `data:image/jpeg;base64,${bytes.toString("base64")}`;
  }
};
const core = createServerCore({
  repository, avatarStorage, mapStorage, travelMapStorage, catalog,
  hashSecret: (secret: string | Uint8Array) => createHash("sha256").update(secret).digest("hex"),
  randomSecret: () => randomBytes(32).toString("base64url"), encryptSecret, decryptSecret
});
const json = (body: unknown, status: number, headers: HeadersInit) => new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
async function limitedBody(request: Request) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 4 * 1024 * 1024) { await reader.cancel(); const error = new Error("Żądanie jest za duże."); (error as any).status = 413; throw error; }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

Deno.serve(async request => {
  const origin = request.headers.get("origin");
  const cors: Record<string, string> = { Vary: "Origin" };
  if (origin && !origins.has(origin)) return json({ error: "Niedozwolone źródło żądania." }, 403, cors);
  if (origin) {
    cors["Access-Control-Allow-Origin"] = origin;
    cors["Access-Control-Allow-Headers"] = "authorization, apikey, content-type, x-client-info";
    cors["Access-Control-Allow-Methods"] = "POST, OPTIONS";
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ error: "Niedozwolona metoda." }, 405, cors);
  try {
    const authorization = request.headers.get("authorization") || "";
    if (!authorization.startsWith("Bearer ")) return json({ error: "Wymagane logowanie." }, 401, cors);
    const bearer = authorization.slice(7);
    const auth = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anonKey, Authorization: `Bearer ${bearer}` } });
    if (!auth.ok) return json({ error: "Sesja wygasła." }, 401, cors);
    const user = await auth.json();
    if (typeof user.id !== "string") return json({ error: "Nieprawidłowa sesja." }, 401, cors);
    const declared = Number(request.headers.get("content-length") || 0);
    if (declared > 4 * 1024 * 1024) return json({ error: "Żądanie jest za duże." }, 413, cors);
    const bodyText = await limitedBody(request);
    let body;
    try { body = JSON.parse(bodyText); } catch { return json({ error: "Nieprawidłowy JSON." }, 400, cors); }
    const result = await core.handle(user.id, body);
    return json(result, 200, cors);
  } catch (error) {
    const status = [400, 401, 403, 409, 413].includes(error?.status) ? error.status : 500;
    if (status === 500) console.error(error);
    return json({ error: status === 500 ? "Błąd serwera." : error.message }, status, cors);
  }
});
