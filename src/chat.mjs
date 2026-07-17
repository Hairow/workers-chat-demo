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

// With the introduction of modules, we're experimenting with allowing text/data blobs to be
// uploaded and exposed as synthetic modules. In wrangler.toml we specify a rule that files ending
// in .html should be uploaded as "Data", equivalent to content-type `application/octet-stream`.
// So when we import it as `HTML` here, we get the HTML content as an `ArrayBuffer`. This lets us
// serve our app's static asset without relying on any separate storage. (However, the space
// available for assets served this way is very limited; larger sites should continue to use Workers
// KV to serve assets.)
// 随着模块语法的引入，我们尝试允许将文本/数据块作为合成模块上传和暴露。
// 在 wrangler.toml 中我们指定规则：以 .html 结尾的文件应该以 "Data" 类型上传，
// 相当于 content-type 为 `application/octet-stream`。
// 因此在这里我们将其作为 `HTML` 导入，得到 `ArrayBuffer` 类型的 HTML 内容。
// 这样不需要依赖任何单独的存储就能提供静态资源服务。
//（但这种方式可用的空间非常有限；大型站点仍应使用 Workers KV 来提供资源。）
import HTML from "./chat.html";

// `handleErrors()` is a little utility function that can wrap an HTTP request handler in a
// try/catch and return errors to the client. You probably wouldn't want to use this in production
// code but it is convenient when debugging and iterating.
// `handleErrors()` 是一个小工具函数，用 try/catch 包装 HTTP 请求处理器并将错误返回给客户端。
// 你可能不想在生产代码中使用它，但在调试和迭代时很方便。
async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    if (request.headers.get("Upgrade") == "websocket") {
      // Annoyingly, if we return an HTTP error in response to a WebSocket request, Chrome devtools
      // won't show us the response body! So... let's send a WebSocket response with an error
      // frame instead.
      // 烦人的是，如果对 WebSocket 请求返回 HTTP 错误，Chrome 开发者工具不会显示响应体！
      // 所以......我们改为发送一个带错误帧的 WebSocket 响应。
      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({ error: err.stack }));
      pair[1].close(1011, "Uncaught exception during session setup");
      return new Response(null, { status: 101, webSocket: pair[0] });
    } else {
      return new Response(err.stack, { status: 500 });
    }
  }
}

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

      if (!path[0]) {
        // Serve our HTML at the root path.
        // 在根路径提供 HTML 页面。
        return new Response(HTML, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
      }

      switch (path[0]) {
        case "api":
          // This is a request for `/api/...`, call the API handler.
          // 这是一个 `/api/...` 请求，调用 API 处理器。
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
    case "room": {
      // Request for `/api/room/...`.
      // 请求 `/api/room/...`。

      if (!path[1]) {
        // The request is for just "/api/room", with no ID.
        // 请求的是 "/api/room"，没有 ID。
        if (request.method == "POST") {
          // POST to /api/room creates a private room.
          // POST 到 /api/room 创建一个私有房间。
          //
          // Incidentally, this code doesn't actually store anything. It just generates a valid
          // unique ID for this namespace. Each durable object namespace has its own ID space, but
          // IDs from one namespace are not valid for any other.
          // 实际上这段代码并不存储任何东西。它只是为这个命名空间生成一个有效的唯一 ID。
          // 每个 Durable Object 命名空间拥有独立的 ID 空间，一个命名空间的 ID 对其他命名空间无效。
          //
          // The IDs returned by `newUniqueId()` are unguessable, so are a valid way to implement
          // "anyone with the link can access" sharing. Additionally, IDs generated this way have
          // a performance benefit over IDs generated from names: When a unique ID is generated,
          // the system knows it is unique without having to communicate with the rest of the
          // world -- i.e., there is no way that someone in the UK and someone in New Zealand
          // could coincidentally create the same ID at the same time, because unique IDs are,
          // well, unique!
          // `newUniqueId()` 返回的 ID 是不可猜测的，适合实现"持有链接即可访问"的分享方式。
          // 此外，这种方式生成的 ID 比从名称派生的 ID 在性能上更优：生成唯一 ID 时，
          // 系统无需与外界通信就能确定其唯一性——即，不会出现英国和新西兰的两个人
          // 同时意外创建出相同 ID 的情况，因为唯一 ID 就是唯一的！
          let id = env.rooms.newUniqueId();
          return new Response(id.toString(), { headers: { "Access-Control-Allow-Origin": "*" } });
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
      return roomObject.fetch(newUrl, request);
    }

    default:
      return new Response("Not found", { status: 404 });
  }
}

// =======================================================================================
// The ChatRoom Durable Object Class
// ChatRoom Durable Object 类

// ChatRoom implements a Durable Object that coordinates an individual chat room. Participants
// connect to the room using WebSockets, and the room broadcasts messages from each participant
// to all others.
// ChatRoom 实现了一个协调单个聊天室的 Durable Object。
// 参与者通过 WebSocket 连接到房间，房间将每个参与者的消息广播给所有人。
export class ChatRoom {
  constructor(state, env) {
    this.state = state

    // `state.storage` provides access to our durable storage. It provides a simple KV
    // get()/put() interface.
    // `state.storage` 提供对持久化存储的访问，带有简单的 KV get()/put() 接口。
    this.storage = state.storage;

    // `env` is our environment bindings (discussed earlier).
    // `env` 是我们的环境绑定（前面讨论过）。
    this.env = env;

    // We will track metadata for each client WebSocket object in `sessions`.
    // 我们将用 `sessions` 跟踪每个客户端 WebSocket 对象的元数据。
    this.sessions = new Map();
    this.state.getWebSockets().forEach((webSocket) => {
      // The constructor may have been called when waking up from hibernation,
      // so get previously serialized metadata for any existing WebSockets.
      // 构造函数可能在从休眠中唤醒时被调用，因此需要获取之前序列化的 WebSocket 元数据。
      let meta = webSocket.deserializeAttachment();

      // Set up our rate limiter client.
      // The client itself can't have been in the attachment, because structured clone doesn't work on functions.
      // DO ids aren't cloneable, restore the ID from its hex string
      // 设置限流客户端。
      // 客户端本身不能存储在 attachment 中，因为 structured clone 不适用于函数。
      // DO id 不可克隆，从十六进制字符串恢复 ID。
      let limiterId = this.env.limiters.idFromString(meta.limiterId);
      let limiter = new RateLimiterClient(
        () => this.env.limiters.get(limiterId),
        err => webSocket.close(1011, err.stack));

      // We don't send any messages to the client until it has sent us the initial user info
      // message. Until then, we will queue messages in `session.blockedMessages`.
      // This could have been arbitrarily large, so we won't put it in the attachment.
      // 在客户端发送初始用户信息消息之前，我们不会向它发送任何消息。
      // 在那之前，消息会被暂存到 `session.blockedMessages` 队列中。
      // 这些消息可能非常大，所以不放在 attachment 中。
      let blockedMessages = [];
      this.sessions.set(webSocket, { ...meta, limiter, blockedMessages });
    });

    // We keep track of the last-seen message's timestamp just so that we can assign monotonically
    // increasing timestamps even if multiple messages arrive simultaneously (see below). There's
    // no need to store this to disk since we assume if the object is destroyed and recreated, much
    // more than a millisecond will have gone by.
    // 我们跟踪最后一条消息的时间戳，以便在同时收到多条消息时也能分配单调递增的时间戳（见下文）。
    // 不需要存入磁盘，因为假设对象被销毁重建时，时间差远超一毫秒。
    this.lastTimestamp = 0;
  }

  // The system will call fetch() whenever an HTTP request is sent to this Object. Such requests
  // can only be sent from other Worker code, such as the code above; these requests don't come
  // directly from the internet. In the future, we will support other formats than HTTP for these
  // communications, but we started with HTTP for its familiarity.
  // 当有 HTTP 请求发送到这个对象时，系统会调用 fetch()。这类请求只能从其他 Worker 代码发出，
  // 如上面的代码；这些请求不会直接来自互联网。未来我们会支持 HTTP 以外的通信格式，
  // 但目前从熟悉的 HTTP 开始。
  async fetch(request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);

      switch (url.pathname) {
        case "/websocket": {
          // The request is to `/api/room/<name>/websocket`. A client is trying to establish a new
          // WebSocket session.
          // 请求是 `/api/room/<name>/websocket`。客户端正在尝试建立新的 WebSocket 会话。
          if (request.headers.get("Upgrade") != "websocket") {
            return new Response("expected websocket", { status: 400 });
          }

          // Get the client's IP address for use with the rate limiter.
          // 获取客户端 IP 地址用于限流。
          let ip = request.headers.get("CF-Connecting-IP");

          // To accept the WebSocket request, we create a WebSocketPair (which is like a socketpair,
          // i.e. two WebSockets that talk to each other), we return one end of the pair in the
          // response, and we operate on the other end. Note that this API is not part of the
          // Fetch API standard; unfortunately, the Fetch API / Service Workers specs do not define
          // any way to act as a WebSocket server today.
          // 为了接受 WebSocket 请求，我们创建一个 WebSocketPair（类似 socketpair，即两个可以互相通信的 WebSocket），
          // 将其中一端返回到响应中，另一端由我们操作。注意这个 API 并非 Fetch API 标准的一部分，
          // 不幸的是 Fetch API / Service Workers 规范目前还没有定义作为 WebSocket 服务器的方式。
          let pair = new WebSocketPair();

          // We're going to take pair[1] as our end, and return pair[0] to the client.
          // 我们将 pair[1] 作为服务端，pair[0] 返回给客户端。
          await this.handleSession(pair[1], ip);

          // Now we return the other end of the pair to the client.
          // 现在将 pair 的另一端返回给客户端。
          return new Response(null, { status: 101, webSocket: pair[0] });
        }

        default:
          return new Response("Not found", { status: 404 });
      }
    });
  }

  // handleSession() implements our WebSocket-based chat protocol.
  // handleSession() 实现基于 WebSocket 的聊天协议。
  async handleSession(webSocket, ip) {
    // Accept our end of the WebSocket. This tells the runtime that we'll be terminating the
    // WebSocket in JavaScript, not sending it elsewhere.
    // 接受 WebSocket 的服务端。这告诉运行时我们会在 JavaScript 中处理 WebSocket，而不是转发到其他地方。
    this.state.acceptWebSocket(webSocket);

    // Set up our rate limiter client.
    // 设置限流客户端。
    let limiterId = this.env.limiters.idFromName(ip);
    let limiter = new RateLimiterClient(
      () => this.env.limiters.get(limiterId),
      err => webSocket.close(1011, err.stack));

    // Create our session and add it to the sessions map.
    // 创建 session 并加入 sessions map。
    let session = { limiterId, limiter, blockedMessages: [] };
    // attach limiterId to the webSocket so it survives hibernation
    // 将 limiterId 附加到 webSocket 上，使其在休眠时也能保留
    webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), limiterId: limiterId.toString() });
    this.sessions.set(webSocket, session);

    // Queue "join" messages for all online users, to populate the client's roster.
    // 为所有在线用户排队 "join" 消息，以填充客户端的在线名单。
    for (let otherSession of this.sessions.values()) {
      if (otherSession.name) {
        session.blockedMessages.push(JSON.stringify({ joined: otherSession.name }));
      }
    }

    // Load the last 100 messages from the chat history stored on disk, and send them to the
    // client.
    // 从磁盘加载最近 100 条聊天记录，发给客户端。
    let storage = await this.storage.list({ reverse: true, limit: 100 });
    let backlog = [...storage.values()];
    backlog.reverse();
    backlog.forEach(value => {
      session.blockedMessages.push(value);
    });
  }

  async webSocketMessage(webSocket, msg) {
    try {
      let session = this.sessions.get(webSocket);
      if (session.quit) {
        // Whoops, when trying to send to this WebSocket in the past, it threw an exception and
        // we marked it broken. But somehow we got another message? I guess try sending a
        // close(), which might throw, in which case we'll try to send an error, which will also
        // throw, and whatever, at least we won't accept the message. (This probably can't
        // actually happen. This is defensive coding.)
        // 糟糕，之前尝试向这个 WebSocket 发送消息时抛出了异常，我们标记它为broken。
        // 但现在又收到了新消息？尝试发送 close()，可能会再次抛出异常，
        // 那我们就发 error，也可能抛异常，但至少我们不会接受这条消息。
        //（实际上这不太可能发生。这是防御性编程。）
        webSocket.close(1011, "WebSocket broken.");
        return;
      }

      // Check if the user is over their rate limit and reject the message if so.
      // 检查用户是否请求过于频繁，如果是则拒绝消息。
      if (!session.limiter.checkLimit()) {
        webSocket.send(JSON.stringify({
          error: "Your IP is being rate-limited, please try again later."
        }));
        return;
      }

      // I guess we'll use JSON.
      // 我们使用 JSON 格式。
      let data = JSON.parse(msg);

      if (!session.name) {
        // The first message the client sends is the user info message with their name. Save it
        // into their session object.
        // 客户端发送的第一条消息是带有用户名的用户信息。把它保存到 session 对象中。
        session.name = "" + (data.name || "anonymous");
        // attach name to the webSocket so it survives hibernation
        // 将 name 附加到 webSocket，使其在休眠时也能保留
        webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), name: session.name });

        // Don't let people use ridiculously long names. (This is also enforced on the client,
        // so if they get here they are not using the intended client.)
        // 不允许使用过长的用户名。（客户端也做了限制，所以能走到这里说明没有使用预期客户端。）
        if (session.name.length > 32) {
          webSocket.send(JSON.stringify({ error: "Name too long." }));
          webSocket.close(1009, "Name too long.");
          return;
        }

        // Deliver all the messages we queued up since the user connected.
        // 下发用户连接后积压的所有消息。
        session.blockedMessages.forEach(queued => {
          webSocket.send(queued);
        });
        delete session.blockedMessages;

        // Broadcast to all other connections that this user has joined.
        // 向所有其他连接广播该用户已加入。
        this.broadcast({ joined: session.name });

        webSocket.send(JSON.stringify({ ready: true }));
        return;
      }

      // Construct sanitized message for storage and broadcast.
      // 构建清洗后的消息用于存储和广播。
      data = { name: session.name, message: "" + data.message };

      // Block people from sending overly long messages. This is also enforced on the client,
      // so to trigger this the user must be bypassing the client code.
      // 禁止发送过长的消息。客户端也做了限制，所以能触发这个说明用户绕过了客户端代码。
      if (data.message.length > 256) {
        webSocket.send(JSON.stringify({ error: "Message too long." }));
        return;
      }

      // Add timestamp. Here's where this.lastTimestamp comes in -- if we receive a bunch of
      // messages at the same time (or if the clock somehow goes backwards????), we'll assign
      // them sequential timestamps, so at least the ordering is maintained.
      // 添加时间戳。这里用到了 this.lastTimestamp——如果我们同时收到多条消息
      //（或者时钟莫名倒退了？？？？），我们会分配顺序递增的时间戳，至少保持了消息顺序。
      data.timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
      this.lastTimestamp = data.timestamp;

      // Broadcast the message to all other WebSockets.
      // 将消息广播给所有其他 WebSocket。
      let dataStr = JSON.stringify(data);
      this.broadcast(dataStr);

      // Save message.
      // 保存消息。
      let key = new Date(data.timestamp).toISOString();
      await this.storage.put(key, dataStr);

      // Keep only the last 100 messages to prevent unbounded storage growth.
      // Durable Object storage is limited to 1 GiB per instance.
      // 只保留最近 100 条消息，防止存储无限增长。每个 Durable Object 实例存储上限为 1 GiB。
      let allKeys = [...(await this.storage.list()).keys()];
      if (allKeys.length > 100) {
        // Keys are ISO timestamps, so lexicographic sort = chronological sort.
        // Delete all but the newest 100.
        // 键是 ISO 时间戳，字典序排序 = 时间顺序排序。删除除最新 100 条外的所有数据。
        let keysToDelete = allKeys.sort().slice(0, allKeys.length - 100);
        await Promise.all(keysToDelete.map(k => this.storage.delete(k)));
      }
    } catch (err) {
      // Report any exceptions directly back to the client. As with our handleErrors() this
      // probably isn't what you'd want to do in production, but it's convenient when testing.
      // 直接将异常返回给客户端。和 handleErrors() 一样，这在生产环境中可能不太合适，但测试时很方便。
      webSocket.send(JSON.stringify({ error: err.stack }));
    }
  }

  // On "close" and "error" events, remove the WebSocket from the sessions list and broadcast
  // a quit message.
  // 当 "close" 和 "error" 事件发生时，从 sessions 列表移除 WebSocket 并广播退出消息。
  async closeOrErrorHandler(webSocket) {
    let session = this.sessions.get(webSocket) || {};
    session.quit = true;
    this.sessions.delete(webSocket);
    if (session.name) {
      this.broadcast({ quit: session.name });
    }
  }

  async webSocketClose(webSocket, code, reason, wasClean) {
    this.closeOrErrorHandler(webSocket)
  }

  async webSocketError(webSocket, error) {
    this.closeOrErrorHandler(webSocket)
  }

  // broadcast() broadcasts a message to all clients.
  // broadcast() 向所有客户端广播消息。
  broadcast(message) {
    // Apply JSON if we weren't given a string to start with.
    // 如果传进来不是字符串，做 JSON 序列化。
    if (typeof message !== "string") {
      message = JSON.stringify(message);
    }

    // Iterate over all the sessions sending them messages.
    // 遍历所有 session 发送消息。
    let quitters = [];
    this.sessions.forEach((session, webSocket) => {
      if (session.name) {
        try {
          webSocket.send(message);
        } catch (err) {
          // Whoops, this connection is dead. Remove it from the map and arrange to notify
          // everyone below.
          // 糟糕，这个连接已断开。从 map 中移除并安排通知所有人。
          session.quit = true;
          quitters.push(session);
          this.sessions.delete(webSocket);
        }
      } else {
        // This session hasn't sent the initial user info message yet, so we're not sending them
        // messages yet (no secret lurking!). Queue the message to be sent later.
        // 这个 session 还没有发送初始用户信息消息，所以暂时不发消息给它（不偷看！）。
        // 将消息排队等待稍后发送。
        session.blockedMessages.push(message);
      }
    });

    quitters.forEach(quitter => {
      if (quitter.name) {
        this.broadcast({ quit: quitter.name });
      }
    });
  }
}

// =======================================================================================
// The RateLimiter Durable Object class.
// RateLimiter Durable Object 类。

// RateLimiter implements a Durable Object that tracks the frequency of messages from a particular
// source and decides when messages should be dropped because the source is sending too many
// messages.
// RateLimiter 实现了一个 Durable Object，用于跟踪特定来源的消息频率，
// 当来源发送过多消息时决定丢弃消息。
//
// We utilize this in ChatRoom, above, to apply a per-IP-address rate limit. These limits are
// global, i.e. they apply across all chat rooms, so if a user spams one chat room, they will find
// themselves rate limited in all other chat rooms simultaneously.
// 我们在上面的 ChatRoom 中使用它来实现每 IP 地址的速率限制。该限制是全局的，
// 即跨所有聊天室生效，因此如果用户在某个聊天室刷屏，他们会在所有聊天室同时被限流。
export class RateLimiter {
  constructor(state, env) {
    // Timestamp at which this IP will next be allowed to send a message. Start in the distant
    // past, i.e. the IP can send a message now.
    // 这个 IP 下一次被允许发消息的时间戳。初始设为远在过去，即 IP 现在可以发送消息。
    this.nextAllowedTime = 0;
  }

  // Our protocol is: POST when the IP performs an action, or GET to simply read the current limit.
  // Either way, the result is the number of seconds to wait before allowing the IP to perform its
  // next action.
  // 我们的协议是：IP 执行操作时发 POST，或者 GET 仅读取当前限制。
  // 无论哪种方式，返回值都是允许 IP 执行下一个操作前需要等待的秒数。
  async fetch(request) {
    return await handleErrors(request, async () => {
      let now = Date.now() / 1000;

      this.nextAllowedTime = Math.max(now, this.nextAllowedTime);

      if (request.method == "POST") {
        // POST request means the user performed an action.
        // We allow one action per 5 seconds.
        // POST 请求表示用户执行了一个操作。我们每 5 秒允许一次操作。
        this.nextAllowedTime += 5;
      }

      // Return the number of seconds that the client needs to wait.
      //
      // We provide a "grace" period of 20 seconds, meaning that the client can make 4-5 requests
      // in a quick burst before they start being limited.
      // 返回客户端需要等待的秒数。
      // 我们提供 20 秒的"缓冲期"，意味着客户端可以在短时间内连续发送 4-5 次请求后才开始被限制。
      let cooldown = Math.max(0, this.nextAllowedTime - now - 20);
      return new Response(cooldown);
    })
  }
}

// RateLimiterClient implements rate limiting logic on the caller's side.
// RateLimiterClient 在调用方实现限流逻辑。
class RateLimiterClient {
  // The constructor takes two functions:
  // * getLimiterStub() returns a new Durable Object stub for the RateLimiter object that manages
  //   the limit. This may be called multiple times as needed to reconnect, if the connection is
  //   lost.
  // * reportError(err) is called when something goes wrong and the rate limiter is broken. It
  //   should probably disconnect the client, so that they can reconnect and start over.
  // 构造函数接受两个函数：
  // * getLimiterStub() 返回管理限流的 RateLimiter Durable Object stub。
  //   如果连接丢失，可能会被多次调用来重新连接。
  // * reportError(err) 在出现错误时限流器损坏时调用。它应该断开客户端连接以便重新连接。
  constructor(getLimiterStub, reportError) {
    this.getLimiterStub = getLimiterStub;
    this.reportError = reportError;

    // Call the callback to get the initial stub.
    // 调用回调获取初始 stub。
    this.limiter = getLimiterStub();

    // When `inCooldown` is true, the rate limit is currently applied and checkLimit() will return
    // false.
    // 当 `inCooldown` 为 true 时，表示正在限流中，checkLimit() 将返回 false。
    this.inCooldown = false;
  }

  // Call checkLimit() when a message is received to decide if it should be blocked due to the
  // rate limit. Returns `true` if the message should be accepted, `false` to reject.
  // 收到消息时调用 checkLimit() 来决定是否因限流阻止该消息。
  // 返回 `true` 表示接受消息，`false` 表示拒绝。
  checkLimit() {
    if (this.inCooldown) {
      return false;
    }
    this.inCooldown = true;
    this.callLimiter();
    return true;
  }

  // callLimiter() is an internal method which talks to the rate limiter.
  // callLimiter() 是与 rate limiter 通信的内部方法。
  async callLimiter() {
    try {
      let response;
      try {
        // Currently, fetch() needs a valid URL even though it's not actually going to the
        // internet. We may loosen this in the future to accept an arbitrary string. But for now,
        // we have to provide a dummy URL that will be ignored at the other end anyway.
        // 目前 fetch() 需要有效的 URL，即使实际上不会访问互联网。未来可能会放宽为接受任意字符串。
        // 但现在我们还是要提供一个虚拟 URL，另一端会忽略它。
        response = await this.limiter.fetch("https://dummy-url", { method: "POST" });
      } catch (err) {
        // `fetch()` threw an exception. This is probably because the limiter has been
        // disconnected. Stubs implement E-order semantics, meaning that calls to the same stub
        // are delivered to the remote object in order, until the stub becomes disconnected, after
        // which point all further calls fail. This guarantee makes a lot of complex interaction
        // patterns easier, but it means we must be prepared for the occasional disconnect, as
        // networks are inherently unreliable.
        //
        // Anyway, get a new limiter and try again. If it fails again, something else is probably
        // wrong.
        // `fetch()` 抛出了异常。这可能是因为 limiter 已断开连接。
        // Stub 实现了 E-order 语义，意味着对同一个 stub 的调用会按顺序到达远端对象，
        // 直到 stub 断开连接，之后所有调用都会失败。
        // 这个保证让很多复杂的交互模式更简单，但也意味着我们需要处理偶尔的断开情况，
        // 因为网络本质上是不可靠的。
        // 总之，获取新的 limiter 并重试。如果再失败，可能是有其他问题。
        this.limiter = this.getLimiterStub();
        response = await this.limiter.fetch("https://dummy-url", { method: "POST" });
      }

      // The response indicates how long we want to pause before accepting more requests.
      // 响应指示在接受更多请求之前需要暂停多长时间。
      let cooldown = +(await response.text());
      await new Promise(resolve => setTimeout(resolve, cooldown * 1000));

      // Done waiting.
      // 等待完成。
      this.inCooldown = false;
    } catch (err) {
      this.reportError(err);
    }
  }
}
