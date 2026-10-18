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

export function createSessionControlActions(deps: SessionControlActionDeps): SessionControlActions {
	return {
		registerControlEndpoint: async (options) => {
			if (process.platform === "win32") return { status: "unsupported", reason: "unsupported_platform" };
			const host = deps.host();
			if (host === undefined) return { status: "unsupported", reason: "unsupported_mode" };
			return host.register(options);
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
