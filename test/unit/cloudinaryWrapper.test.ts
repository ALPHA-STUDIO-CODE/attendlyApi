// Unit tests for src/integrations/cloudinary.ts with the Cloudinary SDK
// itself mocked — the route-level tests mock this *wrapper*, so this is
// where the wrapper's own logic (credential check, upload options, error
// propagation) is covered. No network, no real credentials.

type UploadCallback = (error: unknown, result?: { secure_url: string }) => void;

const ENV_KEYS = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"] as const;

async function loadWrapperWithMockedSdk(
  behaviour: (options: Record<string, unknown>, cb: UploadCallback) => void,
) {
  jest.resetModules();
  const endMock = jest.fn();
  const configMock = jest.fn();
  const uploadStreamMock = jest.fn((options: Record<string, unknown>, cb: UploadCallback) => {
    behaviour(options, cb);
    return { end: endMock };
  });
  jest.doMock("cloudinary", () => ({
    v2: { config: configMock, uploader: { upload_stream: uploadStreamMock } },
  }));
  const wrapper = await import("../../src/integrations/cloudinary");
  return { wrapper, endMock, configMock, uploadStreamMock };
}

describe("uploadBannerImage", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
    }
    process.env.CLOUDINARY_CLOUD_NAME = "demo-cloud";
    process.env.CLOUDINARY_API_KEY = "demo-key";
    process.env.CLOUDINARY_API_SECRET = "demo-secret";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    jest.dontMock("cloudinary");
  });

  it("resolves with the secure_url and streams the buffer to Cloudinary", async () => {
    const { wrapper, endMock } = await loadWrapperWithMockedSdk((_o, cb) =>
      cb(undefined, { secure_url: "https://res.cloudinary.com/demo/x.png" }),
    );
    const buffer = Buffer.from("image-bytes");

    const url = await wrapper.uploadBannerImage({ buffer, eventId: "evt-1" });

    expect(url).toBe("https://res.cloudinary.com/demo/x.png");
    expect(endMock).toHaveBeenCalledWith(buffer);
  });

  it("configures the SDK from env vars, over HTTPS", async () => {
    const { wrapper, configMock } = await loadWrapperWithMockedSdk((_o, cb) =>
      cb(undefined, { secure_url: "https://x" }),
    );

    await wrapper.uploadBannerImage({ buffer: Buffer.from("a"), eventId: "evt-1" });

    expect(configMock).toHaveBeenCalledWith({
      cloud_name: "demo-cloud",
      api_key: "demo-key",
      api_secret: "demo-secret",
      secure: true,
    });
  });

  it("uses a per-event public_id with overwrite, restricts formats, and caps width", async () => {
    const { wrapper, uploadStreamMock } = await loadWrapperWithMockedSdk((_o, cb) =>
      cb(undefined, { secure_url: "https://x" }),
    );

    await wrapper.uploadBannerImage({ buffer: Buffer.from("a"), eventId: "evt-42" });

    const options = uploadStreamMock.mock.calls[0][0];
    expect(options).toMatchObject({
      folder: "attendly/banners",
      public_id: "evt-42",
      overwrite: true,
      invalidate: true,
      resource_type: "image",
      allowed_formats: ["jpg", "png", "webp"],
      transformation: [{ width: 1600, crop: "limit" }],
    });
  });

  it("rejects when Cloudinary reports an error", async () => {
    const { wrapper } = await loadWrapperWithMockedSdk((_o, cb) =>
      cb(new Error("upstream said no")),
    );

    await expect(
      wrapper.uploadBannerImage({ buffer: Buffer.from("a"), eventId: "evt-1" }),
    ).rejects.toThrow("upstream said no");
  });

  it("rejects when Cloudinary returns neither an error nor a result", async () => {
    const { wrapper } = await loadWrapperWithMockedSdk((_o, cb) => cb(undefined, undefined));

    await expect(
      wrapper.uploadBannerImage({ buffer: Buffer.from("a"), eventId: "evt-1" }),
    ).rejects.toThrow(/no result/i);
  });

  it.each(ENV_KEYS)(
    "rejects with a clear message when %s is missing, without calling the SDK",
    async (key) => {
      delete process.env[key];
      const { wrapper, uploadStreamMock } = await loadWrapperWithMockedSdk((_o, cb) =>
        cb(undefined, { secure_url: "https://x" }),
      );

      await expect(
        wrapper.uploadBannerImage({ buffer: Buffer.from("a"), eventId: "evt-1" }),
      ).rejects.toThrow(/not configured/i);
      expect(uploadStreamMock).not.toHaveBeenCalled();
    },
  );
});
