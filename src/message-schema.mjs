// Message type schemas defining required and optional fields in the `body`.
// 消息类型 schema，定义 `body` 中的必填和可选字段。
// replyTo is an optional field on every type, allowing any message to reference another.
// replyTo 是所有类型的可选字段，允许任意消息引用另一条消息。
export const MESSAGE_SCHEMAS = {
  text: { required: ["text"], optional: ["replyTo"], maxLen: { text: 2048 } },
  image: { required: ["uploadId"], optional: ["filename", "mimeType", "size", "replyTo"], maxLen: { filename: 256 } },
  audio: { required: ["uploadId"], optional: ["duration", "filename", "mimeType", "size", "replyTo"], maxLen: { filename: 256 } },
  video: { required: ["uploadId"], optional: ["duration", "filename", "mimeType", "size", "replyTo"], maxLen: { filename: 256 } },
  location: { required: ["lat", "lng", "name"], optional: ["replyTo"], maxLen: { name: 128 } },
  'call-user': { required: ['targetUserId'], optional: [], maxLen: {} },
  'call-rejected': { required: ['targetUserId'], optional: [], maxLen: {} },
  'call-accepted': { required: ['targetUserId', 'callId'], optional: [], maxLen: {} },
  'webrtc-offer': { required: ['targetUserId', 'sdp'], optional: ['callId'], maxLen: {} },
  'webrtc-answer': { required: ['targetUserId', 'sdp'], optional: ['callId'], maxLen: {} },
  'webrtc-ice': { required: ['targetUserId', 'candidates'], optional: ['callId'], maxLen: {} },
  hangup: { required: ['targetUserId'], optional: ['callId'], maxLen: {} },
  // 文件传输信令
  'file-transfer-request': { required: ['targetUserId', 'fileId', 'filename', 'fileSize', 'fileType', 'totalChunks'], optional: [], maxLen: { filename: 256 } },
  'file-transfer-accept': { required: ['targetUserId', 'fileId'], optional: [], maxLen: {} },
  'file-transfer-reject': { required: ['targetUserId', 'fileId'], optional: [], maxLen: {} },
  'file-offer': { required: ['targetUserId', 'sdp'], optional: ['fileId'], maxLen: {} },
  'file-answer': { required: ['targetUserId', 'sdp'], optional: ['fileId'], maxLen: {} },
  'file-ice': { required: ['targetUserId', 'candidates'], optional: ['fileId'], maxLen: {} },
  'file-transfer-complete': { required: ['targetUserId', 'fileId'], optional: [], maxLen: {} },

}

// Validate a message according to its type schema.
// 根据类型 schema 校验消息。
export function validateMessage(type, body) {
  let schema = MESSAGE_SCHEMAS[type];
  if (!schema) return "Unknown message type: " + type;

  // Check required fields.
  // 校验必填字段。
  for (let field of schema.required) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      return "Missing required field '" + field + "' for type '" + type + "'";
    }
  }

  // Build allowed fields set: required + optional.
  // 构建允许的字段集合。
  let allowed = new Set([...schema.required, ...(schema.optional || [])]);
  for (let field of Object.keys(body)) {
    if (!allowed.has(field)) {
      return "Unexpected field '" + field + "' for type '" + type + "'";
    }
  }

  // Check max lengths.
  // 校验最大长度。
  let maxLen = schema.maxLen || {};
  for (let [field, max] of Object.entries(maxLen)) {
    if (body[field] && typeof body[field] === "string" && body[field].length > max) {
      return "Field '" + field + "' exceeds max length of " + max;
    }
  }

  return null; // valid / 有效
}
