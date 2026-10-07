import type { Context, WarmPromptCacheOptions, WarmPromptCacheResult } from "@earendil-works/pi-ai";
import { vi } from "vitest";
import { createCacheKeepAliveExtension } from "../../src/core/extensions/builtin/cache-keepalive/index.ts";
import { PROMPT_CACHE_PREWARM_ENTRY_TYPE } from "../../src/core/extensions/builtin/cache-keepalive/prewarm-entry.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const SIGNAL_TIMEOUT_MS = 2_000;
const harnesses: Harness[] = [];

export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export async function within<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), SIGNAL_TIMEOUT_MS);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export interface WarmCall {
	readonly context: Context;
	readonly options: WarmPromptCacheOptions | undefined;
}

export async function createPrewarmHarness(
	warm: (call: WarmCall) => Promise<WarmPromptCacheResult>,
	options: { extensionFactories?: ExtensionFactory[]; models?: HarnessOptions["models"] } = {},
) {
	const warmCalled = deferred<WarmCall>();
	const harness = await createHarness({
		...(options.models ? { models: options.models } : {}),
		extensionFactories: [
			createCacheKeepAliveExtension({
				warmPromptCache: async (_model, context, options) => {
					const call = { context, options };
					warmCalled.resolve(call);
					return warm(call);
				},
				isPromptCachePrewarmModel: () => true,
			}),
			...(options.extensionFactories ?? []),
		],
	});
	harnesses.push(harness);
	// createAgentSession gives the agent the session id; the bare harness Agent has none.
	harness.agent.sessionId = harness.sessionManager.getSessionId();
	const entryAppended = deferred<{ customType: string; data: unknown }>();
	const appendCustomEntry = harness.sessionManager.appendCustomEntry.bind(harness.sessionManager);
	vi.spyOn(harness.sessionManager, "appendCustomEntry").mockImplementation((customType, data) => {
		const id = appendCustomEntry(customType, data);
		if (customType === PROMPT_CACHE_PREWARM_ENTRY_TYPE) entryAppended.resolve({ customType, data });
		return id;
	});
	return { harness, warmCalled: warmCalled.promise, entryAppended: entryAppended.promise };
}

export function cleanupPrewarmHarnesses(): void {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
}
