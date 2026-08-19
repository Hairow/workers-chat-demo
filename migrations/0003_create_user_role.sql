-- Migration 0003: 创建用户表与角色表
-- 表名以 chat_ 开头并沿用单数约定（chat_archive / chat_upload / chat_user / chat_role）
CREATE TABLE IF NOT EXISTS chat_user (
  id TEXT PRIMARY KEY,                  -- 用户 ID（UUID）
  username TEXT NOT NULL UNIQUE,        -- 用户名
  password_hash TEXT NOT NULL DEFAULT '', -- 密码哈希（预留，当前 demo 用 JWT 未启用密码）
  roles TEXT NOT NULL DEFAULT '[]',     -- 角色数组 JSON，如 ["admin","user"]
  created_at INTEGER NOT NULL           -- 创建时间戳（毫秒）
);

CREATE TABLE IF NOT EXISTS chat_role (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,            -- 角色名：admin / user
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL           -- 创建时间戳（毫秒）
);

-- 预置默认角色
INSERT INTO chat_role (name, description, created_at) VALUES
  ('admin', '管理员', 0),
  ('user',  '普通用户', 0);
