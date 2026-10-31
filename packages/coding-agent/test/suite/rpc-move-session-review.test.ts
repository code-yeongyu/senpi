/**
 * `move_session` review fixes (senpi#3678 round 1): a move settles once however many `finish` calls race, the
 * "open on this host" checks see through `.`, `..` and symlinks, a held session is refused with its own code, and
 * client paths must be absolute.
 */
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { opened } from "./rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { customTypes, devices, hostAndRelease, move } from "./rpc-move-session-support.ts";

const admitted = (file: string, text: string) =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter(
			(line) => line.includes('"pending_input_transition"') && line.includes('"admitted"') && line.includes(text),
		).length;

describe("move_session review fixes (senpi#3678)", () => {
	it("#given two finish calls for one declined move at once #then the queued input comes back exactly once and both see the same result", async () => {
		const { repoA, agentA, sessionPath } = await devices();
		await using a = createInProcessRig(agentA);
		await hostAndRelease(a, repoA, sessionPath, "move-5");
		await move(a, {
			op: "export",
			sessionPath,
			moveId: "move-5",
			target: "device-b",
			droppedUserMessages: ["q1", "q2"],
		});
		const answer = { state: "declined", reason: "cancelled" };

		const [first, second] = await Promise.all([
			move(a, { op: "finish", sessionPath, moveId: "move-5", answer }),
			move(a, { op: "finish", sessionPath, moveId: "move-5", answer }),
		]);

		expect(first).toMatchObject({ success: true, data: { ownership: "writable" } });
		expect(second).toEqual({ ...first });
		expect(admitted(sessionPath, "q1")).toBe(1);
		expect(admitted(sessionPath, "q2")).toBe(1);
		expect(customTypes(sessionPath)).toEqual(["session_released", "session_reclaimed"]);
	});

	it("#given a session open here #when it is exported or finished through a dotted or symlinked path #then both refuse session_open_here", async () => {
		const { base, repoA, agentA, sessionPath } = await devices();
		await using a = createInProcessRig(agentA);
		await hostAndRelease(a, repoA, sessionPath, "move-6");
		opened(await a.open("conn-b", { cwd: repoA, sessionPath, retain_on_disconnect: true }), 0);
		const dir = dirname(sessionPath);
		const dotted = join(dir, ".", "..", dir.split("/").at(-1) ?? "", sessionPath.split("/").at(-1) ?? "");
		const linkDir = join(base, "link");
		symlinkSync(dir, linkDir);
		const linked = join(linkDir, sessionPath.split("/").at(-1) ?? "");

		for (const path of [sessionPath, dotted, linked]) {
			expect(await move(a, { op: "export", sessionPath: path, moveId: "move-6", target: "device-b" })).toMatchObject(
				{ success: false, error: "session_open_here", errorData: { detail: expect.any(String) } },
			);
			expect(
				await move(a, {
					op: "finish",
					sessionPath: path,
					moveId: "move-6",
					answer: { state: "declined", reason: "cancelled" },
				}),
			).toMatchObject({ success: false, error: "session_open_here" });
		}
		expect(customTypes(sessionPath)).toEqual(["session_released"]);
	});

	it("#given a relative cwd or bundle folder #then import refuses it before touching any folder", async () => {
		const { agentB } = await devices();
		await using b = createInProcessRig(agentB);
		await move(b, { op: "prepare", moveId: "move-7" });
		for (const fields of [
			{ bundleDir: "bundle", cwd: "/abs/repo" },
			{ bundleDir: "/abs/bundle", cwd: "repo" },
			{ bundleDir: "/abs/bundle", cwd: "./repo" },
		]) {
			expect(await move(b, { op: "import", ...fields })).toMatchObject({
				success: false,
				error: "invalid_move_request",
			});
		}
		expect(existsSync(join(agentB, "sessions"))).toBe(false);
	});

	it("#given a session held by another process #then export refuses with session_held, not move_failed", async () => {
		const { repoA, agentA, sessionPath } = await devices();
		await using a = createInProcessRig(agentA);
		await hostAndRelease(a, repoA, sessionPath, "move-8");
		await using holder = createInProcessRig(agentA);
		opened(await holder.open("conn-h", { cwd: repoA, sessionPath, retain_on_disconnect: true }), 0);

		expect(await move(a, { op: "export", sessionPath, moveId: "move-8", target: "device-b" })).toMatchObject({
			success: false,
			error: "session_held",
			errorData: { detail: expect.any(String) },
		});
	});

	it("#given a move id that is not a plain id #then nothing is created under session-moves", async () => {
		const { agentB } = await devices();
		await using b = createInProcessRig(agentB);
		for (const moveId of ["../x", "..", "a/b"]) await move(b, { op: "prepare", moveId });
		expect(existsSync(join(agentB, "session-moves"))).toBe(false);
	});
});
