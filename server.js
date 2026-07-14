import http from "http";
import "dotenv/config";
import { Server } from "socket.io";
import app from "./app.js";
import socketHandler from "./socket/socketHandler.js";

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.Frontend_URL || "http://localhost:5173",
    credentials: true,
  },
});

// Call socket handler function
socketHandler(io);

// Run the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
