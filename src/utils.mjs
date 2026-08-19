// ===============================
// Utility Functions / 工具函数
// ===============================

// `handleErrors()` is a little utility function that can wrap an HTTP request handler in a
// try/catch and return errors to the client. You probably wouldn't want to use this in production
// code but it is convenient when debugging and iterating.
// `handleErrors()` 是一个小工具函数，用 try/catch 包装 HTTP 请求处理器并将错误返回给客户端。
// 你可能不想在生产代码中使用它，但在调试和迭代时很方便。
export async function handleErrors(request, func) {
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
      pair[1].send(JSON.stringify({ error: err.stack || String(err) }));
      pair[1].close(1011, "Uncaught exception during session setup");
      return new Response(null, { status: 101, webSocket: pair[0] });
    } else {
      return Response.json({ error: err.stack || String(err) }, { status: 500 });
    }
  }
}
