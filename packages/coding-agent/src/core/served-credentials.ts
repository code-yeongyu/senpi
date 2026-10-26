import { createHash } from "node:crypto";
import { type AssistantMessage, sanitizeProviderDiagnostic } from "@earendil-works/pi-ai";

/** How long a served response vouches for its credential (senpi#2491). */
export const CREDENTIAL_SERVED_WINDOW_MS = 10 * 60_000;
const MAX_SERVED_CREDENTIALS = 1_024;

export interface RequestCredential {
	readonly provider: string;
	readonly baseUrl: string | undefined;
	readonly apiKey: string | undefined;
}

/**
 * When each credential last served a response, keyed by a one-way hash of provider, endpoint and key so no
 * key material is held. An `auth` failure on a credential that served within the window is marked on its
 * message: a gateway refused that request while the key kept working for others (senpi#2491).
 * Without an apiKey (headers, ADC or SigV4), identity reduces to provider + baseUrl.
 */
export class ServedCredentials {
	private readonly servedAt = new Map<string, number>();
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/**
	 * Reads the request's final message before any consumer does: the result promise settles them in order.
	 * Resolves once the observation is recorded; callers on the request path do not wait for it.
	 */
	observe(result: Promise<AssistantMessage | undefined>, credential: RequestCredential): Promise<void> {
		const key = credentialKey(credential);
		return result.then((message) => this.settle(key, message), ignoreFailedRequest);
	}

	private settle(key: string, message: AssistantMessage | undefined): void {
		// An extension-provided stream may settle without a final message; that proves nothing about the credential.
		if (message === undefined) return;
		const now = this.now();
		for (const [recordedKey, servedAt] of this.servedAt) {
			if (now - servedAt > CREDENTIAL_SERVED_WINDOW_MS) this.servedAt.delete(recordedKey);
		}
		if (message.stopReason !== "error" && message.stopReason !== "aborted") {
			// Map insertion order tracks last success, not last failed check.
			this.servedAt.delete(key);
			this.servedAt.set(key, now);
			if (this.servedAt.size > MAX_SERVED_CREDENTIALS) {
				const oldest = this.servedAt.keys().next().value;
				if (oldest !== undefined) this.servedAt.delete(oldest);
			}
			return;
		}
		const servedAt = this.servedAt.get(key);
		if (
			message.stopReason === "error" &&
			servedAt !== undefined &&
			sanitizeProviderDiagnostic(message.providerDiagnostic)?.category === "auth"
		) {
			message.credentialServedRecently = true;
		}
	}
}

/** A request whose stream failed outright proves nothing about its credential; its consumer owns the error. */
function ignoreFailedRequest(): void {}

function credentialKey(credential: RequestCredential): string {
	return createHash("sha256")
		.update(`${credential.provider}\0${credential.baseUrl ?? ""}\0${credential.apiKey ?? ""}`)
		.digest("hex");
}
