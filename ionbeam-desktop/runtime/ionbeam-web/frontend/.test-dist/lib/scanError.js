export function displayScanError(message, deviceNotFoundMessage) {
    if (!message)
        return null;
    return /device\s+not\s+found/i.test(message)
        ? deviceNotFoundMessage
        : message;
}
