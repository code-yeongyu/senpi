/**
 * The sender checks its own session id before sealing (senpi#3662): the id names the resident-blob folder the
 * export copies and the receiver only accepts a plain id, so a missing or oversized header id must be refused
 * before `session_released` seals the file, and nothing from another session's blobs may reach a bundle.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { MoveBundleInvalidError } from "../../src/core/session-move/bundle.ts";
import { exportSessionForMove } from "../../src/core/session-move/export.ts";
import { customTypes, MOVE, root, writeSession } from "./session-move-fixture.ts";

function withHeaderId(file: string, id: string): void {
	const [header = "", ...rest] = readFileSync(file, "utf8").split("\n");
	const parsed = JSON.parse(header) as Record<string, unknown>;
	parsed.id = id;
	writeFileSync(file, [JSON.stringify(parsed), ...rest].join("\n"));
}

describe("exportSessionForMove checks the sender's session id (senpi#3662)", () => {
	for (const [label, id] of [
		["an empty header id", ""],
		["a header id over 128 characters", "a".repeat(129)],
		["a header id that climbs out of a folder", "../other"],
	] as const) {
		it(`#given ${label} #then export refuses before sealing and writes no bundle`, async () => {
			const cwd = join(root(), "repo");
			mkdirSync(cwd, { recursive: true });
			const file = writeSession(cwd);
			withHeaderId(file, id);
			const blobs = join(getDefaultSessionDir(cwd), "resident-blobs", "another-session");
			mkdirSync(blobs, { recursive: true });
			writeFileSync(join(blobs, "secret.bin"), "other session's blob");
			const bundleDir = join(cwd, "..", "bundle");

			await expect(
				exportSessionForMove({
					sessionFile: file,
					moveId: MOVE,
					target: "device-b",
					droppedUserMessages: [],
					bundleDir,
				}),
			).rejects.toBeInstanceOf(MoveBundleInvalidError);

			expect(customTypes(file)).toEqual([]);
			expect(existsSync(bundleDir)).toBe(false);
		});
	}
});
