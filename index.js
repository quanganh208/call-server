const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*', // Trong môi trường production, hãy giới hạn nguồn gốc cụ thể
        methods: ['GET', 'POST']
    }
});

// Lưu trữ thông tin phòng và người dùng
const adminSockets = new Set();
const pendingCalls = new Map(); // Map để lưu trữ các cuộc gọi đang chờ và timeout của chúng

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Khách hàng đăng ký
    socket.on('register-client', (userData) => {
        console.log('Client registered:', userData.name);
        socket.userData = userData;
        socket.role = 'client';

        // Thông báo cho tất cả admin có khách hàng mới
        for (const adminSocketId of adminSockets) {
            const adminSocket = io.sockets.sockets.get(adminSocketId);
            if (adminSocket) {
                adminSocket.emit('new-client', {
                    socketId: socket.id,
                    userData: userData
                });
            }
        }
    });

    // Admin đăng ký
    socket.on('register-admin', () => {
        console.log('Admin registered:', socket.id);
        socket.role = 'admin';
        adminSockets.add(socket.id);

        // Gửi danh sách người dùng hiện tại cho admin
        const clients = Array.from(io.sockets.sockets.values())
            .filter(s => s.role === 'client')
            .map(s => ({
                socketId: s.id,
                userData: s.userData,
                // Thêm thông tin cuộc gọi nếu client đang trong trạng thái chờ
                callStatus: pendingCalls.has(s.id) ? 'waiting' : undefined,
                callType: pendingCalls.has(s.id) ? pendingCalls.get(s.id).callType : undefined
            }));

        socket.emit('current-clients', clients);

        // Gửi thông báo về các cuộc gọi đang chờ cho admin mới kết nối
        for (const [clientId, callData] of pendingCalls.entries()) {
            const clientSocket = io.sockets.sockets.get(clientId);
            if (clientSocket) {
                socket.emit('incoming-call', {
                    socketId: clientId,
                    userData: clientSocket.userData,
                    callType: callData.callType
                });
            }
        }
    });

    // Xử lý tín hiệu WebRTC
    socket.on('offer', (data) => {
        console.log('Offer from', socket.id, 'to', data.target);
        // Gửi offer đến người nhận
        const targetSocket = io.sockets.sockets.get(data.target);
        if (targetSocket) {
            targetSocket.emit('offer', {
                offer: data.offer,
                source: socket.id,
                userData: socket.userData,
                callType: data.callType // Thêm loại cuộc gọi (audio/video)
            });
        }
    });

    socket.on('answer', (data) => {
        console.log('Answer from', socket.id, 'to', data.target);
        // Gửi answer đến người gửi offer
        const targetSocket = io.sockets.sockets.get(data.target);
        if (targetSocket) {
            targetSocket.emit('answer', {
                answer: data.answer,
                source: socket.id,
                callType: data.callType // Thêm loại cuộc gọi (audio/video)
            });
        }
    });

    socket.on('ice-candidate', (data) => {
        console.log('ICE candidate from', socket.id, 'to', data.target);
        // Gửi ice candidate đến đối tác
        const targetSocket = io.sockets.sockets.get(data.target);
        if (targetSocket) {
            targetSocket.emit('ice-candidate', {
                candidate: data.candidate,
                source: socket.id
            });
        }
    });

    // Client yêu cầu gọi cho admin
    socket.on('call-request', (data) => {
        if (socket.role !== 'client') return;

        const callType = data?.callType || 'audio'; // Mặc định là audio nếu không có
        console.log(`${callType} call request from client:`, socket.id);

        // Hủy timeout cũ nếu có
        if (pendingCalls.has(socket.id)) {
            clearTimeout(pendingCalls.get(socket.id).timeout);
        }

        // Tạo timeout mới cho cuộc gọi này (60 giây)
        const timeoutId = setTimeout(() => {
            console.log(`Call from ${socket.id} timed out after 60 seconds`);
            // Xóa cuộc gọi khỏi danh sách chờ
            pendingCalls.delete(socket.id);

            // Thông báo cho client rằng cuộc gọi đã hết hạn
            socket.emit('call-timeout');

            // Thông báo cho tất cả admin cập nhật trạng thái
            for (const adminSocketId of adminSockets) {
                const adminSocket = io.sockets.sockets.get(adminSocketId);
                if (adminSocket) {
                    adminSocket.emit('call-timeout', {
                        socketId: socket.id
                    });
                }
            }
        }, 60000); // 60 giây

        // Lưu thông tin cuộc gọi và timeout của nó
        pendingCalls.set(socket.id, {
            callType: callType,
            timestamp: Date.now(),
            timeout: timeoutId
        });

        // Thông báo cho tất cả admin về yêu cầu gọi
        for (const adminSocketId of adminSockets) {
            const adminSocket = io.sockets.sockets.get(adminSocketId);
            if (adminSocket) {
                adminSocket.emit('incoming-call', {
                    socketId: socket.id,
                    userData: socket.userData,
                    callType: callType
                });
            }
        }

        // Thông báo cho khách hàng rằng yêu cầu đã được gửi
        socket.emit('call-request-sent', { callType: callType });
    });

    // Admin chấp nhận cuộc gọi
    socket.on('accept-call', (data) => {
        if (socket.role !== 'admin') return;

        console.log(`Admin accepted ${data.callType} call for client:`, data.clientId);

        // Hủy timeout nếu có
        if (pendingCalls.has(data.clientId)) {
            clearTimeout(pendingCalls.get(data.clientId).timeout);
            pendingCalls.delete(data.clientId);
        }

        const clientSocket = io.sockets.sockets.get(data.clientId);
        if (clientSocket) {
            clientSocket.emit('call-accepted', {
                adminId: socket.id,
                callType: data.callType
            });
        }
    });

    // Kết thúc cuộc gọi
    socket.on('end-call', (data) => {
        console.log('Call ended by', socket.id);

        // Nếu là client kết thúc cuộc gọi, hủy timeout và xóa khỏi pendingCalls
        if (socket.role === 'client' && pendingCalls.has(socket.id)) {
            clearTimeout(pendingCalls.get(socket.id).timeout);
            pendingCalls.delete(socket.id);

            // Thông báo cho tất cả admin rằng cuộc gọi đã bị hủy
            for (const adminSocketId of adminSockets) {
                const adminSocket = io.sockets.sockets.get(adminSocketId);
                if (adminSocket) {
                    adminSocket.emit('call-request-cancelled', {
                        socketId: socket.id,
                        userData: socket.userData,
                        callType: data.callType // Thêm thông tin loại cuộc gọi
                    });
                }
            }
        }

        // Gửi thông báo kết thúc cuộc gọi đến đối tác
        if (data.targetId) {
            const targetSocket = io.sockets.sockets.get(data.targetId);
            if (targetSocket) {
                targetSocket.emit('call-ended', {
                    source: socket.id
                });
            }
        }
    });

    // Xử lý ngắt kết nối
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);

        if (socket.role === 'admin') {
            adminSockets.delete(socket.id);
        } else if (socket.role === 'client') {
            // Nếu client đang có cuộc gọi chờ thì hủy
            if (pendingCalls.has(socket.id)) {
                clearTimeout(pendingCalls.get(socket.id).timeout);
                pendingCalls.delete(socket.id);
            }

            // Thông báo cho tất cả admin rằng client đã ngắt kết nối
            for (const adminSocketId of adminSockets) {
                const adminSocket = io.sockets.sockets.get(adminSocketId);
                if (adminSocket) {
                    adminSocket.emit('client-disconnected', {
                        socketId: socket.id,
                        userData: socket.userData
                    });
                }
            }
        }
    });

    // Thêm vào các sự kiện socket
    socket.on('cancel-call-request', (data) => {
        console.log(`Client ${socket.id} cancelled call request`);

        // Nếu cuộc gọi đang trong trạng thái chờ
        if (pendingCalls.has(socket.id)) {
            clearTimeout(pendingCalls.get(socket.id).timeout);
            pendingCalls.delete(socket.id);

            // Thông báo cho tất cả admin về việc hủy cuộc gọi
            for (const adminSocketId of adminSockets) {
                const adminSocket = io.sockets.sockets.get(adminSocketId);
                if (adminSocket) {
                    adminSocket.emit('call-request-cancelled', {
                        socketId: socket.id,
                        userData: socket.userData,
                        callType: data.callType
                    });
                }
            }
        }
    });
});

app.get('/', (req, res) => {
    res.send('OMI LiveTalk Signaling Server');
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Signaling server running on port ${PORT}`);
});
