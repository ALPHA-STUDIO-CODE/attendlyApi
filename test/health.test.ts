import request from "supertest";
import { createApp } from "../src/app";

describe("GET /health", () => {
  const app = createApp();

  it("Attendly API is up and running", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.text).toBe("<h1>Attendly API is up and running</h1>");
  });
});
