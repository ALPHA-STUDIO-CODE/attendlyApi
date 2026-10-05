export function assignWaitlistPosition(currentMaxPosition: number | null | undefined): number {
  if (currentMaxPosition === null || currentMaxPosition === undefined) {
    return 1;
  }
  return currentMaxPosition + 1;
}
