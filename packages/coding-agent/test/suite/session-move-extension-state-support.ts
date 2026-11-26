/**
 * Shared rigs for the extension-state move suites: a deferred promise for holding a handler mid-run, and a released
 * session turned into one a move just brought in, with its state pending next to it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { movedStateDir } from "../../src/core/session-move/extension-state.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";

export function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/** Appends a `session_moved_in` for `moveId` to a released session and leaves its state pending next to it. */
export function moveIn(sessionPath: string, moveId: string): string {
	const lines = readFileSync(sessionPath, "utf8").trimEnd().split("\n");
	const id = JSON.parse(lines[0] ?? "{}").id;
	const last = JSON.parse(lines.at(-1) ?? "{}").id;
	const movedIn = {
		type: "custom",
		id: `mv-in-${moveId}`,
		parentId: last,
		timestamp: "2026-10-19T00:00:00.000Z",
		customType: "session_moved_in",
		data: { move_id: moveId, session_id: id, from: "device-a" },
	};
	writeFileSync(sessionPath, `${[...lines, JSON.stringify(movedIn)].join("\n")}\n`);
	const pendingDir = movedStateDir(sessionPath, moveId as MoveId);
	mkdirSync(join(pendingDir, "probe"), { recursive: true });
	writeFileSync(join(pendingDir, "probe", "state.json"), '{"tasks":3}\n');
	return pendingDir;
}
