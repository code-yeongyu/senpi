import { open } from "node:fs/promises";

const TAIL_BYTES = 256 * 1024;

/**
 * The newest transcript entry timestamp strictly before `beforeMs`, read from the tail of the
 * session JSONL. It is the tightest free "last alive" stamp a restore has: every turn appends,
 * while the manifest only records lifecycle transitions. Entries written after `beforeMs` belong
 * to the resuming process and are skipped. Undefined when the file is absent or has no stamp.
 */
export async function sessionActivityBeforeMs(
	sessionFile: string | undefined,
	beforeMs: number,
): Promise<number | undefined> {
	if (sessionFile === undefined) return undefined;
	let text: string;
	try {
		const handle = await open(sessionFile, "r");
		try {
			const { size } = await handle.stat();
			const length = Math.min(size, TAIL_BYTES);
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, size - length);
			text = buffer.toString("utf8");
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
	let newest: number | undefined;
	for (const match of text.matchAll(/"timestamp":"([^"]+)"/g)) {
		const stamp = Date.parse(match[1] ?? "");
		if (!Number.isFinite(stamp) || stamp >= beforeMs) continue;
		if (newest === undefined || stamp > newest) newest = stamp;
	}
	return newest;
}
