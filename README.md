# Edge Chat Demo

基于 [Cloudflare Workers](https://workers.cloudflare.com/) 和 [Durable Objects](https://developers.cloudflare.com/durable-objects/) 构建的实时聊天应用，完全运行在 Cloudflare 边缘网络上。

## 功能特性

### 实时聊天
- 基于 WebSocket 的实时消息广播，使用 Durable Objects WebSocket Hibernation API 降低.duration 计费
- 支持公开房间（按名称加入）和私密房间（64 位随机 ID）
- 聊天记录持久化到 Durable Object Storage，新加入者自动加载历史消息
- 支持文本消息和图片/文件分享（通过 KV 存储，最大 20MB）

### WebRTC 视频通话

基于 `WebRTCManager` 实现的点对点视频通话，信令通过 Durable Objects 转发，媒体流直连。

**信令流程：**

```
主叫方                    Durable Object                    被叫方
  │                            │                              │
  │── call-user ──────────────>│── incoming-call ────────────>│
  │                            │                              │
  │                            │<── call-accepted ────────────│
  │<── call-accepted ──────────│                              │
  │                            │                              │
  │── webrtc-offer ───────────>│── webrtc-offer ─────────────>│
  │                            │                              │
  │                            │<── webrtc-answer ────────────│
  │<── webrtc-answer ──────────│                              │
  │                            │                              │
  │<═══════════ WebRTC P2P 连接建立（媒体流直连） ═══════════>│
  │                            │                              │
  │── webrtc-ice (trickle) ───>│── webrtc-ice ───────────────>│
  │                            │                              │
  │── peer-hangup ────────────>│── peer-hangup ──────────────>│
```

**关键实现：**
- **Trickle ICE**：ICE 候选收集到即通过 WebSocket 发送，不等全部收集完成；接收方若 `setRemoteDescription` 尚未完成，候选会暂存到 `pendingIceCandidates` 队列，设置完成后自动排空
- **连接状态管理**：服务端通过 `callStates` Map 跟踪每路通话状态（calling → accepted → connected），校验主叫/被叫角色权限
- **浏览器兼容**：`RTCPeerConnection` 自动兼容 `webkitRTCPeerConnection` 前缀
- **STUN 配置**：支持多组公共 STUN 服务器（bilibili、小米、阿里云、腾讯云）
- **安全挂断**：检测 `disconnected` / `failed` 状态自动挂断，清理媒体流和 PeerConnection

### WebRTC 点对点文件传输

基于 `WebRTCDataManager` 实现的大文件点对点传输，使用独立的 PeerConnection + DataChannel，与视频通话互不干扰。

**信令流程：**

```
发送方                    Durable Object                    接收方
  │                            │                              │
  │── file-transfer-request ──>│── file-transfer-request ────>│
  │                            │                              │
  │                            │<── file-transfer-accept ─────│
  │<── file-transfer-accept ───│                              │
  │                            │                              │
  │── file-offer (SDP) ───────>│── file-offer ───────────────>│
  │                            │                              │
  │                            │<── file-answer (SDP) ────────│
  │<── file-answer ────────────│                              │
  │                            │                              │
  │<════════ DataChannel P2P 连接建立 ═══════════════════════>│
  │                            │                              │
  │── file-ice (trickle) ─────>│── file-ice ─────────────────>│
  │                            │                              │
  │═══ 分片数据 (ArrayBuffer) ═══════════════════════════════>│
  │                            │                              │
  │── __TRANSFER_DONE__ ──────>│ (DataChannel 内控制消息) ───>│
  │                            │                              │
  │<── file-transfer-complete ─│<── file-transfer-complete ───│
  │                            │                              │
  │    (清理连接)               │                              │
```

**关键实现：**

| 环节 | 发送方 | 接收方 |
|------|--------|--------|
| 文件读取 | `file.stream().getReader()` 流式读取 | — |
| 分片大小 | 60KB，由 ReadableStream 控制 | — |
| 数据写入 | — | OPFS 流式写入（`FileSystemWritableFileStream`） |
| 背压控制 | `bufferedAmount > 480KB` 时暂停发送 | — |
| 缓冲排空 | `bufferedAmount === 0` 后停止发送 | — |
| 完成确认 | 等待 `file-transfer-complete` 再关闭 | OPFS 写入完成后发送确认 |
| 超时兜底 | 30 秒未收到确认则强制清理 | 3 秒延迟后清理连接 |
| 降级方案 | — | OPFS 不可用时回退到内存 `Blob` |

**状态保护机制：**
- 收到 `__TRANSFER_DONE__` 后立即设置 `_finishing` 标记，防止后续 DataChannel 关闭错误覆盖传输状态
- `onerror` 和 `onconnectionstatechange` 检查 `_finishing` 标记，静默忽略传输完成后的连接关闭副作用
- 进度计算基于字节数（`sentBytes / fileSize`），不受流式分片大小影响

### 安全与限流
- JWT 认证（基于 jose + Web Crypto API），24 小时有效期
- 每 IP 全局限流，跨房间生效，基于 Durable Objects 实现
- WebRTC 信令消息免限流，避免影响实时通信

### 设备检测
- 独立的 `check.html` 页面，检测浏览器 WebRTC 能力
- 编解码器支持检测、ICE 连接测试

## 项目结构

```
├── src/
│   ├── index.mjs          # Worker 入口，API 路由与 DO 调度
│   ├── chat-room.mjs       # ChatRoom Durable Object（聊天室核心）
│   ├── rate-limiter.mjs    # RateLimiter Durable Object（限流）
│   ├── auth.mjs            # JWT 签发与校验
│   ├── upload.mjs          # 文件上传处理（KV 存储）
│   └── utils.mjs           # 工具函数
├── public/
│   ├── index.html          # 聊天界面（Vue.js）
│   ├── style.css           # 样式
│   ├── webrtc-manager.js   # WebRTC 视频通话管理
│   ├── webrtc-data-manager.js  # WebRTC 文件传输管理
│   ├── webrtc-detect.js    # WebRTC 能力检测
│   └── check.html          # 设备检测页面
├── wrangler.jsonc          # Workers 部署配置
└── package.json
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Cloudflare Workers (ES Modules) |
| 持久化 | Durable Objects Storage + KV |
| 实时通信 | WebSocket (Hibernation API) |
| 音视频 | WebRTC (RTCPeerConnection) |
| 文件传输 | WebRTC DataChannel + OPFS |
| 认证 | JWT (jose / Web Crypto API) |
| 前端 | Vue.js 2 (CDN) |

## 快速开始

### 前置条件
- [Node.js](https://nodejs.org/) 18+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) CLI（`npm install -g wrangler`）
- Cloudflare 账号，已启用 Durable Objects

### 本地开发

```bash
npm install
npm run dev
```

### 部署

```bash
wrangler login
wrangler deploy
```

部署后需配置 JWT 密钥：

```bash
wrangler secret put JWT_SECRET
```

### 环境变量

| 变量 | 说明 |
|------|------|
| `JWT_SECRET` | JWT 签名密钥（生产环境必须通过 `wrangler secret put` 设置） |

### 绑定

| 绑定 | 类型 | 说明 |
|------|------|------|
| `rooms` | Durable Objects | ChatRoom 命名空间 |
| `limiters` | Durable Objects | RateLimiter 命名空间 |
| `CHAT_ROOMS` | KV | 活跃房间索引 |

## API 路由

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/auth` | POST | 签发 JWT（`{ name: "username" }`） |
| `/api/room/<name>/create?token=...` | GET | WebSocket 连接，加入聊天室 |
| `/api/rooms` | GET | 获取活跃房间列表 |
| `/api/upload` | POST | 上传文件（multipart，最大 20MB） |
| `/api/file/<id>/meta` | GET | 获取文件元信息 |
| `/api/file/<id>/blob` | GET | 获取文件二进制内容 |
| `/api/file/<id>` | DELETE | 删除文件 |

## 参考资料

- [Durable Objects 文档](https://developers.cloudflare.com/durable-objects/)
- [WebSocket Hibernation API](https://developers.cloudflare.com/durable-objects/api/websockets/)
- [Workers KV 文档](https://developers.cloudflare.com/kv/)
