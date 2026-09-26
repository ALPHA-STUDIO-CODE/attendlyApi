import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";
import { signAccessToken } from "../src/auth/jwt";
import { uploadBannerImage } from "../src/integrations/cloudinary";
import { MAX_BANNER_BYTES } from "../src/business/imageType";

// Spec §12: never hit the real Cloudinary in tests. A factory (rather than
// jest's automock) keeps the real SDK from even being loaded.
jest.mock("../src/integrations/cloudinary", () => ({
  uploadBannerImage: jest.fn(),
}));

const mockedUpload = uploadBannerImage as jest.MockedFunction<typeof uploadBannerImage>;

const app = createApp();

const MOCK_URL = "https://res.cloudinary.com/demo/image/upload/v1/attendly/banners/mock.png";

// Minimal file signatures — Cloudinary is mocked, so nothing decodes these;
// the route only inspects the leading bytes.
function pngBuffer(totalBytes = 64): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.alloc(Math.max(0, totalBytes - header.length))]);
}
function jpegBuffer(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);
}
function webpBuffer(): Buffer {
  return Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from("WEBP", "ascii"),
    Buffer.alloc(52),
  ]);
}

async function createUser(role: "USER" | "ADMIN" = "USER") {
  const user = await prisma.user.create({
    data: {
      email: `g1-user-${Date.now()}-${Math.random()}@example.com`,
      passwordHash: "hashed-password",
      name: "G1 Test User",
      role,
    },
  });
  return { user, token: signAccessToken({ sub: user.id, role }) };
}

async function createEventForOrganizer(
  organizerId: string,
  overrides: { isLocked?: boolean } = {},
) {
  const category = await prisma.category.findFirstOrThrow({ where: { name: "Tech" } });
  const start = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  return prisma.event.create({
    data: {
      organizerId,
      title: "G1 Test Event",
      description: "An event used to exercise POST /api/events/:id/banner.",
      categoryId: category.id,
      venueName: "Test Hall",
      address: "123 Test St",
      city: "Testville",
      timezone: "America/New_York",
      date: start,
      startTime: start,
      endTime: new Date(start.getTime() + 1000 * 60 * 60 * 3),
      maxCapacity: 50,
      ...overrides,
    },
  });
}

describe("POST /api/events/:id/banner", () => {
  beforeEach(() => {
    mockedUpload.mockReset();
    mockedUpload.mockResolvedValue(MOCK_URL);
  });

  describe("happy path", () => {
    it("lets the owner upload a PNG; bannerImageUrl is saved and returned", async () => {
      const { user, token } = await createUser();
      const event = await createEventForOrganizer(user.id);
      const file = pngBuffer();

      const response = await request(app)
        .post(`/api/events/${event.id}/banner`)
        .set("Authorization", `Bearer ${token}`)
        .attach("banner", file, { filename: "banner.png", contentType: "image/png" });

      expect(response.status).toBe(200);
      expect(response.body.event.bannerImageUrl).toBe(MOCK_URL);

      const dbEvent = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
      expect(dbEvent.bannerImageUrl).toBe(MOCK_URL);

      expect(mockedUpload).toHaveBeenCalledTimes(1);
      const call = mockedUpload.mock.calls[0][0];
      expect(call.eventId).toBe(event.id);
      expect(Buffer.compare(call.buffer, file)).toBe(0);
    });

    it.each([
      ["JPEG", jpegBuffer(), "banner.jpg", "image/jpeg"],
      ["WebP", webpBuffer(), "banner.webp", "image/webp"],
    ])("accepts a %s", async (_label, file, filename, contentType) => {
      const { user, token } = await createUser();
      const event = await createEventForOrganizer(user.id);

      const response = await request(app)
        .post(`/api/events/${event.id}/banner`)
        .set("Authorization", `Bearer ${token}`)
        .attach("banner", file, { filename, contentType });

      expect(response.status).toBe(200);
      expect(response.body.event.bannerImageUrl).toBe(MOCK_URL);
    });

    it("accepts a file of exactly the maximum size (5 MiB)", async () => {
      const { user, token } = await createUser();
      const event = await createEventForOrganizer(user.id);

      const response = await request(app)
        .post(`/api/events/${event.id}/banner`)
        .set("Authorization", `Bearer ${token}`)
        .attach("banner", pngBuffer(MAX_BANNER_BYTES), {
          filename: "big.png",
          contentType: "image/png",
        });

      expect(response.status).toBe(200);
    });

    it("replaces an existing banner on a second upload", async () => {
      const { user, token } = await createUser();
      const event = await createEventForOrganizer(user.id);
      const secondUrl = "https://res.cloudinary.com/demo/image/upload/v2/attendly/banners/mock.png";

      await request(app)
        .post(`/api/events/${event.id}/banner`)
        .set("Authorization", `Bearer ${token}`)
        .attach("banner", pngBuffer(), { filename: "a.png", contentType: "image/png" });

      mockedUpload.mockResolvedValueOnce(secondUrl);
      const response = await request(app)
        .post(`/api/events/${event.id}/banner`)
        .set("Authorization", `Bearer ${token}`)
        .attach("banner", pngBuffer(), { filename: "b.png", contentType: "image/png" });

      expect(response.status).toBe(200);
      expect(response.body.event.bannerImageUrl).toBe(secondUrl);
    });

    it("still works once the event is locked (spec §7.3: bannerImageUrl is always editable)", async () => {
      const { user, token } = await createUser();
      const event = await createEventForOrganizer(user.id, { isLocked: true });

      const response = await request(app)
        .post(`/api/events/${event.id}/banner`)
        .set("Authorization", `Bearer ${token}`)
        .attach("banner", pngBuffer(), { filename: "banner.png", contentType: "image/png" });

      expect(response.status).toBe(200);
      expect(response.body.event.bannerImageUrl).toBe(MOCK_URL);
    });
  });

  describe("authorization", () => {
    it("returns 401 for an unauthenticated request", async () => {
      const { user } = await createUser();
      const event = await createEventForOrganizer(user.id);

      const response = await request(app)
        .post(`/api/events/${event.id}/banner`)
        .attach("banner", pngBuffer(), { filename: "banner.png", contentType: "image/png" });

      expect(response.status).toBe(401);
      expect(mockedUpload).not.toHaveBeenCalled();
    });

    it("returns 403 for a non-owner, and never touches Cloudinary", async () => {
      const { user } = await createUser();
      const event = await createEventForOrganizer(user.id);
      const { token: otherToken } = await createUser();

      const response = await request(app)
        .post(`/api/events/${event.id}/banner`)
        .set("Authorization", `Bearer ${otherToken}`)
        .attach("banner", pngBuffer(), { filename: "banner.png", contentType: "image/png" });

      expect(response.status).toBe(403);
      expect(mockedUpload).not.toHaveBeenCalled();
    });

    it("returns 403 for an admin who isn't the owner (spec §3: admins don't edit others' event content)", async () => {
      const { user } = await createUser();
      const event = await createEventForOrganizer(user.id);
      const { token: adminToken } = await createUser("ADMIN");

      const response = await request(app)
        .post(`/api/events/${event.id}/banner`)
        .set("Authorization", `Bearer ${adminToken}`)
        .attach("banner", pngBuffer(), { filename: "banner.png", contentType: "image/png" });

      expect(response.status).toBe(403);
      expect(mockedUpload).not.toHaveBeenCalled();
    });

    it("returns 404 for a nonexistent event", async () => {
      const { token } = await createUser();

      const response = await request(app)
        .post("/api/events/00000000-0000-0000-0000-000000000000/banner")
        .set("Authorization", `Bearer ${token}`)
        .attach("banner", pngBuffer(), { filename: "banner.png", contentType: "image/png" });

      expect(response.status).toBe(404);
    });
  });

  describe("file validation (400)", () => {
    async function ownerAndEvent() {
      const { user, token } = await createUser();
      const event = await createEventForOrganizer(user.id);
      return { token, event };
    }

    it("rejects a file over the size limit", async () => {
      const { token, event } = await ownerAndEvent();

      const response = await request(app)
        .post(`/api/events/${event.id}/banner`)
        .set("Authorization", `Bearer ${token}`)
        .attach("banner", pngBuffer(MAX_BANNER_BYTES + 1), {
          filename: "huge.png",
          contentType: "image/png",
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.body.error.details.fields.banner).toEqual(expect.any(String));
      expect(mockedUpload).not.toHaveBeenCalled();
    });

    it("rejects a non-image file", async () => {
      const { token, event } = await ownerAndEvent();

      const response = await request(app)
        .post(`/api/events/${event.id}/banner`)
        .set("Authorization", `Bearer ${token}`)
        .attach("banner", Buffer.from("hello, I am definitely not an image"), {
          filename: "notes.txt",
          contentType: "text/plain",
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(mockedUpload).not.toHaveBeenCalled();
    });

    it("rejects a file that claims to be an image but whose bytes aren't (spoofed Content-Type)", async () => {
      const { token, event } = await ownerAndEvent();

      const response = await request(app)
        .post(`/api/events/${event.id}/banner`)
        .set("Authorization", `Bearer ${token}`)
        .attach("banner", Buffer.from("%PDF-1.7 not really a png"), {
          filename: "sneaky.png",
          contentType: "image/png",
        });

      expect(response.status).toBe(400);
      expect(mockedUpload).not.toHaveBeenCalled();
    });

    it("rejects a GIF (only jpg/png/webp are allowed)", async () => {
      const { token, event } = await ownerAndEvent();

      const response = await request(app)
        .post(`/api/events/${event.id}/banner`)
        .set("Authorization", `Bearer ${token}`)
        .attach("banner", Buffer.from("GIF89a" + "\0".repeat(32), "binary"), {
          filename: "anim.gif",
          contentType: "image/gif",
        });

      expect(response.status).toBe(400);
      expect(mockedUpload).not.toHaveBeenCalled();
    });

    it("rejects an empty (0-byte) file", async () => {
      const { token, event } = await ownerAndEvent();

      const response = await request(app)
        .post(`/api/events/${event.id}/banner`)
        .set("Authorization", `Bearer ${token}`)
        .attach("banner", Buffer.alloc(0), { filename: "empty.png", contentType: "image/png" });

      expect(response.status).toBe(400);
      expect(mockedUpload).not.toHaveBeenCalled();
    });

    it("rejects a request with no file at all", async () => {
      const { token, event } = await ownerAndEvent();

      const response = await request(app)
        .post(`/api/events/${event.id}/banner`)
        .set("Authorization", `Bearer ${token}`)
        .field("note", "no file here");

      expect(response.status).toBe(400);
      expect(response.body.error.details.fields.banner).toEqual(expect.any(String));
    });

    it("rejects a non-multipart (JSON) request", async () => {
      const { token, event } = await ownerAndEvent();

      const response = await request(app)
        .post(`/api/events/${event.id}/banner`)
        .set("Authorization", `Bearer ${token}`)
        .send({ banner: "not a file" });

      expect(response.status).toBe(400);
    });

    it("rejects a file sent under the wrong field name", async () => {
      const { token, event } = await ownerAndEvent();

      const response = await request(app)
        .post(`/api/events/${event.id}/banner`)
        .set("Authorization", `Bearer ${token}`)
        .attach("image", pngBuffer(), { filename: "banner.png", contentType: "image/png" });

      expect(response.status).toBe(400);
      expect(mockedUpload).not.toHaveBeenCalled();
    });

    it("leaves the existing banner untouched when a later upload is rejected", async () => {
      const { user, token } = await createUser();
      const event = await createEventForOrganizer(user.id);
      await request(app)
        .post(`/api/events/${event.id}/banner`)
        .set("Authorization", `Bearer ${token}`)
        .attach("banner", pngBuffer(), { filename: "a.png", contentType: "image/png" });

      await request(app)
        .post(`/api/events/${event.id}/banner`)
        .set("Authorization", `Bearer ${token}`)
        .attach("banner", Buffer.from("nope"), { filename: "b.txt", contentType: "text/plain" });

      const dbEvent = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
      expect(dbEvent.bannerImageUrl).toBe(MOCK_URL);
    });
  });

  describe("Cloudinary failure (spec §8.5)", () => {
    it("returns 502 UPLOAD_FAILED, leaves bannerImageUrl unset, and doesn't leak the upstream error", async () => {
      const { user, token } = await createUser();
      const event = await createEventForOrganizer(user.id);
      mockedUpload.mockRejectedValueOnce(new Error("cloudinary exploded: api_key=SECRET123"));

      const response = await request(app)
        .post(`/api/events/${event.id}/banner`)
        .set("Authorization", `Bearer ${token}`)
        .attach("banner", pngBuffer(), { filename: "banner.png", contentType: "image/png" });

      expect(response.status).toBe(502);
      expect(response.body.error.code).toBe("UPLOAD_FAILED");
      expect(JSON.stringify(response.body)).not.toContain("SECRET123");

      const dbEvent = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
      expect(dbEvent.bannerImageUrl).toBeNull();
    });

    it("keeps the previous banner if a replacement upload fails", async () => {
      const { user, token } = await createUser();
      const event = await createEventForOrganizer(user.id);
      await request(app)
        .post(`/api/events/${event.id}/banner`)
        .set("Authorization", `Bearer ${token}`)
        .attach("banner", pngBuffer(), { filename: "a.png", contentType: "image/png" });

      mockedUpload.mockRejectedValueOnce(new Error("boom"));
      const response = await request(app)
        .post(`/api/events/${event.id}/banner`)
        .set("Authorization", `Bearer ${token}`)
        .attach("banner", pngBuffer(), { filename: "b.png", contentType: "image/png" });

      expect(response.status).toBe(502);
      const dbEvent = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
      expect(dbEvent.bannerImageUrl).toBe(MOCK_URL);
    });
  });

  describe("banner is optional (spec §8.5)", () => {
    it("event creation succeeds with no banner, even while Cloudinary is down", async () => {
      mockedUpload.mockRejectedValue(new Error("cloudinary is down"));
      const { token } = await createUser();
      const category = await prisma.category.findFirstOrThrow({ where: { name: "Tech" } });
      const start = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);

      const response = await request(app)
        .post("/api/events")
        .set("Authorization", `Bearer ${token}`)
        .send({
          title: "No banner needed",
          description: "Created while Cloudinary is unavailable.",
          categoryId: category.id,
          venueName: "Test Hall",
          address: "123 Test St",
          city: "Testville",
          timezone: "America/New_York",
          date: start.toISOString(),
          startTime: start.toISOString(),
          endTime: new Date(start.getTime() + 1000 * 60 * 60 * 3).toISOString(),
          maxCapacity: 50,
        });

      expect(response.status).toBe(201);
      expect(response.body.event.bannerImageUrl).toBeNull();
      expect(mockedUpload).not.toHaveBeenCalled();
    });
  });
});
