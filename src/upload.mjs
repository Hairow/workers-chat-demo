// Upload handler — stores images / videos in D1.
// 上传处理器 — 将图片/视频存储到 D1。
//
// 每条上传在 D1 的 uploads 表中产生一条记录：
//   chat_upload(id, type, mime_type, filename, content BLOB, size, description, duration, uploaded_at)
// 元数据与二进制内容合并在同一行。

const MAX_SIZE = 20 * 1024 * 1024; // 20 MB

function generateId() {
  return crypto.randomUUID();
}

/** Handle POST /api/upload — multipart file upload. */
export async function handleUpload(request, env) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "Invalid form data" }, { status: 400 });
  }

  let file = formData.get("file");
  if (!file || typeof file === "string") {
    return Response.json({ error: "No file uploaded" }, { status: 400 });
  }

  // Validate MIME type.
  let mimeType = file.type;
  if (!mimeType.startsWith("image/") && !mimeType.startsWith("video/") && !mimeType.startsWith("audio/")) {
    return Response.json({ error: "Only image, video, and audio files are allowed" }, { status: 400 });
  }

  // Validate size.
  if (file.size > MAX_SIZE) {
    return Response.json({ error: "File too large (max 20 MB)" }, { status: 413 });
  }

  // Read file as ArrayBuffer.
  let arrayBuffer = await file.arrayBuffer();

  // Generate id.
  let id = generateId();

  // Determine type.
  let type = mimeType.startsWith("image/") ? "image"
    : mimeType.startsWith("video/") ? "video"
      : "audio";

  // Optional duration (seconds) — only meaningful for audio / video.
  let duration = parseFloat(formData.get("duration")) || 0;

  // Store in D1 (content as BLOB, metadata columns alongside).
  await env.d1
    .prepare(
      `INSERT INTO chat_upload (id, type, mime_type, filename, content, size, description, duration, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      type,
      mimeType,
      file.name || "unnamed",
      new Uint8Array(arrayBuffer),
      file.size,
      "",
      type !== "image" ? duration : 0,
      Date.now()
    )
    .run();

  return Response.json({ id, type, mimeType, filename: file.name, size: file.size, duration });
}

/** Handle DELETE /api/file/<id> — delete upload record from D1. */
export async function handleDeleteUpload(id, env) {
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  await env.d1
    .prepare(`DELETE FROM chat_upload WHERE id = ?`)
    .bind(id)
    .run();

  return Response.json({ success: true });
}

/** Shared helper — load upload metadata by id. */
async function getMetadata(id, env) {
  let row = await env.d1
    .prepare(
      `SELECT id, type, mime_type AS mimeType, filename, size, description, duration, uploaded_at AS uploadedAt
       FROM chat_upload WHERE id = ?`
    )
    .bind(id)
    .first();
  return row || null;
}

/** Handle GET /api/file/<id>/meta — return JSON metadata. */
export async function handleFileMeta(id, env) {
  if (!id) return Response.json({ error: "Missing file id" }, { status: 400 });

  let metadata = await getMetadata(id, env);
  if (!metadata) return Response.json({ error: "File not found" }, { status: 404 });

  return Response.json(metadata);
}

/** Handle GET /api/file/<id>/blob — serve the binary file content. */
export async function handleFileBlob(id, request, env) {
  if (!id) return Response.json({ error: "Missing file id" }, { status: 400 });

  let row = await env.d1
    .prepare(`SELECT mime_type AS mimeType, filename, content FROM chat_upload WHERE id = ?`)
    .bind(id)
    .first();
  if (!row) return Response.json({ error: "File not found" }, { status: 404 });

  // D1 BLOB 列读取返回 ArrayBuffer，转成 Uint8Array 以便 subarray 切片（Range 请求）
  let content = new Uint8Array(row.content);
  if (!content || content.byteLength === 0) {
    return Response.json({ error: "File content not found" }, { status: 404 });
  }
  let total = content.byteLength;

  // Support range requests for video seeking.
  let rangeHeader = request.headers.get("Range");

  if (rangeHeader) {
    let match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      let start = parseInt(match[1], 10);
      let end = match[2] ? parseInt(match[2], 10) : total - 1;
      end = Math.min(end, total - 1);

      if (start < 0 || start >= total || end < start) {
        return Response.json({ error: "Range Not Satisfiable" }, {
          status: 416,
          headers: { "Content-Range": `bytes */${total}` },
        });
      }

      let sliced = content.subarray(start, end + 1);
      return new Response(sliced, {
        status: 206,
        headers: {
          "Content-Type": row.mimeType,
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Content-Length": sliced.byteLength.toString(),
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }
  }

  return new Response(content, {
    headers: {
      "Content-Type": row.mimeType,
      "Content-Length": total.toString(),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Disposition": `inline; filename="${row.filename}"`,
    },
  });
}
