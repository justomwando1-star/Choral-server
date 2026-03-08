import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import usersRouter from "./routes/users.js";
import accountRouter from "./routes/account.js";
import uploadRouter from "./routes/uploads.js";
import rolesRouter from "./routes/role.js";
import requestRoleRouter from "./routes/requestRole.js";
import compositionsRouter from "./routes/compositions.js";
import purchasesRouter from "./routes/purchases.js";
import checkoutRouter from "./routes/checkout.js";
import categoriesRouter from "./routes/categories.js";
import adminRouter from "./routes/admin.js";
import mediaRouter from "./routes/media.js";
import supportRouter from "./routes/support.js";
import notificationsRouter from "./routes/notifications.js";
import enrollmentsRouter from "./routes/enrollments.js";
import registrationRouter from "./routes/registration.js";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

function parseAllowedOrigins(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const configuredOrigins = [
  ...parseAllowedOrigins(process.env.CORS_ORIGIN),
  ...parseAllowedOrigins(process.env.ALLOWED_ORIGINS),
];
const allowAnyOrigin = configuredOrigins.includes("*");
const allowedOriginSet = new Set(configuredOrigins.filter((origin) => origin !== "*"));

function resolveCorsOrigin(origin, callback) {
  if (!origin || allowAnyOrigin || allowedOriginSet.size === 0) {
    return callback(null, true);
  }

  if (allowedOriginSet.has(origin)) {
    return callback(null, true);
  }

  return callback(new Error(`CORS blocked for origin: ${origin}`), false);
}

app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`[api] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});
app.use(
  cors({
    origin: resolveCorsOrigin,
    credentials: true,
  }),
);

app.use("/api/users", usersRouter);
app.use("/api/account", accountRouter);
app.use("/api/upload", uploadRouter);
app.use("/api/user", rolesRouter);
app.use("/api", requestRoleRouter);
app.use("/api/compositions", compositionsRouter);
app.use("/api/purchases", purchasesRouter);
app.use("/api/checkout", checkoutRouter);
app.use("/api/categories", categoriesRouter);
app.use("/api/admin", adminRouter);
app.use("/api/media", mediaRouter);
app.use("/api/support", supportRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/enrollments", enrollmentsRouter);
app.use("/api/registration", registrationRouter);

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/health", (_req, res) => res.json({ ok: true }));

const shouldServeStatic =
  String(process.env.SERVE_STATIC || "")
    .trim()
    .toLowerCase() === "true";

if (shouldServeStatic) {
  const distPath = path.resolve(__dirname, "..", "dist");
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api")) return next();
      return res.sendFile(path.join(distPath, "index.html"));
    });
    console.log(`[server] serving frontend static files from ${distPath}`);
  } else {
    console.warn(`[server] SERVE_STATIC=true but dist directory was not found at ${distPath}`);
  }
}

app.use((err, _req, res, _next) => {
  if (String(err?.message || "").startsWith("CORS blocked")) {
    return res.status(403).json({ message: err.message });
  }

  console.error("[server] Unhandled error:", err);
  res.status(500).json({ message: "Internal server error" });
});

const PORT = Number(process.env.PORT || 3001);
let serverInstance = null;

export function startServer(port = PORT) {
  if (serverInstance) return serverInstance;

  const server = http.createServer(app);

  server.on("listening", () => {
    console.log(`[server] listening on port ${port}`);
  });

  server.on("error", (error) => {
    if (error?.code === "EADDRINUSE") {
      console.error(
        `[server] Port ${port} is already in use. Stop the existing process or change PORT in server/.env.`,
      );
      console.error(
        "[server] Windows quick fix: netstat -ano | findstr :3001, then taskkill /PID <pid> /F",
      );
    } else {
      console.error("[server] Failed to start:", error);
    }
    serverInstance = null;
  });

  server.listen(port);
  serverInstance = server;
  return server;
}

export function stopServer() {
  if (!serverInstance) return;
  serverInstance.close();
  serverInstance = null;
}

function registerShutdownHandlers() {
  const shutdown = () => {
    stopServer();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // nodemon restart signal on Windows/Node: allow clean close before re-spawn
  process.once("SIGUSR2", () => {
    stopServer();
    process.kill(process.pid, "SIGUSR2");
  });
}

const isMainModule = process.argv[1] === __filename;
if (isMainModule) {
  registerShutdownHandlers();
  startServer(PORT);
}

export default app;
