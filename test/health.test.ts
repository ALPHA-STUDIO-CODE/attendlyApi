import request from "supertest";
import { createApp } from "../src/app";

describe("GET /health", () => {
  const app = createApp();

  it("returns 200 with a status ok payload", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});
