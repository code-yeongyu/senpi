/**
 * The `export` op's handler gives the core a second check that runs inside the cross-process move lock. Between the
 * handler's first check and that lock, another host generation on the same agent directory can finish the move and
 * give the session back. The export must then refuse: the core seals any writable session it is handed, so without
 * the second check it would seal the session again by itself (no interrupt, no hand-back of queued input, no staged
 * extension state), write a bundle and answer success.
 *
 * The first check and the lock are two awaits inside the core with nothing between them a caller can hold. So this
 * file wraps the core's export, which still runs unchanged, only to place the other process's finish exactly there:
 * after the handler's own guard has returned and before the lock is taken.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as CoreExport from "../../src/core/session-move/export.ts";
import { cleanupIssue2184, spawnModuleChild, srcUrl } from "./regressions/issue-2184-support.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { customTypes, devices, hostAndRelease, move } from "./rpc-move-session-support.ts";

const MOVE = "move-locked-guard-1";

const between = vi.hoisted((): { firstCheckAndLock?: () => Promise<void> } => ({}));

vi.mock("../../src/core/session-move/export.ts", async (importOriginal) => {
	const core = await importOriginal<typeof CoreExport>();
	const exportSessionForMoveAndRead: typeof core.exportSessionForMoveAndRead = (options, read) =>
		core.exportSessionForMoveAndRead(
			{
				...options,
				guard: async () => {
					await options.guard?.();
					await between.firstCheckAndLock?.();
				},
			},
			read,
		);
	return { ...core, exportSessionForMoveAndRead };
});

// Ends the other process of a test that failed before it stopped it.
afterEach(() => {
	between.firstCheckAndLock = undefined;
	cleanupIssue2184();
});

/** Another host generation finishes the move as declined: the real finish, in a process of its own. */
async function givenBackByAnotherProcess(sessionPath: string, bundleDir: string): Promise<void> {
	const finish = { sessionFile: sessionPath, bundleDir, answer: { state: "declined", reason: "cancelled" } };
	const other = spawnModuleChild(
		[
			`const { finishMove } = await import(${JSON.stringify(srcUrl("core/session-move/finish.ts"))});`,
			`const { parseMoveId } = await import(${JSON.stringify(srcUrl("core/session-move/bundle.ts"))});`,
			`await finishMove({ ...${JSON.stringify(finish)}, moveId: parseMoveId(${JSON.stringify(MOVE)}) });`,
			'process.stdout.write("GIVEN_BACK\\n");',
		].join("\n"),
	);
	await other.line("GIVEN_BACK");
	await other.exit();
}

describe("the export op checks the seal again inside the move lock", () => {
	it("#given a session sealed for a move whose export has passed its first check #when another process finishes the move as declined before the export takes the move lock #then the export is refused as not released, the session keeps what the give-back left with no new release entry, and no bundle is written", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await hostAndRelease(a, fixture.repoA, fixture.sessionPath, MOVE);
		const outgoing = join(fixture.agentA, "session-moves", "outgoing", MOVE);
		let givenBack: string | undefined;
		between.firstCheckAndLock = async () => {
			await givenBackByAnotherProcess(fixture.sessionPath, outgoing);
			givenBack = readFileSync(fixture.sessionPath, "utf8");
		};

		const refused = await move(a, {
			op: "export",
			sessionPath: fixture.sessionPath,
			moveId: MOVE,
			target: "device-b",
		});

		expect(refused).toMatchObject({ success: false, errorCode: "move_not_released" });
		expect(customTypes(fixture.sessionPath)).toEqual(["session_released", "session_reclaimed"]);
		expect(readFileSync(fixture.sessionPath, "utf8")).toBe(givenBack);
		expect(existsSync(outgoing)).toBe(false);
	});
});
