import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

function keyBytes(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, "base64");
  if (key.byteLength !== 32) throw new Error("commerce retention key must decode to 32 bytes");
  return key;
}

export function payloadHash(rawBody: Uint8Array): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

export function encryptWebhookPayload(rawBody: Uint8Array, keyBase64: string): Uint8Array {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(keyBase64), iv);
  const ciphertext = Buffer.concat([cipher.update(rawBody), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

export function decryptWebhookPayload(ciphertext: Uint8Array, keyBase64: string): Uint8Array {
  const buffer = Buffer.from(ciphertext);
  if (buffer.byteLength < IV_BYTES + TAG_BYTES) throw new Error("invalid retained payload");
  const iv = buffer.subarray(0, IV_BYTES);
  const tag = buffer.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const encrypted = buffer.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(keyBase64), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export function retentionExpiry(retentionClass: "transient_encrypted" | "unresolved_encrypted", now: Date): Date {
  const days = retentionClass === "transient_encrypted" ? 7 : 30;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}
