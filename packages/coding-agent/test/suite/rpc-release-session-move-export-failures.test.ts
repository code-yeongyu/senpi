/**
 * senpi#6267 (P1): the export runs after the session is sealed, so what it refuses cannot be a refusal of the
 * release. The release answers `success: true` with `export: {ok: false}`, the session stays sealed for the move
 * with its staged state, and only the caller's `finish` takes it back. The teardown's grace bound is the case that
 * matters most: a runtime that still holds the file when the release answers makes the export meet `session_held`.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { opened } from "./rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { customTypes, devices, move, type Rig } from "./rpc-move-session-support.ts";
import { startReleaseHost } from "./rpc-release-host-support.ts";

const MOVE = "move-failed-export-1";

type Fixture = Awaited<ReturnType<typeof devices>>;

const exportOf = (released: Record<string, unknown>) =>
	(released.data as { export?: { ok?: boolean; error?: string; detail?: string } }).export;

const releasedFields = (released: Record<string, unknown>) => {
	const { export: _export, ...rest } = released.data as Record<string, unknown>;
	return rest;
};

async function releaseForMove(rig: Rig, fixture: Fixture): Promise<Record<string, unknown>> {
	const session = opened(
		await rig.open("conn-a", { cwd: fixture.repoA, sessionPath: fixture.sessionPath, retain_on_disconnect: true }),
		0,
	);
	await rig.drop("conn-a");
	const released = await rig.router.handle({
		type: "release_session",
		id: "rel",
		sessionId: session.sessionId,
		reason: "move",
		moveId: MOVE,
		target: "device-b",
		export: { inline: true },
	});
	await rig.settle();
	if (released === undefined) throw new Error("release_session answered nothing");
	return { ...released };
}

describe("an export that fails after the seal (senpi#6267 P1)", () => {
	it("#given the folder the bundle must be written in is a file #when the release exports #then it answers the release and reports the failure, and the session is sealed with its staged state", async () => {
		const fixture = await devices();
		const a = createInProcessRig(fixture.agentA);
		// The move folders live under the agent directory; a file where `outgoing/<moveId>` must be refuses the write.
		const outgoing = join(fixture.agentA, "session-moves", "outgoing");
		await move(a, { op: "prepare", moveId: "unrelated-1" });
		writeFileSync(outgoing, "");

		const released = await releaseForMove(a, fixture);

		expect(released.success).toBe(true);
		expect(exportOf(released)?.ok).toBe(false);
		expect(exportOf(released)?.error).toBe("move_failed");
		expect(releasedFields(released)).toEqual({
			released: true,
			session_path: fixture.sessionPath,
			attachments: 0,
			dropped: { deliveries: [], user_messages: [] },
		});
		expect(customTypes(fixture.sessionPath)).toEqual(["session_released"]);
		expect(existsSync(join(fixture.agentA, "session-moves", "outgoing", MOVE))).toBe(false);

		// The disk is usable again; the give-back needs no bundle, only the seal.
		rmSync(outgoing);
		const finished = await move(a, {
			op: "finish",
			sessionPath: fixture.sessionPath,
			moveId: MOVE,
			answer: { state: "declined", reason: "cancelled" },
		});
		expect(finished).toMatchObject({ success: true, data: { ownership: "writable" } });
	});

	it("#given a session whose shutdown handler outlives the host's close grace #when it is released for a move with an export #then the release answers and its export reports session_held, and the session stays sealed with no bundle written", async () => {
		// The real host closes a session within a 2 s grace; a shutdown handler under its own 10 s budget keeps the
		// runtime, and with it the session's file hold, alive past that grace.
		let releaseHandler = () => {};
		const handlerGate = new Promise<void>((resolve) => {
			releaseHandler = resolve;
		});
		let handlerRan = false;
		const slowShutdown: ExtensionFactory = (pi) => {
			pi.on("session_shutdown", async () => {
				handlerRan = true;
				await handlerGate;
			});
		};
		await using host = await startReleaseHost(slowShutdown);
		const { sessionId, sessionPath } = await host.open("slow-teardown");

		let released: Record<string, unknown>;
		try {
			released = await host.send({
				type: "release_session",
				id: "release-move",
				sessionId,
				reason: "move",
				moveId: MOVE,
				target: "device-b",
				export: { inline: true },
			});
		} finally {
			releaseHandler();
		}

		expect(handlerRan).toBe(true);
		expect(released.success).toBe(true);
		expect(exportOf(released)).toMatchObject({ ok: false, error: "session_held" });
		expect(customTypes(sessionPath)).toEqual(["session_released"]);
		const agentDir = join(dirname(sessionPath), "agent");
		expect(existsSync(join(agentDir, "session-moves", "outgoing", MOVE))).toBe(false);
	});
});
