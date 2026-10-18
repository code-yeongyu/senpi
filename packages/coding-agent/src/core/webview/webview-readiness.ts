import { appendFileSync } from "node:fs";
import type { NativeWebView } from "./native-webview.ts";

/**
 * A Chrome-backed `Bun.WebView` is usable only once a navigation has attached a CDP session to its
 * target, and Bun reports that attach through nothing but the navigation settling. On Windows a
 * freshly launched Chrome sometimes never finishes it (senpi#2353), so the service drives each view's
 * first navigation itself, to `about:blank` (no network, nothing but the launch and the attach), and
 * replies to `create` only once it settled.
 */
export interface WebViewReadinessPolicy {
	/** How long the readiness navigation may take before the launch counts as stalled. */
	readonly attachBoundMs: number;
	/** Launches per view, the first included, before the stall is reported to the cell. */
	readonly launchAttempts: number;
}

// Healthy first navigations on windows-latest measured p95 3.4 s and at most 18 s (the first Chrome
// of a cold runner); two bounded launches fit inside the eval cell's 60 s default budget.
export const DEFAULT_READINESS: WebViewReadinessPolicy = { attachBoundMs: 20_000, launchAttempts: 2 };

export const READINESS_URL = "about:blank";

export type ReadinessEvent =
	| { readonly type: "ready"; readonly launch: number; readonly attachMs: number }
	| { readonly type: "stalled"; readonly phase: "cdp-target-attach"; readonly launch: number };

/** Appends one line per launch outcome to the file `SENPI_WEBVIEW_READINESS_LOG` names (CI diagnostics). */
export function readinessLogFromEnvironment(): ((event: ReadinessEvent) => void) | undefined {
	const path = process.env.SENPI_WEBVIEW_READINESS_LOG;
	if (!path) return undefined;
	return (event) => {
		const outcome =
			event.type === "ready"
				? `ready launch=${event.launch} attachMs=${event.attachMs}`
				: `stalled phase=${event.phase} launch=${event.launch} (Chrome retired)`;
		appendFileSync(path, `${new Date().toISOString()} pid=${process.pid} webview ${outcome}\n`);
	};
}

/** Appends one line per failed Chrome retirement to the same CI diagnostics file (senpi#2993). */
export function retireFailureLogFromEnvironment(): ((message: string) => void) | undefined {
	const path = process.env.SENPI_WEBVIEW_READINESS_LOG;
	if (!path) return undefined;
	return (message) => {
		appendFileSync(
			path,
			`${new Date().toISOString()} pid=${process.pid} webview retire-failed ${JSON.stringify(message)}\n`,
		);
	};
}

export class WebViewNotReadyError extends Error {
	readonly code = "ERR_WEBVIEW_NOT_READY";
	readonly phase = "cdp-target-attach";

	constructor(launches: number, policy: WebViewReadinessPolicy) {
		super(
			`Chrome-backed WebView never became ready: phase cdp-target-attach (Chrome did not attach a CDP session to the new view within ${policy.attachBoundMs} ms) on ${launches} launch(es); each stalled Chrome was retired`,
		);
		this.name = "WebViewNotReadyError";
	}
}

/** Resolves once the readiness bound of one launch is reached; `cancel` stops it when the launch settled first. */
export interface AttachDeadline {
	readonly reached: Promise<void>;
	cancel(): void;
}

export function timedDeadline(boundMs: number): AttachDeadline {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const reached = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, boundMs);
	});
	return { reached, cancel: () => clearTimeout(timer) };
}

/** Resolves the readiness navigation's duration once it settled, undefined when the deadline came first. */
export async function attachedWithin(view: NativeWebView, deadline: AttachDeadline): Promise<number | undefined> {
	const startedAt = performance.now();
	const bound = deadline.reached.then(() => undefined);
	// Bun throws synchronously for some invalid states; the async wrapper turns that into a rejection.
	const navigation = (async () => await view.navigate(READINESS_URL))().then(() =>
		Math.round(performance.now() - startedAt),
	);
	try {
		return await Promise.race([navigation, bound]);
	} finally {
		deadline.cancel();
		// A stalled navigation is abandoned; closing its view rejects it with nobody left waiting.
		navigation.catch(() => {});
	}
}
