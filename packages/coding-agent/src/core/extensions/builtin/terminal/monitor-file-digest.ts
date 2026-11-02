import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";

// Identity digest over first/middle/last 64 KiB samples plus size: cheap enough to run per
// poll tick on large files while still catching content replacements that preserve mtime.
export async function digestFileHandle(handle: FileHandle, signal?: AbortSignal): Promise<string> {
	const SAMPLE_SIZE = 64 * 1024;
	if (signal?.aborted) throw new Error("file monitor registration cancelled");
	const metadata = await handle.stat();
	const hash = createHash("sha256");
	const first = Buffer.alloc(Math.min(SAMPLE_SIZE, metadata.size));
	if (first.length > 0) {
		await handle.read(first, 0, first.length, 0);
		hash.update(first);
	}
	if (metadata.size > SAMPLE_SIZE) {
		const middle = Buffer.alloc(SAMPLE_SIZE);
		await handle.read(middle, 0, middle.length, Math.floor((metadata.size - middle.length) / 2));
		hash.update(middle);
		const last = Buffer.alloc(SAMPLE_SIZE);
		await handle.read(last, 0, last.length, metadata.size - last.length);
		hash.update(last);
	}
	return `${metadata.size}:${hash.digest("hex")}`;
}
