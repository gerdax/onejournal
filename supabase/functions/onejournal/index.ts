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
const core = createServerCore({
  repository, catalog,
  hashSecret: (secret: string) => createHash("sha256").update(secret).digest("hex"),
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
    if (bytes > 1024 * 1024) { await reader.cancel(); const error = new Error("Żądanie jest za duże."); (error as any).status = 413; throw error; }
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
    if (declared > 1024 * 1024) return json({ error: "Żądanie jest za duże." }, 413, cors);
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
