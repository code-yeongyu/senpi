import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as leaseKeeper from "../../../src/core/extensions/builtin/terminal/lease-keeper.ts";
import * as manifestLease from "../../../src/core/extensions/builtin/terminal/manifest-lease.ts";
import { createDigestSlot } from "../../../src/core/extensions/builtin/terminal/restore-digest.ts";
import {
	type PersistenceState,
	startPersistence,
} from "../../../src/core/extensions/builtin/terminal/restore-session.ts";
import type { TerminalToolContext } from "../../../src/core/extensions/builtin/terminal/tools/context.ts";
import { StaleExtensionContextError } from "../../../src/core/extensions/stale-context-error.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import { createSessionGeneration } from "../terminal-restore-session-harness.ts";

const acquired = { acquired: true, path: "unused-test-lease", pid: 1, token: "test-token" } as const;
const foreign = { acquired: false, holder: { pid: 1, startedAtMs: 0 } } as const;

describe("#4711 deferred terminal persistence readers", () => {
	let dir: string | undefined;
	afterEach(() => {
		vi.restoreAllMocks();
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it.each(["acquired", "waiting", "acquire warning", "takeover", "keeper warning"] as const)(
		"%s stops on retirement and preserves unrelated context failures",
		async (phase) => {
			// #4711: the acquisition promise is the event gate. No clock or scheduling luck
			// determines whether the context retires before its continuation runs.
			for (const stale of [true, false]) {
				dir = mkdtempSync(join(tmpdir(), "senpi-4711-persistence-"));
				const generation = createSessionGeneration({
					cwd: dir,
					sessionDir: dir,
					sessionId: "context-retirement",
					mode: "rpc",
				});
				let failure: Error | undefined;
				const ctx = new Proxy(generation.ctx, {
					get(target, key, receiver) {
						if (failure) throw failure;
						return Reflect.get(target, key, receiver);
					},
				}) satisfies ExtensionContext;
				const state: PersistenceState = {
					ctx,
					settings: { notify: "wake" },
					bundle: null,
					lease: null,
					manifestWriter: null,
					ensurePersistence: null,
					recordedBackgroundIds: new Set(),
					keeper: null,
					digestSlot: createDigestSlot(),
					generation: 0,
					restoreInFlight: Promise.resolve(),
				};
				const gate = Promise.withResolvers<manifestLease.AcquireTerminalLeaseResult>();
				const acquire = vi.spyOn(manifestLease, "acquireTerminalLease").mockReturnValue(gate.promise);
				const stop = vi.fn();
				let callbacks: leaseKeeper.LeaseKeeperOptions | undefined;
				vi.spyOn(leaseKeeper, "createLeaseKeeper").mockImplementation((options) => {
					callbacks = options;
					return { state: "waiting", start: () => {}, stop, settled: () => Promise.resolve() };
				});
				await startPersistence({
					pi: generation.pi,
					state,
					sessionKey: "context-retirement",
					toolCtx: {} as TerminalToolContext,
				});
				const pending = state.ensurePersistence?.();
				expect(acquire).toHaveBeenCalledOnce();
				const keeperPhase = phase === "takeover" || phase === "keeper warning";
				if (keeperPhase) {
					gate.resolve(foreign);
					await pending;
					expect(callbacks).toBeDefined();
				}
				failure = stale
					? new StaleExtensionContextError("retired test generation")
					: new Error("unexpected persistence context failure");
				const result = Promise.resolve().then(async () => {
					if (phase === "takeover") await callbacks?.onTakeover(acquired);
					else if (phase === "keeper warning") callbacks?.onError?.(new Error("lease check failed"));
					else {
						if (phase === "acquire warning") gate.reject(new Error("lease acquire failed"));
						else gate.resolve(phase === "acquired" ? acquired : foreign);
						await pending;
					}
				});
				if (stale) {
					await expect(result).resolves.toBeUndefined();
					if (keeperPhase) expect(stop).toHaveBeenCalled();
					expect(state.digestSlot.pending()).toBeUndefined();
					expect(generation.sent).toEqual([]);
					if (phase === "acquired" || phase === "takeover")
						expect(state.lease).toEqual({ path: acquired.path, pid: acquired.pid, token: acquired.token });
				} else {
					await expect(result).rejects.toBe(failure);
				}
				vi.restoreAllMocks();
				rmSync(dir, { recursive: true, force: true });
				dir = undefined;
			}
		},
	);
});
