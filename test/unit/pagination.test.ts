import {
  parsePagination,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from "../../src/business/pagination";

describe("parsePagination", () => {
  it("defaults to page 1, limit 20 when both are missing", () => {
    expect(parsePagination(undefined, undefined)).toEqual({
      page: DEFAULT_PAGE,
      limit: DEFAULT_LIMIT,
    });
  });

  it("defaults when both are empty strings", () => {
    expect(parsePagination("", "")).toEqual({ page: DEFAULT_PAGE, limit: DEFAULT_LIMIT });
  });

  it("accepts valid numeric strings", () => {
    expect(parsePagination("3", "50")).toEqual({ page: 3, limit: 50 });
  });

  it("clamps a limit above the max down to MAX_LIMIT rather than erroring", () => {
    expect(parsePagination("1", "99999")).toEqual({ page: 1, limit: MAX_LIMIT });
  });

  it("throws for a non-numeric page", () => {
    expect(() => parsePagination("abc", "20")).toThrow();
  });

  it("throws for a non-numeric limit", () => {
    expect(() => parsePagination("1", "abc")).toThrow();
  });

  it("throws for a negative page", () => {
    expect(() => parsePagination("-1", "20")).toThrow();
  });

  it("throws for a negative limit", () => {
    expect(() => parsePagination("1", "-5")).toThrow();
  });

  it("throws for page 0 (below the minimum of 1)", () => {
    expect(() => parsePagination("0", "20")).toThrow();
  });

  it("throws for a non-integer (decimal) page", () => {
    expect(() => parsePagination("1.5", "20")).toThrow();
  });
});
