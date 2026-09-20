import { getRejectedLockedFields } from "../../src/business/fieldLock";

describe("getRejectedLockedFields", () => {
  it("rejects nothing when the event is unlocked, regardless of which fields changed", () => {
    const rejected = getRejectedLockedFields(
      ["date", "startTime", "endTime", "venueName", "address", "city", "maxCapacity", "timezone"],
      false,
    );
    expect(rejected).toEqual([]);
  });

  it("rejects all locked fields when the event is locked", () => {
    const lockedFields = [
      "date",
      "startTime",
      "endTime",
      "venueName",
      "address",
      "city",
      "maxCapacity",
      "timezone",
    ];
    const rejected = getRejectedLockedFields(lockedFields, true);
    expect(rejected.sort()).toEqual(lockedFields.sort());
  });

  it("still allows title/description/bannerImageUrl/customTags when locked", () => {
    const rejected = getRejectedLockedFields(
      ["title", "description", "bannerImageUrl", "customTags"],
      true,
    );
    expect(rejected).toEqual([]);
  });

  it("returns exactly the rejected subset for a mixed change set", () => {
    const rejected = getRejectedLockedFields(["title", "date", "description", "maxCapacity"], true);
    expect(rejected.sort()).toEqual(["date", "maxCapacity"]);
  });

  it("returns an empty array when no fields changed at all", () => {
    expect(getRejectedLockedFields([], true)).toEqual([]);
  });
});
