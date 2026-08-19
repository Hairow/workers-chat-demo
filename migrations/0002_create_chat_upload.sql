-- Migration 0002: 创建上传文件表
-- 替代原 KV 方案（upload:<id> 元数据 + blob:<id> 二进制内容）
CREATE TABLE IF NOT EXISTS chat_upload (
  id TEXT PRIMARY KEY,          -- 上传 ID（UUID）
  type TEXT NOT NULL,           -- image / video / audio
  mime_type TEXT NOT NULL,      -- 原始 MIME 类型
  filename TEXT NOT NULL,       -- 原始文件名
  content BLOB NOT NULL,        -- 二进制内容
  size INTEGER NOT NULL,        -- 文件大小（字节）
  description TEXT NOT NULL DEFAULT '',  -- 描述（预留）
  duration REAL NOT NULL DEFAULT 0,     -- 音视频时长（秒），图片为 0
  uploaded_at INTEGER NOT NULL  -- 上传时间戳（毫秒）
);

-- 按类型/时间检索上传记录
CREATE INDEX IF NOT EXISTS idx_chat_upload_type_time
  ON chat_upload(type, uploaded_at);
