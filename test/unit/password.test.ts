import { hashPassword, verifyPassword } from "../../src/auth/password";

describe("password hashing", () => {
  it("hashes a password and then successfully verifies it", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");

    await expect(verifyPassword("correct-horse-battery-staple", hash)).resolves.toBe(true);
  });

  it("fails verification against the wrong password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");

    await expect(verifyPassword("wrong-password", hash)).resolves.toBe(false);
  });

  it("produces different hashes for the same password (salted)", async () => {
    const hashA = await hashPassword("same-password");
    const hashB = await hashPassword("same-password");

    expect(hashA).not.toBe(hashB);
    // but both still verify correctly against the original password
    await expect(verifyPassword("same-password", hashA)).resolves.toBe(true);
    await expect(verifyPassword("same-password", hashB)).resolves.toBe(true);
  });
});
