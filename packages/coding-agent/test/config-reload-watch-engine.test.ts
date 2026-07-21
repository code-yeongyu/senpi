import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ConfigReloadWatchEngine,
	createFsWatchEventSource,
	type WatchEventListener,
} from "../src/core/extensions/builtin/config-reload/watch-engine.ts";

type EventSourceProbe = {
	readonly subscribe: (_path: string, listener: WatchEventListener) => () => void;
	readonly emit: (filename: string | null) => void;
};

function eventSource(): EventSourceProbe {
	let listener: WatchEventListener | undefined;
	return {
		subscribe: (_path, callback) => {
			listener = callback;
			return () => {
				listener = undefined;
			};
		},
		emit: (filename) => listener?.("change", filename),
	};
}

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

describe("config reload watch engine", () => {
	let tempDir: string | undefined;
	const engines: ConfigReloadWatchEngine[] = [];

	afterEach(() => {
		for (const engine of engines.splice(0)) {
			engine.close();
		}
		vi.useRealTimers();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	function createEngine(options: ConstructorParameters<typeof ConfigReloadWatchEngine>[0]): ConfigReloadWatchEngine {
		const engine = new ConfigReloadWatchEngine(options);
		engines.push(engine);
		return engine;
	}

	it("does not report a touch or same-byte rewrite", () => {
		vi.useFakeTimers();
		tempDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-watch-"));
		const settingsPath = join(tempDir, "settings.json");
		writeFileSync(settingsPath, '{"theme":"dark"}');
		const source = eventSource();
		const onRealChange = vi.fn();
		createEngine({
			targets: [{ id: "settings", kind: "dir", path: tempDir, allowList: ["settings.json"] }],
			subscribe: source.subscribe,
			onRealChange,
		});

		utimesSync(settingsPath, new Date(), new Date());
		source.emit("settings.json");
		vi.advanceTimersByTime(200);
		writeFileSync(settingsPath, '{"theme":"dark"}');
		source.emit("settings.json");
		vi.advanceTimersByTime(200);

		expect(onRealChange).not.toHaveBeenCalled();
	});

	it("reports exact paths for content changes", () => {
		vi.useFakeTimers();
		tempDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-watch-"));
		const settingsPath = join(tempDir, "settings.json");
		writeFileSync(settingsPath, "before");
		const source = eventSource();
		const onRealChange = vi.fn();
		createEngine({
			targets: [{ id: "settings", kind: "dir", path: tempDir, allowList: ["settings.json"] }],
			subscribe: source.subscribe,
			onRealChange,
		});

		writeFileSync(settingsPath, "after");
		source.emit("settings.json");
		vi.advanceTimersByTime(200);

		expect(onRealChange).toHaveBeenCalledWith({ changedPaths: [settingsPath], created: [], deleted: [] });
	});

	it("reports file creation and deletion in a directory", () => {
		vi.useFakeTimers();
		tempDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-watch-"));
		const source = eventSource();
		const onRealChange = vi.fn();
		createEngine({
			targets: [{ id: "prompts", kind: "dir-recursive", path: tempDir }],
			subscribe: source.subscribe,
			onRealChange,
		});
		const promptPath = join(tempDir, "prompt.md");

		writeFileSync(promptPath, "hello");
		source.emit("prompt.md");
		vi.advanceTimersByTime(200);
		rmSync(promptPath);
		source.emit("prompt.md");
		vi.advanceTimersByTime(200);

		expect(onRealChange.mock.calls).toEqual([
			[{ changedPaths: [promptPath], created: [promptPath], deleted: [] }],
			[{ changedPaths: [promptPath], created: [], deleted: [promptPath] }],
		]);
	});

	it("coalesces rapid events into one evaluation", () => {
		vi.useFakeTimers();
		tempDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-watch-"));
		writeFileSync(join(tempDir, "one.md"), "one");
		writeFileSync(join(tempDir, "two.md"), "two");
		const source = eventSource();
		const hashFile = vi.fn((path: string) => sha256(path));
		const onRealChange = vi.fn();
		createEngine({
			targets: [{ id: "prompts", kind: "dir", path: tempDir }],
			subscribe: source.subscribe,
			onRealChange,
			hashFile,
		});
		const baselineCalls = hashFile.mock.calls.length;

		source.emit("one.md");
		source.emit("two.md");
		vi.advanceTimersByTime(199);
		expect(hashFile).toHaveBeenCalledTimes(baselineCalls);
		vi.advanceTimersByTime(1);

		expect(hashFile).toHaveBeenCalledTimes(baselineCalls + 2);
		expect(onRealChange).not.toHaveBeenCalled();
	});

	it("detects atomic saves of allow-listed files and keeps its directory watcher active", () => {
		vi.useFakeTimers();
		tempDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-watch-"));
		const settingsPath = join(tempDir, "settings.json");
		writeFileSync(settingsPath, "one");
		const source = eventSource();
		const onRealChange = vi.fn();
		createEngine({
			targets: [{ id: "settings", kind: "dir", path: tempDir, allowList: ["settings.json"] }],
			subscribe: source.subscribe,
			onRealChange,
		});

		const temporaryPath = join(tempDir, "settings.json.tmp");
		writeFileSync(temporaryPath, "two");
		renameSync(temporaryPath, settingsPath);
		source.emit("settings.json");
		vi.advanceTimersByTime(200);
		writeFileSync(settingsPath, "three");
		source.emit("settings.json");
		vi.advanceTimersByTime(200);

		expect(onRealChange.mock.calls.map(([change]) => change.changedPaths)).toEqual([[settingsPath], [settingsPath]]);
	});

	it("filters before hashing non-allow-listed paths", () => {
		vi.useFakeTimers();
		tempDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-watch-"));
		writeFileSync(join(tempDir, "settings.json"), "settings");
		writeFileSync(join(tempDir, "auth.json"), "credential");
		const source = eventSource();
		const hashFile = vi.fn((path: string) => sha256(path));
		const onRealChange = vi.fn();
		createEngine({
			targets: [{ id: "settings", kind: "dir", path: tempDir, allowList: ["settings.json"] }],
			subscribe: source.subscribe,
			onRealChange,
			hashFile,
		});

		source.emit("auth.json");
		vi.advanceTimersByTime(200);

		expect(hashFile).toHaveBeenCalledWith(join(tempDir, "settings.json"));
		expect(hashFile).not.toHaveBeenCalledWith(join(tempDir, "auth.json"));
		expect(onRealChange).not.toHaveBeenCalled();
	});

	it("returns a read-only snapshot of current file hashes", () => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-watch-"));
		const settingsPath = join(tempDir, "settings.json");
		writeFileSync(settingsPath, "settings");
		const source = eventSource();
		const engine = createEngine({
			targets: [{ id: "settings", kind: "dir", path: tempDir, allowList: ["settings.json"] }],
			subscribe: source.subscribe,
			onRealChange: vi.fn(),
		});

		const snapshot = engine.getBaselineSnapshot();
		expect(snapshot).toEqual(new Map([[settingsPath, sha256("settings")]]));
		(snapshot as Map<string, string>).set(settingsPath, "changed");
		expect(engine.getBaselineSnapshot()).toEqual(new Map([[settingsPath, sha256("settings")]]));
	});

	it("reports only explicit dot-directory creation and deletion", () => {
		vi.useFakeTimers();
		tempDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-watch-"));
		const source = eventSource();
		const onRealChange = vi.fn();
		createEngine({
			targets: [{ id: "root", kind: "dir-recursive", path: tempDir, allowList: [".omo"] }],
			subscribe: source.subscribe,
			onRealChange,
		});
		const omoDirectory = join(tempDir, ".omo");

		mkdirSync(omoDirectory);
		source.emit(".omo");
		vi.advanceTimersByTime(200);
		mkdirSync(join(tempDir, ".ignored"));
		source.emit(".ignored");
		vi.advanceTimersByTime(200);
		rmSync(omoDirectory, { recursive: true });
		source.emit(".omo");
		vi.advanceTimersByTime(200);

		expect(onRealChange.mock.calls).toEqual([
			[{ changedPaths: [omoDirectory], created: [omoDirectory], deleted: [] }],
			[{ changedPaths: [omoDirectory], created: [], deleted: [omoDirectory] }],
		]);
	});

	it("reports explicit allow-listed resource directory creation", () => {
		vi.useFakeTimers();
		tempDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-watch-"));
		const source = eventSource();
		const onRealChange = vi.fn();
		createEngine({
			targets: [{ id: "prompts-presence", kind: "dir", path: tempDir, allowList: ["prompts"] }],
			subscribe: source.subscribe,
			onRealChange,
		});
		const promptsDirectory = join(tempDir, "prompts");

		mkdirSync(promptsDirectory);
		source.emit("prompts");
		vi.advanceTimersByTime(200);

		expect(onRealChange).toHaveBeenCalledWith({
			changedPaths: [promptsDirectory],
			created: [promptsDirectory],
			deleted: [],
		});
	});

	it("reports hash errors and keeps other targets live", () => {
		vi.useFakeTimers();
		tempDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-watch-"));
		const unreadablePath = join(tempDir, "unreadable.json");
		const readablePath = join(tempDir, "readable.json");
		writeFileSync(unreadablePath, "unreadable");
		writeFileSync(readablePath, "before");
		const source = eventSource();
		const onError = vi.fn();
		const onRealChange = vi.fn();
		createEngine({
			targets: [
				{ id: "unreadable", kind: "dir", path: tempDir, allowList: ["unreadable.json"] },
				{ id: "readable", kind: "dir", path: tempDir, allowList: ["readable.json"] },
			],
			subscribe: source.subscribe,
			onRealChange,
			onError,
			hashFile: (path) => {
				if (path === unreadablePath) {
					throw new Error("EACCES: unreadable file");
				}
				return sha256(readFileSync(path, "utf8"));
			},
		});

		writeFileSync(readablePath, "after");
		source.emit("readable.json");
		vi.advanceTimersByTime(200);

		expect(onError).toHaveBeenCalledWith(expect.any(Error), unreadablePath);
		expect(onRealChange).toHaveBeenCalledWith({ changedPaths: [readablePath], created: [], deleted: [] });
	});

	it("uses the production fs.watch adapter for recursive directory events", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-watch-"));
		const settingsPath = join(tempDir, "settings.json");
		const watchReadyPath = join(tempDir, "watch-ready.txt");
		writeFileSync(settingsPath, "before");
		writeFileSync(watchReadyPath, "before");
		let resolveReady: (() => void) | undefined;
		let resolveSettingsChange: ((change: { readonly changedPaths: readonly string[] }) => void) | undefined;
		const watcherReady = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});
		const settingsChanged = new Promise<{ readonly changedPaths: readonly string[] }>((resolve) => {
			resolveSettingsChange = resolve;
		});
		createEngine({
			targets: [
				{ id: "settings", kind: "dir-recursive", path: tempDir, allowList: ["settings.json", "watch-ready.txt"] },
			],
			subscribe: createFsWatchEventSource(),
			onRealChange: (change) => {
				if (change.changedPaths.includes(watchReadyPath)) resolveReady?.();
				if (change.changedPaths.includes(settingsPath)) resolveSettingsChange?.(change);
			},
		});

		const awaitChange = async <T>(change: Promise<T>, label: string): Promise<T> => {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					change,
					new Promise<never>((_resolve, reject) => {
						timeout = setTimeout(() => reject(new Error(`fs.watch ${label} was not delivered`)), 2_000);
					}),
				]);
			} finally {
				if (timeout) clearTimeout(timeout);
			}
		};

		// Wait for an event from this exact engine watcher before making the assertion write.
		writeFileSync(watchReadyPath, "armed");
		await awaitChange(watcherReady, "readiness event");
		writeFileSync(settingsPath, "after");
		const result = await awaitChange(settingsChanged, "settings.json change");

		expect(result.changedPaths).toEqual([settingsPath]);
	});
});
