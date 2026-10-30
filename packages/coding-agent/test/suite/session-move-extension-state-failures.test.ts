/**
 * Extension state on the unhappy paths of a move (senpi#3681 review). A failing `session_move_import` handler keeps
 * the moved state for the next open instead of throwing it away; a hung `session_move_export` handler fails the
 * release within the handler budget and reopens admission; and a failed `move` release removes what it staged.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import {
	MOVED_STATE_RESTORED,
	outgoingStateDir,
	pendingMovedState,
} from "../../src/core/session-move/extension-state.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";
import { DEFAULT_SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS } from "../../src/core/settings-manager.ts";
import { SESSION_RELEASED_ENTRY_TYPE } from "../../src/modes/rpc/session-release.ts";
import { gatewayFixture } from "./rpc-release-gateway-fixture.ts";
import { heldTurn, nextEvent, startReleaseHost } from "./rpc-release-host-support.ts";
import { deferred, moveIn } from "./session-move-extension-state-support.ts";
import { customTypes } from "./session-move-fixture.ts";

const stagedAttempts = (sessionPath: string, moveId: string): string[] => {
	const root = outgoingStateDir(sessionPath, moveId as MoveId);
	return existsSync(root) ? readdirSync(root) : [];
};

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("a failing session_move_import handler (senpi#3681 review)", () => {
	it("#given an import handler that throws #when the moved-in session opens #then the state stays pending, the failure is reported, and the next open delivers it again", async () => {
		const imported: string[] = [];
		let failNext = true;
		const extension: ExtensionFactory = (pi) => {
			pi.on("session_move_import", async (event) => {
				if (failNext) {
					failNext = false;
					throw new Error("probe store is offline");
				}
				imported.push(readFileSync(join(event.dir, "probe", "state.json"), "utf8"));
			});
		};
		const reported = vi.spyOn(ExtensionRunner.prototype, "emitError");
		await using host = await startReleaseHost(extension);
		host.faux.setResponses([fauxAssistantMessage("seed reply")]);
		const { sessionPath, sessionId } = await host.open("import-fails");
		expect(await host.release(sessionId)).toMatchObject({ success: true });
		const pendingDir = moveIn(sessionPath, "move-61");

		const first = await host.attach(sessionPath);

		expect(first).toMatchObject({ success: true });
		expect(reported).toHaveBeenCalledWith(
			expect.objectContaining({ event: "session_move_import", error: "probe store is offline" }),
		);
		expect(customTypes(sessionPath)).not.toContain(MOVED_STATE_RESTORED);
		expect(existsSync(join(pendingDir, "probe", "state.json"))).toBe(true);
		expect(await pendingMovedState(sessionPath)).toMatchObject({ moveId: "move-61", dir: pendingDir });

		const reopenedId = (first.data as { sessionId: string }).sessionId;
		expect(
			await host.send({
				type: "release_session",
				id: "release-attached",
				sessionId: reopenedId,
				reason: "takeover",
				force: true,
			}),
		).toMatchObject({ success: true });
		expect(await host.attach(sessionPath)).toMatchObject({ success: true });

		expect(imported).toEqual(['{"tasks":3}\n']);
		expect(customTypes(sessionPath)).toContain(MOVED_STATE_RESTORED);
		expect(existsSync(pendingDir)).toBe(false);
	});
});

describe("a hung session_move_export handler (senpi#3681 review)", () => {
	it("#given an export handler that never returns #when a move release interrupts a turn #then it fails with release_failed at the handler budget, admission reopens, and the staged state is removed", async () => {
		const exportStarted = deferred();
		const hung = deferred();
		const gateway = gatewayFixture();
		const extension: ExtensionFactory = (pi) => {
			gateway.extension(pi);
			pi.on("session_move_export", async (event) => {
				mkdirSync(join(event.dir, "probe"), { recursive: true });
				exportStarted.resolve();
				await hung.promise;
			});
		};
		await using host = await startReleaseHost(extension);
		host.faux.setResponses([fauxAssistantMessage("seed reply"), heldTurn]);
		const { sessionId, sessionPath, session } = await host.open("export-hangs");
		const started = nextEvent(session, "agent_start");
		await host.send({ type: "prompt", id: "work", sessionId, message: "long work" });
		await started;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const replying = host.send({
				type: "release_session",
				id: "rel-move",
				sessionId,
				reason: "move",
				moveId: "move-62",
				target: "laptop",
				interrupt: true,
			});
			await exportStarted.promise;
			await vi.advanceTimersByTimeAsync(DEFAULT_SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS);
			const reply = await replying;

			expect(reply).toMatchObject({
				success: false,
				error: "release_failed",
				errorData: { detail: expect.stringContaining("timed out"), interrupted: true },
			});
		} finally {
			vi.useRealTimers();
			hung.resolve();
		}
		expect(readFileSync(sessionPath, "utf8")).not.toContain(SESSION_RELEASED_ENTRY_TYPE);
		expect(stagedAttempts(sessionPath, "move-62")).toEqual([]);
		expect(await host.send({ type: "wake", id: "w", sessionId, delivery_ids: ["after-hang"] })).toMatchObject({
			success: true,
			data: { admitted: [{ delivery_id: "after-hang" }] },
		});
	});
});

describe("a failed move release (senpi#3681 review)", () => {
	it("#given an export handler that writes part of its state and then throws #then the release fails and the staged folder is removed", async () => {
		const extension: ExtensionFactory = (pi) => {
			pi.on("session_move_export", async (event) => {
				mkdirSync(join(event.dir, "probe"), { recursive: true });
				writeFileSync(join(event.dir, "probe", "partial.json"), "{");
				throw new Error("probe state is locked");
			});
		};
		await using host = await startReleaseHost(extension);
		host.faux.setResponses([fauxAssistantMessage("seed reply")]);
		const { sessionId, sessionPath } = await host.open("export-partial");

		const reply = await host.send({
			type: "release_session",
			id: "rel-move",
			sessionId,
			reason: "move",
			moveId: "move-63",
			target: "laptop",
		});

		expect(reply).toMatchObject({ success: false, error: "release_failed" });
		expect(stagedAttempts(sessionPath, "move-63")).toEqual([]);
	});
});
