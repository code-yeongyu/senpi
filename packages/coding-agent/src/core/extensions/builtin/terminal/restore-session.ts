/**
 * A session's persistence lifecycle across process restarts: take the per-session lease, restore
 * the persisted monitors on a detached promise (session_start never waits on a grace window), and
 * deliver ONE decided digest through a slot that holds it until a model is bound. A live foreign
 * holder defers everything: the footer says who holds the monitors, and a lease keeper takes the
 * session over the moment that process exits, running the same restore exactly once. Monitors
 * created while waiting are queued and reach the manifest after the takeover.
 */

import { existsSync } from "node:fs";
import { encodedSessionId } from "../../../session-sidecar-store.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { createRestartableCommandHandler } from "./durable-command.ts";
import { createCheckpointedFileRestoreHandler } from "./durable-file.ts";
import { createLeaseKeeper, type LeaseKeeper } from "./lease-keeper.ts";
import {
	type AcquireTerminalLeaseResult,
	acquireTerminalLease,
	type LeaseHolder,
	releaseTerminalLease,
	retireLeaseToken,
} from "./manifest-lease.ts";
import { removeMonitorStateDir, terminalStateDir } from "./monitor-state-dir.ts";
import { ownProcessStartedAtMs, processBootAtMs } from "./process-identity.ts";
import { type RestoreDigest, type RestoreHandler, reapplyPersistedMute, restoreTerminalState } from "./restore.ts";
import { buildRestoreDigest, createDigestSlot, type DigestSlot, deliverRestoreDigest } from "./restore-digest.ts";
import type { TerminalSessionBundle } from "./session-bundle.ts";
import { createTerminalManifestStore, TerminalManifestWriter } from "./terminal-manifest.ts";
import { sweepTerminalStateDir } from "./terminal-state-gc.ts";
import type { TerminalToolContext } from "./tools/context.ts";
import { bindTerminalManifestWriter, unbindTerminalManifestWriter } from "./tools/monitor.ts";

export const RESTORE_STATUS_KEY = "terminal-restore";

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Test-only timing overrides; production uses the modules' own defaults. */
export const restoreSessionTestHooks: { keeperIntervalMs?: number; graceMs?: number } = {};

export interface PersistenceState {
	ctx: ExtensionContext | undefined;
	readonly settings: { readonly notify: string };
	bundle: TerminalSessionBundle | null;
	lease: { path: string; pid: number; token: string } | null;
	manifestWriter: TerminalManifestWriter | null;
	ensurePersistence: (() => Promise<void>) | null;
	recordedBackgroundIds: Set<string>;
	keeper: LeaseKeeper | null;
	digestSlot: DigestSlot;
	generation: number;
	restoreInFlight: Promise<void>;
}

const decisions = new Map<string, { promise: Promise<void>; resolve: () => void }>();

function armDecision(sessionKey: string): () => void {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	decisions.set(sessionKey, { promise, resolve });
	return resolve;
}

/** Settles once this session's current generation has decided its restore (or had nothing to decide). */
export function whenRestoreDecided(sessionKey: string): Promise<void> {
	return decisions.get(sessionKey)?.promise ?? Promise.resolve();
}

export function flushRestoreDigest(pi: ExtensionAPI, state: PersistenceState): void {
	state.digestSlot.flush((message) => {
		// terminal.notify "off" keeps the model channel silent; the user still sees the digest.
		if (state.settings.notify !== "off") return deliverRestoreDigest(pi, state.ctx, message);
		state.ctx?.ui?.notify?.(message.content, "info");
		return true;
	});
}

function emptyDigest(): RestoreDigest {
	return {
		restored: 0,
		lost: 0,
		expired: 0,
		muted: 0,
		completed: 0,
		attachedElsewhere: 0,
		storeError: false,
		results: [],
		backgroundSessions: [],
		downtimeMs: 0,
	};
}

function restoreHandlers(state: PersistenceState, toolCtx: TerminalToolContext, bundle: TerminalSessionBundle) {
	const writer = state.manifestWriter;
	if (writer === null) throw new Error("restore handlers need the bound manifest writer");
	const registry = bundle.monitors;
	const adopting =
		(handler: RestoreHandler): RestoreHandler =>
		async (monitor, context) => {
			const result = await handler(monitor, context);
			// Only a LIVE entry is re-adopted, so the next persist keeps it and drops the rest.
			if (result.outcome === "restored" || result.outcome === "muted") {
				writer.adoptRestored(result.runtime === undefined ? monitor : { ...monitor, runtime: result.runtime });
				registry.adoptFireWindow(monitor.monitorId, monitor.fireWindow);
			}
			return result;
		};
	let freshFileRuntimeId: string | undefined;
	const checkpointedFile = createCheckpointedFileRestoreHandler({
		registry,
		writer,
		bindMonitorId: (monitorId, runtimeId) => {
			freshFileRuntimeId = runtimeId;
			bundle.manager.bindMonitorId(monitorId, runtimeId);
		},
	});
	return {
		"restartable-command": adopting(
			createRestartableCommandHandler({
				ctx: toolCtx,
				registry,
				...(restoreSessionTestHooks.graceMs !== undefined ? { graceMs: restoreSessionTestHooks.graceMs } : {}),
			}),
		),
		"checkpointed-file": adopting(async (monitor, context) => {
			freshFileRuntimeId = undefined;
			const result = await checkpointedFile(monitor, context);
			if (result.outcome !== "restored" || freshFileRuntimeId === undefined) return result;
			return { ...result, outcome: reapplyPersistedMute(registry, monitor, freshFileRuntimeId) };
		}),
	};
}

interface StartOptions {
	readonly pi: ExtensionAPI;
	readonly state: PersistenceState;
	readonly toolCtx: TerminalToolContext;
	readonly sessionKey: string;
}

/** Non-reload session_start (and a reload that does not hold the lease): take ownership or wait for it. */
export async function startPersistence({ pi, state, toolCtx, sessionKey }: StartOptions): Promise<void> {
	state.generation += 1;
	state.digestSlot = createDigestSlot();
	const decided = armDecision(sessionKey);
	const ctx = state.ctx;
	const dir = terminalStateDir(ctx);
	const sessionManager = ctx?.sessionManager;
	if (dir === undefined || sessionManager === undefined) return decided();
	const encoded = encodedSessionId(sessionKey);
	const generation = state.generation;

	const own = async (lease: AcquireTerminalLeaseResult & { acquired: true }): Promise<void> => {
		ctx?.ui?.setStatus?.(RESTORE_STATUS_KEY, undefined);
		state.lease = { path: lease.path, pid: lease.pid, token: lease.token };
		const writer = new TerminalManifestWriter({ session: sessionManager });
		state.manifestWriter = writer;
		state.recordedBackgroundIds.clear();
		const bundle = state.bundle;
		let restoredFromReadableManifest = false;
		if (bundle !== null && existsSync(writer.store.filePath)) {
			let digest: RestoreDigest;
			try {
				digest = await restoreTerminalState({
					manifest: writer.store,
					handlers: restoreHandlers(state, toolCtx, bundle),
					sessionFile: sessionManager.getSessionFile?.(),
					processStartedAtMs: ownProcessStartedAtMs(),
				});
			} catch (error) {
				// A restore that throws (an unreadable transcript, a kill error on a confirmed orphan)
				// still decides: the session hears it failed, and the lease stays bound for shutdown.
				ctx?.ui?.notify?.(`Terminal restore failed: ${errorText(error)}`, "warning");
				digest = { ...emptyDigest(), storeError: true };
			}
			// A watch that did not come back never runs again: its baseline dir goes with it.
			await Promise.all(
				digest.results
					.filter(
						(result) =>
							result.outcome === "lost" || result.outcome === "expired" || result.outcome === "completed",
					)
					.map((result) => removeMonitorStateDir(dir, result.monitorId)),
			);
			if (generation !== state.generation) return;
			restoredFromReadableManifest = !digest.storeError;
			if (digest.storeError || digest.results.length > 0 || digest.backgroundSessions.length > 0) {
				state.digestSlot.set(buildRestoreDigest(digest, { generation, outcome: "decided" }));
			}
		}

		// Bound AFTER the restore read the file: draining queued specs writes the manifest.
		bindTerminalManifestWriter(sessionKey, writer);
		// A corrupt manifest is left as it was (fail closed); a readable one is rewritten to the truth.
		if (restoredFromReadableManifest) await writer.persistRestored();
		state.ensurePersistence = null;
		const self = { pid: process.pid, bootAtMs: processBootAtMs(), processStartedAtMs: ownProcessStartedAtMs() };
		// Housekeeping only: a failed sweep leaves the files for the next start to reclaim.
		void sweepTerminalStateDir(dir, { self, keep: new Set([`${encoded}.lease`, `${encoded}.json`]) }).catch(
			() => undefined,
		);
		flushRestoreDigest(pi, state);
		decided();
	};

	const wait = (holder: LeaseHolder | null): void => {
		ctx?.ui?.setStatus?.(
			RESTORE_STATUS_KEY,
			holder === null ? "monitors waiting for the session lease" : `monitors held by pid ${holder.pid}`,
		);
		state.digestSlot.set(
			buildRestoreDigest(emptyDigest(), {
				generation,
				outcome: "deferred",
				...(holder === null ? {} : { holderPid: holder.pid }),
			}),
		);
		state.keeper?.stop();
		state.keeper = createLeaseKeeper({
			dir,
			encodedSessionId: encoded,
			...(restoreSessionTestHooks.keeperIntervalMs !== undefined
				? { intervalMs: restoreSessionTestHooks.keeperIntervalMs }
				: {}),
			onTakeover: (lease) => {
				state.restoreInFlight = own(lease);
				return state.restoreInFlight;
			},
			onError: (error) => {
				const waiting = state.keeper?.state === "waiting";
				ctx?.ui?.notify?.(
					`Terminal lease ${waiting ? "check failed, still waiting" : "takeover failed"}: ${errorText(error)}`,
					"warning",
				);
			},
		});
		state.keeper.start(holder);
	};

	const acquire = async (): Promise<void> => {
		// The lease kept changing (or the dir failed): never leave the session undecided; the keeper retries.
		const lease = await acquireTerminalLease({ dir, encodedSessionId: encoded }).catch((error: unknown) => {
			ctx?.ui?.notify?.(`Terminal lease not acquired yet, retrying: ${errorText(error)}`, "warning");
			return null;
		});
		if (lease === null) return wait(null);
		if (lease.acquired) {
			state.restoreInFlight = own(lease);
			return;
		}
		wait(lease.holder);
	};

	if (existsSync(createTerminalManifestStore(sessionManager).filePath)) return acquire();
	// Nothing to restore: the lease and the recorder wait for the first real registration.
	decided();
	let binding: Promise<void> | null = null;
	state.ensurePersistence = () => {
		binding ??= acquire().then(() => state.restoreInFlight);
		return binding;
	};
}

/** session_shutdown (not reload): stop waiting, finish any restore, suspend and flush, release. */
export async function stopPersistence(state: PersistenceState, sessionKey: string): Promise<void> {
	const keeper = state.keeper;
	keeper?.stop();
	state.keeper = null;
	// A tick in flight may still be acquiring (then releases) or taking over (then restores).
	await keeper?.settled();
	const lease = state.lease;
	state.lease = null;
	if (lease !== null) retireLeaseToken(lease.token);
	await state.restoreInFlight;
	const writer = state.manifestWriter;
	if (writer && state.bundle) await writer.observeMonitorState(state.bundle.monitors.snapshot());
	detachPersistence(state, sessionKey);
	if (writer) await writer.recordShutdown();
	if (lease !== null) await releaseTerminalLease(lease);
	decisions.get(sessionKey)?.resolve();
}

/** Detach the manifest recorder without writing (a reload keeps live state instead). */
export function detachPersistence(state: PersistenceState, sessionKey: string | undefined): void {
	state.manifestWriter = null;
	state.ensurePersistence = null;
	state.recordedBackgroundIds.clear();
	if (sessionKey !== undefined) unbindTerminalManifestWriter(sessionKey);
}
