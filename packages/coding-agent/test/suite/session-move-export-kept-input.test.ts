/**
 * senpi#6454's custody pre-read: an export sent again without `droppedUserMessages` keeps the queued input the bundle
 * already at the move's place records. That bundle may hold less than a whole manifest (an export that failed after
 * the seal keeps only its format, move id and input), and it may be there and unreadable. Only a bundle that is not
 * there reads as "no input": a partial one still gives its input, and one that cannot be read fails the export, which
 * changes nothing and can be sent again. Otherwise the export that replaces the bundle erases the input for good.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportSessionForMove } from "../../src/core/session-move/export.ts";
import { MOVE, root, writeSession } from "./session-move-fixture.ts";

function world() {
	const base = root();
	const cwd = join(base, "repo");
	mkdirSync(cwd, { recursive: true });
	return { sessionFile: writeSession(cwd), bundleDir: join(base, "outgoing", MOVE) };
}

const exportedAgain = ({ sessionFile, bundleDir }: ReturnType<typeof world>, sent?: readonly string[]) =>
	exportSessionForMove({
		sessionFile,
		moveId: MOVE,
		target: "device-b",
		bundleDir,
		...(sent === undefined ? {} : { droppedUserMessages: sent }),
	}).then(
		() => "exported",
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);

function keep(bundleDir: string, manifest: Record<string, unknown>): void {
	mkdirSync(bundleDir, { recursive: true });
	writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifest));
}

const inputIn = (bundleDir: string): unknown =>
	(JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8")) as { droppedUserMessages?: unknown })
		.droppedUserMessages;

describe("the queued input a kept bundle records, when its move is exported again without a list (senpi#6454)", () => {
	it("#given a kept bundle that holds only its format, its move id and the queued input #when the move is exported again with no list #then the new bundle's manifest lists that input", async () => {
		const kept = world();
		keep(kept.bundleDir, { format: 1, moveId: MOVE, droppedUserMessages: ["queued follow-up"] });

		const outcome = await exportedAgain(kept);

		expect({ outcome, input: inputIn(kept.bundleDir) }).toEqual({ outcome: "exported", input: ["queued follow-up"] });
	});

	it("#given a kept bundle whose manifest is there and cannot be read #when the move is exported again with no list #then the export fails and the kept bundle is still there", async () => {
		const kept = world();
		// A folder where the manifest file must be: reading it fails, and not because it is missing.
		mkdirSync(join(kept.bundleDir, "manifest.json"), { recursive: true });

		const outcome = await exportedAgain(kept);

		expect({
			exported: outcome === "exported",
			keptStillThere:
				existsSync(join(kept.bundleDir, "manifest.json")) &&
				statSync(join(kept.bundleDir, "manifest.json")).isDirectory(),
		}).toEqual({ exported: false, keptStillThere: true });
	});

	it("#given a kept bundle that records queued input #when the move is exported again with an empty list #then the new bundle's manifest still lists that input", async () => {
		const kept = world();
		keep(kept.bundleDir, { format: 1, moveId: MOVE, droppedUserMessages: ["queued follow-up"] });

		const outcome = await exportedAgain(kept, []);

		expect({ outcome, input: inputIn(kept.bundleDir) }).toEqual({ outcome: "exported", input: ["queued follow-up"] });
	});

	it("#given a kept bundle that records queued input #when the move is exported again with a list that names input #then the list sent is written, not merged with the kept one", async () => {
		const kept = world();
		keep(kept.bundleDir, { format: 1, moveId: MOVE, droppedUserMessages: ["queued follow-up"] });

		const outcome = await exportedAgain(kept, ["sent now"]);

		expect({ outcome, input: inputIn(kept.bundleDir) }).toEqual({ outcome: "exported", input: ["sent now"] });
	});

	it("#given a bundle of another move at the move's place #when the move is exported with no list #then it is exported with no input", async () => {
		const kept = world();
		keep(kept.bundleDir, { format: 1, moveId: "move-of-another", droppedUserMessages: ["another move's input"] });

		const outcome = await exportedAgain(kept);

		expect({ outcome, input: inputIn(kept.bundleDir) }).toEqual({ outcome: "exported", input: [] });
	});

	it("#given no bundle at the move's place #when the move is exported with no list #then it is exported with no input", async () => {
		const fresh = world();

		const outcome = await exportedAgain(fresh);

		expect({ outcome, input: inputIn(fresh.bundleDir) }).toEqual({ outcome: "exported", input: [] });
	});
});
