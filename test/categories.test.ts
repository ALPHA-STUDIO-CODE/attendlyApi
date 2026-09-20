import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";

const app = createApp();

async function createUser(role: "USER" | "ADMIN" = "USER") {
  const response = await request(app)
    .post("/api/auth/register")
    .send({
      email: `f1-${role.toLowerCase()}-${Date.now()}-${Math.random()}@example.com`,
      password: "correct-horse-battery-staple",
      name: "F1 Test User",
    });
  if (role === "ADMIN") {
    await prisma.user.update({ where: { id: response.body.user.id }, data: { role: "ADMIN" } });
    // Re-login so the access token actually carries the ADMIN role — the
    // one from registration was signed before the promotion above.
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: response.body.user.email, password: "correct-horse-battery-staple" });
    return login.body.accessToken as string;
  }
  return response.body.accessToken as string;
}

describe("GET /api/categories", () => {
  it("returns the 10 seeded categories", async () => {
    const response = await request(app).get("/api/categories");
    expect(response.status).toBe(200);
    expect(response.body.categories).toHaveLength(10);
  });

  it("requires no authentication", async () => {
    const response = await request(app).get("/api/categories");
    expect(response.status).not.toBe(401);
  });
});

describe("POST /api/categories", () => {
  it("rejects a non-admin user with 403", async () => {
    const token = await createUser("USER");
    const response = await request(app)
      .post("/api/categories")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: `F1 New Category ${Date.now()}` });
    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await request(app).post("/api/categories").send({ name: "Whatever" });
    expect(response.status).toBe(401);
  });

  it("allows an admin to create a category", async () => {
    const token = await createUser("ADMIN");
    const name = `F1 Admin Category ${Date.now()}`;
    const response = await request(app)
      .post("/api/categories")
      .set("Authorization", `Bearer ${token}`)
      .send({ name });
    expect(response.status).toBe(201);
    expect(response.body.category.name).toBe(name);
  });

  it("rejects a duplicate category name with 409", async () => {
    const token = await createUser("ADMIN");
    const name = `F1 Duplicate Category ${Date.now()}`;
    await request(app)
      .post("/api/categories")
      .set("Authorization", `Bearer ${token}`)
      .send({ name });

    const response = await request(app)
      .post("/api/categories")
      .set("Authorization", `Bearer ${token}`)
      .send({ name });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CATEGORY_EXISTS");
  });
});
