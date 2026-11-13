/**
 * senpi#6593: a `move_session` op `export` sent while the host that released the session is still stopping its
 * runtime. Refusing it `session_held` is right. Its `detail` must not name this host as another process to quit:
 * there is none, and the caller's next step is to send the export again.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionHeldError } from "../../src/core/session-hold-errors.ts";
import { cleanupIssue2184, spawnModuleChild, srcUrl } from "./regressions/issue-2184-support.ts";
import { opened } from "./rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { customTypes, devices, move } from "./rpc-move-session-support.ts";
import { startReleaseHost } from "./rpc-release-host-support.ts";
import { fileHoldLetGo, heldShutdown } from "./rpc-release-slow-teardown-support.ts";
import { SESSION_ID } from "./session-move-fixture.ts";

const MOVE = "move-export-while-stopping-1";
const NOT_EXPORTED_YET =
	"This session has not finished stopping on this host, so it was not exported. Send export again once it has stopped.";

// Ends the holder process of a test that failed before it stopped it, and takes the spy off the runtime.
afterEach(() => {
	cleanupIssue2184();
	vi.restoreAllMocks();
});

const exporting = (id: string, sessionPath: string) =>
	({ type: "move_session", id, op: "export", sessionPath, moveId: MOVE, target: "device-b" }) as const;

const detailOf = (refused: Record<string, unknown>) => (refused.errorData as { detail?: string } | undefined)?.detail;

describe("an export op sent while the releasing host's runtime is still stopping (senpi#6593)", () => {
	it("#given a session released for a move whose shutdown handler outlives the host's close grace #when its export is sent while that runtime is still stopping #then it is refused session_held in this host's own words and writes no bundle, and once the runtime has stopped the same export writes the bundle", async () => {
		const shutdown = heldShutdown();
		await using host = await startReleaseHost(shutdown.extension);
		const { sessionId, sessionPath } = await host.open("slow-teardown");
		const outgoing = join(dirname(sessionPath), "agent", "session-moves", "outgoing", MOVE);

		const letGo = fileHoldLetGo();
		try {
			const released = await host.send({
				type: "release_session",
				id: "release-move",
				sessionId,
				reason: "move",
				moveId: MOVE,
				target: "device-b",
			});
			const sealed = readFileSync(sessionPath, "utf8");
			const sealedTypes = customTypes(sessionPath);
			const early = await host.send(exporting("export-while-stopping", sessionPath));
			const bundleAfterEarly = existsSync(outgoing);
			const afterEarly = readFileSync(sessionPath, "utf8");
			shutdown.letGo();
			await letGo;
			const exported = await host.send(exporting("export", sessionPath));

			expect(shutdown.ran()).toBe(true);
			expect(released.success).toBe(true);
			expect(sealedTypes).toEqual(["session_released"]);
			expect(early).toMatchObject({ success: false, errorCode: "session_held" });
			expect(bundleAfterEarly).toBe(false);
			expect(afterEarly).toBe(sealed);
			expect(exported).toMatchObject({ success: true, data: { move_id: MOVE } });
			expect(existsSync(join(outgoing, "manifest.json"))).toBe(true);
			expect(detailOf(early)).toBe(NOT_EXPORTED_YET);
		} finally {
			shutdown.letGo();
		}
	});

	it("#given a session released for a move that another live process holds as well #when its export is sent #then it is refused session_held with the text that names that process, word for word, and writes no bundle", async () => {
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
		});
		await a.settle();
		const refused = await move(a, {
			op: "export",
			sessionPath: fixture.sessionPath,
			moveId: MOVE,
			target: "device-b",
		});
		const bundleWritten = existsSync(join(fixture.agentA, "session-moves", "outgoing", MOVE));
		holder.send("stop\n");
		await holder.exit();

		const other = new SessionHeldError(fixture.sessionPath, [{ pid: holder.child.pid ?? 0, cwd: fixture.repoB }]);
		expect(released?.success).toBe(true);
		expect(refused).toMatchObject({ success: false, errorCode: "session_held" });
		expect(detailOf(refused)).toBe(other.message);
		expect(bundleWritten).toBe(false);
	});
});
