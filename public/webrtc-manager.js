// webrtc-manager.js
// 注意：webrtc-detect.js 通过 <script> 加载，webrtcDetector 为全局变量

class WebRTCManager {
    constructor(ws, userId, callbacks) {
        this.ws = ws;
        this.userId = userId;
        this.pc = null;
        this.localStream = null;
        this.remoteStream = null;
        this.isCalling = false;       // true = 主叫方已发出呼叫（等待或已建立）
        this.calleeUserId = null;     // 主叫方记录被叫方 userId
        this.pendingCallFrom = null;  // 被叫方记录主叫方 userId
        this.callbacks = callbacks || {};  // 回调：onCallStateChange(active), onStatus(msg)
        this.iceBatch = new Map();    // Map(候选key -> candidate)，自动去重
        this.currentCallId = null;    // 当前通话 ID，用于 ICE 信令

        // ICE 服务器配置（生产环境建议用自己的 TURN）
        this.iceServers = {
            iceServers: [
                { urls: 'stun:stun.cloudflare.com:3478' },
                { urls: 'stun:stun.l.google.com:19302' }
            ]
        };
    }

    // === 初始化：监听 WebSocket 的 WebRTC 相关消息 ===
    init() {
        this.ws.addEventListener('message', (event) => {
            const data = JSON.parse(event.data);
            const webrtcTypes = [
                'incoming-call', 'call-accepted', 'call-rejected',
                'webrtc-offer', 'webrtc-answer', 'webrtc-ice', 'peer-hangup'
            ];
            if (webrtcTypes.includes(data.type)) {
                this.handleSignalingMessage(data);
            }
        });
    }

    // === 检查 WebRTC 能力（async） ===
    async checkWebRtc() {
        const detectResult = await window.webrtcDetector.fullDetect();
        if (!detectResult.webRTC) {
            this.showError('您的浏览器不支持 WebRTC，请使用最新版的 Chrome、Firefox 或 Edge');
            return false;
        }
        const codecs = detectResult.codecs;
        const hasVP8 = codecs.video.some(c => c.name === 'VP8' && c.supported);
        if (!hasVP8) {
            console.warn('⚠️ VP8 编解码器不支持，视频通话可能不可用');
            // 仅警告，不阻止（部分浏览器用 H264 也可互通）
        }
        // 检查摄像头权限
        if (window.webrtcDetector.capabilities.permissions.camera === 'denied') {
            this.showError('摄像头权限被拒绝，请到浏览器设置中允许访问');
            return false;
        }
        // 检查麦克风权限
        if (window.webrtcDetector.capabilities.permissions.microphone === 'denied') {
            this.showError('麦克风权限被拒绝，请到浏览器设置中允许访问');
            return false;
        }
        // 检查是否有设备
        if (window.webrtcDetector.capabilities.mediaDevices.cameras.length === 0) {
            this.showError('未检测到摄像头设备');
            return false;
        }
        if (window.webrtcDetector.capabilities.mediaDevices.microphones.length === 0) {
            this.showError('未检测到麦克风设备');
            return false;
        }
        return true;
    }

    // === 处理来自 DO 的信令 ===
    async handleSignalingMessage(data) {
        switch (data.type) {
            case 'incoming-call':
                // 有人呼叫你：先检查 WebRTC 能力
                if (!(await this.checkWebRtc())) return;
                this.showIncomingCall(data);
                break;

            case 'call-accepted':
                // 对方接受呼叫，主叫方开始建立 PeerConnection
                await this.handleCallAccept(data);
                break;

            case 'call-rejected':
                // 对方拒绝呼叫
                this.handleCallRejected(data);
                break;

            case 'webrtc-offer':
                // 收到 Offer（你是被叫方）
                await this.handleOffer(data);
                break;

            case 'webrtc-answer':
                // 收到 Answer（你是主叫方）
                await this.handleAnswer(data);
                break;

            case 'webrtc-ice':
                // 收到 ICE Candidate
                await this.handleIceCandidate(data);
                break;

            case 'peer-hangup':
                // 对方挂断
                this.hangup(true);
                break;

            case 'offer-error':
            case 'answer-error':
                // 信令错误
                this.showError(data.body && data.body.error || 'WebRTC 信令错误');
                break;

            default:
                console.warn('[WebRTC] 未处理的信令类型:', data.type);
                break;
        }
    }

    // === 发起通话 ===
    async startCallUser(targetUserId) {
        if (this.isCalling) return;
        if (!(await this.checkWebRtc())) return;

        this.calleeUserId = targetUserId;  // 记录被叫方
        this.isCalling = true;

        // 通知对方有人呼叫
        this.ws.send(JSON.stringify({
            type: 'call-user',
            body: {
                targetUserId: targetUserId
            }
        }));

        this.showCallingUI(targetUserId);
        this._setCallActive(true);  // 开始呼叫即进入通话状态
    }

    // === 接受通话（被叫方） ===
    async acceptCall(fromUserId, callId) {
        try {
            // 1. 获取本地流
            this.localStream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true
            });
            document.getElementById('localVideo').srcObject = this.localStream;

            // 2. 创建 PeerConnection
            this.pc = new RTCPeerConnection(this.iceServers);
            this.setupPeerConnection();

            // 3. 添加本地流
            this.localStream.getTracks().forEach(track => {
                this.pc.addTrack(track, this.localStream);
            });

            // 记录主叫方 userId，等收到 Offer 后再处理
            this.pendingCallFrom = fromUserId;
            this.isCalling = false;  // 被叫方不置 isCalling=true，由 handleOffer 后决定
            this.currentCallId = callId;
            this._setCallActive(true);

            // 发送 call-accepted
            this.ws.send(JSON.stringify({
                type: 'call-accepted',
                body: {
                    targetUserId: fromUserId,
                    callId: callId
                }
            }));

        } catch (error) {
            console.error('Accept call error:', error);
            this.showError('无法访问摄像头/麦克风：' + error.message);
        }
    }

    // === 处理 call-accepted（主叫方收到被叫方接受）===
    async handleCallAccept(data) {
        const fromUserId = data.body.fromUserId;
        const callId = data.body.callId;
        this.currentCallId = callId;

        try {
            // 1. 获取本地媒体流
            this.localStream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true
            });
            document.getElementById('localVideo').srcObject = this.localStream;

            // 2. 创建 PeerConnection
            this.pc = new RTCPeerConnection(this.iceServers);
            this.setupPeerConnection();

            // 3. 添加本地流
            this.localStream.getTracks().forEach(track => {
                this.pc.addTrack(track, this.localStream);
            });

            // 4. 创建 Offer
            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);

            // 5. 通过 DO 发送 Offer 给被叫方
            this.ws.send(JSON.stringify({
                type: 'webrtc-offer',
                body: {
                    targetUserId: fromUserId,
                    callId: callId,
                    sdp: this.pc.localDescription
                }
            }));

            this._setCallActive(true);
        } catch (error) {
            console.error('handleCallAccept error:', error);
            this.showError('建立通话失败：' + error.message);
        }
    }

    // === UI 控制（通过回调通知 Vue 层） ===
    _setCallActive(active) {
        const vc = document.getElementById('videoContainer');
        if (vc) vc.style.display = active ? 'flex' : 'none';
        if (typeof this.callbacks.onCallStateChange === 'function') {
            this.callbacks.onCallStateChange(active);
        }
    }

    _setStatus(msg) {
        if (typeof this.callbacks.onStatus === 'function') {
            this.callbacks.onStatus(msg);
        }
    }

    // 拨出时显示"呼叫中"状态
    showCallingUI(targetUserId) {
        this._setStatus('呼叫中，等待对方接听...');
    }

    // === 处理对方拒绝呼叫 ===
    handleCallRejected(data) {
        this.isCalling = false;
        this.calleeUserId = null;
        this.showError('对方拒绝了通话请求');
        this._setCallActive(false);
        this._setStatus(null);
    }

    // === 处理 Offer（被叫方收到主叫方的 Offer）===
    async handleOffer(data) {
        const fromUserId = data.body.fromUserId;  // 修正：从 data.body 取

        if (!this.pc) {
            console.error('收到 Offer 但 PeerConnection 未初始化');
            return;
        }

        await this.pc.setRemoteDescription(new RTCSessionDescription(data.body.sdp));

        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);

        // 发送 Answer 回去
        this.ws.send(JSON.stringify({
            type: 'webrtc-answer',
            body: {
                targetUserId: fromUserId,   // 修正：使用 fromUserId
                callId: data.body.callId,
                sdp: this.pc.localDescription,
            }
        }));
    }

    // === 处理 Answer（主叫方收到被叫方的 Answer）===
    async handleAnswer(data) {
        if (!this.pc) return;
        await this.pc.setRemoteDescription(new RTCSessionDescription(data.body.sdp));
        // answer 到位后才可发送 ICE candidates
        this._flushIce();
    }

    // === 发送缓存的 ICE candidates（需 setRemoteDescription 完成后） ===
    _flushIce() {
        if (!this.pc || !this.pc.remoteDescription) return;
        const targetUserId = this.isCalling ? this.calleeUserId : this.pendingCallFrom;
        if (targetUserId && this.iceBatch.size > 0) {
            this.ws.send(JSON.stringify({
                type: 'webrtc-ice',
                body: {
                    targetUserId: targetUserId,
                    candidates: [...this.iceBatch.values()],
                    callId: this.currentCallId,
                }
            }));
        }
        this.iceBatch.clear();
    }

    // === 处理 ICE Candidate ===
    // 兼容批量（candidates 数组）和单个（candidate 对象）两种格式
    async handleIceCandidate(data) {
        if (!this.pc) return;
        const candidates = data.body.candidates || (data.body.candidate ? [data.body.candidate] : []);
        for (const c of candidates) {
            try {
                await this.pc.addIceCandidate(new RTCIceCandidate(c));
            } catch (error) {
                console.error('Add ICE candidate error:', error);
            }
        }
    }

    // === 设置 PeerConnection 的事件监听 ===
    setupPeerConnection() {
        // 收到远端流
        this.pc.ontrack = (event) => {
            if (!this.remoteStream) {
                this.remoteStream = new MediaStream();
                document.getElementById('remoteVideo').srcObject = this.remoteStream;
            }
            event.streams[0].getTracks().forEach(track => {
                this.remoteStream.addTrack(track);
            });
        };

        // 收集 ICE Candidate（Map key 自动去重，不逐个发送，等收集完毕批量发送）
        this.iceBatch = new Map();
        this.pc.onicecandidate = (event) => {
            if (event.candidate) {
                const key = `${event.candidate.sdpMid || ''}:${event.candidate.sdpMLineIndex}:${event.candidate.candidate}`;
                this.iceBatch.set(key, event.candidate);
            }
        };

        // ICE 收集完成后，等 setRemoteDescription 后才能发送候选
        this.pc.onicegatheringstatechange = () => {
            if (this.pc.iceGatheringState === 'complete') {
                this._flushIce();
            }
        };

        // 连接状态变化
        this.pc.onconnectionstatechange = () => {
            console.log('Connection state:', this.pc.connectionState);
            if (this.pc.connectionState === 'disconnected' ||
                this.pc.connectionState === 'failed') {
                this.hangup(true);
            }
        };
    }

    // === 挂断 ===
    hangup(isRemote = false) {
        // 通知对方（如果不是被动挂断）
        if (!isRemote) {
            const targetUserId = this.isCalling ? this.calleeUserId : this.pendingCallFrom;
            if (targetUserId) {
                this.ws.send(JSON.stringify({
                    type: 'hangup',
                    body: { targetUserId, callId: this.currentCallId }
                }));
            }
        }

        if (this.pc) {
            this.pc.close();
            this.pc = null;
        }

        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }

        this.remoteStream = null;
        this.isCalling = false;
        this.calleeUserId = null;
        this.pendingCallFrom = null;
        this.currentCallId = null;

        const lv = document.getElementById('localVideo');
        const rv = document.getElementById('remoteVideo');
        if (lv) lv.srcObject = null;
        if (rv) rv.srcObject = null;

        this._setCallActive(false);
        this._setStatus(null);
    }

    showIncomingCall(data) {
        const fromUserId = data.body.fromUserId;
        const fromUserName = data.body.fromUserName;
        const callId = data.body.callId;

        if (confirm(`${fromUserName} 邀请你视频通话，是否接受？`)) {
            this.acceptCall(fromUserId, callId);
        } else {
            // 拒绝通话
            this.ws.send(JSON.stringify({
                type: 'call-rejected',
                body: {
                    targetUserId: fromUserId,
                    callId: callId
                }
            }));
        }
    }

    showError(msg) {
        console.error('[WebRTC]', msg);
        if (typeof this.callbacks.onError === 'function') {
            this.callbacks.onError(msg);
        } else {
            alert(msg);
        }
    }
}
