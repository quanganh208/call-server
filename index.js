const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Trong môi trường production, hãy giới hạn nguồn gốc cụ thể
    methods: ["GET", "POST"],
  },
});

// Lưu trữ thông tin phòng và người dùng
const adminSockets = new Map(); // Thay đổi từ Set sang Map để lưu trữ thêm thông tin admin
const pendingCalls = new Map(); // Map để lưu trữ các cuộc gọi đang chờ và timeout của chúng

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Khách hàng đăng ký
  socket.on("register-client", (userData) => {
    console.log("Client registered:", userData.SocialName);
    socket.userData = userData;
    socket.role = "client";

    // Thông báo cho tất cả admin có khách hàng mới
    for (const [adminSocketId, adminData] of adminSockets.entries()) {
      const adminSocket = io.sockets.sockets.get(adminSocketId);
      if (adminSocket) {
        adminSocket.emit("new-client", {
          socketId: socket.id,
          userData: userData,
        });
      }
    }
  });

  // Admin đăng ký với số điện thoại
  socket.on("register-admin", (adminData) => {
    console.log(
      "Admin registered:",
      socket.id,
      "with phone:",
      adminData.phoneNumber
    );
    socket.role = "admin";
    socket.adminData = adminData; // Lưu thông tin admin

    // Lưu socket ID và thông tin admin vào Map
    adminSockets.set(socket.id, {
      phoneNumber: adminData.phoneNumber,
      name: adminData.name || "Admin",
    });

    // Gửi danh sách người dùng hiện tại cho admin
    const clients = Array.from(io.sockets.sockets.values())
      .filter((s) => s.role === "client")
      .map((s) => ({
        socketId: s.id,
        userData: s.userData,
        // Thêm thông tin cuộc gọi nếu client đang trong trạng thái chờ
        callStatus: pendingCalls.has(s.id) ? "waiting" : undefined,
        callType: pendingCalls.has(s.id)
          ? pendingCalls.get(s.id).callType
          : undefined,
      }));

    socket.emit("current-clients", clients);

    // Gửi danh sách admin khác cho admin này
    const otherAdmins = Array.from(adminSockets.entries())
      .filter(([id, _]) => id !== socket.id)
      .map(([id, data]) => ({
        socketId: id,
        phoneNumber: data.phoneNumber,
        name: data.name,
      }));

    socket.emit("current-admins", otherAdmins);

    // Thông báo cho các admin khác về admin mới
    for (const [adminSocketId, _] of adminSockets.entries()) {
      if (adminSocketId !== socket.id) {
        const adminSocket = io.sockets.sockets.get(adminSocketId);
        if (adminSocket) {
          adminSocket.emit("new-admin", {
            socketId: socket.id,
            phoneNumber: adminData.phoneNumber,
            name: adminData.name || "Admin",
          });
        }
      }
    }

    // Gửi thông báo về các cuộc gọi đang chờ cho admin mới kết nối
    for (const [clientId, callData] of pendingCalls.entries()) {
      const clientSocket = io.sockets.sockets.get(clientId);
      if (clientSocket) {
        socket.emit("incoming-call", {
          socketId: clientId,
          userData: clientSocket.userData,
          callType: callData.callType,
        });
      }
    }
  });

  // Xử lý tín hiệu WebRTC
  socket.on("offer", (data) => {
    console.log("Offer from", socket.id, "to", data.target);
    // Gửi offer đến người nhận
    const targetSocket = io.sockets.sockets.get(data.target);
    if (targetSocket) {
      targetSocket.emit("offer", {
        offer: data.offer,
        source: socket.id,
        userData: socket.userData || socket.adminData, // Có thể là userData của client hoặc adminData
        callType: data.callType, // Thêm loại cuộc gọi (audio/video)
      });
    }
  });

  socket.on("answer", (data) => {
    console.log("Answer from", socket.id, "to", data.target);
    // Gửi answer đến người gửi offer
    const targetSocket = io.sockets.sockets.get(data.target);
    if (targetSocket) {
      targetSocket.emit("answer", {
        answer: data.answer,
        source: socket.id,
        callType: data.callType, // Thêm loại cuộc gọi (audio/video)
      });
    }
  });

  socket.on("ice-candidate", (data) => {
    console.log("ICE candidate from", socket.id, "to", data.target);
    // Gửi ice candidate đến đối tác
    const targetSocket = io.sockets.sockets.get(data.target);
    if (targetSocket) {
      targetSocket.emit("ice-candidate", {
        candidate: data.candidate,
        source: socket.id,
      });
    }
  });

  // Client yêu cầu gọi cho admin
  socket.on("call-request", (data) => {
    if (socket.role !== "client") return;

    const callType = data?.callType || "audio"; // Mặc định là audio nếu không có
    console.log(`${callType} call request from client:`, socket.id);

    // Kiểm tra xem yêu cầu có chỉ định admin cụ thể không
    const targetAdminId = data?.targetAdminPhone
      ? Array.from(adminSockets.entries()).find(
          ([_, adminData]) => adminData.phoneNumber === data.targetAdminPhone
        )?.[0]
      : null;

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
      socket.emit("call-timeout");

      // Thông báo cho tất cả admin hoặc admin cụ thể cập nhật trạng thái
      if (targetAdminId) {
        const targetAdminSocket = io.sockets.sockets.get(targetAdminId);
        if (targetAdminSocket) {
          targetAdminSocket.emit("call-timeout", {
            socketId: socket.id,
          });
        }
      } else {
        for (const [adminSocketId, _] of adminSockets.entries()) {
          const adminSocket = io.sockets.sockets.get(adminSocketId);
          if (adminSocket) {
            adminSocket.emit("call-timeout", {
              socketId: socket.id,
            });
          }
        }
      }
    }, 60000); // 60 giây

    // Lưu thông tin cuộc gọi và timeout của nó
    pendingCalls.set(socket.id, {
      callType: callType,
      timestamp: Date.now(),
      timeout: timeoutId,
      targetAdminId: targetAdminId, // Nếu có chỉ định admin cụ thể
    });

    // Thông báo cho admin về yêu cầu gọi
    if (targetAdminId) {
      // Nếu có chỉ định admin cụ thể, chỉ thông báo cho admin đó
      const targetAdminSocket = io.sockets.sockets.get(targetAdminId);
      if (targetAdminSocket) {
        targetAdminSocket.emit("incoming-call", {
          socketId: socket.id,
          userData: socket.userData,
          callType: callType,
          targetSpecific: true,
        });
      }
    } else {
      // Thông báo cho tất cả admin
      for (const [adminSocketId, _] of adminSockets.entries()) {
        const adminSocket = io.sockets.sockets.get(adminSocketId);
        if (adminSocket) {
          adminSocket.emit("incoming-call", {
            socketId: socket.id,
            userData: socket.userData,
            callType: callType,
          });
        }
      }
    }

    // Thông báo cho khách hàng rằng yêu cầu đã được gửi
    socket.emit("call-request-sent", {
      callType: callType,
      targetAdminPhone: data?.targetAdminPhone,
    });
  });

  // Admin gọi cho admin khác
  socket.on("admin-call-admin", (data) => {
    if (socket.role !== "admin") return;

    const targetAdminId = Array.from(adminSockets.entries()).find(
      ([_, adminData]) => adminData.phoneNumber === data.targetAdminPhone
    )?.[0];

    if (!targetAdminId) {
      return socket.emit("admin-not-found", {
        phoneNumber: data.targetAdminPhone,
      });
    }

    const targetAdminSocket = io.sockets.sockets.get(targetAdminId);
    if (targetAdminSocket) {
      console.log(`Admin ${socket.id} calling admin ${targetAdminId}`);

      targetAdminSocket.emit("incoming-admin-call", {
        socketId: socket.id,
        adminData: adminSockets.get(socket.id),
        callType: data.callType || "audio",
      });

      // Thông báo cho admin gọi
      socket.emit("admin-call-sent", {
        targetAdminId: targetAdminId,
        phoneNumber: data.targetAdminPhone,
      });
    }
  });

  // Admin chấp nhận cuộc gọi từ admin khác
  socket.on("accept-admin-call", (data) => {
    if (socket.role !== "admin") return;

    console.log(`Admin ${socket.id} accepted call from admin ${data.adminId}`);

    const callingAdminSocket = io.sockets.sockets.get(data.adminId);
    if (callingAdminSocket) {
      callingAdminSocket.emit("admin-call-accepted", {
        adminId: socket.id,
        callType: data.callType,
      });
    }
  });

  // Admin từ chối cuộc gọi từ admin khác
  socket.on("reject-admin-call", (data) => {
    if (socket.role !== "admin") return;

    console.log(`Admin ${socket.id} rejected call from admin ${data.adminId}`);

    const callingAdminSocket = io.sockets.sockets.get(data.adminId);
    if (callingAdminSocket) {
      callingAdminSocket.emit("admin-call-rejected", {
        adminId: socket.id,
      });
    }
  });

  // Admin chấp nhận cuộc gọi
  socket.on("accept-call", (data) => {
    if (socket.role !== "admin") return;

    console.log(
      `Admin accepted ${data.callType} call for client:`,
      data.clientId
    );

    // Hủy timeout nếu có
    if (pendingCalls.has(data.clientId)) {
      clearTimeout(pendingCalls.get(data.clientId).timeout);
      pendingCalls.delete(data.clientId);
    }

    const clientSocket = io.sockets.sockets.get(data.clientId);
    if (clientSocket) {
      clientSocket.emit("call-accepted", {
        adminId: socket.id,
        adminPhone: adminSockets.get(socket.id)?.phoneNumber,
        adminName: adminSockets.get(socket.id)?.name,
        callType: data.callType,
      });
    }

    // Thông báo cho các admin khác rằng cuộc gọi này đã được xử lý
    for (const [adminSocketId, _] of adminSockets.entries()) {
      if (adminSocketId !== socket.id) {
        const adminSocket = io.sockets.sockets.get(adminSocketId);
        if (adminSocket) {
          adminSocket.emit("call-handled", {
            clientId: data.clientId,
            handledBy: {
              socketId: socket.id,
              phoneNumber: adminSockets.get(socket.id)?.phoneNumber,
              name: adminSockets.get(socket.id)?.name,
            },
          });
        }
      }
    }
  });

  // Kết thúc cuộc gọi
  socket.on("end-call", (data) => {
    console.log("Call ended by", socket.id);

    // Nếu là client kết thúc cuộc gọi, hủy timeout và xóa khỏi pendingCalls
    if (socket.role === "client" && pendingCalls.has(socket.id)) {
      clearTimeout(pendingCalls.get(socket.id).timeout);
      pendingCalls.delete(socket.id);

      // Thông báo cho tất cả admin hoặc admin cụ thể rằng cuộc gọi đã bị hủy
      const targetAdminId = pendingCalls.get(socket.id)?.targetAdminId;

      if (targetAdminId) {
        const targetAdminSocket = io.sockets.sockets.get(targetAdminId);
        if (targetAdminSocket) {
          targetAdminSocket.emit("call-request-cancelled", {
            socketId: socket.id,
            userData: socket.userData,
            callType: data.callType,
          });
        }
      } else {
        for (const [adminSocketId, _] of adminSockets.entries()) {
          const adminSocket = io.sockets.sockets.get(adminSocketId);
          if (adminSocket) {
            adminSocket.emit("call-request-cancelled", {
              socketId: socket.id,
              userData: socket.userData,
              callType: data.callType,
            });
          }
        }
      }
    }

    // Gửi thông báo kết thúc cuộc gọi đến đối tác
    if (data.targetId) {
      const targetSocket = io.sockets.sockets.get(data.targetId);
      if (targetSocket) {
        targetSocket.emit("call-ended", {
          source: socket.id,
          isAdmin: socket.role === "admin",
        });
      }
    }
  });

  // Xử lý ngắt kết nối
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    if (socket.role === "admin") {
      const adminData = adminSockets.get(socket.id);
      adminSockets.delete(socket.id);

      // Thông báo cho các admin khác rằng một admin đã ngắt kết nối
      for (const [adminSocketId, _] of adminSockets.entries()) {
        const adminSocket = io.sockets.sockets.get(adminSocketId);
        if (adminSocket) {
          adminSocket.emit("admin-disconnected", {
            socketId: socket.id,
            phoneNumber: adminData?.phoneNumber,
            name: adminData?.name,
          });
        }
      }
    } else if (socket.role === "client") {
      // Nếu client đang có cuộc gọi chờ thì hủy
      if (pendingCalls.has(socket.id)) {
        clearTimeout(pendingCalls.get(socket.id).timeout);
        pendingCalls.delete(socket.id);
      }

      // Thông báo cho tất cả admin rằng client đã ngắt kết nối
      for (const [adminSocketId, _] of adminSockets.entries()) {
        const adminSocket = io.sockets.sockets.get(adminSocketId);
        if (adminSocket) {
          adminSocket.emit("client-disconnected", {
            socketId: socket.id,
            userData: socket.userData,
          });
        }
      }
    }
  });

  // Thêm vào các sự kiện socket
  socket.on("cancel-call-request", (data) => {
    console.log(`Client ${socket.id} cancelled call request`);

    // Nếu cuộc gọi đang trong trạng thái chờ
    if (pendingCalls.has(socket.id)) {
      const callData = pendingCalls.get(socket.id);
      clearTimeout(callData.timeout);

      // Thông báo cho admin cụ thể hoặc tất cả admin về việc hủy cuộc gọi
      if (callData.targetAdminId) {
        const targetAdminSocket = io.sockets.sockets.get(
          callData.targetAdminId
        );
        if (targetAdminSocket) {
          targetAdminSocket.emit("call-request-cancelled", {
            socketId: socket.id,
            userData: socket.userData,
            callType: data.callType,
          });
        }
      } else {
        for (const [adminSocketId, _] of adminSockets.entries()) {
          const adminSocket = io.sockets.sockets.get(adminSocketId);
          if (adminSocket) {
            adminSocket.emit("call-request-cancelled", {
              socketId: socket.id,
              userData: socket.userData,
              callType: data.callType,
            });
          }
        }
      }

      pendingCalls.delete(socket.id);
    }
  });

  // Lấy danh sách số điện thoại của admin
  socket.on("get-admin-phones", () => {
    // Trả về danh sách số điện thoại của các admin đang online
    const adminPhones = Array.from(adminSockets.values()).map((admin) => ({
      phoneNumber: admin.phoneNumber,
      name: admin.name,
    }));

    socket.emit("admin-phones-list", adminPhones);
  });
});

app.get("/", (req, res) => {
  res.send("OMI LiveTalk Signaling Server");
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
