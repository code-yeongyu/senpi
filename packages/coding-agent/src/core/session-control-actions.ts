/**
 * `pi.session` as one session binds it: admission and the ledger come from the session's own
 * `ExternalAdmission`, the header write from its `SessionManager`, and the control endpoint from
 * whichever host the running mode installed. Only the interactive TUI installs one; every other
 * mode answers `unsupported` and registers nothing.
 */

import type {
	RegisterControlEndpointOptions,
	SessionControlActions,
	SessionControlRegistration,
} from "./extensions/session-control-types.ts";
import type { ExternalAdmission } from "./external-admission.ts";
import type { SessionManager } from "./session-manager.ts";
import { RELOCATION_NOT_OFFERED, type SessionRelocationHost } from "./session-relocation.ts";
import type { SessionWakePort } from "./session-wakes.ts";

export interface ControlEndpointHost {
	register(options: RegisterControlEndpointOptions): Promise<SessionControlRegistration>;
}

export interface SessionControlActionDeps {
	readonly admission: ExternalAdmission;
	readonly sessionManager: SessionManager;
	readonly host: () => ControlEndpointHost | undefined;
	readonly relocationHost: () => SessionRelocationHost | undefined;
}

/** One extension generation's `pi.session`, which owns the control endpoints that generation registered. */
export interface GenerationSessionControlActions extends SessionControlActions {
	/**
	 * Disposes every endpoint this generation registered. A reload calls it as it retires the
	 * generation: the endpoint's `drain` is that generation's closure, so it must not outlive it
	 * (senpi#3246). Idempotent.
	 */
	retire(): Promise<void>;
}

export function createSessionControlActions(deps: SessionControlActionDeps): GenerationSessionControlActions {
	const owned = new Set<Extract<SessionControlRegistration, { readonly status: "registered" }>>();
	let retired = false;
	return {
		registerControlEndpoint: async (options) => {
			const host = deps.host();
			if (host === undefined) return { status: "unsupported", reason: "unsupported_mode" };
			// The endpoint may run a pass before this registration returns (its first `inbox` wake): a retired
			// generation's `drain` is never called, whatever the timing.
			const registration = await host.register({
				...options,
				drain: async (event) => (retired ? undefined : options.drain(event)),
			});
			if (registration.status !== "registered") return registration;
			// Registered while this generation was being retired: it is released at once, never left serving.
			if (retired) {
				const teardown = await registration.dispose().then(
					() => "",
					(error: unknown) => `; its teardown failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				return { status: "failed", reason: `stale extension generation after reload${teardown}` };
			}
			owned.add(registration);
			return {
				...registration,
				dispose: async () => {
					owned.delete(registration);
					await registration.dispose();
				},
			};
		},
		retire: async () => {
			retired = true;
			const registrations = [...owned];
			owned.clear();
			await Promise.all(registrations.map((registration) => registration.dispose()));
		},
		admissionGate: () => deps.admission.gate(),
		admitExternalMessage: (input) => deps.admission.admit(input),
		listAdmittedDeliveries: () => deps.admission.list(),
		persistHeaderNow: () => deps.sessionManager.persistHeaderNow(),
		relocationOffered: () => deps.relocationHost()?.offered() ?? false,
		relocationTargets: async (signal) => (await deps.relocationHost()?.targets(signal)) ?? RELOCATION_NOT_OFFERED,
		requestRelocation: async (request, signal) =>
			(await deps.relocationHost()?.request(request, signal)) ?? RELOCATION_NOT_OFFERED,
		// A session in this process keeps its own timers and schedule jobs.
		sessionWakes: () => undefined,
	};
}

/** What a runtime without a session reaches of the session whose call it is running (session port, senpi#6754). */
export interface CallSessionControl {
	relocationHost(): SessionRelocationHost | undefined;
	sessionWakes(): SessionWakePort | undefined;
}

/**
 * `pi.session` for a runtime without a session (a hand's loopless runtime): relocation and wakes answer for the loop
 * session whose call is running, when the loop carried them; every other member stays unbound.
 */
export function callSessionControlActions(call: () => CallSessionControl | undefined): SessionControlActions {
	return {
		...unboundSessionControlActions(),
		relocationOffered: () => call()?.relocationHost()?.offered() ?? false,
		relocationTargets: async (signal) => (await call()?.relocationHost()?.targets(signal)) ?? RELOCATION_NOT_OFFERED,
		requestRelocation: async (request, signal) =>
			(await call()?.relocationHost()?.request(request, signal)) ?? RELOCATION_NOT_OFFERED,
		sessionWakes: () => call()?.sessionWakes(),
	};
}

export function unboundSessionControlActions(): SessionControlActions {
	const notBound = (): never => {
		throw new Error("Extension runtime not initialized. pi.session cannot be used during extension loading.");
	};
	return {
		registerControlEndpoint: () => Promise.reject(new Error("Extension runtime not initialized")),
		admissionGate: notBound,
		admitExternalMessage: notBound,
		listAdmittedDeliveries: notBound,
		persistHeaderNow: () => Promise.reject(new Error("Extension runtime not initialized")),
		relocationOffered: notBound,
		relocationTargets: () => Promise.reject(new Error("Extension runtime not initialized")),
		requestRelocation: () => Promise.reject(new Error("Extension runtime not initialized")),
		sessionWakes: notBound,
	};
}
