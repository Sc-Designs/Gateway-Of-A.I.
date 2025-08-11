import http from "http";
import { Server } from "socket.io";
import app from "./app.js";
import socketHandler from "./socket/socketHandler.js";

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    credentials: true,
  },
});

// Call socket handler function
socketHandler(io);

// Run the server
server.listen(process.env.PORT || 3000, () => {
  console.log("Gateway (with Socket.IO) running on port 3000");
});
