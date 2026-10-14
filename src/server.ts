import express from "express";

import { env } from "./config/env.js";
import authRoutes from "./routes/auth.routes.js";
import urlRoutes from "./routes/url.routes.js";
import { incrementLocalCounter } from "./experiments/in-memory-counter.js";
import experimentRoutes from "./routes/experiment.routes.js";

import {
  connectRedis,
  redisClient
} from "./db/redis.js";

const app = express();

app.use(express.json());


app.get("/", (_req, res) => {
  res.json({
    message: "URL Shortener API",
    status: "running"
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok"
  });
});

app.get("/whoami",(_req,res)=>{
  res.json({
    instance: process.env.INSTANCE_ID ?? "native",
    pid: process.pid
  });
});

app.use("/api/auth",authRoutes);

app.get("/debug/local-counter",(_req,res)=>{
  res.json({
    instance: process.env.INSTANCE_ID ?? "native",
    pid: process.pid,
    localCounter: incrementLocalCounter(),
    storage: "Node.js process memory"
  });
});

app.use(experimentRoutes);

app.use(urlRoutes);

async function startServer(): Promise<void> {
  if (redisClient) {
    await connectRedis();
    console.log("[Redis] Connected successfully");
  } else {
    console.log(
      "[Redis] Not configured; Redis experiment is disabled"
    );
  }

  app.listen(env.port, () => {
    console.log(
      `Server running at http://localhost:${env.port}`
    );
  });
}

startServer().catch((error: unknown) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});