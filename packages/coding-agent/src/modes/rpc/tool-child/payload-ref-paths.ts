import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PayloadRef } from "./protocol.ts";
import { isRefId } from "./protocol-guard.ts";

/**
 * Layout under the channel's ref root: `gen-<generation>/refs/<refId>` and `gen-<generation>/spool/`. Refs of both
 * directions live under the child generation that owns the channel, so one teardown removes all of them.
 */
const GENERATION_DIR = /^gen-(\d+)$/;

export function refGenerationDir(root: string, generation: number): string {
	return join(root, `gen-${generation}`);
}

export function refFilePath(root: string, ref: Pick<PayloadRef, "refId" | "generation">): string {
	if (!isRefId(ref.refId)) throw new Error(`invalid ref id: ${JSON.stringify(ref.refId)}`);
	return join(refGenerationDir(root, ref.generation), "refs", ref.refId);
}

export function spoolDir(root: string, generation: number): string {
	return join(refGenerationDir(root, generation), "spool");
}

/** Generation teardown: every ref of that generation, acknowledged or not, and its `spool/`. */
export async function teardownRefGeneration(root: string, generation: number): Promise<void> {
	await rm(refGenerationDir(root, generation), { recursive: true, force: true });
}

/** Removes the directory of every generation not in `live` (left by a dead child or server); returns them, sorted. */
export async function sweepRefGenerations(root: string, live: ReadonlySet<number>): Promise<number[]> {
	let names: string[];
	try {
		names = await readdir(root);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const stale = names
		.map((name) => GENERATION_DIR.exec(name)?.[1])
		.filter((digits) => digits !== undefined)
		.map(Number)
		.filter((generation) => !live.has(generation))
		.sort((left, right) => left - right);
	for (const generation of stale) await teardownRefGeneration(root, generation);
	return stale;
}
