import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CompactAdmissionError } from "./compact-admission-error.ts";

/** Per socket epoch, including ordinary and mirror attempts; retired IDs are never evicted. */
export const ADMISSION_LIMITS = { entries: 128, bytes: 16 * 1024 * 1024, hot: 16, row: 131_584 } as const;
const rowSchema = z.object({
	fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
	state: z.enum(["pending", "complete", "cancelled", "failed"]),
	answer: z.string().max(65_536).optional(),
});
export type AdmissionRow = z.infer<typeof rowSchema>;
type Directory = { readonly directory: Promise<string> };

export async function readAdmissionRow(epoch: Directory, key: string): Promise<AdmissionRow | undefined> {
	try {
		const text = await readFile(join(await epoch.directory, key), "utf8");
		if (Buffer.byteLength(text) > ADMISSION_LIMITS.row) throw new CompactAdmissionError("storage_unavailable");
		return rowSchema.parse(JSON.parse(text));
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
		if (cause instanceof CompactAdmissionError) throw cause;
		throw new CompactAdmissionError("storage_unavailable");
	}
}

export async function writeAdmissionRow(epoch: Directory, key: string, row: AdmissionRow): Promise<void> {
	const text = JSON.stringify(row);
	if (Buffer.byteLength(text) > ADMISSION_LIMITS.row) throw new CompactAdmissionError("storage_unavailable");
	try {
		await writeFile(join(await epoch.directory, key), text, { mode: 0o600, flush: true });
	} catch (cause) {
		if (!(cause instanceof Error)) throw cause;
		throw new CompactAdmissionError("storage_unavailable");
	}
}
