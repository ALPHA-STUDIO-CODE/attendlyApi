import { v2 as cloudinary } from "cloudinary";

// Thin wrapper around the Cloudinary SDK. Routes depend on this module, not
// on the SDK, so tests can mock one function (spec §12: never hit real
// third-party APIs in tests) and the SDK stays swappable.

const BANNER_FOLDER = "attendly/banners";
// Banners are displayed well below this width; capping it at ingest keeps
// storage and bandwidth in check without ever upscaling a smaller image.
const BANNER_MAX_WIDTH = 1600;

let configured = false;

function ensureConfigured(): void {
  if (configured) {
    return;
  }
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      "Cloudinary is not configured: set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.",
    );
  }
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });
  configured = true;
}

export interface UploadBannerInput {
  buffer: Buffer;
  eventId: string;
}

/**
 * Uploads a banner image and resolves with its HTTPS URL. Rejects on any
 * failure (missing credentials, network error, Cloudinary rejection) —
 * callers decide how to surface that (the events route maps it to 502
 * UPLOAD_FAILED).
 *
 * The public_id is derived from the event id with overwrite enabled, so
 * re-uploading a banner replaces the previous asset instead of leaving an
 * orphan behind. Cloudinary's returned URL carries a version segment, so
 * the new image isn't masked by a stale CDN cache.
 */
export async function uploadBannerImage({ buffer, eventId }: UploadBannerInput): Promise<string> {
  ensureConfigured();

  return new Promise<string>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: BANNER_FOLDER,
        public_id: eventId,
        overwrite: true,
        invalidate: true,
        resource_type: "image",
        // Server-side second line of defence behind our own magic-byte check.
        allowed_formats: ["jpg", "png", "webp"],
        transformation: [{ width: BANNER_MAX_WIDTH, crop: "limit" }],
      },
      (error, result) => {
        if (error || !result) {
          reject(error ?? new Error("Cloudinary returned no result."));
          return;
        }
        resolve(result.secure_url);
      },
    );
    stream.end(buffer);
  });
}
