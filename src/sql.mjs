// Centralized D1 SQL statements.
// D1 SQL 语句集中管理 — 改表名/字段时只需修改此处。

// ---- chat_user（用户表） ----
/** 按用户名查重（注册时用） */
export const SQL_USER_FIND_BY_NAME =
  "SELECT id FROM chat_user WHERE username = ?";

/** 插入新用户（注册时用） */
export const SQL_USER_INSERT =
  "INSERT INTO chat_user (username, password_hash, roles, created_at) VALUES (?, ?, ?, ?)";

/** 按用户名查询完整凭据（登录校验用） */
export const SQL_USER_FIND_WITH_CREDENTIALS =
  "SELECT id, username, password_hash, roles FROM chat_user WHERE username = ?";

// ---- chat_upload（上传文件表） ----
/** 插入一条上传记录 */
export const SQL_UPLOAD_INSERT = `INSERT INTO chat_upload
  (id, type, mime_type, filename, content, size, description, duration, uploaded_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** 删除指定上传记录 */
export const SQL_UPLOAD_DELETE = "DELETE FROM chat_upload WHERE id = ?";

/** 查询上传元数据（不含二进制内容） */
export const SQL_UPLOAD_META = `SELECT
  id, type, mime_type AS mimeType, filename, size, description, duration, uploaded_at AS uploadedAt
  FROM chat_upload WHERE id = ?`;

/** 查询上传二进制内容（Blob 响应用） */
export const SQL_UPLOAD_BLOB =
  "SELECT mime_type AS mimeType, filename, content FROM chat_upload WHERE id = ?";

// ---- chat_archive（消息归档表） ----
/** 写入一批归档消息 */
export const SQL_ARCHIVE_INSERT = `INSERT INTO chat_archive
  (room_id, batch_id, messages, archived_at) VALUES (?, ?, ?, ?)`;
