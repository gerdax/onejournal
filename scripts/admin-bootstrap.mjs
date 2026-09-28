/* Run once from a trusted terminal to create or rotate the GM invitation. */
import { randomBytes, createHash, createCipheriv } from "node:crypto";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const key = Buffer.from(process.env.ONEJOURNAL_ENCRYPTION_KEY || "", "base64");
const sqlMode = process.argv.includes('--sql');
if ((!sqlMode && (!url || !serviceKey)) || key.length !== 32) {
  console.error("Set a 32-byte base64 ONEJOURNAL_ENCRYPTION_KEY; for RPC mode also set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
async function rpc(name, body) {
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${name}: ${response.status} ${await response.text()}`);
  return response.json();
}
function encrypt(secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}
if (sqlMode) {
  const secret = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(secret).digest('hex');
  const ciphertext = encrypt(secret);
  const id = randomBytes(32).toString('base64url');
  console.log(`GM invitation secret: ${secret}`);
  console.log(`BEGIN;
SELECT id FROM onejournal_private.game WHERE id=1 FOR UPDATE;
UPDATE onejournal_private.access_links SET secret_hash='${hash}', encrypted_secret='${ciphertext}', version=version+1, active=true WHERE role='gm';
INSERT INTO onejournal_private.access_links(id,role,hero_id,secret_hash,encrypted_secret,version,active)
SELECT '${id}','gm',NULL,'${hash}','${ciphertext}',1,true
WHERE NOT EXISTS (SELECT 1 FROM onejournal_private.access_links WHERE role='gm');
UPDATE onejournal_private.game SET revision=revision+1 WHERE id=1;
COMMIT;`);
  process.exit(0);
}
for (let attempt = 0; attempt < 5; attempt++) {
  const doc = await rpc("onejournal_read", {});
  if (!doc || !doc.state) throw new Error("Apply the database migration first.");
  const secret = randomBytes(32).toString("base64url");
  const link = doc.links.find(item => item.role === "gm");
  if (link) {
    link.secretHash = createHash("sha256").update(secret).digest("hex");
    link.encryptedSecret = encrypt(secret);
    link.version++;
    link.active = true;
  } else {
    doc.links.push({ id: randomBytes(32).toString("base64url"), role: "gm", heroId: null,
      secretHash: createHash("sha256").update(secret).digest("hex"), encryptedSecret: encrypt(secret), version: 1, active: true });
  }
  const expected = doc.revision;
  doc.revision++;
  if (await rpc("onejournal_cas", { expected_revision: expected, document: doc, notify_public: false })) {
    console.log(`GM invitation secret: ${secret}`);
    console.log("Keep this secret private. Running bootstrap again rotates it and revokes previous GM grants.");
    process.exit(0);
  }
}
throw new Error("Concurrent game changes prevented bootstrap; retry.");
