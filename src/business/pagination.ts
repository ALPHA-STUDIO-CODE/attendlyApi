import { ValidationError } from "../errors";

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export interface PaginationResult {
  page: number;
  limit: number;
}

export function parsePagination(rawPage: unknown, rawLimit: unknown): PaginationResult {
  return {
    page: parseParam(rawPage, DEFAULT_PAGE, { min: 1 }),
    limit: parseParam(rawLimit, DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT }),
  };
}

function parseParam(
  raw: unknown,
  defaultValue: number,
  { min, max }: { min: number; max?: number },
): number {
  if (raw === undefined || raw === null || raw === "") {
    return defaultValue;
  }

  const asString = Array.isArray(raw) ? raw[0] : raw;
  const num = Number(asString);

  if (!Number.isFinite(num) || !Number.isInteger(num) || num < min) {
    throw new ValidationError(
      `Invalid pagination parameter: expected a whole number >= ${min}.`,
      undefined,
      "INVALID_PAGINATION",
    );
  }

  if (max !== undefined && num > max) {
    return max;
  }

  return num;
}
