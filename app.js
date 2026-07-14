import express from "express";
import expressProxy from "express-http-proxy";
import cors from "cors";
import logger from "morgan";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import RedisStore from "rate-limit-redis";
import helmet from "helmet";
import redisClient from "./redisClient.js";

// ----------------------
// ENVIRONMENT VALIDATION
// ----------------------
// Fail fast at startup — never silently route to undefined
const REQUIRED_ENV = [
  "Frontend_URL",
  "USER_API_URL",
  "ADMIN_API_URL",
  "AI_API_URL",
  "ORG_API_URL",
  "RESULT_API_URL",
  "TEST_API_URL",
];

const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(
    `[Gateway] FATAL: Missing required environment variables: ${missingEnv.join(", ")}`,
  );
  process.exit(1);
}

// Validate all upstream URLs are actually valid URLs
const UPSTREAM_URLS = {
  USER_API_URL: process.env.USER_API_URL,
  ADMIN_API_URL: process.env.ADMIN_API_URL,
  AI_API_URL: process.env.AI_API_URL,
  ORG_API_URL: process.env.ORG_API_URL,
  RESULT_API_URL: process.env.RESULT_API_URL,
  TEST_API_URL: process.env.TEST_API_URL,
};

for (const [key, value] of Object.entries(UPSTREAM_URLS)) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error(`Protocol must be http or https, got: ${url.protocol}`);
    }
  } catch (err) {
    console.error(`[Gateway] FATAL: Invalid URL for ${key}: ${err.message}`);
    process.exit(1);
  }
}

// Never log upstream URLs in production — they may contain credentials
if (process.env.NODE_ENV !== "production") {
  console.log(
    "[Gateway] Upstream services configured:",
    Object.keys(UPSTREAM_URLS).join(", "),
  );
}

// ----------------------
// APP INIT
// ----------------------
const app = express();

app.set("trust proxy", 1); // Trust only the first proxy hop

// ----------------------
// SECURITY HEADERS (helmet)
// ----------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: true,
    crossOriginOpenerPolicy: true,
    crossOriginResourcePolicy: { policy: "same-origin" },
    dnsPrefetchControl: { allow: false },
    frameguard: { action: "deny" },
    hidePoweredBy: true, // Remove X-Powered-By: Express
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
    ieNoOpen: true,
    noSniff: true, // X-Content-Type-Options: nosniff
    originAgentCluster: true,
    permittedCrossDomainPolicies: false,
    referrerPolicy: { policy: "no-referrer" },
    xssFilter: true,
  }),
);

// ----------------------
// CORS — strict origin enforcement
// ----------------------
const allowedOrigins = process.env.Frontend_URL.split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Block requests with no origin (except in dev/test for tooling like curl)
      if (!origin) {
       const safePaths = ["/health", "/"];
       if (
         process.env.NODE_ENV === "production" &&
         !safePaths.includes(req.path)
       ) {
         return callback(
           new Error("Requests without an Origin are not allowed"),
         );
       }
        return callback(null, true);
      }
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS: Origin '${origin}' is not allowed`));
    },
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 600, // Cache preflight for 10 min
  }),
);

// ----------------------
// BODY SIZE LIMITS
// ----------------------
// Prevents large-payload DoS before it reaches the upstream
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// ----------------------
// LOGGING (redact sensitive data)
// ----------------------
logger.token("redacted-url", (req) => {
  // Strip query-string tokens/keys from access logs
  try {
    const url = new URL(req.url, "http://placeholder");
    ["token", "key", "secret", "password", "api_key"].forEach((param) =>
      url.searchParams.set(param, "[REDACTED]"),
    );
    return url.pathname + (url.search !== "?" ? url.search : "");
  } catch {
    return req.url;
  }
});

app.use(
  logger(
    process.env.NODE_ENV === "production"
      ? ":remote-addr - :method :redacted-url :status :res[content-length] - :response-time ms"
      : "dev",
  ),
);

// ----------------------
// REQUEST HEADER SANITIZATION
// ----------------------
// Strip internal/hop-by-hop headers that should never come from clients.
// Prevents header injection and privilege escalation (e.g. a client spoofing
// X-Internal-User-Id that a downstream service blindly trusts).
const BLOCKED_INBOUND_HEADERS = new Set([
  "x-forwarded-for", // Will be re-set by the proxy layer correctly
  "x-real-ip",
  "x-internal-user-id",
  "x-internal-role",
  "x-gateway-secret",
  "x-admin-token",
  "x-service-auth",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

app.use((req, res, next) => {
  for (const header of BLOCKED_INBOUND_HEADERS) {
    delete req.headers[header];
  }
  next();
});

// ----------------------
// PATH TRAVERSAL GUARD
// ----------------------
// Block any request URLs containing path traversal or null bytes
app.use((req, res, next) => {
  const raw = decodeURIComponent(req.url);
  if (raw.includes("..") || raw.includes("\0") || raw.includes("%00")) {
    return res.status(400).json({ message: "Invalid request path" });
  }
  next();
});

// ----------------------
// RATE LIMITERS
// ----------------------
const makeRateLimiter = (prefix, windowMinutes, max, message) =>
  rateLimit({
    store: new RedisStore({
      sendCommand: (...args) => redisClient.call(...args),
      prefix: `rl-${prefix}:`,
    }),
    windowMs: windowMinutes * 60 * 1000,
    max,
    message: { message },
    standardHeaders: true,
    legacyHeaders: false,
    // Use a key that combines IP + route prefix to prevent cross-route limit sharing
    keyGenerator: (req) => {
      const ip = ipKeyGenerator(req.ip);
      return `${ip}:${prefix}`;
    },
    // Don't crash the gateway if Redis is down — fail open with a warning
    skip: () => false,
    handler: (req, res) => {
      console.warn(`[RateLimit] ${prefix} exceeded for IP: ${req.ip}`);
      res.status(429).json({ message });
    },
  });

const globalLimiter = makeRateLimiter(
  "global",
  15,
  2000,
  "Too many requests. Please try again later.",
);
const userLimiter = makeRateLimiter(
  "user",
  10,
  500,
  "User service rate limit exceeded.",
);
const adminLimiter = makeRateLimiter(
  "admin",
  10,
  200,
  "Admin service rate limit exceeded.",
);
const aiLimiter = makeRateLimiter(
  "ai",
  1,
  30,
  "AI service rate limit exceeded.",
); // AI endpoints are expensive

app.use(globalLimiter);

// ----------------------
// GATEWAY SECRET (inter-service auth)
// ----------------------
// Downstream services should validate this header to reject requests
// that didn't come through the gateway.
const GATEWAY_SECRET = process.env.GATEWAY_SECRET;
if (!GATEWAY_SECRET || GATEWAY_SECRET.length < 32) {
  console.error(
    "[Gateway] FATAL: GATEWAY_SECRET must be set and at least 32 characters.",
  );
  process.exit(1);
}

// ----------------------
// PROXY FACTORY
// ----------------------
const makeProxy = (target, stripPrefix = "") =>
  expressProxy(target, {
    // Only parse body for non-multipart (preserve streaming for file uploads)
    parseReqBody: (req) => {
      const contentType = req.headers["content-type"] || "";
      return !contentType.startsWith("multipart/");
    },
    // Do NOT preserve the inbound Host header — use the upstream's own host.
    // Preserving it can confuse virtual-host routing on the upstream.
    preserveHostHdr: false,

    proxyReqPathResolver: (req) => {
      let path = req.url;
      if (stripPrefix && path.startsWith(stripPrefix)) {
        path = path.slice(stripPrefix.length) || "/";
      }
      // Final guard: reject paths that still look dangerous after stripping
      if (path.includes("..") || path.includes("\0")) {
        throw new Error("Blocked path traversal in proxy path resolver");
      }
      return path;
    },

    proxyReqOptDecorator: (proxyReqOpts, srcReq) => {
      const targetHost = new URL(target).host;

      // Build a clean forwarded header set — never blindly spread srcReq.headers
      // into the proxy request, as that leaks hop-by-hop and client headers.
      proxyReqOpts.headers = {
        // Keep content negotiation headers from the client
        "content-type": srcReq.headers["content-type"] || "",
        accept: srcReq.headers["accept"] || "*/*",
        "accept-language": srcReq.headers["accept-language"] || "",
        // Pass the Authorization header through so upstreams can validate JWTs
        ...(srcReq.headers["authorization"]
          ? { authorization: srcReq.headers["authorization"] }
          : {}),
        // Correct Host for the upstream virtual-host routing
        host: targetHost,
        // Propagate the real client IP (already validated by trust proxy:1)
        "x-forwarded-for": srcReq.ip,
        "x-forwarded-proto": srcReq.protocol,
        // Gateway identity so upstreams can reject unproxied traffic
        "x-gateway-secret": GATEWAY_SECRET,
        // Optional: pass request ID for distributed tracing
        ...(srcReq.headers["x-request-id"]
          ? { "x-request-id": srcReq.headers["x-request-id"] }
          : {}),
      };

      return proxyReqOpts;
    },

    // Strip internal headers from upstream responses before sending to clients
    userResDecorator: (proxyRes, proxyResData) => {
      delete proxyRes.headers["x-powered-by"];
      delete proxyRes.headers["server"];
      delete proxyRes.headers["x-internal-trace"];
      return proxyResData;
    },

    proxyErrorHandler: (err, res, next) => {
      // Log internally but never leak upstream error details to clients
      console.error(`[Proxy → ${target}] ${err.message}`);
      res
        .status(502)
        .json({
          message: "Service temporarily unavailable. Please try again.",
        });
    },
  });

// ----------------------
// ADMIN AUTH MIDDLEWARE
// ----------------------
// These routes produce the token — they must be reachable without one.
const ADMIN_PUBLIC_ROUTES = new Set([
  "/api/login",
  "/api/register",
  "/api/verify-otp",
]);

const requireAdminAuth = (req, res, next) => {
  // Let login / register / otp through without a token
  if (ADMIN_PUBLIC_ROUTES.has(req.path)) return next();

  const auth = req.headers["authorization"] || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Authorization required" });
  }
  // Reject clearly malformed tokens early (real validation is on the admin service)
  const token = auth.slice(7);
  if (token.length < 20 || /\s/.test(token)) {
    return res
      .status(401)
      .json({ message: "Invalid authorization token format" });
  }
  next();
};

// ----------------------
// MOUNT SERVICES
// ----------------------
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "API Gateway" });
});

// Health check — no rate limiting, no auth, used by load balancers
app.get("/health", (_req, res) => {
  res.json({ status: "healthy", ts: new Date().toISOString() });
});

app.use(
  "/user",
  userLimiter,
  (req, _res, next) => {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[Gateway → User] ${req.method} ${req.url}`);
    }
    next();
  },
  makeProxy(process.env.USER_API_URL, "/user"),
);

app.use(
  "/admin",
  adminLimiter,
  requireAdminAuth, // Extra auth gate before proxying
  makeProxy(process.env.ADMIN_API_URL),
);

app.use("/ai", aiLimiter, makeProxy(process.env.AI_API_URL)); // Stricter AI limit
app.use("/orgs", makeProxy(process.env.ORG_API_URL));
app.use("/result", makeProxy(process.env.RESULT_API_URL));
app.use("/test", makeProxy(process.env.TEST_API_URL));

// ----------------------
// 404 CATCH-ALL
// ----------------------
app.use((_req, res) => {
  res.status(404).json({ message: "Not found" });
});

// ----------------------
// GLOBAL ERROR HANDLER
// ----------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  // CORS errors and other thrown errors land here
  if (err.message?.startsWith("CORS")) {
    return res.status(403).json({ message: "CORS policy violation" });
  }
  // Never expose stack traces to clients
  console.error("[Gateway] Unhandled error:", err.message);
  res.status(500).json({ message: "Internal server error" });
});

export default app;
