/**
 * senpi#6445's custody delta review (LOW): the commit moves each staged sidecar into the session folder and skips one
 * whose destination already exists. Sidecars of the same session id can be there with no session file: an import that
 * died between moving them and the rename, then was given up. A later move then landed with that OLDER file, while
 * the bundle's own went with staging, and the check before the rename only asked whether something was there. The
 * landed sidecar must be the one the manifest lists, by its hash, or nothing lands.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { MOVE, SESSION_ID, setup } from "./session-move-fixture.ts";
import { anHourLater } from "./session-move-later.ts";

describe("a sidecar of the same session already at the landing place, with no session file (senpi#6445 custody delta)", () => {
	it("#given an older goal sidecar of the session left in the session folder by an import that died #when the move is imported #then the import fails, nothing lands, and the move settles failed instead of landing with the older sidecar", async () => {
		const world = await setup();
		const sessionDir = getDefaultSessionDir(world.cwdB);
		const leftover = join(sessionDir, "extensions", "goal", `${SESSION_ID}.json`);
		mkdirSync(dirname(leftover), { recursive: true });
		writeFileSync(leftover, '{"goal":"an older goal"}\n');
		const landing = join(sessionDir, basename(world.source));

		const answer = await importMovedSession({
			bundleDir: world.bundleDir,
			targetCwd: world.cwdB,
			ledger: world.ledger,
			readIdentity: world.readIdentity,
		}).then(
			() => "accepted",
			() => "refused",
		);
		const status = await anHourLater(world.ledger).answerStatus(MOVE, {
			movedIn: false,
			landed: async (target) => (existsSync(target) ? "moved_in" : "absent"),
		});

		expect({
			answer,
			sessionLanded: existsSync(landing),
			sidecarAtTheLandingPlace: readFileSync(leftover, "utf8"),
			status,
		}).toEqual({
			answer: "refused",
			sessionLanded: false,
			sidecarAtTheLandingPlace: '{"goal":"an older goal"}\n',
			status: { state: "failed", reason: "import_failed" },
		});
	});
});
