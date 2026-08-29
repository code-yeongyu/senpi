import { vi } from "vitest";
import type { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import type {
	MonitorEvent,
	MonitorSnapshotEntry,
} from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import { MonitorRegistry } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import { createMonitorTool } from "../../src/core/extensions/builtin/terminal/tools/monitor.ts";

type WatchListener = (eventType: string, filename: string | null) => void;

export class FakeWatcher {
	readonly close = vi.fn();
	readonly #listener: WatchListener;
	readonly #errorListeners = new Set<(error: Error) => void>();

	constructor(listener: WatchListener) {
		this.#listener = listener;
	}

	on(event: "error", listener: (error: Error) => void): this {
		if (event === "error") this.#errorListeners.add(listener);
		return this;
	}

	emit(filename: string | null): void {
		this.#listener("rename", filename);
	}

	fail(error: Error): void {
		for (const listener of this.#errorListeners) listener(error);
	}
}

export interface NativeFileMonitorHarness {
	readonly events: MonitorEvent[];
	readonly snapshots: Array<readonly MonitorSnapshotEntry[]>;
	readonly registry: MonitorRegistry;
	readonly tool: ReturnType<typeof createMonitorTool>;
	readonly watcher: () => FakeWatcher | undefined;
}

export interface NativeFileMonitorHarnessOptions {
	readonly beforeWatchReturn?: () => void;
	readonly onEvent?: (event: MonitorEvent) => void;
	readonly onMonitorRearmed?: (id: string) => void;
	readonly queueReconcile?: (callback: () => void) => void;
}

export function createNativeFileMonitorHarness(
	manager: TerminalManager,
	cwd: string,
	options: NativeFileMonitorHarnessOptions = {},
): NativeFileMonitorHarness {
	const events: MonitorEvent[] = [];
	const snapshots: Array<readonly MonitorSnapshotEntry[]> = [];
	let watcher: FakeWatcher | undefined;
	const fileMonitor = {
		queueReconcile: options.queueReconcile,
		watch: (_path: string, _options: { readonly encoding: "utf8" }, listener: WatchListener) => {
			watcher = new FakeWatcher(listener);
			options.beforeWatchReturn?.();
			return watcher;
		},
	};
	const registryOptions = {
		fileMonitor,
		onChange: (snapshot: readonly MonitorSnapshotEntry[]) => snapshots.push(snapshot),
	};
	const registry = new MonitorRegistry((event) => {
		events.push(event);
		options.onEvent?.(event);
	}, registryOptions);
	const tool = createMonitorTool({
		manager,
		monitorRegistry: registry,
		cwd,
		defaultCols: 120,
		defaultRows: 40,
		getEnv: () => ({ ...process.env }),
		onMonitorRearmed: options.onMonitorRearmed,
	});
	return { events, snapshots, registry, tool, watcher: () => watcher };
}
