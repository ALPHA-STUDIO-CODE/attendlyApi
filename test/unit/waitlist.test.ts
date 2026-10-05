import { assignWaitlistPosition } from "../../src/business/waitlist";

describe("assignWaitlistPosition", () => {
  it("assigns position 1 when no one is on the waitlist yet (null)", () => {
    expect(assignWaitlistPosition(null)).toBe(1);
  });

  it("assigns position 1 when no one is on the waitlist yet (undefined)", () => {
    expect(assignWaitlistPosition(undefined)).toBe(1);
  });

  it("increments from the current max position", () => {
    expect(assignWaitlistPosition(1)).toBe(2);
    expect(assignWaitlistPosition(4)).toBe(5);
  });

  it("increments correctly from a large existing position", () => {
    expect(assignWaitlistPosition(999)).toBe(1000);
  });

  it('treats 0 as a real existing position, not as "nobody waitlisted"', () => {
    expect(assignWaitlistPosition(0)).toBe(1);
  });
});
