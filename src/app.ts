import express, { Express } from "express";

export function createApp(): Express {
  const app = express();

  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.send("<h1>Attendly API is up and running</h1>");
  });

  return app;
}
