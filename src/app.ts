import express, { Express } from "express";
import cookieParser from "cookie-parser";
import { requestIdMiddleware } from "./middleware/requestId";
import { errorMiddleware } from "./middleware/errorHandler";
import { authRouter } from "./routes/auth";
import { categoryRouter } from "./routes/categories";
import { eventRouter } from "./routes/events";

export function createApp(): Express {
  const app = express();

  app.use(express.json());
  app.use(cookieParser());
  app.use(requestIdMiddleware);

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/categories", categoryRouter);
  app.use("/api/events", eventRouter);

  app.use(errorMiddleware);

  return app;
}
