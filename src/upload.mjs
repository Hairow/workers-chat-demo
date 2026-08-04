// Upload handler — stores images / videos in KV.
// 上传处理器 — 将图片/视频存储到 KV。
//
// Two records per upload:
//   upload:<id> → JSON { type, mimeType, filename, contentKey, size, uploadedAt }
//   blob:<id>   → ArrayBuffer (binary content)
// 每条上传产生两条记录。

const MAX_SIZE = 20 * 1024 * 1024; // 20 MB

function generateId() {
  return crypto.randomUUID();
}

/** Handle POST /api/upload — multipart file upload. */
export async function handleUpload(request, env) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return new Response("Invalid form data", { status: 400 });
  }

  let file = formData.get("file");
  if (!file || typeof file === "string") {
    return new Response("No file uploaded", { status: 400 });
  }

  // Validate MIME type.
  let mimeType = file.type;
  if (!mimeType.startsWith("image/") && !mimeType.startsWith("video/") && !mimeType.startsWith("audio/")) {
    return new Response("Only image, video, and audio files are allowed", { status: 400 });
  }

  // Validate size.
  if (file.size > MAX_SIZE) {
    return new Response("File too large (max 20 MB)", { status: 413 });
  }

  // Read file as ArrayBuffer.
  let arrayBuffer = await file.arrayBuffer();

  // Generate keys.
  let id = generateId();
  let metaKey = `upload:${id}`;
  let blobKey = `blob:${id}`;

  // Determine type.
  let type = mimeType.startsWith("image/") ? "image"
            : mimeType.startsWith("video/") ? "video"
            : "audio";

  // Optional duration (seconds) — only meaningful for audio / video.
  let duration = parseFloat(formData.get("duration")) || 0;

  // Build metadata JSON.
  let metadata = {
    type,
    mimeType,
    filename: file.name || "unnamed",
    contentKey: blobKey,
    size: file.size,
    description: "",
    duration: type !== "image" ? duration : 0,
    uploadedAt: Date.now(),
  };

  // Store both records in KV in parallel.
  await Promise.all([
    env.CHAT_ROOMS.put(metaKey, JSON.stringify(metadata)),
    env.CHAT_ROOMS.put(blobKey, arrayBuffer),
  ]);

  return Response.json({ id, type, mimeType, filename: file.name, size: file.size, duration });
}

/** Shared helper — load upload metadata by id. */
async function getMetadata(id, env) {
  let metaStr = await env.CHAT_ROOMS.get(`upload:${id}`);
  if (!metaStr) return null;
  return JSON.parse(metaStr);
}

/** Handle GET /api/file/<id>/meta — return JSON metadata. */
export async function handleFileMeta(id, env) {
  if (!id) return new Response("Missing file id", { status: 400 });

  let metadata = await getMetadata(id, env);
  if (!metadata) return new Response("File not found", { status: 404 });

  return Response.json(metadata);
}

/** Handle GET /api/file/<id>/blob — serve the binary file content. */
export async function handleFileBlob(id, request, env) {
  if (!id) return new Response("Missing file id", { status: 400 });

  let metadata = await getMetadata(id, env);
  if (!metadata) return new Response("File not found", { status: 404 });

  let blobKey = metadata.contentKey;
  let arrayBuffer = await env.CHAT_ROOMS.get(blobKey, { type: "arrayBuffer" });
  if (!arrayBuffer) return new Response("File content not found", { status: 404 });

  // Support range requests for video seeking.
  let rangeHeader = request.headers.get("Range");
  let total = arrayBuffer.byteLength;

  if (rangeHeader) {
    let match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      let start = parseInt(match[1], 10);
      let end = match[2] ? parseInt(match[2], 10) : total - 1;
      end = Math.min(end, total - 1);

      if (start < 0 || start >= total || end < start) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: { "Content-Range": `bytes */${total}` },
        });
      }

      let sliced = arrayBuffer.slice(start, end + 1);
      return new Response(sliced, {
        status: 206,
        headers: {
          "Content-Type": metadata.mimeType,
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Content-Length": sliced.byteLength.toString(),
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }
  }

  return new Response(arrayBuffer, {
    headers: {
      "Content-Type": metadata.mimeType,
      "Content-Length": total.toString(),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Disposition": `inline; filename="${metadata.filename}"`,
    },
  });
}
