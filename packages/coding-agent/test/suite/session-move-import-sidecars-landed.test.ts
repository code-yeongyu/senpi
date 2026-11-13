/**
 * What the check before the rename asks for (senpi#6445's custody fold). It guards the sidecars the commit lands with
 * the session: its extension state files and its resident blobs. A manifest may list a sidecar at any other path
 * within the depth cap; the import stages that one and never lands it, and such a bundle imports (senpi#6469 pins it
 * on main). The check first demanded every listed path at the landing place and refused that bundle.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { MOVE, SESSION_ID, setup } from "./session-move-fixture.ts";
import { anHourLater } from "./session-move-later.ts";

describe("the sidecars an import must have landed before its rename (senpi#6445 custody fold)", () => {
	it("#given a bundle whose manifest also lists a sidecar at a path the commit does not land #when it is imported #then the session lands with its own sidecar, the move is accepted, and that other path is not in the session folder", async () => {
		const world = await setup();
		const other = "files/notes/kept-by-the-sender.txt";
		mkdirSync(dirname(join(world.bundleDir, other)), { recursive: true });
		writeFileSync(join(world.bundleDir, other), "a note");
		const manifestFile = join(world.bundleDir, "manifest.json");
		const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
			sidecars: { path: string; sha256: string }[];
		};
		manifest.sidecars.push({ path: other, sha256: createHash("sha256").update("a note").digest("hex") });
		writeFileSync(manifestFile, JSON.stringify(manifest));
		const sessionDir = getDefaultSessionDir(world.cwdB);

		const answer = await importMovedSession({
			bundleDir: world.bundleDir,
			targetCwd: world.cwdB,
			ledger: world.ledger,
			readIdentity: world.readIdentity,
		}).then(
			() => "accepted",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		const status = await anHourLater(world.ledger).answerStatus(MOVE, {
			movedIn: existsSync(join(sessionDir, basename(world.source))),
		});

		expect({
			answer,
			sessionLanded: existsSync(join(sessionDir, basename(world.source))),
			goalSidecarLanded: existsSync(join(sessionDir, "extensions", "goal", `${SESSION_ID}.json`)),
			otherPathLanded: existsSync(join(sessionDir, "notes", "kept-by-the-sender.txt")),
			status,
		}).toEqual({
			answer: "accepted",
			sessionLanded: true,
			goalSidecarLanded: true,
			otherPathLanded: false,
			status: { state: "accepted" },
		});
	});
});
