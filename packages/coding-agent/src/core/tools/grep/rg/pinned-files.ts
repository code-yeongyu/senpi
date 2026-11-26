import type { FileHandle } from "node:fs/promises";
import { openToolFile } from "@code-yeongyu/senpi-machine-ops";
import type { Candidate } from "./enumerate.ts";
import type { RgEvent } from "./json-rows.ts";
import type { RgRun } from "./process.ts";

const MAX_READ = 4194304;
const FD_BATCH = 200;

async function bytes(file: FileHandle): Promise<Buffer> {
	const size = Math.min((await file.stat()).size, MAX_READ);
	const buffer = Buffer.alloc(size);
	let length = 0;
	while (length < size) {
		const { bytesRead } = await file.read(buffer, length, size - length, length);
		if (!bytesRead) break;
		length += bytesRead;
	}
	return buffer.subarray(0, length);
}

export async function containsNul(path: string): Promise<boolean> {
	const file = await openToolFile(path);
	try {
		return (await bytes(file)).includes(0);
	} finally {
		await file.close();
	}
}

/** Only a descriptor already checked by openToolFile may supply content. Passing
 * the original names to rg would let it reopen a different object after admission. */
export async function matchPinnedFiles(
	run: RgRun,
	candidates: Candidate[],
	args: string[],
	cwd: string,
	onEvent: (event: RgEvent) => void,
) {
	for (let start = 0; start < candidates.length; start += FD_BATCH) {
		const batch = candidates.slice(start, start + FD_BATCH);
		const files: FileHandle[] = [];
		try {
			for (const candidate of batch) files.push(await openToolFile(candidate.absolute));
			if (process.platform === "win32") {
				for (const [i, file] of files.entries())
					await run(
						args,
						cwd,
						(e) => onEvent({ ...e, data: { ...e.data, path: { text: batch[i].absolute } } }),
						await bytes(file),
					);
			} else {
				const paths = batch.map((_, i) => `/dev/fd/${i + 3}`);
				await run(
					[...args, ...paths],
					cwd,
					(e) => {
						if (e.type === "summary") return onEvent(e);
						const i = paths.indexOf(e.data.path?.text ?? "");
						if (i < 0) throw new Error("unexpected file in descriptor-only grep output");
						onEvent({ ...e, data: { ...e.data, path: { text: batch[i].absolute } } });
					},
					undefined,
					files.map((file) => file.fd),
				);
			}
		} finally {
			await Promise.all(files.map((file) => file.close()));
		}
	}
}
