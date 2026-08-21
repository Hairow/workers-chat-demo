// HTTP handlers for user registration & login.
// 用户注册与登录的 HTTP 处理器。
//
// Dependencies:
//   auth.mjs — JWT 签发 / 密码哈希校验
//   sql.mjs  — D1 SQL 语句常量

import { signToken, hashPassword, verifyPassword } from "./auth.mjs";
import {
  SQL_USER_FIND_BY_NAME,
  SQL_USER_INSERT,
  SQL_USER_FIND_WITH_CREDENTIALS,
} from "./sql.mjs";

/**
 * Handle POST /api/register — create a user with a hashed password.
 * 处理 POST /api/register — 注册新用户，密码经 PBKDF2 哈希后入库。
 */
export async function handleRegister(request, env) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  let body;
  try { body = await request.json(); } catch (e) {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  let name = (body.name || "").trim();
  let password = body.password || "";
  if (!name || name.length > 32) {
    return Response.json({ error: "Invalid name" }, { status: 400 });
  }
  if (!password || password.length < 6) {
    return Response.json({ error: "Password must be at least 6 characters" }, { status: 400 });
  }
  // 用户名查重
  let existing = await env.d1
    .prepare(SQL_USER_FIND_BY_NAME)
    .bind(name)
    .first();
  if (existing) {
    return Response.json({ error: "Username already taken" }, { status: 409 });
  }
  // 密码哈希后入库，默认角色 user
  let passwordHash = await hashPassword(password);
  await env.d1
    .prepare(SQL_USER_INSERT)
    .bind(name, passwordHash, JSON.stringify(["user"]), Date.now())
    .run();
  return Response.json({ ok: true, username: name });
}

/**
 * Handle POST /api/auth — verify username + password, then issue a JWT.
 * 处理 POST /api/auth — 校验用户名与密码，通过后签发 JWT。
 */
export async function handleAuth(request, env) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  let body;
  try { body = await request.json(); } catch (e) {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  let name = (body.name || "").trim();
  let password = body.password || "";
  if (!name || name.length > 32) {
    return Response.json({ error: "Invalid name" }, { status: 400 });
  }
  if (!password) {
    return Response.json({ error: "Password required" }, { status: 400 });
  }
  // 查询用户并校验密码
  let user = await env.d1.prepare(SQL_USER_FIND_WITH_CREDENTIALS).bind(name).first();
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return Response.json({ error: "Invalid username or password" }, { status: 401 });
  }
  let token = await signToken(env, user.username, undefined, {
    uid: user.id,
    roles: JSON.parse(user.roles || "[]"),
  });
  return Response.json({ token, uid: user.id, username: user.username, roles: JSON.parse(user.roles || "[]") });
}
