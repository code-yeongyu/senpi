import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import {
	buildToolContext,
	type TerminalExtensionState,
} from "../../../src/core/extensions/builtin/terminal/extension-state.ts";
import * as rpcObserver from "../../../src/core/extensions/builtin/terminal/rpc-monitor-observer.ts";
import * as rpcTargets from "../../../src/core/extensions/builtin/terminal/rpc-monitor-targets.ts";
import { TerminalSessionBundle } from "../../../src/core/extensions/builtin/terminal/session-bundle.ts";
import { TerminalManifestWriter } from "../../../src/core/extensions/builtin/terminal/terminal-manifest.ts";
import {
	bindTerminalManifestWriter,
	unbindTerminalManifestWriter,
} from "../../../src/core/extensions/builtin/terminal/tools/monitor-manifest-binding.ts";
import { createRpcMonitor } from "../../../src/core/extensions/builtin/terminal/tools/monitor-rpc.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

interface CheckpointReader {
	dispatch(source: "record" | "lost"): void;
	verify(source: "record" | "lost"): Promise<void>;
	failNextCheckpoint(error: Error): void;
	dispose(): Promise<void>;
}

const readers = new Map<TerminalExtensionState, CheckpointReader>();

/** Real registry/watch/manifest path; only endpoint discovery and the observer transport are faked. */
export async function armRpcCheckpoint(state: TerminalExtensionState, pi: ExtensionAPI): Promise<void> {
	const sessionId = state.ctx?.sessionManager.getSessionId();
	if (sessionId === undefined) throw new Error("checkpoint fixture needs a session id");
	const dir = mkdtempSync(join(tmpdir(), "senpi-4711-rpc-checkpoint-"));
	const socket = join(dir, "host.sock");
	const bundle = new TerminalSessionBundle({});
	state.bundle = bundle;
	const session = { getSessionId: () => sessionId, getSessionDir: () => dir };
	const original = new TerminalManifestWriter({ session });
	const replacement = new TerminalManifestWriter({ session });
	let handlers: rpcObserver.RpcObserverHandlers | undefined;
	let monitorId: string | undefined;
	const originalCheckpoint = vi.spyOn(original, "scheduleRpcCheckpoint");
	const reader: CheckpointReader = {
		dispatch(source) {
			if (handlers === undefined) throw new Error("RPC observer did not connect");
			if (source === "record")
				handlers.record({ type: "session_status", sessionId: "watched-child", status: "idle", seq: 2 });
			else handlers.closed("host gone");
		},
		async verify(source) {
			await replacement.flush();
			expect(replacement.persistFailure).toBeUndefined();
			const saved = await replacement.store.read();
			expect(saved?.monitors.find((entry) => entry.monitorId === monitorId)?.rpcCheckpoint).toEqual(
				source === "record"
					? {
							hosts: { [socket]: { instanceId: "host-instance", generation: "1" } },
							statuses: { [`${socket}#watched-child`]: "idle" },
						}
					: { hosts: {}, statuses: {} },
			);
			expect(originalCheckpoint).not.toHaveBeenCalled();
			// Retirement must not kill the persistent watch or silently drop its checkpoint.
			expect(bundle.monitors.snapshot()).toHaveLength(1);
			await bundle.teardown();
		},
		failNextCheckpoint(error) {
			vi.spyOn(replacement, "scheduleRpcCheckpoint").mockImplementationOnce(() => {
				throw error;
			});
		},
		async dispose() {
			await bundle.teardown();
			await original.flush();
			await replacement.flush();
			unbindTerminalManifestWriter(sessionId);
			rmSync(dir, { recursive: true, force: true });
		},
	};
	readers.set(state, reader);
	bindTerminalManifestWriter(sessionId, original);
	vi.spyOn(rpcTargets, "endpointSockets").mockResolvedValue([socket]);
	vi.spyOn(rpcObserver, "openRpcObserver").mockImplementation(async (_socket, _subscription, callbacks) => {
		handlers = callbacks;
		return {
			subscribed: Promise.resolve({
				type: "response",
				success: true,
				data: {
					hostInstanceId: "host-instance",
					hostGeneration: "1",
					snapshot: [{ sessionId: "watched-child", status: "running" }],
				},
			}),
			close: () => {},
		};
	});
	const result = await createRpcMonitor(buildToolContext(pi, state), {
		description: "persistent RPC checkpoint",
		target: "children",
		persistent: true,
	});
	const id = result.details?.monitor_id;
	if (typeof id !== "string") throw new Error("monitor registration returned no stable id");
	monitorId = id;
	await original.flush();
	originalCheckpoint.mockClear();
	// Reload parks the same live watch, but the new generation binds a different writer.
	bundle.park();
	await replacement.seedFromDisk();
	bindTerminalManifestWriter(sessionId, replacement);
}

export async function fireRpcCheckpoint(
	state: TerminalExtensionState,
	source: "record" | "lost",
	error?: Error,
): Promise<void> {
	const reader = readers.get(state);
	if (reader === undefined) throw new Error("RPC checkpoint fixture was not armed");
	if (error) reader.failNextCheckpoint(error);
	reader.dispatch(source);
	await reader.verify(source);
}

export async function disposeRpcCheckpoints(): Promise<void> {
	for (const reader of readers.values()) await reader.dispose();
	readers.clear();
}
