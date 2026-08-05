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
 * @param {string} [room]  Optional room name for scope
 * @returns {Promise<string>} JWT string
 */
export async function signToken(env, username, room) {
  const key = getKey(env);
  const payload = { sub: username };
  if (room) payload.room = room;
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
