import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CompactAdmissionError } from "./compact-admission-error.ts";

/** Per socket epoch: 128 IDs, 16 MiB reserved disk bytes, 16 live producers. No retired ID is evicted. */
export const ADMISSION_LIMITS = { entries: 128, bytes: 16 * 1024 * 1024, hot: 16, row: 131_584 } as const;
const rowSchema = z.object({
	fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
	state: z.enum(["pending", "complete", "cancelled", "failed"]),
	failure: z.literal("storage_unavailable").optional(),
	answer: z.string().max(65_536).optional(),
});
export type AdmissionRow = z.infer<typeof rowSchema>;
type Directory = { readonly directory: Promise<string>; readonly failures?: ReadonlyMap<string, AdmissionRow> };

export async function readAdmissionRow(epoch: Directory, key: string): Promise<AdmissionRow | undefined> {
	const failure = epoch.failures?.get(key);
	if (failure) return failure;
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
