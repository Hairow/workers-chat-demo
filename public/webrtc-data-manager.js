// webrtc-data-manager.js
// WebRTC 点对点文件传输管理器，基于 DataChannel 实现分片传输

class WebRTCDataManager {
    constructor(ws, userId, callbacks) {
        this.ws = ws;
        this.userId = userId;
        this.callbacks = callbacks || {};  // onTransferUpdate(transfer), onIncomingFile(file), onError(msg)

        this.CHUNK_SIZE = 64 * 1024;  // 64KB 分片
        this.PROGRESS_INTERVAL = 10;   // 每 10 片回传一次进度确认

        this.pc = null;                // 当前 PeerConnection
        this.dc = null;                // 当前 DataChannel
        this.iceBatch = new Set();
        this.transfers = [];           // 传输任务列表
        this.pendingFileId = null;     // 当前待处理的传输 ID

        // ICE 服务器配置
        this.iceServers = {
            iceServers: [
                { urls: 'stun:stun.cloudflare.com:3478' },
                { urls: 'stun:stun.l.google.com:19302' }
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

        this.ws.send(JSON.stringify({
            type: 'file-transfer-accept',
            body: { targetUserId: transfer.fromUserId, fileId: fileId }
        }));
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
            chunks: [],
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

        this.pendingFileId = fileId;
        var PeerConn = window.RTCPeerConnection || window.webkitRTCPeerConnection;
        this.pc = new PeerConn(this.iceServers);

        // 监听 DataChannel
        this.pc.ondatachannel = (event) => {
            this.dc = event.channel;
            this.dc.binaryType = 'arraybuffer';
            this._setupDataChannel(transfer);
        };
        this._setupPeerConnection(transfer);

        await this.pc.setRemoteDescription(new RTCSessionDescription(data.body.sdp));
        var answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);

        this.ws.send(JSON.stringify({
            type: 'file-answer',
            body: {
                targetUserId: data.body.fromUserId,
                fileId: fileId,
                sdp: this.pc.localDescription
            }
        }));
    }

    // 收到 Answer
    _handleAnswer(data) {
        if (!this.pc) return;
        this.pc.setRemoteDescription(new RTCSessionDescription(data.body.sdp));
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
                self._startSending(transfer);
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
                    self._finishReceive(transfer);
                }
                return;
            }

            // ArrayBuffer 为文件分片
            transfer.chunks.push(data);
            transfer.receivedBytes += data.byteLength;
            transfer.receivedChunks++;
            self._notify(transfer);
        };

        this.dc.onerror = function (e) {
            console.error('[FileTransfer] DataChannel 错误:', e);
            transfer.status = 'error';
            transfer.error = '数据传输错误';
            self._notify(transfer);
        };

        this.dc.onclose = function () {
            console.log('[FileTransfer] DataChannel 已关闭');
        };
    }

    // 发送方：分片发送文件
    _startSending(transfer) {
        var self = this;
        var file = transfer.file;
        var offset = 0;
        var chunkIndex = 0;

        function sendNext() {
            if (!self.dc || self.dc.readyState !== 'open') {
                transfer.status = 'error';
                transfer.error = 'DataChannel 已断开';
                self._notify(transfer);
                return;
            }

            // 检查缓冲区压力，防止溢出
            if (self.dc.bufferedAmount > self.CHUNK_SIZE * 8) {
                setTimeout(sendNext, 50);
                return;
            }

            if (chunkIndex >= transfer.totalChunks) {
                // 全部发完
                self.dc.send('__TRANSFER_DONE__');
                transfer.status = 'done';
                transfer.sentBytes = transfer.fileSize;
                self._notify(transfer);
                self._cleanup();
                return;
            }

            var slice = file.slice(offset, offset + self.CHUNK_SIZE);
            var reader = new FileReader();
            reader.onload = function () {
                self.dc.send(reader.result);
                offset += reader.result.byteLength;
                transfer.sentBytes = offset;
                transfer.sentChunks = chunkIndex + 1;
                chunkIndex++;

                // 节流通知 UI
                if (chunkIndex % 5 === 0 || chunkIndex === transfer.totalChunks) {
                    self._notify(transfer);
                }
                sendNext();
            };
            reader.onerror = function () {
                transfer.status = 'error';
                transfer.error = '文件读取失败';
                self._notify(transfer);
            };
            reader.readAsArrayBuffer(slice);
        }

        sendNext();
    }

    // 接收方：合并文件并下载
    _finishReceive(transfer) {
        var blob = new Blob(transfer.chunks, { type: transfer.fileType });
        transfer.status = 'done';
        transfer.receivedBytes = blob.size;
        transfer.blob = blob;
        this._notify(transfer);

        // 触发下载
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = transfer.fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 5000);

        this._cleanup();
    }

    // ========== PeerConnection 信令 ==========

    _setupPeerConnection(transfer) {
        var self = this;
        this.iceBatch = new Set();

        this.pc.onicecandidate = function (event) {
            if (event.candidate) {
                self.iceBatch.add(JSON.stringify(event.candidate));
            }
        };

        this.pc.onicegatheringstatechange = function () {
            if (self.pc && self.pc.iceGatheringState === 'complete') {
                self._flushIce(transfer);
            }
        };

        this.pc.onconnectionstatechange = function () {
            if (!self.pc) return;
            console.log('[FileTransfer] Connection:', self.pc.connectionState);
            // disconnected 是临时状态（ICE 仍在协商），只有 failed 才是真正的连接失败
            if (self.pc.connectionState === 'failed') {
                if (transfer.status !== 'done') {
                    transfer.status = 'error';
                    transfer.error = '连接失败';
                    self._notify(transfer);
                }
                self._cleanup();
            }
        };
    }

    _flushIce(transfer) {
        if (!this.pc || !this.pc.remoteDescription) return;
        var targetUserId = transfer.role === 'sender' ? transfer.targetUserId : transfer.fromUserId;
        if (targetUserId && this.iceBatch.size > 0) {
            this.ws.send(JSON.stringify({
                type: 'file-ice',
                body: {
                    targetUserId: targetUserId,
                    fileId: transfer.fileId,
                    candidates: [...this.iceBatch].map(JSON.parse)
                }
            }));
        }
        this.iceBatch.clear();
    }

    async _handleIce(data) {
        if (!this.pc) return;
        var candidates = data.body.candidates || [];
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
        if (this.dc) { this.dc.close(); this.dc = null; }
        if (this.pc) { this.pc.close(); this.pc = null; }
        this.iceBatch.clear();
        this.pendingFileId = null;
    }

    // === 获取 ICE 服务器配置 ===
    getIceServers() {
        return this.iceServers;
    }
}
