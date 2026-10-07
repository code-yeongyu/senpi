import { isQuotaExhaustionMessage } from "@earendil-works/pi-ai";
import { isBillingErrorMessage } from "./billing.ts";
import type { CircuitAdmission, FallbackCircuitAccess, ProbeToken } from "./circuit.ts";

/**
 * Non-retryable failures that still say the entry is unusable for everyone:
 * billing and account quota/budget exhaustion. Auth and request-shape rejections
 * are not outages and never open a circuit.
 */
export function isHealthExhaustionFailure(errorMessage: string | undefined): boolean {
	return isBillingErrorMessage(errorMessage) || isQuotaExhaustionMessage(errorMessage);
}

/**
 * One session's side of the shared breaker: at most one probe token, taken by
 * atomic admission before the session switches to (or starts on) an entry, and
 * given back on every terminal path - accepted, failed, aborted, or abandoned.
 */
export class CircuitProbes {
	private readonly circuits: FallbackCircuitAccess | undefined;
	private token: ProbeToken | undefined;

	constructor(circuits: FallbackCircuitAccess | undefined) {
		this.circuits = circuits;
	}

	isOpen(selector: string): boolean {
		return this.circuits?.isOpen(selector) ?? false;
	}

	governs(selector: string): boolean {
		return this.circuits?.governs(selector) ?? false;
	}

	admit(selector: string): CircuitAdmission["kind"] {
		const admission: CircuitAdmission = this.circuits?.admit(selector) ?? { kind: "closed" };
		if (admission.kind === "probe" && this.token?.selector !== selector) {
			this.release();
			this.token = admission.token;
		}
		return admission.kind;
	}

	holds(selector: string): boolean {
		return this.token?.selector === selector;
	}

	get probing(): string | undefined {
		return this.token?.selector;
	}

	noteFailure(selector: string, failure: { retryAfterMs?: number; errorMessage?: string }): void {
		this.circuits?.noteFailure(selector, failure);
		if (this.token?.selector === selector) this.token = undefined;
	}

	accept(selector: string): void {
		this.circuits?.close(selector);
		if (this.token?.selector === selector) this.token = undefined;
	}

	release(): void {
		if (this.token) this.circuits?.release(this.token);
		this.token = undefined;
	}

	releaseAll(): void {
		this.token = undefined;
		this.circuits?.releaseAll();
	}
}
