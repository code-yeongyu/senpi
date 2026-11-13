/**
 * senpi#6267 (P1): the export runs after the session is sealed, so what it refuses cannot be a refusal of the
 * release. The release answers `success: true` with `export: {ok: false}`, the session stays sealed for the move
 * with its staged state, and only the caller's `finish` takes it back. The teardown's grace bound is the case that
 * matters most: a runtime that still holds the file when the release answers makes the export meet `session_held`.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionHeldError } from "../../src/core/session-hold-errors.ts";
import { cleanupIssue2184, spawnModuleChild, srcUrl } from "./regressions/issue-2184-support.ts";
import { opened } from "./rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { customTypes, devices, move, type Rig } from "./rpc-move-session-support.ts";
import { startReleaseHost } from "./rpc-release-host-support.ts";
import { fileHoldLetGo, heldShutdown } from "./rpc-release-slow-teardown-support.ts";
import { SESSION_ID } from "./session-move-fixture.ts";

const MOVE = "move-failed-export-1";
/**
 * What the export's `detail` says when the holder is the releasing host's own runtime, which had not stopped by the
 * close grace (docs/rpc.md). The text for a session open in another process would send the user to quit a process
 * that is this host.
 */
const STILL_STOPPING_HERE =
	"This session had not finished stopping on this host when it was released, so nothing was exported. Give it back with finish and a declined answer.";
/** What a give-back is refused with while that same runtime is still stopping: the caller sends it again. */
const NOT_GIVEN_BACK_YET =
	"This session has not finished stopping on this host, so it was not given back. Send finish again.";

// Ends the holder process of a test that failed before it stopped it, and takes the spy off the runtime.
afterEach(() => {
	cleanupIssue2184();
	vi.restoreAllMocks();
});

const givingBack = (id: string, sessionPath: string) =>
	({
		type: "move_session",
		id,
		op: "finish",
		sessionPath,
		moveId: MOVE,
		answer: { state: "declined", reason: "cancelled" },
	}) as const;

type Fixture = Awaited<ReturnType<typeof devices>>;

const exportOf = (released: Record<string, unknown>) =>
	(released.data as { export?: { ok?: boolean; error?: string; detail?: string } }).export;

const detailOf = (refused: Record<string, unknown>) => (refused.errorData as { detail?: string } | undefined)?.detail;

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

	it("#given a session whose shutdown handler outlives the host's close grace #when it is released for a move with an export #then the release answers and its export reports session_held in this host's own words, the session stays sealed with no bundle written, a give-back sent while that runtime is still stopping is refused and changes nothing, and once it has stopped the give-back makes the session writable and whole again", async () => {
		const shutdown = heldShutdown();
		await using host = await startReleaseHost(shutdown.extension);
		const { sessionId, sessionPath } = await host.open("slow-teardown");

		// The handler is held past the release's answer, so the first give-back meets a runtime that is still stopping.
		// The wait for that runtime to let go of the file is subscribed before the release, so it cannot miss it.
		const letGo = fileHoldLetGo();
		try {
			const released = await host.send({
				type: "release_session",
				id: "release-move",
				sessionId,
				reason: "move",
				moveId: MOVE,
				target: "device-b",
				export: { inline: true },
			});
			const sealed = readFileSync(sessionPath, "utf8");
			const sealedTypes = customTypes(sessionPath);
			const agentDir = join(dirname(sessionPath), "agent");
			const bundleWritten = existsSync(join(agentDir, "session-moves", "outgoing", MOVE));
			const early = await host.send(givingBack("give-back-while-stopping", sessionPath));
			const afterEarly = readFileSync(sessionPath, "utf8");
			shutdown.letGo();
			await letGo;
			const finished = await host.send(givingBack("give-back", sessionPath));
			const reopened = await host.attach(sessionPath);

			expect(shutdown.ran()).toBe(true);
			expect(released.success).toBe(true);
			expect(exportOf(released)).toMatchObject({ ok: false, error: "session_held" });
			expect(sealedTypes).toEqual(["session_released"]);
			expect(bundleWritten).toBe(false);
			expect(early).toMatchObject({ success: false, errorCode: "session_held" });
			expect(afterEarly).toBe(sealed);
			expect(finished).toMatchObject({ success: true, data: { ownership: "writable" } });
			expect(reopened.success).toBe(true);
			expect(readFileSync(sessionPath, "utf8").startsWith(sealed)).toBe(true);
			expect(detailOf(early)).toBe(NOT_GIVEN_BACK_YET);
			expect(exportOf(released)?.detail).toBe(STILL_STOPPING_HERE);
		} finally {
			shutdown.letGo();
		}
	});

	it("#given a session that another live process holds as well #when it is released for a move with an export #then its export reports session_held with the text that names that process, word for word, and so does a give-back sent while that process still holds it", async () => {
		const fixture = await devices();
		const a = createInProcessRig(fixture.agentA);
		const session = opened(
			await a.open("conn-a", { cwd: fixture.repoA, sessionPath: fixture.sessionPath, retain_on_disconnect: true }),
			0,
		);
		await a.drop("conn-a");
		const holder = spawnModuleChild(
			[
				`const { holdSessionFile } = await import(${JSON.stringify(srcUrl("core/session-holders.ts"))});`,
				`holdSessionFile(${JSON.stringify(fixture.sessionPath)}, ${JSON.stringify(SESSION_ID)}, { cwd: ${JSON.stringify(fixture.repoB)}, expectExisting: true });`,
				'process.stdout.write("HELD\\n");',
				'process.stdin.on("data", () => process.exit(0));',
			].join("\n"),
		);
		await holder.line("HELD");

		const released = await a.router.handle({
			type: "release_session",
			id: "rel",
			sessionId: session.sessionId,
			reason: "move",
			moveId: MOVE,
			target: "device-b",
			export: { inline: true },
		});
		await a.settle();
		const givenBack = await move(a, {
			op: "finish",
			sessionPath: fixture.sessionPath,
			moveId: MOVE,
			answer: { state: "declined", reason: "cancelled" },
		});
		holder.send("stop\n");
		await holder.exit();

		const other = new SessionHeldError(fixture.sessionPath, [{ pid: holder.child.pid ?? 0, cwd: fixture.repoB }]);
		expect(released?.success).toBe(true);
		expect(exportOf({ ...released })).toEqual({ ok: false, error: "session_held", detail: other.message });
		expect(givenBack).toMatchObject({ success: false, errorCode: "session_held" });
		expect(detailOf(givenBack)).toBe(other.message);
	});
});
