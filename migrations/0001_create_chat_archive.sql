-- Migration 0001: 创建聊天归档表
-- 用于空房间定时归档：整批消息以 JSON 存入 messages 列
CREATE TABLE IF NOT EXISTS chat_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,            -- Durable Object ID（房间标识）
  batch_id TEXT NOT NULL,           -- 归档批次 ID（一般为归档时间 ISO 字符串）
  messages TEXT NOT NULL,           -- 整批消息 JSON 数组
  archived_at INTEGER NOT NULL      -- 归档时间戳（毫秒）
);

-- 按房间 + 时间检索归档
CREATE INDEX IF NOT EXISTS idx_chat_archive_room
  ON chat_archive(room_id, archived_at);
