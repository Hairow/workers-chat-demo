-- Migration 0004: chat_user.id 由 TEXT(UUID) 改为 INTEGER 自增
-- SQLite 不支持 ALTER COLUMN 修改列类型，采用重建表方式：
--   建新表 → 拷贝数据 → 删除旧表 → 重命名
-- 注意：原 UUID 无法映射为数字，重建时按插入顺序重新分配自增 id，
--       旧 id 对应的外键引用（如 chat_upload.created_by，尚未启用）需另行处理。
CREATE TABLE IF NOT EXISTS chat_user_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT, -- 用户 ID（自增整数）
  username TEXT NOT NULL UNIQUE,        -- 用户名
  password_hash TEXT NOT NULL DEFAULT '', -- 密码哈希（预留）
  roles TEXT NOT NULL DEFAULT '[]',     -- 角色数组 JSON
  created_at INTEGER NOT NULL           -- 创建时间戳（毫秒）
);

INSERT INTO chat_user_new (username, password_hash, roles, created_at)
  SELECT username, password_hash, roles, created_at FROM chat_user;

DROP TABLE chat_user;
ALTER TABLE chat_user_new RENAME TO chat_user;
