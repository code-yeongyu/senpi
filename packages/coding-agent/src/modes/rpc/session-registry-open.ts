import { runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { createAgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { ClientAdmissions } from "./client-admissions.ts";
import { EffectLedger } from "./effect-ledger.ts";

import { assertRequestedModelResolved } from "./open-session-model.ts";

import { canonicalSessionPath } from "./session-path-key.ts";
import { attachToOpenSession } from "./session-registry-attach.ts";
import {
	type PendingClaims,
	settleClosingReservation,
	settlePendingClaim,
	takeCrossGenerationClaim,
} from "./session-registry-claims.ts";
import { resolveMovedProfile } from "./session-registry-moved-path.ts";
import { buildOpeningEntry, type OpeningEntry } from "./session-registry-opening.ts";
import {
	type OpenRpcSession,
	type RpcSessionEntry,
	type RpcSessionLaunchProfile,
	type RpcSessionOpenOptions,
	RpcSessionRegistryError,
	type RpcSessionRegistryOptions,
} from "./session-registry-types.ts";
import { releaseWithinGrace, type SessionTeardownHost } from "./session-teardown.ts";
export interface RegistryOpenPort {
	readonly entries: Map<string, RpcSessionEntry>;
	readonly reservations: Set<string>;
	readonly pendingClaims: PendingClaims;
	readonly options: RpcSessionRegistryOptions;
	readonly teardownHost: SessionTeardownHost;
	readonly closeGraceMs: number;
	now(): number;
	nextHandle(): string;
	validateProfile(profile: RpcSessionLaunchProfile): void;
	syncRuntimeMetadata(): void;
}
export async function openRegistrySession(
	host: RegistryOpenPort,
	requested: RpcSessionLaunchProfile,
	options?: RpcSessionOpenOptions,
): Promise<OpenRpcSession> {
	host.validateProfile(requested);
	const profile = resolveMovedProfile(requested);
	host.syncRuntimeMetadata();
	const sessionPath = profile.sessionPath ? canonicalSessionPath(profile.sessionPath) : undefined;
	// Taken SYNCHRONOUSLY, before any await, exactly like the path reservation below: a
	// concurrent open naming the same durable id must find this one already recorded rather
	// than a window between the decision and the record of it. Two LIVE sessions may never
	// share a durable id - every per-session artifact a client keys by it would collide.
	// Re-opening the SAME file is an attach/resume, not a collision: the id is the file's own.
	const requestedDurableId = profile.durableSessionId;
	if (requestedDurableId !== undefined) {
		for (const entry of host.entries.values()) {
			if (entry.state === "closed") continue;
			if (entry.durableSessionId !== requestedDurableId) continue;
			if (sessionPath !== undefined && entry.reservationKey === sessionPath) continue;
			throw new RpcSessionRegistryError("session_id_in_use");
		}
	}
	if (sessionPath) {
		await settleClosingReservation(host.entries.values(), sessionPath, host.closeGraceMs);
		// Re-checked right before the reservation decision, with no await in between: a waiter woken
		// by a FAILED claim must see the next open's claim, not a bare reservation (senpi#3485 review).
		const deadline = Date.now() + host.closeGraceMs;
		while (host.pendingClaims.has(sessionPath))
			await settlePendingClaim(host.pendingClaims, sessionPath, Math.max(0, deadline - Date.now()));
	}
	if (sessionPath && host.reservations.has(sessionPath)) {
		return attachToOpenSession(
			host.entries,
			sessionPath,
			profile,
			options,
			host.options.pathReservations,
			host.now(),
		);
	}
	if (options?.attachOnly)
		throw new RpcSessionRegistryError("session_not_held", undefined, {
			reason: "session_not_held",
			action: "rediscover_holder",
		});
	let claimSettled: (() => void) | undefined;
	if (sessionPath) {
		// Taken SYNCHRONOUSLY, before any await: a concurrent open for the same path must find the
		// reservation already held, not a window between the decision and the record of it.
		host.reservations.add(sessionPath);
		// Another generation of this daemon may still be writing this file. Its claim is the only
		// thing this process can see across a handoff, and a live one means "retry", not "gone".
		// Only AWAIT when there is a cross-generation claim to take: `await undefined` still costs a
		// microtask, and an embedded registry (no second generation) must reach the "opening" entry
		// in the same tick a caller that raced it would look, exactly as it did before generations.
		// A concurrent open of this path waits on `claimSettled` instead of finding a reservation no
		// entry backs (senpi#3485); it is settled once the entry is recorded or the reservation is back.
		if (host.options.pathReservations)
			claimSettled = await takeCrossGenerationClaim(
				host.reservations,
				host.pendingClaims,
				host.options.pathReservations,
				sessionPath,
			);
	}

	const handle = host.nextHandle();
	let opening: OpeningEntry;
	try {
		opening = buildOpeningEntry({
			profile,
			sessionPath,
			requestedDurableId,
			options,
			now: host.now(),
			createRuntime: host.options.createRuntime,
			sync: () => host.syncRuntimeMetadata(),
		});
	} catch (cause) {
		// Give the path back before waking waiters, or they find a reservation no entry backs. A failed
		// claim release is reported, never allowed to strand the waiters or replace the build error.
		try {
			if (sessionPath) {
				host.reservations.delete(sessionPath);
				await host.options.pathReservations?.release(sessionPath);
			}
		} catch (releaseCause) {
			process.stderr.write(
				`senpi rpc open of ${sessionPath} could not release its claim: ${String(releaseCause)}\n`,
			);
		} finally {
			claimSettled?.();
		}
		throw cause;
	}
	const { entry, storedProfile, runtimeProfile, sessionStartEvent, settleOpen } = opening;
	host.entries.set(handle, entry);
	claimSettled?.();
	host.options.onSizeChange?.(host.entries.size);
	try {
		const newSessionOptions = {
			...(requestedDurableId !== undefined ? { id: requestedDurableId } : {}),
			...(storedProfile.spawnedBy ? { spawnedBy: storedProfile.spawnedBy } : {}),
		};
		const manager = sessionPath
			? host.options.sessionFileLoad === "blocking"
				? SessionManager.open(sessionPath, undefined, storedProfile.cwd, newSessionOptions)
				: await SessionManager.openAsync(
						sessionPath,
						undefined,
						storedProfile.cwd,
						newSessionOptions,
						host.options.createSlicer?.(),
					)
			: SessionManager.create(storedProfile.cwd, undefined, newSessionOptions);
		entry.runtime = await runWithProviderScope(entry.scope, () =>
			createAgentSessionRuntime(host.options.createRuntime, {
				cwd: manager.getCwd(),
				agentDir: host.options.agentDir,
				sessionManager: manager,
				sessionStartEvent,
				launchProfile: runtimeProfile,
			}),
		);
		assertRequestedModelResolved(runtimeProfile, entry.runtime.diagnostics);
		ClientAdmissions.sealQueuedOnReplace(entry.runtime);
		EffectLedger.sealOnReplace(entry.runtime);
		entry.durableSessionId = manager.getSessionId();
		entry.sessionPath ??= manager.getSessionFile();
		entry.state = "open";
		settleOpen.resolve();
		return { sessionId: handle, durableSessionId: entry.durableSessionId, sessionPath: entry.sessionPath };
	} catch (error) {
		// Runtime construction may have started extensions, watchers, and provider
		// registrations before it rejects. Keep the reservation and entry private
		// until all of those resources have been torn down, then release them as
		// one rollback so the path can immediately be opened again.
		try {
			await entry.runtime?.dispose();
		} catch {
			// The original construction error remains the externally visible cause.
		} finally {
			try {
				await entry.scope.close?.();
			} finally {
				host.entries.delete(handle);
				host.options.onSizeChange?.(host.entries.size);
				if (sessionPath) await releaseWithinGrace(host.teardownHost, handle, sessionPath);
			}
		}
		if (error instanceof RpcSessionRegistryError) {
			settleOpen.reject(error);
			throw error;
		}
		const wrapped = new RpcSessionRegistryError("open_failed", error instanceof Error ? error.message : undefined);
		settleOpen.reject(wrapped);
		throw wrapped;
	}
}
