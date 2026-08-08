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

    // 存储每个用户的 WebRTC 连接状态（可选）
    this.callStates = new Map(); // callId -> { caller, callee, state, ... }

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
      // 休眠恢复时，所有连接都已完成认证，blockedMessages 不再需要队列。
      // meta 中已包含 userId（从 attachment 反序列化），直接存入 session
      this.sessions.set(webSocket, { ...meta, limiter });
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

          // Read the verified username from the header set by the Worker.
          // 从 Worker 设置的头中读取已验证的用户名。
          let verifiedName = request.headers.get("X-Verified-Name") || null;

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
          await this.handleSession(pair[1], ip, verifiedName);

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
  //
  // If verifiedName is provided (authenticated via JWT), the session is named immediately and
  // the client does not need to send a name message. (Only via index.mjs which verifies the token.)
  // 如果提供了 verifiedName（通过 JWT 认证），session 立即命名，客户端无需发送名称消息。
  async handleSession(webSocket, ip, verifiedName) {
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
    // Apply the verified name BEFORE any async operation, so that webSocketMessage
    // (which may fire during await below) sees a named session and skips the
    // "first message = name" fallback that would overwrite it as "anonymous".
    // 创建 session 并加入 sessions map。
    // 在所有异步操作之前应用已验证的用户名，这样在 await 期间触发的
    // webSocketMessage 会看到已命名的 session，跳过会把名字覆盖为 "anonymous" 的降级逻辑。
    let session = { limiterId, limiter, blockedMessages: [], ip };
    if (verifiedName) {
      session.name = verifiedName;
    }

    session.userId = crypto.randomUUID();

    // attach limiterId, name, ip, userId to the webSocket so they survive hibernation
    // 将 limiterId、ip、name、userId 附加到 webSocket，使其在休眠时也能保留
    webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), limiterId: limiterId.toString(), ip, name: session.name, userId: session.userId });
    this.sessions.set(webSocket, session);

    // Queue "join" messages for all OTHER online users, to populate the client's roster.
    // The new session itself is excluded — its own join is broadcast separately below.
    // 为所有其他在线用户排队 "join" 消息，以填充客户端的在线名单。
    // 排除新会话自身 — 自己的 join 由后面的 broadcast 单独发送。
    for (let otherSession of this.sessions.values()) {
      if (otherSession.name && otherSession !== session) {
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

    // If the user is already named (JWT-auth'd), flush blocked messages and send ready now.
    // 如果用户已命名（JWT 认证），立即刷新阻塞消息并发送 ready。
    if (verifiedName) {
      for (let msg of session.blockedMessages) {
        webSocket.send(msg);
      }
      delete session.blockedMessages;
      webSocket.send(JSON.stringify({ ready: true, name: verifiedName }));

      // Broadcast join to other users.
      // 向其他用户广播加入消息。
      this.broadcast({ joined: verifiedName, ip, userId: session.userId });

    }
  }

  // Message type schemas defining required and optional fields in the `body`.
  // 消息类型 schema，定义 `body` 中的必填和可选字段。
  // replyTo is an optional field on every type, allowing any message to reference another.
  // replyTo 是所有类型的可选字段，允许任意消息引用另一条消息。
  static MESSAGE_SCHEMAS = {
    text: { required: ["text"], optional: ["replyTo"], maxLen: { text: 2048 } },
    image: { required: ["uploadId"], optional: ["filename", "mimeType", "size", "replyTo"], maxLen: { filename: 256 } },
    audio: { required: ["uploadId"], optional: ["duration", "filename", "mimeType", "size", "replyTo"], maxLen: { filename: 256 } },
    video: { required: ["uploadId"], optional: ["duration", "filename", "mimeType", "size", "replyTo"], maxLen: { filename: 256 } },
    location: { required: ["lat", "lng", "name"], optional: ["replyTo"], maxLen: { name: 128 } },
    'call-user': { required: ['targetUserId'], optional: [], maxLen: {} },
    'call-rejected': { required: ['targetUserId'], optional: [], maxLen: {} },
    'call-accepted': { required: ['targetUserId', 'callId'], optional: [], maxLen: {} },
    'webrtc-offer': { required: ['targetUserId', 'sdp'], optional: [], maxLen: {} },
    'webrtc-answer': { required: ['targetUserId', 'sdp'], optional: [], maxLen: {} },
    'webrtc-ice': { required: ['targetUserId', 'candidate'], optional: [], maxLen: {} },
    hangup: { required: ['targetUserId'], optional: [], maxLen: {} },

  }

  // Validate a message according to its type schema.
  // 根据类型 schema 校验消息。
  static validateMessage(type, body) {
    let schema = ChatRoom.MESSAGE_SCHEMAS[type];
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

  async webSocketMessage(webSocket, msg) {
    try {
      let session = this.sessions.get(webSocket);
      if (session.quit) {
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

      let data = JSON.parse(msg);

      let type = data.type;
      let body = data.body;

      if (!type || !body) {
        webSocket.send(JSON.stringify({ error: "Missing 'type' or 'body' in message." }));
        return;
      }

      // Validate the message against its type schema.
      // 根据类型 schema 校验消息。
      let validationErr = ChatRoom.validateMessage(type, body);
      if (validationErr) {
        webSocket.send(JSON.stringify({ error: validationErr }));
        return;
      }

      //处理不同类型的消息包括转发WebRTC
      switch (data.type) {
        case 'text':
        case 'image':
        case 'audio':
        case 'video':
        case 'location':
          await this.handleCommonMsg(webSocket, data)
          break;
        case 'call-user':
          // 发起通话请求
          await this.handleCallRequest(data, webSocket);
          break;
        case 'call-accepted':
          // 接受通话请求
          await this.handleCallAccepted(data, webSocket);
          break;
        case 'call-rejected':
          //  处理拒绝
          await this.handleCallRejected(data, webSocket);
          break;
        case 'webrtc-offer':
        case 'webrtc-answer':
        case 'webrtc-ice':
          // WebRTC 信令转发（只转发给目标用户）
          await this.forwardWebRTCSignal(data, webSocket);
          break;
        case 'hangup':
          // 挂断通知
          await this.broadcastHangup(data, webSocket);
          break;
        default:
          console.warn('未知消息类型:', data.type);
      }

    } catch (err) {
      webSocket.send(JSON.stringify({ error: err.stack }));
    }
  }

  //处理普通消息 非WebRTC
  async handleCommonMsg(websocket, data) {
    let session = this.sessions.get(websocket);
    // Determine message type from the typed-schema payload.
    // 从类型化 schema 中获取消息类型。
    let type = data.type;
    let body = data.body;

    // Sanitize all string body fields.
    // 清洗所有字符串 body 字段。
    let sanitizedBody = {};
    for (let [k, v] of Object.entries(body)) {
      sanitizedBody[k] = typeof v === "string" ? "" + v : v;
    }
    body = sanitizedBody;

    // Sanitize replyTo if present on any message type.
    // 任何消息类型如果携带 replyTo，清洗其内容。
    if (body.replyTo) {
      body.replyTo.name = "" + (body.replyTo.name || "unknown");
      body.replyTo.text = "" + (body.replyTo.text || "");
      if (body.replyTo.text.length > 512) {
        body.replyTo.text = body.replyTo.text.slice(0, 512);
      }
    }

    // Add timestamp.
    // 添加时间戳。
    data.timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    this.lastTimestamp = data.timestamp;

    // Assemble the final message envelope.
    // 组装最终消息信封。
    let envelope = {
      type: type,
      sender: { name: session.name, ip: session.ip },
      timestamp: data.timestamp,
      body: body,
    };

    let dataStr = JSON.stringify(envelope);
    this.broadcast(dataStr);

    // Save message.
    // 保存消息。
    let key = new Date(data.timestamp).toISOString();
    await this.storage.put(key, dataStr);

    // Keep only the last 1000 messages (check every 100 messages to avoid blocking).
    // 只保留最近 1000 条消息（每 100 条检查一次，减少阻塞）。
    this._msgCount = (this._msgCount || 0) + 1;
    if (this._msgCount % 100 === 0) {
      let allKeys = [...(await this.storage.list()).keys()];
      if (allKeys.length > 1000) {
        let keysToDelete = allKeys.sort().slice(0, allKeys.length - 1000);
        await Promise.all(keysToDelete.map(k => this.storage.delete(k)));
      }
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
        if (session.blockedMessages) {
          // Session is named (JWT) but blockedMessages haven't been flushed yet.
          // Queue here so that real-time messages don't jump ahead of history,
          // which would cause the client's timestamp-based dedup to discard history.
          // Session 已命名但 blockedMessages 尚未刷新，排队以保证实时消息
          // 不会插在历史消息前面，避免客户端时间戳去重丢弃历史。
          session.blockedMessages.push(message);
        } else {
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

  // === 处理通话请求 ===
  async handleCallRequest(data, senderWs) {
    const callerSession = this.sessions.get(senderWs);
    const fromUserId = callerSession.userId;
    const fromUserName = callerSession.name;
    const targetUserId = data.body.targetUserId;
    const callId = crypto.randomUUID();

    // 直接按 userId 查找目标
    let targetWs = null;
    for (const [ws, s] of this.sessions) {
      if (s.userId === targetUserId && ws.readyState === WebSocket.OPEN) {
        targetWs = ws;
        break;
      }
    }

    if (!targetWs) return;

    const callState = {
      id: callId,
      caller: fromUserId,
      callee: targetUserId,
      state: 'calling', // calling  | accepted | rejected | cancelled | timeout | connected | ended
      offerSent: false,
      offerTimestamp: null,
      answerSent: false,
      answerTimestamp: null,
    }

    targetWs.send(JSON.stringify({
      type: 'incoming-call',
      body: {
        fromUserId: fromUserId,
        fromUserName: fromUserName,
        callId: callId,
      }
    }));
    this.callStates.set(callId, callState);
  }

  // === 处理接受呼叫 ===
  async handleCallAccepted(data, senderWs) {
    // data 格式: { type: 'call-accepted', body:{targetUserId: 'xxx' }  }
    const fromUserId = this.sessions.get(senderWs).userId;
    const targetUserId = data.body.targetUserId;
    const callId = data.body.callId;

    const callState = this.callStates.get(callId);
    if (!callState) {
      console.warn('⚠️ 呼叫不存在:', callId);
      return;
    }

    if (callState.callee !== fromUserId) {
      senderWs.send(JSON.stringify({
        type: 'error',
        body: {
          error: '只有被叫方可以接受呼叫'
        }
      }));
      return;
    }

    for (const [ws, s] of this.sessions) {
      if (s.userId === targetUserId && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'call-accepted',
          body: {
            ...data.body,
            fromUserId: fromUserId,
          }
        }));
        // 更新状态为 accepted
        callState.state = 'accepted';
        callState.acceptedTimestamp = Date.now();
        return;
      }
    }
  }

  // === 处理拒绝呼叫 ===
  async handleCallRejected(data, senderWs) {
    // data 格式: { type: 'call-rejected', body:{targetUserId: 'xxx' }  }
    const fromUserId = this.sessions.get(senderWs).userId;
    const targetUserId = data.body.targetUserId;
    const reason = data.body.reason || 'rejected'; // 可选：'busy', 'timeout', 'declined'

    for (const [ws, s] of this.sessions) {
      if (s.userId === targetUserId && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'call-rejected',
          body: {
            ...data.body,
            fromUserId: fromUserId,
          }
        }));
        return;
      }
    }
  }


  // === 转发 WebRTC 信令 ===
  async forwardWebRTCSignal(data, senderWs) {
    // data 格式: { type: 'webrtc-offer', body:{targetUserId: 'xxx', sdp: {...}}  }
    // data 格式: { type: 'webrtc-answer', body:{targetUserId: 'xxx', sdp: {...}}  }
    // data 格式: { type: 'webrtc-ice', body:{targetUserId: 'xxx', candidate: 'xxx'}  }

    const fromUserId = this.sessions.get(senderWs).userId;
    const targetUserId = data.body.targetUserId;
    const callId = data.body.callId;
    const callState = this.callStates.get(callId);

    if (data.type == 'webrtc-offer') {
      if (!callState) {
        senderWs.send(JSON.stringify({
          type: 'offer-error',
          body: {
            error: '呼叫不存在',
            callId: callId
          }
        }));
        return;
      }
      if (callState.caller !== fromUserId) {
        senderWs.send(JSON.stringify({
          type: 'offer-error',
          body: {
            error: '只有主叫方可以发送 Offer',
            callId: callId
          }
        }));
        return;
      }
      if (callState.state !== 'accepted') {
        const stateMap = {
          'calling': '对方还未接听',
          'rejected': '对方已拒绝',
          'cancelled': '已取消',
          'connected': '已连接',
          'ended': '已结束'
        };
        senderWs.send(JSON.stringify({
          type: 'offer-error',
          body: {
            error: `状态错误: ${stateMap[callState.state] || callState.state}`,
            callId: callId
          }
        }));
        return;
      }
      if (callState.offerSent) {
        senderWs.send(JSON.stringify({
          type: 'offer-error',
          body: {
            error: '已经发送过 Offer，请勿重复发送',
            callId: callId
          }
        }));
        return;
      }

    } else if (data.type == 'webrtc-answer') {
      if (!callState) {
        senderWs.send(JSON.stringify({
          type: 'offer-error',
          body: {
            error: '呼叫不存在',
            callId: callId
          }
        }));
        return;
      }
      if (callState.callee !== fromUserId) {
        senderWs.send(JSON.stringify({
          type: 'offer-error',
          body: {
            error: '只有被叫方可以发送 Answer',
            callId: callId
          }
        }));
        return;
      }
      if (!callState.offerSent) {
        senderWs.send(JSON.stringify({
          type: 'answer-error',
          body: {
            error: '尚未收到 Offer，请等待',
            callId: callId
          }
        }));
        return;
      }
      if (callState.state === 'connected') {
        console.warn('已连接，忽略重复的 Answer');
        return;
      }

    }

    // 找到目标用户的 WebSocket
    for (const [webSocket, s] of this.sessions) {
      if (s.userId === targetUserId && webSocket.readyState === WebSocket.OPEN) {
        webSocket.send(JSON.stringify({
          type: data.type,
          body: {
            ...data.body,
            fromUserId: fromUserId,
          }
        }));
        if (data.type == 'webrtc-offer') {
          // 标记已发送
          callState.offerSent = true;
          callState.offerTimestamp = Date.now();
        } else if (data.type == 'webrtc-answer') {
          // 更新状态为已连接
          callState.state = 'connected';
          callState.answerTimestamp = Date.now();
        }

        break;
      }
    }
  }


  // === 广播挂断 ===
  async broadcastHangup(data, senderWs) {
    // data 格式: { type: 'hangup', body:{targetUserId: 'xxx' }  }
    for (const [webSocket, s] of this.sessions) {
      if (webSocket !== senderWs && webSocket.readyState === WebSocket.OPEN) {
        webSocket.send(JSON.stringify({
          type: 'peer-hangup',
          body: {
            ...data.body,
            fromUserId: this.sessions.get(senderWs).userId
          }
        }));
      }
    }
  }

}
