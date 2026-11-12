/**
 * senpi#6445's custody review (MEDIUM 1): before an import attempt stages, it sweeps staging older than an hour by its
 * folder's modification time, on the rule that an attempt in progress is younger. A live attempt is not always younger:
 * a suspended machine, a clock that steps forward, or staging that runs that long. If another import's sweep takes a
 * live attempt's folder inside that attempt's commit, after its staged session file was read and before the rename,
 * the sidecars the bundle lists are not there to move. The import must then fail before the rename: the move settles
 * failed and nothing lands, never an accepted move whose session folder lacks a sidecar its manifest lists.
 */
import { existsSync, readdirSync, utimesSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { withStagingAttempt } from "../../src/core/session-move/import-staging.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";
import { MOVE, SESSION_ID, setup } from "./session-move-fixture.ts";

type World = Awaited<ReturnType<typeof setup>>;

const disk = vi.hoisted(() => ({ afterWrite: undefined as ((path: string) => Promise<void>) | undefined }));

// The commit writes its landing's temp file from the staged session file it read: the test acts right after that.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
			await actual.writeFile(...args);
			await disk.afterWrite?.(String(args[0]));
		},
	};
});

afterEach(() => {
	disk.afterWrite = undefined;
});

const stagingOf = (world: World) => join(getDefaultSessionDir(world.cwdB), ".move-staging");
const sessionDirOf = (world: World) => getDefaultSessionDir(world.cwdB);
const landingOf = (world: World) => join(sessionDirOf(world), basename(world.source));
const goalSidecarOf = (world: World) => join(sessionDirOf(world), "extensions", "goal", `${SESSION_ID}.json`);

/** Dates everything under `dir` two hours back, deepest first: an attempt suspended that long reads as dead. */
function agedTwoHours(dir: string): void {
	const old = new Date(Date.now() - 2 * 60 * 60_000);
	for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" }).sort((x, y) => y.length - x.length))
		utimesSync(join(dir, name), old, old);
	utimesSync(dir, old, old);
}

describe("an age sweep that takes a live attempt's staging inside its commit (senpi#6445 custody review)", () => {
	it("#given an import whose commit has read its staged session file #when another import's sweep removes that attempt's staging, aged past the bound, before the rename #then the import fails, the move settles failed, and nothing lands", async () => {
		const world = await setup();
		let swept = false;
		disk.afterWrite = async (path) => {
			if (!basename(path).includes(".rebind-") || swept) return;
			swept = true;
			agedTwoHours(stagingOf(world));
			await withStagingAttempt(sessionDirOf(world), "move-woke-up" as MoveId, async () => undefined);
		};

		const answer = await importMovedSession({
			bundleDir: world.bundleDir,
			targetCwd: world.cwdB,
			ledger: world.ledger,
			readIdentity: world.readIdentity,
		}).then(
			(value) => ({ value }),
			(error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
		);
		const landed = existsSync(landingOf(world));
		const status = await world.ledger.answerStatus(MOVE, {
			movedIn: false,
			landed: async (target) => (existsSync(target) ? "moved_in" : "absent"),
		});

		expect({
			swept,
			accepted: "value" in answer,
			sessionLanded: landed,
			goalSidecarLanded: existsSync(goalSidecarOf(world)),
			status,
		}).toEqual({
			swept: true,
			accepted: false,
			sessionLanded: false,
			goalSidecarLanded: false,
			status: { state: "failed", reason: "import_failed" },
		});
	});
});
