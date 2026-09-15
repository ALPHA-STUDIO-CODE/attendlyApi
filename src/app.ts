import express, { Express } from "express";
import cookieParser from "cookie-parser";
import { requestIdMiddleware } from "./middleware/requestId";
import { errorMiddleware } from "./middleware/errorHandler";
import { authRouter } from "./routes/auth";

export function createApp(): Express {
  const app = express();

  app.use(express.json());
  app.use(cookieParser());
  app.use(requestIdMiddleware);

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use("/api/auth", authRouter);

  // Must be mounted last — Express recognizes error middleware by its
  // 4-argument signature and only invokes it when next(err) is called or
  // an async handler rejects (Express 5 auto-forwards async rejections).
  app.use(errorMiddleware);

  return app;
}
