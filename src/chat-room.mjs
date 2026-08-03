// =======================================================================================
// The ChatRoom Durable Object Class
// ChatRoom Durable Object 类

import { handleErrors } from "./utils.mjs";
import { RateLimiterClient } from "./rate-limiter.mjs";

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
        case "/": {
          // DELETE /api/room/<name> — delete the room and all its data.
          if (request.method === "DELETE") {
            // Notify all connected users that the room is being deleted.
            this.broadcast({ quit: "Room deleted by admin." });
            // Close all WebSocket connections.
            this.state.getWebSockets().forEach(ws => ws.close(1001, "Room deleted"));
            this.sessions.clear();
            // Delete all stored messages.
            await this.storage.deleteAll();
            return new Response("Room deleted");
          }
          return new Response("Method not allowed", { status: 405 });
        }

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
    let session = { limiterId, limiter, blockedMessages: [], ip };
    // attach limiterId, name, ip to the webSocket so they survive hibernation
    // 将 limiterId、name、ip 附加到 webSocket，使其在休眠时也能保留
    webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), limiterId: limiterId.toString(), ip });
    this.sessions.set(webSocket, session);

    // Queue "join" messages for all online users, to populate the client's roster.
    // 为所有在线用户排队 "join" 消息，以填充客户端的在线名单。
    for (let otherSession of this.sessions.values()) {
      if (otherSession.name) {
        session.blockedMessages.push(JSON.stringify({ joined: otherSession.name, ip: otherSession.ip }));
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
        this.broadcast({ joined: session.name, ip: session.ip });

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

      // Keep only the last 1000 messages to prevent unbounded storage growth.
      // Durable Object storage is limited to 1 GiB per instance.
      // 只保留最近 1000 条消息，防止存储无限增长。每个 Durable Object 实例存储上限为 1 GiB。
      let allKeys = [...(await this.storage.list()).keys()];
      if (allKeys.length > 1000) {
        // Keys are ISO timestamps, so lexicographic sort = chronological sort.
        // Delete all but the newest 1000.
        // 键是 ISO 时间戳，字典序排序 = 时间顺序排序。删除除最新 1000 条外的所有数据。
        let keysToDelete = allKeys.sort().slice(0, allKeys.length - 1000);
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
      this.broadcast({ quit: session.name, ip: session.ip });
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
        this.broadcast({ quit: quitter.name, ip: quitter.ip });
      }
    });
  }
}
