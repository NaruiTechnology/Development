export function displayScanError(
  message: string | null,
  deviceNotFoundMessage: string,
): string | null {
  if (!message) return null;
  return /device\s+not\s+found/i.test(message)
    ? deviceNotFoundMessage
    : message;
}
