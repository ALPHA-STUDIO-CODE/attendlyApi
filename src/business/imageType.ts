// Banner upload rules (spec §8.2: "file type/size limits on banner upload,
// e.g. jpg/png/webp, <5MB"). Kept as pure functions/constants so they're
// unit-testable without HTTP or Cloudinary.

// Exactly 5 MiB is accepted; anything larger is rejected.
export const MAX_BANNER_BYTES = 5 * 1024 * 1024;

export type SupportedImageType = "jpeg" | "png" | "webp";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(buffer: Buffer, signature: number[], offset = 0): boolean {
  if (buffer.length < offset + signature.length) {
    return false;
  }
  return signature.every((byte, i) => buffer[offset + i] === byte);
}

function asciiBytes(text: string): number[] {
  return Array.from(Buffer.from(text, "ascii"));
}

/**
 * Identify an image by its leading "magic" bytes rather than by the
 * client-supplied filename or Content-Type header — both are trivially
 * spoofable, the file's own signature isn't. Returns null for anything that
 * isn't a JPEG, PNG, or WebP (including a RIFF container that isn't WebP,
 * e.g. WAV audio).
 */
export function detectImageType(buffer: Buffer): SupportedImageType | null {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return "jpeg";
  }
  if (startsWith(buffer, PNG_SIGNATURE)) {
    return "png";
  }
  // WebP: "RIFF" <4-byte size> "WEBP"
  if (startsWith(buffer, asciiBytes("RIFF")) && startsWith(buffer, asciiBytes("WEBP"), 8)) {
    return "webp";
  }
  return null;
}
