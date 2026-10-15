import { ForbiddenError } from "../errors";

export function assertAccountActive(user: { status: string }): void {
  if (user.status === "SUSPENDED") {
    throw new ForbiddenError("Your account has been suspended.", undefined, "ACCOUNT_SUSPENDED");
  }
}
