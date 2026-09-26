import multer from "multer";
import { RequestHandler } from "express";
import { ValidationError } from "../errors";
import { MAX_BANNER_BYTES } from "../business/imageType";
import { logger } from "../logger";

export const BANNER_FIELD_NAME = "banner";

// Memory storage: files are capped at 5 MiB and go straight on to
// Cloudinary, so nothing needs to touch disk. `files: 1` and the size limit
// are enforced by multer while streaming, so an oversized upload is cut off
// rather than fully buffered first.
const parseSingleBanner = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BANNER_BYTES, files: 1 },
}).single(BANNER_FIELD_NAME);

function bannerError(message: string): ValidationError {
  return new ValidationError("Invalid banner upload.", {
    fields: { [BANNER_FIELD_NAME]: message },
  });
}

/**
 * Parses a multipart upload with a single file under the `banner` field into
 * `req.file`. Every failure at the parsing stage — too large, unexpected
 * field, malformed multipart body — is a client error, so it's reported as
 * the standard 400 validation envelope rather than falling through to the
 * generic 500 handler.
 *
 * A request that isn't multipart at all is passed through untouched with
 * `req.file` unset; the route handler reports the missing file.
 */
export const parseBannerUpload: RequestHandler = (req, res, next) => {
  parseSingleBanner(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }

    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        next(bannerError("Banner must be 5MB or smaller."));
        return;
      }
      if (err.code === "LIMIT_UNEXPECTED_FILE") {
        next(bannerError(`Upload the image under the "${BANNER_FIELD_NAME}" field.`));
        return;
      }
    }

    logger.warn({ requestId: req.id, err }, "Banner upload could not be parsed");
    next(bannerError("The upload could not be read. Send a single image as multipart/form-data."));
  });
};
