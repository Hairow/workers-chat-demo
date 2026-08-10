// webrtc-detect.js

class WebRTCDetector {
    constructor() {
        this.capabilities = {
            webRTCSupported: false,
            getUserMediaSupported: false,
            screenShareSupported: false,
            codecs: {
                video: [],
                audio: []
            },
            mediaDevices: {
                cameras: [],
                microphones: []
            },
            permissions: {
                camera: 'prompt', // 'granted' | 'denied' | 'prompt' | 'unsupported'
                microphone: 'prompt'
            }
        };
    }

    // ============================================
    // 1️⃣ 检测 WebRTC 基础支持
    // ============================================

    checkWebRTCSupport() {
        // 检查 RTCPeerConnection
        const hasRTCPeerConnection = typeof window.RTCPeerConnection !== 'undefined' ||
            typeof window.webkitRTCPeerConnection !== 'undefined';

        // 检查 getUserMedia
        const hasGetUserMedia = typeof navigator.mediaDevices?.getUserMedia !== 'undefined' ||
            typeof navigator.getUserMedia !== 'undefined' ||
            typeof navigator.webkitGetUserMedia !== 'undefined';

        // 检查 MediaStream
        const hasMediaStream = typeof window.MediaStream !== 'undefined';

        // 检查 RTCSessionDescription
        const hasRTCSessionDescription = typeof window.RTCSessionDescription !== 'undefined' ||
            typeof window.webkitRTCSessionDescription !== 'undefined';

        // 检查 RTCIceCandidate
        const hasRTCIceCandidate = typeof window.RTCIceCandidate !== 'undefined' ||
            typeof window.webkitRTCIceCandidate !== 'undefined';

        this.capabilities.webRTCSupported = hasRTCPeerConnection &&
            hasGetUserMedia &&
            hasMediaStream &&
            hasRTCSessionDescription &&
            hasRTCIceCandidate;

        this.capabilities.getUserMediaSupported = hasGetUserMedia;
        this.capabilities.screenShareSupported = typeof navigator.mediaDevices?.getDisplayMedia !== 'undefined';

        return this.capabilities.webRTCSupported;
    }

    // ============================================
    // 2️⃣ 检测编解码器支持
    // ============================================

    checkCodecSupport() {
        try {
            const PeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
            if (!PeerConnection) return this.capabilities.codecs;
            const pc = new PeerConnection();

            // 视频编解码器
            const videoCodecs = [];
            const audioCodecs = [];

            // 检查视频编解码器
            const videoCodecList = [
                { name: 'VP8', mimeType: 'video/VP8' },
                { name: 'VP9', mimeType: 'video/VP9' },
                { name: 'H264', mimeType: 'video/H264' },
                { name: 'AV1', mimeType: 'video/AV1' }
            ];

            for (const codec of videoCodecList) {
                try {
                    const supported = RTCRtpSender.getCapabilities('video')?.codecs?.some(
                        c => c.mimeType.toLowerCase() === codec.mimeType.toLowerCase()
                    ) || false;
                    videoCodecs.push({
                        ...codec,
                        supported: supported
                    });
                } catch (e) {
                    videoCodecs.push({
                        ...codec,
                        supported: false,
                        error: e.message
                    });
                }
            }

            // 检查音频编解码器
            const audioCodecList = [
                { name: 'Opus', mimeType: 'audio/opus' },
                { name: 'PCMU', mimeType: 'audio/PCMU' },
                { name: 'PCMA', mimeType: 'audio/PCMA' },
                { name: 'G722', mimeType: 'audio/G722' }
            ];

            for (const codec of audioCodecList) {
                try {
                    const supported = RTCRtpSender.getCapabilities('audio')?.codecs?.some(
                        c => c.mimeType.toLowerCase() === codec.mimeType.toLowerCase()
                    ) || false;
                    audioCodecs.push({
                        ...codec,
                        supported: supported
                    });
                } catch (e) {
                    audioCodecs.push({
                        ...codec,
                        supported: false,
                        error: e.message
                    });
                }
            }

            this.capabilities.codecs.video = videoCodecs;
            this.capabilities.codecs.audio = audioCodecs;

            pc.close();

        } catch (error) {
            console.error('编解码器检测失败:', error);
        }

        return this.capabilities.codecs;
    }

    // ============================================
    // 3️⃣ 检测媒体设备
    // ============================================

    async detectMediaDevices() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
            return false;
        }

        try {
            const devices = await navigator.mediaDevices.enumerateDevices();

            this.capabilities.mediaDevices.cameras = devices
                .filter(d => d.kind === 'videoinput')
                .map(d => ({
                    deviceId: d.deviceId,
                    label: d.label || `Camera ${d.deviceId.slice(0, 6)}`,
                    groupId: d.groupId
                }));

            this.capabilities.mediaDevices.microphones = devices
                .filter(d => d.kind === 'audioinput')
                .map(d => ({
                    deviceId: d.deviceId,
                    label: d.label || `Microphone ${d.deviceId.slice(0, 6)}`,
                    groupId: d.groupId
                }));

            return true;

        } catch (error) {
            console.error('设备检测失败:', error);
            return false;
        }
    }

    // ============================================
    // 4️⃣ 检测权限状态
    // ============================================

    async checkPermissions() {
        // 4.1 使用 Permissions API（推荐）
        if (navigator.permissions && navigator.permissions.query) {
            try {
                // 摄像头权限
                const cameraPermission = await navigator.permissions.query({
                    name: 'camera'
                });
                this.capabilities.permissions.camera = cameraPermission.state;

                // 麦克风权限
                const micPermission = await navigator.permissions.query({
                    name: 'microphone'
                });
                this.capabilities.permissions.microphone = micPermission.state;

                // 监听权限变化
                cameraPermission.onchange = () => {
                    this.capabilities.permissions.camera = cameraPermission.state;
                    this.onPermissionChange('camera', cameraPermission.state);
                };

                micPermission.onchange = () => {
                    this.capabilities.permissions.microphone = micPermission.state;
                    this.onPermissionChange('microphone', micPermission.state);
                };

            } catch (error) {
                // Permissions API 可能不支持或拒绝访问
                console.warn('Permissions API 不可用，尝试 getUserMedia 检测');
                await this.checkPermissionsViaGetUserMedia();
            }
        } else {
            // 不支持 Permissions API，使用 getUserMedia 检测
            await this.checkPermissionsViaGetUserMedia();
        }

        return this.capabilities.permissions;
    }

    // ============================================
    // 5️⃣ 通过 getUserMedia 检测权限（兜底方案）
    // ============================================

    async checkPermissionsViaGetUserMedia() {
        // 5.1 检测摄像头权限
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: false
            });
            this.capabilities.permissions.camera = 'granted';
            stream.getTracks().forEach(track => track.stop());
        } catch (error) {
            if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                this.capabilities.permissions.camera = 'denied';
            } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
                this.capabilities.permissions.camera = 'no-device';
            } else {
                this.capabilities.permissions.camera = 'error';
            }
        }

        // 5.2 检测麦克风权限
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: false,
                audio: true
            });
            this.capabilities.permissions.microphone = 'granted';
            stream.getTracks().forEach(track => track.stop());
        } catch (error) {
            if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                this.capabilities.permissions.microphone = 'denied';
            } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
                this.capabilities.permissions.microphone = 'no-device';
            } else {
                this.capabilities.permissions.microphone = 'error';
            }
        }
    }

    // ============================================
    // 6️⃣ 权限变化回调
    // ============================================

    onPermissionChange(type, state) {
        // 权限变化时更新 capabilities
        this.capabilities.permissions[type] = state;
    }

    // ============================================
    // 7️⃣ 一键完整检测
    // ============================================

    async fullDetect() {
        const results = {
            webRTC: this.checkWebRTCSupport(),
            codecs: this.checkCodecSupport(),
            devices: await this.detectMediaDevices(),
            permissions: await this.checkPermissions(),
            timestamp: Date.now()
        };

        console.log('📊 WebRTC 检测结果:', results);

        return results;
    }
}

// ============================================
// 📦 全局单例（以普通 <script> 方式加载，非 ES module）
// ============================================

window.webrtcDetector = new WebRTCDetector();