// webrtc-data-manager.js
// WebRTC 点对点文件传输管理器，基于 DataChannel 实现分片传输

class WebRTCDataManager {
    constructor(ws, userChatId, callbacks) {
        this.ws = ws;
        this.userChatId = userChatId;
        this.callbacks = callbacks || {};  // onTransferUpdate(transfer), onIncomingFile(file), onError(msg)

        this.CHUNK_SIZE = 60 * 1024;  // 64KB 分片
        this.PROGRESS_INTERVAL = 10;   // 每 10 片回传一次进度确认

        this.pc = null;                // 当前 PeerConnection
        this.dc = null;                // 当前 DataChannel
        this.pendingIceCandidates = [];
        this.transfers = [];           // 传输任务列表
        this.pendingFileId = null;     // 当前待处理的传输 ID

        // ICE 服务器配置
        this.iceServers = {
            iceServers: [
                { urls: 'stun:stun.chat.bilibili.com:3478' },
                { urls: 'stun:stun.miwifi.com:3478' }
            ]
        };
    }

    // === 初始化：监听 WebSocket 的文件传输信令 ===
    init() {
        this.ws.addEventListener('message', (event) => {
            let data;
            try { data = JSON.parse(event.data); } catch (e) { return; }
            const fileTypes = [
                'file-transfer-request', 'file-transfer-accept', 'file-transfer-reject',
                'file-offer', 'file-answer', 'file-ice', 'file-transfer-complete'
            ];
            if (fileTypes.includes(data.type)) {
                this.handleSignaling(data);
            }
        });
    }

    // === 信令路由 ===
    async handleSignaling(data) {
        switch (data.type) {
            case 'file-transfer-request':
                this._onIncomingRequest(data);
                break;
            case 'file-transfer-accept':
                this._onAccept(data);
                break;
            case 'file-transfer-reject':
                this._onReject(data);
                break;
            case 'file-offer':
                await this._handleOffer(data);
                break;
            case 'file-answer':
                this._handleAnswer(data);
                break;
            case 'file-ice':
                await this._handleIce(data);
                break;
            case 'file-transfer-complete':
                this._onTransferComplete(data);
                break;
        }
    }

    // === 发送方：发起文件传输 ===
    sendFile(targetUserId, file) {
        var fileId = 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        var totalChunks = Math.ceil(file.size / this.CHUNK_SIZE);

        var transfer = {
            fileId: fileId,
            role: 'sender',
            targetUserId: targetUserId,
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type || 'application/octet-stream',
            totalChunks: totalChunks,
            sentChunks: 0,
            sentBytes: 0,
            status: 'waiting',   // waiting -> accepting -> transferring -> done / error
            file: file,
            startTime: 0,
        };
        this.transfers.push(transfer);
        this._notify(transfer);

        // 发送传输请求给对方
        this.ws.send(JSON.stringify({
            type: 'file-transfer-request',
            body: {
                targetUserId: targetUserId,
                fileId: fileId,
                filename: file.name,
                fileSize: file.size,
                fileType: file.type || 'application/octet-stream',
                totalChunks: totalChunks
            }
        }));
    }

    // === 接收方：接受文件 ===
    acceptFile(fileId) {
        var transfer = this._findTransfer(fileId);
        if (!transfer || transfer.role !== 'receiver') return;
        transfer.status = 'accepting';
        this._notify(transfer);

        var self = this;
        // 尝试初始化 OPFS，失败则回退到内存
        this._initOpfs(transfer).then(function () {
            self.ws.send(JSON.stringify({
                type: 'file-transfer-accept',
                body: { targetUserId: transfer.fromUserId, fileId: fileId }
            }));
        }).catch(function (e) {
            console.warn('[FileTransfer] OPFS 初始化失败，使用内存模式:', e);
            self.ws.send(JSON.stringify({
                type: 'file-transfer-accept',
                body: { targetUserId: transfer.fromUserId, fileId: fileId }
            }));
        });
    }

    // === 接收方：拒绝文件 ===
    rejectFile(fileId) {
        var transfer = this._findTransfer(fileId);
        if (!transfer || transfer.role !== 'receiver') return;
        transfer.status = 'rejected';
        this._notify(transfer);

        this.ws.send(JSON.stringify({
            type: 'file-transfer-reject',
            body: { targetUserId: transfer.fromUserId, fileId: fileId }
        }));
    }

    // ========== 发送方流程 ==========

    // 对方接受 → 建立 PeerConnection 并创建 DataChannel
    async _onAccept(data) {
        var fileId = data.body.fileId;
        var fromUserId = data.body.fromUserId;
        var transfer = this._findTransfer(fileId);
        if (!transfer) return;

        transfer.status = 'connecting';
        this._notify(transfer);

        try {
            this.pendingFileId = fileId;
            var PeerConn = window.RTCPeerConnection || window.webkitRTCPeerConnection;
            this.pc = new PeerConn(this.iceServers);

            // 创建 DataChannel
            this.dc = this.pc.createDataChannel('fileTransfer', { ordered: true });
            this.dc.binaryType = 'arraybuffer';
            this._setupDataChannel(transfer);
            this._setupPeerConnection(transfer);

            // 创建 Offer
            var offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);

            this.ws.send(JSON.stringify({
                type: 'file-offer',
                body: {
                    targetUserId: fromUserId,
                    fileId: fileId,
                    sdp: this.pc.localDescription
                }
            }));
        } catch (e) {
            console.error('[FileTransfer] 建立连接失败:', e);
            transfer.status = 'error';
            transfer.error = e.message;
            this._notify(transfer);
        }
    }

    // 对方拒绝
    _onReject(data) {
        var fileId = data.body.fileId;
        var transfer = this._findTransfer(fileId);
        if (!transfer) return;
        transfer.status = 'rejected';
        this._notify(transfer);
    }

    // ========== 接收方流程 ==========

    // 收到传输请求
    _onIncomingRequest(data) {
        var body = data.body;
        var transfer = {
            fileId: body.fileId,
            role: 'receiver',
            fromUserId: data.body.fromUserId,  // 由服务端注入
            fileName: body.filename,
            fileSize: body.fileSize,
            fileType: body.fileType,
            totalChunks: body.totalChunks,
            receivedChunks: 0,
            receivedBytes: 0,
            chunks: [],           // OPFS 不可用时回退到内存
            opfsFile: null,       // OPFS FileHandle
            opfsWriter: null,     // OPFS WritableStreamDefaultWriter
            status: 'pending',   // pending -> accepting -> transferring -> done / error
            startTime: 0,
        };
        this.transfers.push(transfer);
        this._notify(transfer);

        if (typeof this.callbacks.onIncomingFile === 'function') {
            this.callbacks.onIncomingFile(transfer);
        }
    }

    // 收到 Offer → 创建 Answer
    async _handleOffer(data) {
        var fileId = data.body.fileId;
        var transfer = this._findTransfer(fileId);
        if (!transfer) return;

        try {
            this.pendingFileId = fileId;
            var PeerConn = window.RTCPeerConnection || window.webkitRTCPeerConnection;
            this.pc = new PeerConn(this.iceServers);

            // 监听 DataChannel
            var self = this;
            this.pc.ondatachannel = function (event) {
                self.dc = event.channel;
                self.dc.binaryType = 'arraybuffer';
                self._setupDataChannel(transfer);
            };
            this._setupPeerConnection(transfer);

            await this.pc.setRemoteDescription(new RTCSessionDescription(data.body.sdp));
            // 排空在 offer 到达前收到的 ICE 候选
            await this._flushPendingIce();
            var answer = await this.pc.createAnswer();//触发ice收集
            await this.pc.setLocalDescription(answer);

            this.ws.send(JSON.stringify({
                type: 'file-answer',
                body: {
                    targetUserId: data.body.fromUserId,
                    fileId: fileId,
                    sdp: this.pc.localDescription
                }
            }));
        } catch (e) {
            console.error('[FileTransfer] 接收方建立连接失败:', e);
            transfer.status = 'error';
            transfer.error = e.message;
            this._notify(transfer);
        }
    }

    // 收到 Answer
    _handleAnswer(data) {
        if (!this.pc) return;
        var self = this;
        var fileId = data.body.fileId;
        var transfer = this._findTransfer(fileId);
        this.pc.setRemoteDescription(new RTCSessionDescription(data.body.sdp)).then(function () {
            // answer 设置完成后，排空等待中的 ICE 候选
            self._flushPendingIce();
        }).catch(function (e) {
            console.error('[FileTransfer] 设置 Answer 失败:', e);
        });
    }

    // ========== DataChannel 数据传输 ==========

    _setupDataChannel(transfer) {
        var self = this;

        this.dc.onopen = function () {
            console.log('[FileTransfer] DataChannel 已打开');
            if (transfer.role === 'sender') {
                transfer.status = 'transferring';
                transfer.startTime = Date.now();
                self._notify(transfer);
                // 稍延迟开始发送，确保接收方 DataChannel 也已完成建立
                setTimeout(function () { self._startSending(transfer); }, 200);
            } else {
                transfer.status = 'transferring';
                transfer.startTime = Date.now();
                self._notify(transfer);
            }
        };

        this.dc.onmessage = function (event) {
            if (transfer.role !== 'receiver') return;
            var data = event.data;

            // 字符串消息为控制指令
            if (typeof data === 'string') {
                if (data === '__TRANSFER_DONE__') {
                    transfer._finishing = true;  // 立即标记，防止后续错误覆盖状态
                    self._finishReceive(transfer);
                }
                return;
            }

            // ArrayBuffer 为文件分片，优先写入 OPFS
            if (transfer.opfsWriter) {
                transfer.opfsWriter.write(data).catch(function (e) {
                    console.error('[FileTransfer] OPFS 写入失败:', e);
                    transfer.status = 'error';
                    transfer.error = '文件写入失败';
                    self._notify(transfer);
                });
            } else {
                transfer.chunks.push(data);
            }
            transfer.receivedBytes += data.byteLength;
            transfer.receivedChunks++;
            self._notify(transfer);
        };

        this.dc.onerror = function (e) {
            // 传输已完成或正在完成，关闭连接的副作用，静默忽略
            if (transfer._finishing || transfer.status === 'done' || transfer.status === 'error') return;
            var connState = self.pc ? self.pc.connectionState : 'null';
            console.error('[FileTransfer] DataChannel 错误 (连接状态: ' + connState + '):', e.error || e.type);
            // 连接级别的错误由 onconnectionstatechange 处理，这里只处理传输错误
            if (connState === 'connected' || connState === 'connecting') {
                transfer.status = 'error';
                transfer.error = '数据传输错误';
                self._notify(transfer);
            }
        };

        this.dc.onclose = function () {
            console.log('[FileTransfer] DataChannel 已关闭');
        };
    }

    // 发送方：流式读取并发送文件
    _startSending(transfer) {
        var self = this;
        var file = transfer.file;
        var chunkIndex = 0;
        var reader = file.stream().getReader();

        function sendChunk(chunk) {
            // 检查缓冲区压力，防止溢出
            if (self.dc.bufferedAmount > self.CHUNK_SIZE * 8) {
                return new Promise(function (resolve) {
                    setTimeout(resolve, 50);
                }).then(function () {
                    return sendChunk(chunk);
                });
            }
            try {
                self.dc.send(chunk);
            } catch (e) {
                transfer.status = 'error';
                transfer.error = '发送失败: ' + (e.message || e.name);
                self._notify(transfer);
                return Promise.reject(e);
            }
            transfer.sentBytes += chunk.byteLength;
            transfer.sentChunks = ++chunkIndex;
            if (chunkIndex % 5 === 0) {
                self._notify(transfer);
            }
            return Promise.resolve();
        }

        function pump() {
            if (!self.dc || self.dc.readyState !== 'open') {
                transfer.status = 'error';
                transfer.error = 'DataChannel 已断开';
                self._notify(transfer);
                reader.cancel();
                return;
            }
            reader.read().then(function (result) {
                if (result.done) {
                    // 全部发完，发送完成信号
                    try { self.dc.send('__TRANSFER_DONE__'); } catch (e) {
                        transfer.status = 'error';
                        transfer.error = '发送完成信号失败';
                        self._notify(transfer);
                        return;
                    }
                    transfer.status = 'done';
                    transfer.sentBytes = transfer.fileSize;
                    self._notify(transfer);
                    // 等待缓冲区排空，但不立即关闭——等接收方确认后再清理
                    self._waitForDrain(function () {
                        console.log('[FileTransfer] 发送完成，等待接收方确认');
                        // 超时兜底：30 秒后强制清理，防止确认消息丢失导致连接永不释放
                        transfer._cleanupTimer = setTimeout(function () {
                            console.warn('[FileTransfer] 等待确认超时，强制清理');
                            self._cleanup();
                        }, 30000);
                    });
                    return;
                }
                sendChunk(result.value).then(pump).catch(function () {
                    reader.cancel();
                });
            }).catch(function (e) {
                console.error('[FileTransfer] 文件流读取失败:', e);
                transfer.status = 'error';
                transfer.error = '文件读取失败';
                self._notify(transfer);
            });
        }

        pump();
    }

    // 接收方：完成接收并触发下载
    _finishReceive(transfer) {
        var self = this;

        if (transfer.opfsWriter && transfer.opfsFile) {
            // OPFS 模式：关闭 writer，从 OPFS 读取文件并下载
            transfer.opfsWriter.close().then(function () {
                // OPFS 写入完成，立即通知发送方可以关闭连接
                self._sendTransferComplete(transfer);
                return transfer.opfsFile.getFile();
            }).then(function (file) {
                transfer.status = 'done';
                transfer.receivedBytes = file.size;
                self._notify(transfer);
                self._triggerDownload(file, transfer.fileName);
                // 清理 OPFS 临时文件
                self._cleanupOpfs(transfer);
                // 延迟关闭，给发送方时间处理 file-transfer-complete 消息
                setTimeout(function () { self._cleanup(); }, 3000);
            }).catch(function (e) {
                console.error('[FileTransfer] OPFS 读取失败:', e);
                transfer.status = 'error';
                transfer.error = '文件读取失败';
                self._notify(transfer);
                self._cleanupOpfs(transfer);
                self._cleanup();
            });
        } else {
            // 内存模式：合并 chunks 为 Blob
            var blob = new Blob(transfer.chunks, { type: transfer.fileType });
            transfer.status = 'done';
            transfer.receivedBytes = blob.size;
            transfer.blob = blob;
            this._notify(transfer);
            this._triggerDownload(blob, transfer.fileName);
            // 通知发送方已完成，可以关闭连接
            this._sendTransferComplete(transfer);
            // 延迟关闭，给发送方时间处理 file-transfer-complete 消息
            var self = this;
            setTimeout(function () { self._cleanup(); }, 3000);
        }
    }

    // 通知发送方传输完成
    _sendTransferComplete(transfer) {
        try {
            this.ws.send(JSON.stringify({
                type: 'file-transfer-complete',
                body: {
                    targetUserId: transfer.fromUserId,
                    fileId: transfer.fileId
                }
            }));
        } catch (e) {
            console.warn('[FileTransfer] 发送完成确认失败:', e);
        }
    }

    // 触发浏览器下载
    _triggerDownload(fileOrBlob, fileName) {
        var url = URL.createObjectURL(fileOrBlob);
        var a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    }

    // ========== PeerConnection 信令 ==========

    _setupPeerConnection(transfer) {
        var self = this;
        this.pendingIceCandidates = [];

        this.pc.onicecandidate = function (event) {
            if (event.candidate) {
                // trickle ICE：收集到就立即发送
                var targetUserId = transfer.role === 'sender' ? transfer.targetUserId : transfer.fromUserId;
                if (targetUserId) {
                    self.ws.send(JSON.stringify({
                        type: 'file-ice',
                        body: {
                            targetUserId: targetUserId,
                            fileId: transfer.fileId,
                            candidate: event.candidate
                        }
                    }));
                }
            }
        };

        this.pc.onconnectionstatechange = function () {
            if (!self.pc) return;
            console.log('[FileTransfer] Connection:', self.pc.connectionState);
            // disconnected 是临时状态（ICE 仍在协商），只有 failed 才是真正的连接失败
            if (self.pc.connectionState === 'failed') {
                if (!transfer._finishing && transfer.status !== 'done') {
                    transfer.status = 'error';
                    transfer.error = '连接失败';
                    self._notify(transfer);
                }
                self._cleanup();
            }
        };
    }

    // 排空等待中的 ICE 候选
    async _flushPendingIce() {
        if (!this.pc || !this.pc.remoteDescription) return;
        var candidates = this.pendingIceCandidates.splice(0);
        for (var i = 0; i < candidates.length; i++) {
            try {
                await this.pc.addIceCandidate(new RTCIceCandidate(candidates[i]));
            } catch (e) {
                console.error('[FileTransfer] Add pending ICE candidate error:', e);
            }
        }
    }

    async _handleIce(data) {
        if (!this.pc) return;
        var candidates = data.body.candidates || (data.body.candidate ? [data.body.candidate] : []);
        // 如果 remoteDescription 还没设置，先排队等待
        if (!this.pc.remoteDescription) {
            this.pendingIceCandidates.push.apply(this.pendingIceCandidates, candidates);
            return;
        }
        for (var i = 0; i < candidates.length; i++) {
            try {
                await this.pc.addIceCandidate(new RTCIceCandidate(candidates[i]));
            } catch (e) {
                console.error('[FileTransfer] Add ICE candidate error:', e);
            }
        }
    }

    _onTransferComplete(data) {
        var fileId = data.body.fileId;
        var transfer = this._findTransfer(fileId);
        if (transfer) {
            transfer.status = 'done';
            this._notify(transfer);
            console.log('[FileTransfer] 接收方已确认完成，清理连接');
            this._cleanup();
        }
    }

    // ========== 工具方法 ==========

    _findTransfer(fileId) {
        for (var i = 0; i < this.transfers.length; i++) {
            if (this.transfers[i].fileId === fileId) return this.transfers[i];
        }
        return null;
    }

    _notify(transfer) {
        if (typeof this.callbacks.onTransferUpdate === 'function') {
            this.callbacks.onTransferUpdate(transfer);
        }
    }

    _cleanup() {
        try { if (this.dc) { this.dc.close(); } } catch (e) { /* 忽略关闭错误 */ }
        try { if (this.pc) { this.pc.close(); } } catch (e) { /* 忽略关闭错误 */ }
        this.dc = null;
        this.pc = null;
        this.pendingIceCandidates = [];
        this.pendingFileId = null;
    }

    // 初始化 OPFS 文件（接收方用）
    _initOpfs(transfer) {
        if (!navigator.storage || !navigator.storage.getDirectory) {
            return Promise.reject(new Error('OPFS 不可用'));
        }
        var tempName = 'transfer_' + transfer.fileId + '_' + transfer.fileName;
        return navigator.storage.getDirectory().then(function (root) {
            return root.getFileHandle(tempName, { create: true });
        }).then(function (fileHandle) {
            transfer.opfsFile = fileHandle;
            return fileHandle.createWritable();
        }).then(function (writer) {
            transfer.opfsWriter = writer;
            console.log('[FileTransfer] OPFS 初始化成功:', tempName);
        });
    }

    // 清理 OPFS 临时文件
    _cleanupOpfs(transfer) {
        if (!transfer.opfsFile) return;
        var fileName = transfer.opfsFile.name;
        transfer.opfsFile = null;
        transfer.opfsWriter = null;
        navigator.storage.getDirectory().then(function (root) {
            return root.removeEntry(fileName).catch(function (e) {
                console.warn('[FileTransfer] OPFS 清理失败:', e);
            });
        });
    }

    // 等待 DataChannel 缓冲区排空后再关闭
    _waitForDrain(callback) {
        var self = this;
        var maxWait = 5000; // 最多等 5 秒
        var startTime = Date.now();

        function check() {
            if (!self.dc || self.dc.readyState !== 'open') {
                callback();
                return;
            }
            if (self.dc.bufferedAmount === 0) {
                // 再等 100ms 确保数据已送达对端
                setTimeout(callback, 100);
                return;
            }
            if (Date.now() - startTime > maxWait) {
                console.warn('[FileTransfer] 缓冲区排空超时，强制关闭');
                callback();
                return;
            }
            setTimeout(check, 50);
        }
        check();
    }

    // === 获取 ICE 服务器配置 ===
    getIceServers() {
        return this.iceServers;
    }
}
