// =======================================================================================
// JWT Authentication Module — powered by jose (Web Crypto API)
// JWT 认证模块 — 基于 jose（Web Crypto API）
//
// Tokens are signed/verified in the stateless Worker (index.mjs).
// The Durable Object receives the verified username via X-Verified-Name header.
// Token 在无状态 Worker（index.mjs）中签发/校验。
// Durable Object 通过 X-Verified-Name 头获取已验证的用户名。

import * as jose from "jose";

let cachedKey = null;

function getKey(env) {
  if (cachedKey) return cachedKey;
  const secret = env.JWT_SECRET || "dev-secret-change-in-production";
  cachedKey = new TextEncoder().encode(secret);
  return cachedKey;
}

/**
 * Sign a JWT for the given username.
 * 为指定用户签发 JWT。
 * @param {object} env   Worker environment (包含 JWT_SECRET)
 * @param {string} username
 * @param {string} [room]   Optional room name for scope
 * @param {object} [extra]  Extra claims to merge into the payload
 * @returns {Promise<string>} JWT string
 */
export async function signToken(env, username, room, extra = {}) {
  const key = getKey(env);
  const payload = { sub: username };
  if (room) payload.room = room;
  Object.assign(payload, extra);
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(key);
}

/**
 * Verify a JWT and return its payload.
 * 校验 JWT 并返回其 payload。
 * @param {object} env      Worker environment (包含 JWT_SECRET)
 * @param {string} token    JWT string to verify
 * @returns {Promise<object>}  Decoded payload, e.g. { sub: "alice", iat: ..., exp: ... }
 * @throws  {Error}          If token is invalid or expired
 */
export async function verifyToken(env, token) {
  const key = getKey(env);
  const { payload } = await jose.jwtVerify(token, key);
  return payload;
}

// =======================================================================================
// Password Hashing — PBKDF2-SHA256 via Web Crypto API
// 密码哈希 — 基于 Web Crypto API 的 PBKDF2-SHA256
//
// Stored format:  pbkdf2$<iterations>$<salt-b64>$<hash-b64>
// 存储格式：pbkdf2$<迭代次数>$<盐-base64>$<哈希-base64>
// =======================================================================================

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_KEY_BYTES = 32;

/** Derive an encryption key from the given raw key material and salt. */
async function deriveKey(password, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations,
    },
    keyMaterial,
    PBKDF2_KEY_BYTES * 8,
  );
}

/** Base64-encode raw bytes (ASCII-safe, matching btoa). */
function bytesToB64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Base64-decode into a Uint8Array. */
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Hash a plaintext password with a random salt.
 * 用随机盐哈希明文密码。
 * @param {string} password  Plaintext password 明文密码
 * @returns {Promise<string>}  Stored hash string 存储用的哈希字符串
 */
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const hash = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToB64(salt)}$${bytesToB64(new Uint8Array(hash))}`;
}

/**
 * Verify a plaintext password against a stored hash string.
 * 校验明文密码是否与存储的哈希匹配。
 * @param {string} password     Plaintext password 明文密码
 * @param {string} storedHash   Hash from hashPassword() hashPassword() 产出的哈希
 * @returns {Promise<boolean>}  true if it matches 匹配返回 true
 */
export async function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.startsWith("pbkdf2$")) return false;
  const [, iterStr, saltB64, hashB64] = storedHash.split("$");
  const iterations = Number(iterStr);
  if (!iterations || !saltB64 || !hashB64) return false;
  const salt = b64ToBytes(saltB64);
  const expected = b64ToBytes(hashB64);
  const actual = new Uint8Array(await deriveKey(password, salt, iterations));
  if (actual.length !== expected.length) return false;
  // Constant-time comparison 常量时间比较
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}
