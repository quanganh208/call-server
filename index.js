const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // In production, limit to specific origins
    methods: ["GET", "POST"],
  },
});

// Store admin information
const adminSockets = new Map(); // Map to store admin info (socketId -> adminData)

// Store active call requests with timeouts
const activeCallRequests = new Map(); // Map to store pending call requests and their timeouts
const CALL_TIMEOUT_DURATION = 30000; // 30 seconds timeout for calls

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Client registration
  socket.on("register-client", (userData) => {
    console.log("Client registered:", userData.SocialName);
    socket.userData = userData;
    socket.role = "client";

    // Notify all admins about new client
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

  // Admin registration with phone number
  socket.on("register-admin", (adminData) => {
    console.log(
      "Admin registered:",
      socket.id,
      "with phone:",
      adminData.phoneNumber
    );
    socket.role = "admin";
    socket.adminData = adminData;

    // Store admin info in the map
    adminSockets.set(socket.id, {
      phoneNumber: adminData.phoneNumber,
      name: adminData.name || "Admin",
    });

    // Send current client list to the admin
    const clients = Array.from(io.sockets.sockets.values())
      .filter((s) => s.role === "client")
      .map((s) => ({
        socketId: s.id,
        userData: s.userData,
      }));

    socket.emit("current-clients", clients);

    // Send other admins list to this admin
    const otherAdmins = Array.from(adminSockets.entries())
      .filter(([id, _]) => id !== socket.id)
      .map(([id, data]) => ({
        socketId: id,
        phoneNumber: data.phoneNumber,
        name: data.name,
      }));

    socket.emit("current-admins", otherAdmins);

    // Notify other admins about new admin
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
  });

  // WebRTC signaling
  socket.on("offer", (data) => {
    console.log("Offer from", socket.id, "to", data.target);
    // Send offer to recipient
    const targetSocket = io.sockets.sockets.get(data.target);
    if (targetSocket) {
      targetSocket.emit("offer", {
        offer: data.offer,
        source: socket.id,
        userData: socket.userData || socket.adminData,
        callType: data.callType, // audio/video
      });
    }
  });

  socket.on("answer", (data) => {
    console.log("Answer from", socket.id, "to", data.target);
    // Send answer to offer sender
    const targetSocket = io.sockets.sockets.get(data.target);
    if (targetSocket) {
      targetSocket.emit("answer", {
        answer: data.answer,
        source: socket.id,
        callType: data.callType,
      });
    }
  });

  socket.on("ice-candidate", (data) => {
    console.log("ICE candidate from", socket.id, "to", data.target);
    // Send ice candidate to partner
    const targetSocket = io.sockets.sockets.get(data.target);
    if (targetSocket) {
      targetSocket.emit("ice-candidate", {
        candidate: data.candidate,
        source: socket.id,
      });
    }
  });

  // Client call request to admin
  socket.on("call-request", (data) => {
    if (socket.role !== "client") return;

    const callType = data?.callType || "audio"; // Default to audio
    console.log(`${callType} call request from client:`, socket.id);

    // Check if request specifies a particular admin
    const targetAdminPhone = data?.targetAdminPhone;
    let targetAdminId = null;

    if (targetAdminPhone) {
      // Find all admins with matching phone number
      const matchingAdmins = Array.from(adminSockets.entries()).filter(
        ([_, adminData]) => adminData.phoneNumber === targetAdminPhone
      );

      if (matchingAdmins.length > 0) {
        // Get the first available admin with this phone number
        const availableAdmin = matchingAdmins.find(([id, _]) => {
          const adminSocket = io.sockets.sockets.get(id);
          return adminSocket && !adminSocket.inCall;
        });

        if (availableAdmin) {
          targetAdminId = availableAdmin[0];
        } else {
          // All admins with this phone are busy
          return socket.emit("admin-busy", {
            targetAdminId: matchingAdmins[0][0],
            adminName: adminSockets.get(matchingAdmins[0][0])?.name || "Admin",
          });
        }
      } else {
        // Admin not online
        return socket.emit("admin-offline", {
          phoneNumber: targetAdminPhone,
        });
      }
    }

    // Set up timeout for call request
    const callRequestTimeout = setTimeout(() => {
      console.log(`Call request from client ${socket.id} timed out`);

      // Notify client about timeout
      socket.emit("call-timeout", {
        message: "Call request timed out. No admin answered your call.",
      });

      // Notify admins about cancelled call request
      if (targetAdminId) {
        // If specific admin was targeted
        const targetAdminSocket = io.sockets.sockets.get(targetAdminId);
        if (targetAdminSocket) {
          targetAdminSocket.emit("call-request-cancelled", {
            socketId: socket.id,
            userData: socket.userData,
            reason: "timeout",
          });
        }
      } else if (!targetAdminPhone) {
        // If call was to all admins
        for (const [adminSocketId, _] of adminSockets.entries()) {
          const adminSocket = io.sockets.sockets.get(adminSocketId);
          if (adminSocket) {
            adminSocket.emit("call-request-cancelled", {
              socketId: socket.id,
              userData: socket.userData,
              reason: "timeout",
            });
          }
        }
      }

      // Remove timeout from active call requests
      activeCallRequests.delete(socket.id);
    }, CALL_TIMEOUT_DURATION);

    // Store timeout reference
    activeCallRequests.set(socket.id, {
      type: "client-admin",
      timeout: callRequestTimeout,
      targetAdminId: targetAdminId,
    });

    // Notify admin(s) about call request
    if (targetAdminId) {
      // If specific admin is targeted and available, notify only that admin
      const targetAdminSocket = io.sockets.sockets.get(targetAdminId);
      if (targetAdminSocket) {
        targetAdminSocket.emit("incoming-call", {
          socketId: socket.id,
          userData: socket.userData,
          callType: callType,
          targetSpecific: true,
        });
      }
    } else if (!targetAdminPhone) {
      // If no specific admin is targeted, notify all available admins
      for (const [adminSocketId, _] of adminSockets.entries()) {
        const adminSocket = io.sockets.sockets.get(adminSocketId);
        if (adminSocket && !adminSocket.inCall) {
          adminSocket.emit("incoming-call", {
            socketId: socket.id,
            userData: socket.userData,
            callType: callType,
          });
        }
      }
    }

    // Notify client that request has been sent
    socket.emit("call-request-sent", {
      callType: callType,
      targetAdminPhone: data?.targetAdminPhone,
      adminIsOnline: !!targetAdminId || !targetAdminPhone,
      timeout: CALL_TIMEOUT_DURATION / 1000, // Send timeout in seconds
    });
  });

  // Thêm hàm kiểm tra xem admin có đang trong cuộc gọi
  const isAdminInCall = (adminSocketId) => {
    const adminSocket = io.sockets.sockets.get(adminSocketId);
    return adminSocket && adminSocket.inCall === true;
  };

  // Admin call to another admin
  socket.on("admin-call-admin", (data) => {
    if (socket.role !== "admin") return;

    const callType = data?.callType || "audio";
    const targetAdminPhone = data.targetAdminPhone;

    // Trước tiên kiểm tra xem admin gọi có đang trong cuộc gọi không
    if (socket.inCall) {
      console.log(
        `Admin ${socket.id} đang trong cuộc gọi nhưng vẫn cố gắng gọi`
      );
      return socket.emit("error", {
        message: "Bạn đang trong một cuộc gọi khác",
      });
    }

    if (!targetAdminPhone) {
      return socket.emit("error", {
        message: "Target admin phone number not provided",
      });
    }

    // Find admin with corresponding phone number
    const targetAdmin = Array.from(adminSockets.entries()).find(
      ([_, adminData]) => adminData.phoneNumber === targetAdminPhone
    );

    if (targetAdmin) {
      // Admin is online
      const targetAdminId = targetAdmin[0];
      const targetAdminSocket = io.sockets.sockets.get(targetAdminId);

      if (targetAdminSocket) {
        // Check if target admin is in another call
        if (isAdminInCall(targetAdminId)) {
          console.log(`Target admin ${targetAdminId} is busy in another call`);
          return socket.emit("admin-busy", {
            targetAdminId: targetAdminId,
            adminName: adminSockets.get(targetAdminId)?.name || "Admin",
          });
        }

        console.log(`Admin ${socket.id} calling admin ${targetAdminId}`);

        // Set up timeout for admin-to-admin call
        const adminCallTimeout = setTimeout(() => {
          console.log(
            `Admin call from ${socket.id} to ${targetAdminId} timed out`
          );

          // Notify calling admin about timeout
          socket.emit("admin-call-timeout", {
            targetAdminId: targetAdminId,
            adminName: adminSockets.get(targetAdminId)?.name || "Admin",
            message:
              "Call request timed out. The admin didn't answer your call.",
          });

          // Notify target admin that call timed out
          if (targetAdminSocket) {
            targetAdminSocket.emit("admin-call-cancelled", {
              adminId: socket.id,
              adminName: adminSockets.get(socket.id)?.name || "Admin",
              reason: "timeout",
            });
          }

          // Remove timeout from active call requests
          activeCallRequests.delete(`admin-${socket.id}-${targetAdminId}`);
        }, CALL_TIMEOUT_DURATION);

        // Store timeout reference
        activeCallRequests.set(`admin-${socket.id}-${targetAdminId}`, {
          type: "admin-admin",
          timeout: adminCallTimeout,
          callerAdminId: socket.id,
          targetAdminId: targetAdminId,
        });

        targetAdminSocket.emit("incoming-admin-call", {
          socketId: socket.id,
          adminData: adminSockets.get(socket.id),
          callType: callType,
        });

        // Notify calling admin
        socket.emit("admin-call-sent", {
          targetAdminId: targetAdminId,
          phoneNumber: targetAdminPhone,
          adminName: adminSockets.get(targetAdminId)?.name || "Admin",
          timeout: CALL_TIMEOUT_DURATION / 1000, // Send timeout in seconds
        });
      }
    } else {
      // Admin not online
      console.log(`Admin with phone ${targetAdminPhone} is not online`);
      socket.emit("admin-offline", {
        phoneNumber: targetAdminPhone,
      });
    }
  });

  // Admin accepts call
  socket.on("accept-call", (data) => {
    if (socket.role !== "admin") return;

    console.log(
      `Admin accepted ${data.callType} call for client:`,
      data.clientId
    );

    // Clear any pending timeout for this call
    const callRequest = activeCallRequests.get(data.clientId);
    if (callRequest) {
      clearTimeout(callRequest.timeout);
      activeCallRequests.delete(data.clientId);
    }

    // Mark admin as in call
    socket.inCall = true;

    const clientSocket = io.sockets.sockets.get(data.clientId);
    if (clientSocket) {
      clientSocket.emit("call-accepted", {
        adminId: socket.id,
        adminPhone: adminSockets.get(socket.id)?.phoneNumber,
        adminName: adminSockets.get(socket.id)?.name,
        callType: data.callType,
      });
    }

    // Notify other admins that call has been handled
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

  // Admin accepts call from another admin
  socket.on("accept-admin-call", (data) => {
    if (socket.role !== "admin") return;

    console.log(`Admin ${socket.id} accepted call from admin ${data.adminId}`);

    // Clear any pending timeout for this admin call
    const callId = `admin-${data.adminId}-${socket.id}`;
    const callRequest = activeCallRequests.get(callId);
    if (callRequest) {
      clearTimeout(callRequest.timeout);
      activeCallRequests.delete(callId);
    }

    // Mark admin as in call
    socket.inCall = true;

    const callingAdminSocket = io.sockets.sockets.get(data.adminId);
    if (callingAdminSocket) {
      callingAdminSocket.inCall = true;
      callingAdminSocket.emit("admin-call-accepted", {
        adminId: socket.id,
        callType: data.callType,
      });
    }
  });

  // Admin rejects call from another admin
  socket.on("reject-admin-call", (data) => {
    if (socket.role !== "admin") return;

    console.log(`Admin ${socket.id} rejected call from admin ${data.adminId}`);

    // Clear any pending timeout for this admin call
    const callId = `admin-${data.adminId}-${socket.id}`;
    const callRequest = activeCallRequests.get(callId);
    if (callRequest) {
      clearTimeout(callRequest.timeout);
      activeCallRequests.delete(callId);
    }

    const callingAdminSocket = io.sockets.sockets.get(data.adminId);
    if (callingAdminSocket) {
      callingAdminSocket.emit("admin-call-rejected", {
        adminId: socket.id,
        adminName: socket.adminData.name,
      });
    }
  });

  // End call
  socket.on("end-call", (data) => {
    console.log(
      "Call ended by",
      socket.id,
      "target:",
      data.targetId,
      "additional data:",
      data
    );

    // Kiểm tra nếu không có targetId nhưng có forceCleanup, chỉ reset trạng thái của socket hiện tại
    if (!data.targetId && data?.forceCleanup) {
      if (socket.role === "admin") {
        socket.inCall = false;
      }
      return;
    }

    // Get information about call participants
    const targetSocket = io.sockets.sockets.get(data.targetId);
    const isTargetAdmin = targetSocket && targetSocket.role === "admin";
    const isSourceAdmin = socket.role === "admin";

    // If both are admins (admin-admin call)
    if (isSourceAdmin && isTargetAdmin) {
      console.log("Admin-admin call ended");
      // Update call status for both admins
      socket.inCall = false;
      if (targetSocket) {
        targetSocket.inCall = false;
      }
    }
    // If only one side is admin (client-admin call)
    else if (isSourceAdmin || isTargetAdmin) {
      console.log("Client-admin call ended");
      // Update call status only for admin
      if (isSourceAdmin) {
        socket.inCall = false;
      } else if (targetSocket) {
        targetSocket.inCall = false;
      }
    }

    // Send call end notification to partner with detailed info
    if (data.targetId) {
      const targetSocket = io.sockets.sockets.get(data.targetId);
      if (targetSocket) {
        console.log(
          `Sending call-ended event to ${data.targetId} from ${
            socket.id
          } with reason: ${data.endReason || "unknown"}`
        );
        targetSocket.emit("call-ended", {
          source: socket.id,
          isAdmin: socket.role === "admin",
          isAdminCall: data.isAdminCall || false,
          isInitiator: data.isInitiator || false,
          endReason: data.endReason || "unknown",
          callType:
            isSourceAdmin && isTargetAdmin ? "admin-admin" : "client-admin",
          endedBy: socket.id,
          timestamp: Date.now(),
        });
      }
    }

    // Đảm bảo admin gọi cuộc gọi đều không còn trạng thái inCall
    if (isSourceAdmin) {
      console.log(`Resetting inCall for admin ${socket.id}`);
      socket.inCall = false;

      // Thông báo cho các admin khác về trạng thái của admin này
      for (const [adminSocketId, _] of adminSockets.entries()) {
        if (adminSocketId !== socket.id) {
          const adminSocket = io.sockets.sockets.get(adminSocketId);
          if (adminSocket) {
            adminSocket.emit("admin-status-changed", {
              adminId: socket.id,
              inCall: false,
            });
          }
        }
      }
    }
  });

  // Cancel call request
  socket.on("cancel-call-request", () => {
    console.log(`Client ${socket.id} cancelled call request`);

    // Clear any pending timeout for this call
    const callRequest = activeCallRequests.get(socket.id);
    if (callRequest) {
      clearTimeout(callRequest.timeout);
      activeCallRequests.delete(socket.id);
    }

    // Notify all admins that call request was cancelled
    for (const [adminSocketId, _] of adminSockets.entries()) {
      const adminSocket = io.sockets.sockets.get(adminSocketId);
      if (adminSocket) {
        adminSocket.emit("call-request-cancelled", {
          socketId: socket.id,
          userData: socket.userData,
          reason: "user-cancelled",
        });
      }
    }
  });

  // Cancel admin-to-admin call
  socket.on("cancel-admin-call", (data) => {
    if (socket.role !== "admin") return;

    console.log(
      `Admin ${socket.id} cancelled call to admin ${data.targetAdminId}`
    );

    // Clear any pending timeout for this admin call
    const callId = `admin-${socket.id}-${data.targetAdminId}`;
    const callRequest = activeCallRequests.get(callId);
    if (callRequest) {
      clearTimeout(callRequest.timeout);
      activeCallRequests.delete(callId);
    }

    // Notify target admin that call was cancelled
    const targetAdminSocket = io.sockets.sockets.get(data.targetAdminId);
    if (targetAdminSocket) {
      console.log(
        `Sending admin-call-cancelled to ${data.targetAdminId} from ${socket.id}`
      );
      targetAdminSocket.emit("admin-call-cancelled", {
        adminId: socket.id,
        adminName: adminSockets.get(socket.id)?.name || "Admin",
        reason: "user-cancelled",
        timestamp: Date.now(),
      });
    }
  });

  // Reset admin call state
  socket.on("admin-reset-call-state", () => {
    if (socket.role !== "admin") return;

    console.log(`Admin ${socket.id} reset call state`);

    // Reset admin call state
    socket.inCall = false;

    // Thông báo cho tất cả admin khác về việc này để họ có thể cập nhật UI
    for (const [adminSocketId, _] of adminSockets.entries()) {
      if (adminSocketId !== socket.id) {
        const adminSocket = io.sockets.sockets.get(adminSocketId);
        if (adminSocket) {
          adminSocket.emit("admin-status-changed", {
            adminId: socket.id,
            inCall: false,
          });
        }
      }
    }
  });

  // Thêm sự kiện kiểm tra trạng thái admin
  socket.on("check-admin-status", (data) => {
    const { targetAdminPhone } = data;

    if (!targetAdminPhone) {
      return socket.emit("admin-status", { online: false });
    }

    // Tìm admin với số điện thoại tương ứng
    const targetAdmin = Array.from(adminSockets.entries()).find(
      ([_, adminData]) => adminData.phoneNumber === targetAdminPhone
    );

    if (targetAdmin) {
      const targetAdminId = targetAdmin[0];
      const targetAdminSocket = io.sockets.sockets.get(targetAdminId);

      if (targetAdminSocket) {
        socket.emit("admin-status", {
          online: true,
          inCall: !!targetAdminSocket.inCall,
          adminName: adminSockets.get(targetAdminId)?.name || "Admin",
        });
      } else {
        socket.emit("admin-status", { online: false });
      }
    } else {
      socket.emit("admin-status", { online: false });
    }
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    // Clear any pending call requests
    if (socket.role === "client") {
      const callRequest = activeCallRequests.get(socket.id);
      if (callRequest) {
        clearTimeout(callRequest.timeout);
        activeCallRequests.delete(socket.id);
      }
    } else if (socket.role === "admin") {
      // Check for and clear admin-admin calls
      for (const [callId, callData] of activeCallRequests.entries()) {
        if (
          callData.type === "admin-admin" &&
          (callData.callerAdminId === socket.id ||
            callData.targetAdminId === socket.id)
        ) {
          clearTimeout(callData.timeout);
          activeCallRequests.delete(callId);

          // Notify the other admin if needed
          const otherAdminId =
            callData.callerAdminId === socket.id
              ? callData.targetAdminId
              : callData.callerAdminId;
          const otherAdminSocket = io.sockets.sockets.get(otherAdminId);

          if (otherAdminSocket) {
            otherAdminSocket.emit("admin-call-cancelled", {
              adminId: socket.id,
              reason: "disconnect",
            });
          }
        }
      }
    }

    if (socket.role === "admin") {
      const adminData = adminSockets.get(socket.id);
      adminSockets.delete(socket.id);

      // Notify other admins that an admin has disconnected
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
      // Notify all admins that client has disconnected
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
});

app.get("/", (req, res) => {
  res.send("OMI LiveTalk Signaling Server");
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
