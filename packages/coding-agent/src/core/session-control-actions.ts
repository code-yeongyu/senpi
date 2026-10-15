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

export interface ControlEndpointHost {
	register(options: RegisterControlEndpointOptions): Promise<SessionControlRegistration>;
}

export interface SessionControlActionDeps {
	readonly admission: ExternalAdmission;
	readonly sessionManager: SessionManager;
	readonly host: () => ControlEndpointHost | undefined;
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
			if (process.platform === "win32") return { status: "unsupported", reason: "unsupported_platform" };
			const host = deps.host();
			if (host === undefined) return { status: "unsupported", reason: "unsupported_mode" };
			const registration = await host.register(options);
			if (registration.status !== "registered") return registration;
			// Registered while this generation was being retired: it is released at once, never left serving.
			if (retired) {
				await registration.dispose();
				return { status: "failed", reason: "stale extension generation after reload" };
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
	};
}
