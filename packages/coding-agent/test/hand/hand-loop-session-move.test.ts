// senpi#5898: a hosted loop's session move runs the user's move handlers on the hand. The state folder crosses the link
// as entries (a folder `{ path }` or a base64 file `{ path, data }`), checked at the hand's boundary: paths stay inside
// the folder, a file's folders are created whatever the order, and the state is bounded (review L4).
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import { localRunner, loopEventMachine } from "./loop-event-fixture.ts";
import { cleanupHands } from "./remote-hand-fixture.ts";

let user: Awaited<ReturnType<typeof loopEventMachine>>;
let local: ExtensionRunner;
beforeAll(async () => {
	user = await loopEventMachine();
	local = await localRunner(user.dirs.cwd);
});
afterAll(cleanupHands);

describe("a hosted loop's session move runs the user's move handlers on the hand (senpi#5898)", () => {
	it("session_move_export carries back the state the user's handler wrote, as a local session's folder holds it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "senpi-5898-move-"));
		const failures = await local.emitSessionMove({ type: "session_move_export", moveId: "move-1", dir });

		const reply = await user.send("session_move_export", { moveId: "move-1" });

		expect([failures, reply.errors]).toEqual([[], undefined]);
		expect(reply.files).toEqual([
			{ path: "loop-event-ext" },
			{
				path: "loop-event-ext/state.json",
				data: readFileSync(join(dir, "loop-event-ext", "state.json")).toString("base64"),
			},
		]);
	});

	it("session_move_import hands the user's handler the state the loop carried, in a folder of its own", async () => {
		const state = Buffer.from(JSON.stringify({ moveId: "move-1" })).toString("base64");

		const reply = await user.send("session_move_import", {
			moveId: "move-1",
			redelivered: true,
			files: [{ path: "loop-event-ext" }, { path: "loop-event-ext/state.json", data: state }],
		});

		expect(reply.errors).toBeUndefined();
		expect(reply.notices?.map((notice) => notice.message)).toEqual(['{"moveId":"move-1"} true']);
	});

	it("refuses carried state whose path leaves the import folder, before any handler runs", async () => {
		await expect(
			user.send("session_move_import", {
				moveId: "move-1",
				redelivered: false,
				files: [{ path: "../escaped.json", data: "" }],
			}),
		).rejects.toThrow("malformed session_move_import payload");
	});

	it("session_move_import creates a file's folders, whatever order the loop sends the entries in (review L4)", async () => {
		const state = Buffer.from(JSON.stringify({ moveId: "move-2" })).toString("base64");

		const reply = await user.send("session_move_import", {
			moveId: "move-2",
			redelivered: false,
			files: [{ path: "loop-event-ext/state.json", data: state }, { path: "loop-event-ext" }],
		});

		expect(reply.errors).toBeUndefined();
		expect(reply.notices?.map((notice) => notice.message)).toEqual(['{"moveId":"move-2"} false']);
	});

	it("refuses carried state past its size bounds or not in base64, before anything is written (review L4)", async () => {
		const oversize = Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64");
		const quarter = Buffer.alloc(7 * 1024 * 1024).toString("base64");

		for (const files of [
			[{ path: "big.bin", data: oversize }],
			[1, 2, 3, 4, 5].map((index) => ({ path: `part-${index}.bin`, data: quarter })),
			[{ path: "bad.bin", data: "not base64!" }],
		])
			await expect(
				user.send("session_move_import", { moveId: "move-3", redelivered: false, files }),
			).rejects.toThrow("malformed session_move_import payload");
	});
});
