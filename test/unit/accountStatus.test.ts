import { assertAccountActive } from "../../src/auth/accountStatus";
import { AppError } from "../../src/errors";

describe("assertAccountActive", () => {
  it("lets an ACTIVE user through", () => {
    expect(() => assertAccountActive({ status: "ACTIVE" })).not.toThrow();
  });

  it("throws 403 ACCOUNT_SUSPENDED for a SUSPENDED user", () => {
    let thrown: unknown;
    try {
      assertAccountActive({ status: "SUSPENDED" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(403);
    expect((thrown as AppError).code).toBe("ACCOUNT_SUSPENDED");
  });
});
