// This is the Edge Chat Demo Worker, built using Durable Objects!
// 这是使用 Durable Objects 构建的 Edge Chat 演示 Worker！

// ===============================
// Introduction to Modules
// 模块简介
// ===============================
//
// The first thing you might notice, if you are familiar with the Workers platform, is that this
// Worker is written differently from others you may have seen. It even has a different file
// extension. The `mjs` extension means this JavaScript is an ES Module, which, among other things,
// means it has imports and exports. Unlike other Workers, this code doesn't use
// `addEventListener("fetch", handler)` to register its main HTTP handler; instead, it _exports_
// a handler, as we'll see below.
// 如果你熟悉 Workers 平台，你可能会注意到这个 Worker 的写法和之前见过的不一样。它的文件扩展名也不同。
// `.mjs` 扩展名表示这是一个 ES 模块，意味着它有 import 和 export。
// 与其他 Worker 不同，这段代码没有使用 `addEventListener("fetch", handler)` 来注册 HTTP 处理器；
// 而是导出了一个处理器函数。
//
// This is a new way of writing Workers that we expect to introduce more broadly in the future. We
// like this syntax because it is *composable*: You can take two workers written this way and
// merge them into one worker, by importing the two Workers' exported handlers yourself, and then
// exporting a new handler that call into the other Workers as appropriate.
// 这是一种新的 Worker 编写方式，我们预计将来会广泛推广。我们喜欢这种语法因为它是可组合的：
// 你可以把两个以这种方式编写的 Worker 合并成一个，通过自己导入两个 Worker 的 handler，
// 然后导出一个新的 handler 来调用它们。
//
// This new syntax is required when using Durable Objects, because your Durable Objects are
// implemented by classes, and those classes need to be exported. The new syntax can be used for
// writing regular Workers (without Durable Objects) too, but for now, you must be in the Durable
// Objects beta to be able to use the new syntax, while we work out the quirks.
// 使用 Durable Objects 时必须使用这种新语法，因为 Durable Objects 是以类的方式实现的，
// 这些类需要被导出。新语法也可以用来编写普通的 Worker（不使用 Durable Objects），
// 但目前你需要加入 Durable Objects beta 才能使用。
//
// To see an example configuration for uploading module-based Workers, check out the wrangler.toml
// file or one of our Durable Object templates for Wrangler:
// 要查看基于模块的 Worker 上传配置示例，请参考 wrangler.toml 文件或以下模板：
//   * https://github.com/cloudflare/durable-objects-template
//   * https://github.com/cloudflare/durable-objects-rollup-esm
//   * https://github.com/cloudflare/durable-objects-webpack-commonjs

// ===============================
// Required Environment
// 所需的运行环境
// ===============================
//
// This worker, when deployed, must be configured with two environment bindings:
// * rooms: A Durable Object namespace binding mapped to the ChatRoom class.
// * limiters: A Durable Object namespace binding mapped to the RateLimiter class.
// 这个 Worker 部署时必须配置两个环境绑定：
// * rooms: 映射到 ChatRoom 类的 Durable Object 命名空间绑定。
// * limiters: 映射到 RateLimiter 类的 Durable Object 命名空间绑定。
//
// Incidentally, in pre-modules Workers syntax, "bindings" (like KV bindings, secrets, etc.)
// appeared in your script as global variables, but in the new modules syntax, this is no longer
// the case. Instead, bindings are now delivered in an "environment object" when an event handler
// (or Durable Object class constructor) is called. Look for the variable `env` below.
// 顺便提一下，在旧版的 Worker 语法中，绑定（如 KV 绑定、密钥等）会以全局变量的形式出现，
// 但在新模块语法中不再是这样的。现在绑定通过"环境对象"传递给事件处理器
//（或 Durable Object 类的构造函数）。详见下面的 `env` 变量。
//
// We made this change, again, for composability: The global scope is global, but if you want to
// call into existing code that has different environment requirements, then you need to be able
// to pass the environment as a parameter instead.
// 这个改动同样是为了可组合性：全局作用域是全局的，但如果你想调用已有代码，
// 而这些代码有不同的环境要求，你就需要把环境作为参数传递。
//
// Once again, see the wrangler.toml file to understand how the environment is configured.
// 再次说明，请查看 wrangler.toml 文件了解环境的配置方式。

// =======================================================================================
// The regular Worker part...
// 常规 Worker 部分...
//
// This section of the code implements a normal Worker that receives HTTP requests from external
// clients. This part is stateless.
// 这部分代码实现了接收外部 HTTP 请求的普通 Worker。这部分是无状态的。

import { handleErrors } from "./utils.mjs";
import { handleUpload, handleDeleteUpload, handleFileMeta, handleFileBlob } from "./upload.mjs";
import { signToken, verifyToken, hashPassword, verifyPassword } from "./auth.mjs";

// Re-export Durable Object classes so that Cloudflare can discover them.
// 重新导出 Durable Object 类，以便 Cloudflare 可以发现它们。
export { ChatRoom } from "./chat-room.mjs";
export { RateLimiter } from "./rate-limiter.mjs";

// In modules-syntax workers, we use `export default` to export our script's main event handlers.
// Here, we export one handler, `fetch`, for receiving HTTP requests. In pre-modules workers, the
// fetch handler was registered using `addEventHandler("fetch", event => { ... })`; this is just
// new syntax for essentially the same thing.
// 在模块语法 Worker 中，我们使用 `export default` 来导出脚本的主事件处理器。
// 这里导出了一个 `fetch` 处理器来接收 HTTP 请求。在旧版 Worker 中，
// fetch 处理器是通过 `addEventHandler("fetch", event => { ... })` 注册的；这只是新语法。
//
// `fetch` isn't the only handler. If your worker runs on a Cron schedule, it will receive calls
// to a handler named `scheduled`, which should be exported here in a similar way. We will be
// adding other handlers for other types of events over time.
// `fetch` 不是唯一的处理器。如果你的 Worker 按 Cron 定时任务运行，它会调用名为 `scheduled` 的处理器，
// 需要以类似方式导出。我们还会逐步添加其他类型的处理器。
export default {
  async fetch(request, env) {
    return await handleErrors(request, async () => {
      // We have received an HTTP request! Parse the URL and route the request.
      // 收到 HTTP 请求！解析 URL 并路由请求。

      let url = new URL(request.url);
      let path = url.pathname.slice(1).split('/');

      // 根路径重定向到 index.html
      if (url.pathname === '/') {
        return Response.redirect(url.origin + '/index.html', 302);
      }


      // API 路由
      switch (path[0]) {
        case "api":
          return handleApiRequest(path.slice(1), request, env);
        default:
          return new Response("Not found", { status: 404 });
      }
    });
  }
}

async function handleApiRequest(path, request, env) {
  // We've received at API request. Route the request based on the path.
  // 收到 API 请求。根据路径路由请求。

  switch (path[0]) {
    case "upload":
      // POST /api/upload — multipart form upload.
      return handleUpload(request, env);

    case "file": {
      // GET  /api/file/<id>/meta — return JSON metadata.
      // GET  /api/file/<id>/blob — serve binary content.
      // DELETE /api/file/<id>    — delete upload.
      let id = path[1];
      let action = path[2];
      if (request.method === "DELETE") return handleDeleteUpload(id, env);
      if (action === "meta") return handleFileMeta(id, env);
      if (action === "blob") return handleFileBlob(id, request, env);
      return new Response("Not found", { status: 404 });
    }

    case "rooms": {
      // GET /api/rooms — list all active rooms from KV.
      // Key format: room:<id> (private) or room:<id>-<name> (public).
      // 键格式：room:<id>（私密房间）或 room:<id>-<name>（公开房间）。
      let rooms = await env.CHAT_ROOMS.list({ prefix: "room:" });
      let result = rooms.keys.map(k => {
        let raw = k.name.slice(5);           // strip "room:"
        let dashIdx = raw.indexOf("-");
        if (dashIdx === -1) {
          // Private room: room:<id>
          return { id: raw, name: raw, private: true };
        } else {
          // Public room: room:<id>-<name>
          return { id: raw.slice(0, dashIdx), name: raw.slice(dashIdx + 1), private: false };
        }
      });
      return Response.json(result);
    }

    case "register": {
      // POST /api/register — create a user with a hashed password.
      // POST /api/register — 注册新用户，密码经 PBKDF2 哈希后入库。
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response("Invalid JSON", { status: 400 });
      }
      let name = (body.name || "").trim();
      let password = body.password || "";
      if (!name || name.length > 32) {
        return new Response("Invalid name", { status: 400 });
      }
      if (!password || password.length < 6) {
        return new Response("Password must be at least 6 characters", { status: 400 });
      }
      // 用户名查重
      let existing = await env.d1.prepare("SELECT id FROM chat_user WHERE username = ?").bind(name).first();
      if (existing) {
        return new Response("Username already taken", { status: 409 });
      }
      // 密码哈希后入库，默认角色 user
      let passwordHash = await hashPassword(password);
      await env.d1.prepare(
        "INSERT INTO chat_user (username, password_hash, roles, created_at) VALUES (?, ?, ?, ?)"
      ).bind(name, passwordHash, JSON.stringify(["user"]), Date.now()).run();
      return Response.json({ ok: true, username: name });
    }

    case "auth": {
      // POST /api/auth — verify username + password, then issue a JWT.
      // POST /api/auth — 校验用户名与密码，通过后签发 JWT。
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response("Invalid JSON", { status: 400 });
      }
      let name = (body.name || "").trim();
      let password = body.password || "";
      if (!name || name.length > 32) {
        return new Response("Invalid name", { status: 400 });
      }
      if (!password) {
        return new Response("Password required", { status: 400 });
      }
      // 查询用户并校验密码
      let user = await env.d1.prepare(
        "SELECT id, username, password_hash, roles FROM chat_user WHERE username = ?"
      ).bind(name).first();
      if (!user || !(await verifyPassword(password, user.password_hash))) {
        return new Response("Invalid username or password", { status: 401 });
      }
      let token = await signToken(env, user.username, undefined, {
        uid: user.id,
        roles: JSON.parse(user.roles || "[]"),
      });
      return Response.json({ token, uid: user.id, username: user.username, roles: JSON.parse(user.roles || "[]") });
    }

    case "room": {
      // Request for `/api/room/...`.
      // 请求 `/api/room/...`。

      if (!path[1]) {
        // The request is for just "/api/room", with no ID.
        // 请求的是 "/api/room"，没有 ID。
        if (request.method == "POST") {
          // Create a private room by generating a random, unguessable Durable Object ID.
          // The 64-char hex string acts as a "secret" room name — only those who know it can join.
          // 通过生成随机 Durable Object ID 创建私密房间。
          // 64 位十六进制字符串作为"秘密"房间名 — 只有知道它的人才能加入。
          let id = env.rooms.newUniqueId();
          return new Response(id.toString());
        } else {
          // If we wanted to support returning a list of public rooms, this might be a place to do
          // it. The list of room names might be a good thing to store in KV, though a singleton
          // Durable Object is also a possibility as long as the Cache API is used to cache reads.
          // (A caching layer would be needed because a single Durable Object is single-threaded,
          // so the amount of traffic it can handle is limited. Also, caching would improve latency
          // for users who don't happen to be located close to the singleton.)
          // 如果我们想支持返回公开房间列表，这里可以是一个实现的地方。
          // 房间名列表很适合存在 KV 中，不过也可以使用单例 Durable Object，
          // 前提是用 Cache API 来缓存读取结果。
          //（缓存层是必要的，因为单个 Durable Object 是单线程的，能处理的流量有限。
          // 另外缓存还能改善离单例较远的用户的延迟。）
          //
          // For this demo, though, we're not implementing a public room list, mainly because
          // inevitably some trolls would probably register a bunch of offensive room names. Sigh.
          // 不过在这个 Demo 中，我们没有实现公开房间列表，
          // 主要是考虑到总会有无聊的人注册一些冒犯性的房间名。唉。
          return new Response("Method not allowed", { status: 405 });
        }
      }

      // OK, the request is for `/api/room/<name>/...`. It's time to route to the Durable Object
      // for the specific room.
      // 请求是 `/api/room/<name>/...`。是时候路由到具体房间的 Durable Object 了。
      let name = path[1];

      // Each Durable Object has a 256-bit unique ID. IDs can be derived from string names, or
      // chosen randomly by the system.
      // 每个 Durable Object 有一个 256 位的唯一 ID。ID 可以从字符串名称派生，也可以由系统随机生成。
      let id;
      if (name.match(/^[0-9a-f]{64}$/)) {
        // The name is 64 hex digits, so let's assume it actually just encodes an ID. We use this
        // for private rooms. `idFromString()` simply parses the text as a hex encoding of the raw
        // ID (and verifies that this is a valid ID for this namespace).
        // 名称是 64 位十六进制，假设它直接编码了一个 ID。这用于私有房间。
        // `idFromString()` 将文本解析为原始 ID 的十六进制编码（并验证它是该命名空间的有效 ID）。
        id = env.rooms.idFromString(name);
      } else if (name.length <= 32) {
        // Treat as a string room name (limited to 32 characters). `idFromName()` consistently
        // derives an ID from a string.
        // 作为字符串房间名处理（限制 32 个字符）。`idFromName()` 从字符串一致地派生出 ID。
        id = env.rooms.idFromName(name);
      } else {
        return new Response("Name too long", { status: 404 });
      }

      // Get the Durable Object stub for this room! The stub is a client object that can be used
      // to send messages to the remote Durable Object instance. The stub is returned immediately;
      // there is no need to await it. This is important because you would not want to wait for
      // a network round trip before you could start sending requests. Since Durable Objects are
      // created on-demand when the ID is first used, there's nothing to wait for anyway; we know
      // an object will be available somewhere to receive our requests.
      // 获取这个房间的 Durable Object stub！stub 是一个客户端对象，用于向远程 Durable Object 实例发送消息。
      // stub 会立即返回，无需 await。这一点很重要，因为你不想在发送请求之前等待网络往返。
      // 由于 Durable Objects 是在 ID 首次被使用时按需创建的，实际上也没什么可等待的；
      // 我们确信某处会有一个对象来接收我们的请求。
      let roomObject = env.rooms.get(id);

      // Compute a new URL with `/api/room/<name>` removed. We'll forward the rest of the path
      // to the Durable Object.
      // 计算去掉 `/api/room/<name>` 后的新 URL。我们将把剩余路径转发给 Durable Object。
      let newUrl = new URL(request.url);
      newUrl.pathname = "/" + path.slice(2).join("/");

      // Send the request to the object. The `fetch()` method of a Durable Object stub has the
      // same signature as the global `fetch()` function, but the request is always sent to the
      // object, regardless of the request's URL.
      // 将请求发送给该对象。Durable Object stub 的 `fetch()` 方法和全局 `fetch()` 函数签名相同，
      // 但请求总是发送给该对象，与请求的 URL 无关。 
      // 真正的聊天室是在fetch第一次被调用时，Cloudflare 才在全球边缘节点上启动一个 ChatRoom 实例

      // For WebSocket connections, verify JWT and attach the verified username.
      // 对 WebSocket 连接，校验 JWT 并附加已验证的用户名。
      if (path[2] === "create") {
        // Store room info in KV when someone joins (i.e. room becomes active).
        // 当有人通过 WebSocket 加入房间时，将房间信息写入 KV。
        // Value 为 JSON 对象；仅当 key 不存在时新建，已存在则不覆盖（保留首次创建信息）。
        let hex = id.toString();
        let isPrivate = !!name.match(/^[0-9a-f]{64}$/);
        let key = isPrivate
          ? `room:${hex}`           // private: name is the 64-char hex ID
          : `room:${hex}-${name}`;  // public: store both id and name

        let existing = await env.CHAT_ROOMS.get(key);
        if (!existing) {
          let roomInfo = {
            id: hex,
            name,
            private: isPrivate,
            createdAt: new Date().toISOString()
          };
          await env.CHAT_ROOMS.put(key, JSON.stringify(roomInfo));
        }

        // Verify JWT token from query parameter.
        // 从查询参数中校验 JWT。
        let token = newUrl.searchParams.get("token");
        if (!token) {
          return new Response("Missing token", { status: 401 });
        }
        let payload;
        try {
          payload = await verifyToken(env, token);
        } catch (e) {
          return new Response("Invalid or expired token", { status: 401 });
        }
        if (!payload.sub) {
          return new Response("Invalid token: missing subject", { status: 401 });
        }

        // Forward the request with the verified username in a header.
        // 将请求转发给 DO，并附加已验证的用户名到头中。
        let verifiedRequest = new Request(newUrl, request);
        verifiedRequest.headers.set("X-Verified-Name", payload.sub);
        console.debug('before room fetch')
        return roomObject.fetch(newUrl, verifiedRequest);
      }

      return roomObject.fetch(newUrl, request);
    }

    default:
      return new Response("Not found", { status: 404 });
  }
}
