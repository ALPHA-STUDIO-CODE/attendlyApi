export function isUniqueConstraintError(err: unknown): boolean {
  return hasPrismaErrorCode(err, "P2002");
}

export function isForeignKeyConstraintError(err: unknown): boolean {
  return hasPrismaErrorCode(err, "P2003");
}

function hasPrismaErrorCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === code
  );
}
