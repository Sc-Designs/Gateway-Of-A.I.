import express from "express";
import expressProxy from "express-http-proxy";
import cors from "cors";
import logger from "morgan";
import "dotenv/config";
import rateLimit from "express-rate-limit";
import RedisStore from "rate-limit-redis";
import redisClient from "./redisClient.js";

const app = express();

app.set("trust proxy", 1);

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
  max: 2000,
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
  max: 500,
  message: "User service rate limit exceeded.",
});

const adminLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix: "rl-admin",
  }),
  windowMs: 10 * 60 * 1000, // 10 min
  max: 200,
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
      console.log(err);
      res.status(502).json({ message: "Upstream service error" });
    },
  });

// ----------------------
// MOUNT SERVICES
// ----------------------
console.log("User"+ process.env.USER_API_URL + "Admin" + process.env.ADMIN_API_URL + "ai" + process.env.AI_API_URL + "Orgs" + process.env.ORG_API_URL + "result" + process.env.RESULT_API_URL + "test" + process.env.TEST_API_URL);
app.use("/user", userLimiter, makeProxy(process.env.USER_API_URL));
app.use("/admin", adminLimiter, makeProxy(process.env.ADMIN_API_URL));
app.use("/ai", makeProxy(process.env.AI_API_URL));
app.use("/orgs", makeProxy(process.env.ORG_API_URL));
app.use("/result", makeProxy(process.env.RESULT_API_URL));
app.use("/test", makeProxy(process.env.TEST_API_URL));

// ----------------------

export default app;
