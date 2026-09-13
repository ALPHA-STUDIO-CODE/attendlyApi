import { NextFunction, Request, Response } from "express";
import { AppError } from "../errors";
import { logger } from "../logger";

export function errorMiddleware(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    logger.warn({ requestId: req.id, code: err.code, details: err.details }, err.message);
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details ?? null,
      },
    });
    return;
  }

  // Anything that isn't an AppError is unexpected — log the real error
  // internally, but never leak its message or stack to the client.
  logger.error({ requestId: req.id, err }, "Unhandled error");
  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Something went wrong. Please try again.",
      details: null,
    },
  });
}
