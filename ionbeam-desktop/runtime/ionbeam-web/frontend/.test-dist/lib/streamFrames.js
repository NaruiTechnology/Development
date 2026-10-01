/** Incremental bounded parser: HTTP chunk boundaries are not frame boundaries. */
export const MAX_FRAME = 16 * 1024 * 1024;
export async function* readFrames(stream) {
    const reader = stream.getReader();
    let chunk = new Uint8Array(0);
    let offset = 0;
    async function exact(size, allowEof = false) {
        const result = new Uint8Array(size);
        let copied = 0;
        while (copied < size) {
            if (offset === chunk.length) {
                const next = await reader.read();
                if (next.done) {
                    if (allowEof && copied === 0)
                        return null;
                    throw new Error("Truncated scan frame");
                }
                chunk = next.value;
                offset = 0;
            }
            const n = Math.min(size - copied, chunk.length - offset);
            result.set(chunk.subarray(offset, offset + n), copied);
            offset += n;
            copied += n;
        }
        return result;
    }
    try {
        while (true) {
            const header = await exact(5, true);
            if (!header)
                return;
            const kind = header[0];
            const length = new DataView(header.buffer).getUint32(1, false);
            if (kind > 2 || length > MAX_FRAME)
                throw new Error("Invalid scan frame header");
            const payload = (await exact(length));
            yield { kind, payload };
        }
    }
    finally {
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
