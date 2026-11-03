import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

/** Real session bindings plus access to the extension event bus, not a simulated reducer. */
export async function createLifecycleHarness(options: HarnessOptions = {}) {
	let events: ExtensionAPI["events"] | undefined;
	const h = await createHarness({
		...options,
		extensionFactories: [
			...(options.extensionFactories ?? []),
			(pi) => {
				events = pi.events;
			},
		],
	});
	await h.session.bindExtensions({ mode: "rpc" });
	const bus = events;
	if (bus === undefined) throw new Error("The extension event bus must be bound");
	return { h, publish: (name: string, data: unknown) => bus.emit(name, data) };
}

export async function createBoundLifecycleHarness(options: HarnessOptions = {}): Promise<Harness> {
	const h = await createHarness(options);
	await h.session.bindExtensions({ mode: "rpc" });
	return h;
}

/** Subscribe before the triggering action; the timeout bounds failure without polling. */
export function nextSessionEvent(
	h: Pick<Harness, "session">,
	predicate: (event: AgentSessionEvent) => boolean,
	cancel?: AbortSignal,
): Promise<AgentSessionEvent> {
	return new Promise((resolve, reject) => {
		const timeout = AbortSignal.timeout(10_000);
		const signal = cancel ? AbortSignal.any([timeout, cancel]) : timeout;
		const unsubscribe = h.session.subscribe((event) => {
			if (!predicate(event)) return;
			unsubscribe();
			signal.removeEventListener("abort", abort);
			resolve(event);
		});
		const abort = () => {
			unsubscribe();
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

export async function runToAgentIdle<T>(h: Pick<Harness, "session">, action: () => Promise<T>): Promise<T> {
	const cancel = new AbortController();
	const idle = nextSessionEvent(h, (event) => event.type === "agent_idle", cancel.signal);
	try {
		const [, result] = await Promise.all([idle, Promise.resolve().then(action)]);
		return result;
	} finally {
		cancel.abort();
	}
}
