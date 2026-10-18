/**
 * The "opening" entry an `openSession` records once its path is reserved and claimed. Built in one
 * synchronous step so the registry can give the reservation back if building it throws, instead of
 * leaving a reserved path no entry backs (senpi#3485).
 */
import { existsSync } from "node:fs";
import { ProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import type { SessionStartEvent } from "../../core/extensions/types.ts";
import type { PreparableRuntimeFactory } from "./host-warm.ts";
import { createEntrySwitchSession } from "./session-registry-switch.ts";
import {
	frozenProfile,
	type RpcSessionEntry,
	type RpcSessionLaunchProfile,
	type RpcSessionOpenOptions,
	sessionIdentity,
} from "./session-registry-types.ts";

export interface OpeningEntry {
	readonly entry: RpcSessionEntry;
	readonly storedProfile: RpcSessionLaunchProfile;
	readonly runtimeProfile: RpcSessionLaunchProfile;
	readonly sessionStartEvent: SessionStartEvent | undefined;
	readonly settleOpen: { readonly resolve: () => void; readonly reject: (cause: unknown) => void };
}

export function buildOpeningEntry(input: {
	readonly profile: RpcSessionLaunchProfile;
	readonly sessionPath: string | undefined;
	readonly requestedDurableId: string | undefined;
	readonly options: RpcSessionOpenOptions | undefined;
	readonly now: number;
	readonly createRuntime: PreparableRuntimeFactory;
	readonly sync: () => void;
}): OpeningEntry {
	const { profile, sessionPath, requestedDurableId, options } = input;
	// Resume vs create parity (D1 + omo SenpiSessionRuntime.ts:198-200):
	// Create-only launch semantics mirror classic startup flags. A resumed
	// session restores its persisted model and thinking level instead of being
	// overridden by the new open_session request.
	const isResume = sessionPath !== undefined && existsSync(sessionPath);
	// Re-opening an existing session file is a resume, exactly like interactive
	// /resume (AgentSessionRuntime.switchSession). Without the event the session
	// starts with reason "startup" and every extension that only rebuilds state
	// on a resume - the ask-user dangling-question hook - stays unreachable from
	// the RPC restart path. A session created by this open stays "startup".
	const sessionStartEvent: SessionStartEvent | undefined = isResume
		? { type: "session_start", reason: "resume" }
		: undefined;
	const storedProfile = frozenProfile({ ...profile, ...(sessionPath ? { sessionPath } : {}) });
	const runtimeProfile = isResume
		? frozenProfile({ ...storedProfile, creationModel: undefined, initialThinkingLevel: undefined })
		: storedProfile;
	let settleOpen!: { resolve: () => void; reject: (cause: unknown) => void };
	const openCompletion = new Promise<void>((resolve, reject) => {
		settleOpen = { resolve, reject };
	});
	// A concurrent explicit open for the same path waits on this to attach, never to time it out.
	openCompletion.catch(() => {});
	const entry: RpcSessionEntry = {
		state: "opening",
		scope: new ProviderScope(),
		profile: storedProfile,
		...sessionIdentity(storedProfile),
		sessionPath,
		reservationKey: sessionPath,
		cwd: storedProfile.cwd,
		attachments: 1,
		retainOnDisconnect: options?.retainOnDisconnect === true,
		lastCommandAt: input.now,
		lifecycleMutex: Promise.resolve(),
		openCompletion,
	};
	entry.switchSession = createEntrySwitchSession(entry, input.createRuntime, input.sync);
	// Recorded before the first await so the synchronous collision guard sees an open that is still
	// being built. `manager.getSessionId()` overwrites it later with the authoritative value, which on
	// a resume is the header's id, not the requested one.
	if (requestedDurableId !== undefined) entry.durableSessionId = requestedDurableId;
	return { entry, storedProfile, runtimeProfile, sessionStartEvent, settleOpen };
}
