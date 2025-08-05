import express from "express"
import expressProxy from "express-http-proxy"
import cors from "cors"
import logger from "morgan"
import "dotenv/config"
import rateLimit from "express-rate-limit";
import RedisStore from "rate-limit-redis";
import redisClient from "./redisClient.js"
const app = express();

app.use(logger("dev"))
app.use(cors({origin: "http://localhost:5173"}))

// const limiter = rateLimit({
//   store: new RedisStore({
//     sendCommand: (...args) => redisClient.call(...args),
//     prefix: "rl-global",
//   }),
//   windowMs: 15 * 60 * 1000,
//   max: 100,
//   message: "Too many requests from this IP. Please try again later.",
//   standardHeaders: true,
//   legacyHeaders: false,
// });

// app.use(limiter);

const userLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix: "rl-user",
  }),
  windowMs: 10 * 60 * 1000,
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

app.use("/user",userLimiter , expressProxy("http://localhost:3001"))
app.use("/admin",adminLimiter , expressProxy("http://localhost:3002"))
app.use("/ai", expressProxy("http://localhost:3003"))
app.use("/orgs", expressProxy("http://localhost:3004"))
app.use("/result", expressProxy("http://localhost:3005"))
app.use("/test", expressProxy("http://localhost:3006"))

app.listen(3000,()=>{
    console.log("GateWay Running on 3000")
})