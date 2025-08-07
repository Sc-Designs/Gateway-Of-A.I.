import axios from 'axios';

export default function socketHandler(io) {
  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    socket.on("join", ({ role, id }) => {
      const room = `${role}-${id}`;
      socket.join(room);
      console.log(`Socket ${socket.id} joined room ${room}`);
    });

    socket.on("block-user", async({from, give, to, token}) =>{
      try {
        const res = await axios.post(
          `${process.env.USER_API_URL}/block-user`,
          { to },
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );
        if (res.status === 200) {
          io.to(`admin-${give}`).emit("block-user-success", {
            message: `${res.data.blockStatus ? "Blocked" : "Unblocked"} user successfully`,
            userId: to,
          });

          io.to(`user-${to}`).emit("blocked", {
            message: "You have been blocked by admin",
            blockStatus: res.data.blockStatus,
          });
        }
      } catch (error) {
        console.error("Block user error:", error.message);
        io.to(`admin-${socket.id}`).emit("block-user-failed", {
          error: error.response?.data || "Failed to block user",
        });
      }
      
    });
    socket.on("block-org", async ({ from, give, to, token }) => {
      try {
        const res = await axios.post(
          `${process.env.ORG_API_URL}/block-org`,
          { to },
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );
        if (res.status === 200) {
          io.to(`admin-${give}`).emit("block-org-success", {
            message: `${
              res.data.blockStatus ? "Blocked" : "Unblocked"
            } org successfully`,
            orgId: to,
          });

          io.to(`org-${to}`).emit("blocked", {
            message: "You have been blocked by admin",
            blockStatus: res.data.blockStatus,
          });
        }
      } catch (error) {
        console.error("Block user error:", error.message);
        io.to(`admin-${socket.id}`).emit("block-user-failed", {
          error: error.response?.data || "Failed to block user",
        });
      }
    });

    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
    });
  });
}
