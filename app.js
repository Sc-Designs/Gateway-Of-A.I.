import express from "express";
import expressProxy from "express-http-proxy";
import cors from "cors";
import logger from "morgan";
import "dotenv/config";
import rateLimit from "express-rate-limit";
import RedisStore from "rate-limit-redis";
import redisClient from "./redisClient.js";

const app = express();

app.use(logger("dev"));
app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  })
);

// ----------------------
// RATE LIMITERS
// ----------------------
const globalLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix: "rl-global",
  }),
  windowMs: 15 * 60 * 1000, // 15 min
  max: 500,
  message: "Too many requests from this IP. Please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
});

const userLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix: "rl-user",
  }),
  windowMs: 10 * 60 * 1000, // 10 min
  max: 50,
  message: "User service rate limit exceeded.",
});

const adminLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix: "rl-admin",
  }),
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: "Admin service rate limit exceeded.",
});

app.use(globalLimiter);

// ----------------------
// PROXY CREATOR
// ----------------------
const makeProxy = (target) =>
  expressProxy(target, {
    parseReqBody: false, // ✅ allows multipart streaming
    preserveHostHdr: true,
    proxyReqPathResolver: (req) => req.url,
    proxyReqOptDecorator: (proxyReqOpts, srcReq) => {
      proxyReqOpts.headers = {
        ...proxyReqOpts.headers,
        ...srcReq.headers,
        host: new URL(target).host,
      };
      return proxyReqOpts;
    },
    proxyErrorHandler: (err, res) => {
      console.error(`[Proxy ${target}]`, err);
      res.status(502).json({ message: "Upstream service error" });
    },
  });

// ----------------------
// MOUNT SERVICES
// ----------------------
app.use("/user", userLimiter, makeProxy("http://localhost:3001"));
app.use("/admin", adminLimiter, makeProxy("http://localhost:3002"));
app.use("/ai", makeProxy("http://localhost:3003"));
app.use("/orgs", makeProxy("http://localhost:3004"));
app.use("/result", makeProxy("http://localhost:3005"));
app.use("/test", makeProxy("http://localhost:3006"));

// ----------------------
app.listen(3000, () => {
  console.log("Gateway running on 3000");
});
