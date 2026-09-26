import { buildEventWhereClause } from "../../src/business/eventFilters";

describe("buildEventWhereClause", () => {
  it("returns an empty where-clause when no filters are given", () => {
    expect(buildEventWhereClause({})).toEqual({});
  });

  it("filters by categoryId when category is given", () => {
    const where = buildEventWhereClause({ category: "cat-123" });
    expect(where.categoryId).toBe("cat-123");
  });

  it("filters by city with case-insensitive contains", () => {
    const where = buildEventWhereClause({ city: "new york" });
    expect(where.city).toEqual({ contains: "new york", mode: "insensitive" });
  });

  it("builds an OR search across title and description", () => {
    const where = buildEventWhereClause({ search: "concert" });
    expect(where.OR).toEqual([
      { title: { contains: "concert", mode: "insensitive" } },
      { description: { contains: "concert", mode: "insensitive" } },
    ]);
  });

  it("applies a from/to date range", () => {
    const where = buildEventWhereClause({
      from: "2027-01-01T00:00:00.000Z",
      to: "2027-12-31T00:00:00.000Z",
    });
    expect(where.date).toEqual({
      gte: new Date("2027-01-01T00:00:00.000Z"),
      lte: new Date("2027-12-31T00:00:00.000Z"),
    });
  });

  it("applies only gte when only from is given", () => {
    const where = buildEventWhereClause({ from: "2027-01-01T00:00:00.000Z" });
    expect(where.date).toEqual({ gte: new Date("2027-01-01T00:00:00.000Z") });
  });

  it("filters to now-or-later when upcoming=true", () => {
    const before = new Date();
    const where = buildEventWhereClause({ upcoming: "true" });
    const after = new Date();

    const gte = (where.date as { gte: Date }).gte;
    expect(gte.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(gte.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("accepts upcoming=1 as equivalent to upcoming=true", () => {
    const where = buildEventWhereClause({ upcoming: "1" });
    expect(where.date).toBeDefined();
  });

  it("ignores upcoming when it's neither 'true' nor '1'", () => {
    const where = buildEventWhereClause({ upcoming: "yes" });
    expect(where.date).toBeUndefined();
  });

  it("upcoming doesn't override an explicit `from` that's already later", () => {
    const farFuture = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
    const where = buildEventWhereClause({ from: farFuture, upcoming: "true" });
    expect((where.date as { gte: Date }).gte).toEqual(new Date(farFuture));
  });

  it("combines multiple filters together", () => {
    const where = buildEventWhereClause({ category: "cat-1", city: "Austin", search: "tech" });
    expect(where.categoryId).toBe("cat-1");
    expect(where.city).toEqual({ contains: "Austin", mode: "insensitive" });
    expect(where.OR).toBeDefined();
  });

  it("never filters out CANCELLED events (spec §7.6: cancelled events stay visible in listings)", () => {
    const where = buildEventWhereClause({ category: "cat-1" });
    expect(where.status).toBeUndefined();
  });
});
