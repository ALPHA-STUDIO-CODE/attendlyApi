import type { Request } from "express";
import { NotFoundError } from "../errors";

export function requireStringParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string") {
    throw new NotFoundError("Resource not found.");
  }
  return value;
}

export function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return undefined;
}
