/**
 * Move handlers that outlive their budget (senpi#3681 delta review). A handler past the cap sees its signal aborted
 * and a warning is logged before that; whatever it writes later lands only in its own attempt's folder, so a retry of
 * the same move never bundles it and a redelivered import still gets the state intact, marked `redelivered`.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { readManifest } from "../../src/core/session-move/bundle.ts";
import { restoreMovedState } from "../../src/core/session-move/extension-state.ts";
import { DEFAULT_SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS } from "../../src/core/settings-manager.ts";
import { startReleaseHost } from "./rpc-release-host-support.ts";
import { deferred, moveIn } from "./session-move-extension-state-support.ts";
import { root, writeSession } from "./session-move-fixture.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const moveRelease = (sessionId: string, id: string) =>
	({ type: "release_session", id, sessionId, reason: "move", moveId: "move-91", target: "laptop" }) as const;

describe("an export handler past its budget (senpi#3681 delta review)", () => {
	it("#given an export handler that times out and writes afterwards #when the same move is released again and exported #then its signal was aborted, a stall was warned, and the bundle holds only the retry's state", async () => {
		const firstStarted = deferred();
		const late = deferred();
		const staleWritten = deferred();
		let calls = 0;
		let firstSignal: AbortSignal | undefined;
		const extension: ExtensionFactory = (pi) => {
			pi.on("session_move_export", async (event) => {
				calls += 1;
				mkdirSync(join(event.dir, "probe"), { recursive: true });
				if (calls > 1) {
					writeFileSync(join(event.dir, "probe", "state.json"), '{"tasks":3}\n');
					return;
				}
				firstSignal = event.signal;
				firstStarted.resolve();
				await late.promise;
				mkdirSync(join(event.dir, "probe"), { recursive: true });
				writeFileSync(join(event.dir, "probe", "stale.json"), '{"tasks":"stale"}\n');
				staleWritten.resolve();
			});
		};
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await using host = await startReleaseHost(extension);
		host.faux.setResponses([fauxAssistantMessage("seed reply")]);
		const { sessionId, sessionPath } = await host.open("export-retry");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const replying = host.send(moveRelease(sessionId, "rel-1"));
			await firstStarted.promise;
			await vi.advanceTimersByTimeAsync(DEFAULT_SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS);
			expect(await replying).toMatchObject({ success: false, error: "release_failed" });
		} finally {
			vi.useRealTimers();
		}
		expect(firstSignal?.aborted).toBe(true);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("session_move_export handler"));

		expect(await host.send(moveRelease(sessionId, "rel-2"))).toMatchObject({ success: true });
		late.resolve();
		await staleWritten.promise;
		const exported = await host.send({
			type: "move_session",
			id: "exp",
			op: "export",
			sessionPath,
			moveId: "move-91",
			target: "laptop",
		});

		expect(exported).toMatchObject({ success: true });
		const bundleDir = (exported.data as { bundle_dir: string }).bundle_dir;
		expect(
			(await readManifest(bundleDir)).payloads.flatMap((payload) => payload.files.map((file) => file.path)),
		).toEqual(["state/probe/state.json"]);
	});
});

describe("an import handler that outlives its attempt (senpi#3681 delta review)", () => {
	it("#given an import attempt that fails and its handler later changes its folder #when the state is delivered again #then the next attempt gets it intact and marked redelivered", async () => {
		const sessionFile = writeSession(join(root(), "repo"));
		moveIn(sessionFile, "move-92");
		const seen: { dir: string; redelivered: boolean }[] = [];

		await restoreMovedState(SessionManager.open(sessionFile), async (event) => {
			seen.push({ dir: event.dir, redelivered: event.redelivered });
			return false;
		});
		const firstDir = seen[0]?.dir ?? "";
		rmSync(join(firstDir, "probe", "state.json"), { force: true });
		mkdirSync(join(firstDir, "probe"), { recursive: true });
		writeFileSync(join(firstDir, "probe", "state.json"), '{"tasks":"half-applied"}\n');
		let restored = "";
		await restoreMovedState(SessionManager.open(sessionFile), async (event) => {
			seen.push({ dir: event.dir, redelivered: event.redelivered });
			restored = readFileSync(join(event.dir, "probe", "state.json"), "utf8");
			return true;
		});

		expect(restored).toBe('{"tasks":3}\n');
		expect(seen.map((attempt) => attempt.redelivered)).toEqual([false, true]);
	});
});
