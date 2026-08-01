// =======================================================================================
// The RateLimiter Durable Object class.
// RateLimiter Durable Object 类。

import { handleErrors } from "./utils.mjs";

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
export class RateLimiterClient {
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
