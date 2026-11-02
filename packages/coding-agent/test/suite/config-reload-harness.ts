import { resolve } from "node:path";
import { vi } from "vitest";
import configReloadExtension, { DEFAULT_DEBOUNCE_MS } from "../../src/core/extensions/builtin/config-reload/index.ts";
import type { WatchEventListener } from "../../src/core/extensions/builtin/config-reload/watch-engine.ts";
import type { ExtensionFactory } from "../../src/index.ts";
import { createHarness, type HarnessOptions } from "./harness.ts";

type ConfigReloadHarness = {
	readonly harness: Awaited<ReturnType<typeof createHarness>>;
	readonly reloads: readonly boolean[];
	readonly notify: (path: string, filename: string) => Promise<void>;
};

export async function createConfigReloadHarness(
	agentDir: string,
	extension?: ExtensionFactory,
	harnessOptions: Pick<HarnessOptions, "api"> = {},
): Promise<ConfigReloadHarness> {
	const listeners = new Map<string, Set<WatchEventListener>>();
	const reloads: boolean[] = [];
	const harness = await createHarness({
		...harnessOptions,
		extensionFactories: [
			(pi) =>
				configReloadExtension(pi, {
					agentDir,
					subscribe: (path, listener) => {
						const subscribers = listeners.get(path) ?? new Set<WatchEventListener>();
						subscribers.add(listener);
						listeners.set(path, subscribers);
						return () => {
							subscribers.delete(listener);
						};
					},
				}),
			...(extension ? [extension] : []),
		],
	});
	await harness.session.bindExtensions({
		mode: "tui",
		commandContextActions: {
			waitForIdle: () => harness.session.waitForIdle(),
			newSession: async () => ({ cancelled: false }),
			fork: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: false }),
			editAssistantMessage: async () => ({ cancelled: false }),
			editUserMessage: async () => ({ cancelled: false }),
			switchSession: async () => ({ cancelled: false }),
			reload: async () => {
				reloads.push(harness.session.isIdle);
			},
		},
	});
	return {
		harness,
		reloads,
		async notify(path: string, filename: string) {
			for (const listener of listeners.get(resolve(path)) ?? []) listener("change", filename);
			await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
		},
	};
}
