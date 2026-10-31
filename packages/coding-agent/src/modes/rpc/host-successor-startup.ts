/** RED baseline (senpi#4602): today's successor readiness - presenter relayed at spawn, 30 s public wait, no grant. */
import type { HostProtocolInfo } from "./host-decision.ts";
import type { StartupController, StartupOutcome } from "./host-startup-policy.ts";

export type PresenterResult = "enrolled" | "unavailable" | "closed";

export interface SuccessorAttempt {
	readonly controller: StartupController;
	readonly coordinated: boolean;
	grant(): Promise<void>;
}

export type SuccessorStartupResult =
	| { readonly ready: true; readonly answer: HostProtocolInfo }
	| { readonly ready: false; readonly outcome: Exclude<StartupOutcome, { readonly kind: "ready" }> };

export async function driveSuccessorStartup(options: {
	readonly attempt: SuccessorAttempt;
	readonly presenter: (() => Promise<PresenterResult>) | undefined;
	readonly awaitAnswer: (budgetMs: number) => Promise<HostProtocolInfo | undefined>;
}): Promise<SuccessorStartupResult> {
	const presenter = options.presenter?.();
	const answer = await options.awaitAnswer(30_000);
	await presenter;
	if (answer) return { ready: true, answer };
	return {
		ready: false,
		outcome: { kind: "failed", phase: "public_verified", cause: new Error("no answer"), elapsedMs: 0 },
	};
}

export function predecessorOwnerArgs(_host: HostProtocolInfo): string[] {
	return [];
}
