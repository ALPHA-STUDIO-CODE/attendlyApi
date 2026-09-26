import { detectImageType, MAX_BANNER_BYTES } from "../../src/business/imageType";

function bytes(...values: number[]): Buffer {
  return Buffer.from(values);
}

const JPEG = Buffer.concat([bytes(0xff, 0xd8, 0xff, 0xe0), Buffer.alloc(16)]);
const PNG = Buffer.concat([
  bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  Buffer.alloc(16),
]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  bytes(0x24, 0x00, 0x00, 0x00),
  Buffer.from("WEBP", "ascii"),
  Buffer.alloc(16),
]);

describe("detectImageType", () => {
  it("recognizes JPEG", () => {
    expect(detectImageType(JPEG)).toBe("jpeg");
  });

  it("recognizes PNG", () => {
    expect(detectImageType(PNG)).toBe("png");
  });

  it("recognizes WebP", () => {
    expect(detectImageType(WEBP)).toBe("webp");
  });

  it("rejects a RIFF container that isn't WebP (e.g. WAV audio)", () => {
    const wav = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      bytes(0x24, 0x00, 0x00, 0x00),
      Buffer.from("WAVE", "ascii"),
      Buffer.alloc(16),
    ]);
    expect(detectImageType(wav)).toBeNull();
  });

  it("rejects a PDF", () => {
    expect(detectImageType(Buffer.from("%PDF-1.7\n...", "ascii"))).toBeNull();
  });

  it("rejects a GIF (not in the allowed set)", () => {
    expect(detectImageType(Buffer.from("GIF89a....", "ascii"))).toBeNull();
  });

  it("rejects plain text", () => {
    expect(detectImageType(Buffer.from("just some text pretending to be an image"))).toBeNull();
  });

  it("rejects an empty buffer", () => {
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
  });

  it("rejects buffers too short to hold a full signature without throwing", () => {
    expect(detectImageType(bytes(0xff, 0xd8))).toBeNull();
    expect(detectImageType(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull();
    expect(detectImageType(Buffer.from("RIFF....WEB", "ascii"))).toBeNull();
  });

  it("rejects a PNG signature with a corrupted tail (partial magic-number match)", () => {
    const almostPng = Buffer.concat([
      bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00),
      Buffer.alloc(8),
    ]);
    expect(detectImageType(almostPng)).toBeNull();
  });
});

describe("MAX_BANNER_BYTES", () => {
  it("is 5 MiB", () => {
    expect(MAX_BANNER_BYTES).toBe(5 * 1024 * 1024);
  });
});
