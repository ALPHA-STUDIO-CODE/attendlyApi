import { getEventSemanticErrors } from "../../src/business/eventSemantics";

const futureDate = () => new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
const futureStart = () => new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
const futureEnd = () =>
  new Date(Date.now() + 1000 * 60 * 60 * 24 * 30 + 1000 * 60 * 60 * 3).toISOString();

describe("getEventSemanticErrors", () => {
  it("returns no errors for a fully valid payload", () => {
    const errors = getEventSemanticErrors({
      date: futureDate(),
      startTime: futureStart(),
      endTime: futureEnd(),
      maxCapacity: 100,
      timezone: "America/New_York",
    });
    expect(errors).toEqual({});
  });

  it("flags endTime at or before startTime", () => {
    const start = futureStart();
    const errors = getEventSemanticErrors({ startTime: start, endTime: start });
    expect(errors.endTime).toBeDefined();
  });

  it("flags endTime strictly before startTime", () => {
    const errors = getEventSemanticErrors({
      startTime: futureEnd(),
      endTime: futureStart(),
    });
    expect(errors.endTime).toBeDefined();
  });

  it("flags zero capacity", () => {
    const errors = getEventSemanticErrors({ maxCapacity: 0 });
    expect(errors.maxCapacity).toBeDefined();
  });

  it("flags negative capacity", () => {
    const errors = getEventSemanticErrors({ maxCapacity: -5 });
    expect(errors.maxCapacity).toBeDefined();
  });

  it("allows positive capacity", () => {
    const errors = getEventSemanticErrors({ maxCapacity: 1 });
    expect(errors.maxCapacity).toBeUndefined();
  });

  it("flags a date in the past", () => {
    const pastDate = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString();
    const errors = getEventSemanticErrors({ date: pastDate });
    expect(errors.date).toBeDefined();
  });

  it("allows a date in the future", () => {
    const errors = getEventSemanticErrors({ date: futureDate() });
    expect(errors.date).toBeUndefined();
  });

  it("flags an invalid timezone string", () => {
    const errors = getEventSemanticErrors({ timezone: "Not/A_Real_Zone" });
    expect(errors.timezone).toBeDefined();
  });

  it("allows a valid IANA timezone", () => {
    const errors = getEventSemanticErrors({ timezone: "Europe/London" });
    expect(errors.timezone).toBeUndefined();
  });

  it("only checks fields actually present (partial input)", () => {
    const errors = getEventSemanticErrors({});
    expect(errors).toEqual({});
  });
});
