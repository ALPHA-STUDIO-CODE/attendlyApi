import { randomUUID } from "crypto";
import { NextFunction, Request, Response } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

const REQUEST_ID_HEADER = "x-request-id";

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(REQUEST_ID_HEADER);
  req.id = incoming && incoming.trim().length > 0 ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, req.id);
  next();
}
