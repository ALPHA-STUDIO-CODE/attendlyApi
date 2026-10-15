import { userStatusFilterSchema } from "../../src/validation/userSchemas";

describe("userStatusFilterSchema", () => {
  it.each([
    ["active", "ACTIVE"],
    ["ACTIVE", "ACTIVE"],
    ["Suspended", "SUSPENDED"],
  ])("accepts %s and normalises it to %s", (input, expected) => {
    const parsed = userStatusFilterSchema.safeParse(input);
    expect(parsed.success && parsed.data).toBe(expected);
  });

  it.each(["banned", "", "open"])("rejects %j", (input) => {
    expect(userStatusFilterSchema.safeParse(input).success).toBe(false);
  });
});
