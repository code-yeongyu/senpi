import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withRootLock } from "./install-lock.ts";

const POINTER = "active";
const REVISION = /^rev-(\d+)$/;

export interface Revision {
	readonly number: number;
	readonly dir: string;
}

export async function readActiveRevision(base: string): Promise<Revision | undefined> {
	try {
		const name = (await readFile(join(base, POINTER), "utf8")).trim();
		const match = REVISION.exec(name);
		return match?.[1] === undefined ? undefined : { number: Number(match[1]), dir: join(base, name) };
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Builds the next revision under the root's lock: a staging copy of the active revision (so packages
 * accumulate) is handed to `build`, renamed to `rev-<n>` only after `build` succeeds, and published by an
 * atomic replace of the `active` pointer. A failed, cancelled or interrupted build is deleted; the
 * previous revision stays active and is never modified, so a running kernel never sees a partial install.
 */
export async function publishNextRevision(
	base: string,
	build: (staging: string, previous: Revision | undefined) => Promise<void>,
	signal?: AbortSignal,
): Promise<{ readonly revision: Revision; readonly previous: Revision | undefined }> {
	await mkdir(base, { recursive: true });
	return withRootLock(
		base,
		async () => {
			const previous = await readActiveRevision(base);
			const number = Math.max(previous?.number ?? 0, await highestRevision(base)) + 1;
			const staging = join(base, `.staging-rev-${number}-${process.pid}`);
			const dir = join(base, `rev-${number}`);
			try {
				if (previous === undefined) await mkdir(staging, { recursive: true });
				else await cp(previous.dir, staging, { recursive: true, verbatimSymlinks: true });
				await build(staging, previous);
				signal?.throwIfAborted();
				await rename(staging, dir);
				const pointer = join(base, `.${POINTER}-${process.pid}`);
				await writeFile(pointer, `rev-${number}\n`);
				await rename(pointer, join(base, POINTER));
			} catch (error) {
				await rm(staging, { recursive: true, force: true });
				throw error;
			}
			return { revision: { number, dir }, previous };
		},
		signal,
	);
}

async function highestRevision(base: string): Promise<number> {
	let highest = 0;
	for (const entry of await readdir(base)) {
		const match = REVISION.exec(entry);
		if (match?.[1] !== undefined) highest = Math.max(highest, Number(match[1]));
	}
	return highest;
}
