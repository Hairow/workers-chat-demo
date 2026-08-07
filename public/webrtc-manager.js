// webrtc-manager.js
import { webrtcDetector } from './webrtc-detect.js';

class WebRTCManager {
    constructor(ws, roomId, userId, userName) {
        this.ws = ws;
        this.roomId = roomId;
        this.userId = userId;
        this.userName = userName;
        this.pc = null;
        this.localStream = null;
        this.remoteStream = null;
        this.isCalling = false;


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
            if (data.type == 'incoming-call') {
                if (this.checkWebRtc() == false) return;
            }
            this.handleSignalingMessage(data);
        });
    }

    checkWebRtc() {
        const detectResult = await webrtcDetector.fullDetect();
        if (!detectResult.webRTC) {
            this.showError('您的浏览器不支持 WebRTC，请使用最新版的 Chrome、Firefox 或 Edge');
            return false;
        }
        const codecs = detectResult.codecs;
        const hasVP8 = codecs.video.some(c => c.name === 'VP8' && c.supported);
        if (!hasVP8) {
            console.warn('⚠️ VP8 编解码器不支持，视频通话可能不可用');
            return false;
        }
        // 检查摄像头权限
        if (webrtcDetector.capabilities.permissions.camera === 'denied') {
            this.showError('摄像头权限被拒绝，请到浏览器设置中允许访问');
            return false;
        }

        // 检查麦克风权限
        if (webrtcDetector.capabilities.permissions.microphone === 'denied') {
            this.showError('麦克风权限被拒绝，请到浏览器设置中允许访问');
            return false;
        }

        // 检查是否有设备
        if (webrtcDetector.capabilities.mediaDevices.cameras.length === 0) {
            this.showError('未检测到摄像头设备');
            return false;
        }

        if (webrtcDetector.capabilities.mediaDevices.microphones.length === 0) {
            this.showError('未检测到麦克风设备');
            return false;
        }
        return true;
    }

    // === 处理来自 DO 的信令 ===
    async handleSignalingMessage(data) {
        switch (data.type) {
            case 'incoming-call':
                // 有人呼叫你
                this.showIncomingCall(data);
                break;
            case 'call-accepted':
                //对方接受呼叫
                this.handleCallAccept(data)
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
                this.hangup(true); // 被动挂断
                break;
        }
    }

    // === 发起通话 ===
    async startCallUser(targetUserId) {
        if (this.isCalling) return;

        if (this.checkWebRtc() == false) return;

        // 通知对方有人呼叫
        this.ws.send(JSON.stringify({
            type: 'call-user',
            body: {
                targetUserId: targetUserId,
                fromUserName: this.userId
            }
        }));


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

            // 注意：此时还没有 remote description，等收到 Offer 后再处理
            this.pendingCallFrom = fromUserId;
            this.isCalling = true;
            this.showCallUI(true);

            // call-accepted
            this.ws.send(JSON.stringify({
                type: 'call-accepted',
                body: {
                    targetUserId: fromUserId,
                    callId: callId
                }
            }));

        } catch (error) {
            console.error('Accept call error:', error);
        }
    }

    // === 处理 Offer ===
    async handleOffer(data) {
        const fromUserId = data.body.fromUserId

        await this.pc.setRemoteDescription(new RTCSessionDescription(data.body.sdp));

        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);

        // 发送 Answer 回去
        this.ws.send(JSON.stringify({
            type: 'webrtc-answer',
            body: {
                targetUserId: data.fromUserId,
                sdp: this.pc.localDescription,
            }
        }));
    }

    // === 处理 Answer ===
    async handleAnswer(data) {
        if (!this.pc) return;
        await this.pc.setRemoteDescription(new RTCSessionDescription(data.body.sdp));
    }

    // === 处理 ICE Candidate ===
    async handleIceCandidate(data) {
        if (!this.pc) return;
        try {
            await this.pc.addIceCandidate(new RTCIceCandidate(data.body.candidate));
        } catch (error) {
            console.error('Add ICE candidate error:', error);
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

        // 收集 ICE Candidate
        this.pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.ws.send(JSON.stringify({
                    type: 'webrtc-ice',
                    body: {
                        targetUserId: this.isCalling ? this.pendingCallFrom : this.calleeUserId,
                        candidate: event.candidate,
                    }
                }));
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

        document.getElementById('localVideo').srcObject = null;
        document.getElementById('remoteVideo').srcObject = null;

        this.showCallUI(false);

        // 通知对方（如果不是被动挂断）
        if (!isRemote) {
            this.ws.send(JSON.stringify({
                type: 'hangup',
                body: {
                    targetUserId: this.pendingCallFrom || this.calleeUserId
                }
            }));
        }
    }

    // === UI 控制 ===
    showCallUI(isCalling) {
        document.getElementById('videoContainer').style.display = isCalling ? 'flex' : 'none';
        document.getElementById('hangupBtn').style.display = isCalling ? 'inline' : 'none';
        document.getElementById('callControls').style.display = isCalling ? 'none' : 'block';
    }

    showIncomingCall(data) {
        const fromUserId = data.body.fromUserId
        const fromUserName = data.body.fromUserName
        const callId = data.body.callId

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

    //
    handleCallAccept(data) {
        const fromUserId = data.body.fromUserId
        const callId = data.body.callId

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

        // 5. 通过 DO 发送 Offer 给目标用户
        this.ws.send(JSON.stringify({
            type: 'webrtc-offer',
            body: {
                targetUserId: fromUserId,
                callId: callId,
                sdp: this.pc.localDescription
            }
        }));

        this.isCalling = true;
        this.showCallUI(true);
    }
}