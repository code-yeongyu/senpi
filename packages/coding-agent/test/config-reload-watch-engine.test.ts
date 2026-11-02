import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	type FSWatcher,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ConfigReloadWatchEngine,
	createFsWatchEventSource,
	type WatchEventListener,
} from "../src/core/extensions/builtin/config-reload/watch-engine.ts";

const mocks = vi.hoisted(() => ({ fsWatch: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	mocks.fsWatch.mockImplementation(actual.watch);
	return { ...actual, watch: mocks.fsWatch };
});

type EventSourceProbe = {
	readonly subscribe: (path: string, listener: WatchEventListener) => () => void;
	/** Emits on the root watcher, mirroring how a real parent directory reports its children. */
	readonly emit: (filename: string | null) => void;
	/** Emits on the watcher for a specific directory, with a name relative to it. */
	readonly emitFrom: (directory: string, filename: string | null) => void;
	readonly watchedPaths: () => string[];
};

/**
 * Keeps one listener per watched directory. The engine subscribes per in-scope
 * directory rather than handing a whole subtree to the OS, so a single-listener
 * probe would silently drop every watcher but the last.
 */
function eventSource(): EventSourceProbe {
	const listeners = new Map<string, WatchEventListener>();
	let rootPath: string | undefined;
	return {
		subscribe: (path, callback) => {
			rootPath ??= path;
			listeners.set(path, callback);
			return () => {
				listeners.delete(path);
			};
		},
		emit: (filename) => {
			if (rootPath !== undefined) listeners.get(rootPath)?.("change", filename);
		},
		emitFrom: (directory, filename) => listeners.get(directory)?.("change", filename),
		watchedPaths: () => [...listeners.keys()],
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

	it("subscribes only to in-scope directories, never a whole subtree", () => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-watch-"));
		// A realistic extensions tree: one loadable package plus dependency and VCS
		// noise that must never reach the OS watcher.
		mkdirSync(join(tempDir, "my-ext"), { recursive: true });
		writeFileSync(join(tempDir, "my-ext", "index.ts"), "export default {}");
		mkdirSync(join(tempDir, "my-ext", "node_modules", "dep", "dist"), { recursive: true });
		writeFileSync(join(tempDir, "my-ext", "node_modules", "dep", "dist", "index.js"), "noise");
		mkdirSync(join(tempDir, ".git", "objects"), { recursive: true });

		const source = eventSource();
		createEngine({
			targets: [{ id: "extensions", kind: "dir-recursive", path: tempDir }],
			subscribe: source.subscribe,
			onRealChange: vi.fn(),
		});

		const watched = source.watchedPaths();
		expect(watched).toContain(tempDir);
		expect(watched).toContain(join(tempDir, "my-ext"));
		// The regression this locks: `fs.watch({recursive:true})` on the root would
		// register every one of these with the OS, and the target filter only
		// discards their events after delivery.
		expect(watched.filter((path) => path.includes("node_modules"))).toEqual([]);
		expect(watched.filter((path) => path.includes(".git"))).toEqual([]);
	});

	it("requests no recursive OS watch for a recursive target", () => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-watch-"));
		mkdirSync(join(tempDir, "nested", "deeper"), { recursive: true });
		const recursiveRequests: (boolean | undefined)[] = [];
		createEngine({
			targets: [{ id: "root", kind: "dir-recursive", path: tempDir }],
			subscribe: (_path, _listener, options) => {
				recursiveRequests.push(options?.recursive);
				return () => {};
			},
			onRealChange: vi.fn(),
		});

		expect(recursiveRequests.length).toBeGreaterThan(1);
		expect(recursiveRequests.some(Boolean)).toBe(false);
	});

	it("detects a change in a nested directory through its own watcher", () => {
		vi.useFakeTimers();
		tempDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-watch-"));
		const nested = join(tempDir, "pkg", "deep");
		mkdirSync(nested, { recursive: true });
		const nestedFile = join(nested, "skill.md");
		writeFileSync(nestedFile, "before");
		const source = eventSource();
		const onRealChange = vi.fn();
		createEngine({
			targets: [{ id: "skills", kind: "dir-recursive", path: tempDir }],
			subscribe: source.subscribe,
			onRealChange,
		});

		writeFileSync(nestedFile, "after");
		// A per-directory watcher reports names relative to its own directory; the
		// engine must re-anchor that to the target root before matching.
		source.emitFrom(nested, "skill.md");
		vi.advanceTimersByTime(200);

		expect(onRealChange.mock.calls).toEqual([[{ changedPaths: [nestedFile], created: [], deleted: [] }]]);
	});

	it("attaches a watcher to a directory created after startup", () => {
		vi.useFakeTimers();
		tempDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-watch-"));
		const source = eventSource();
		createEngine({
			targets: [{ id: "skills", kind: "dir-recursive", path: tempDir }],
			subscribe: source.subscribe,
			onRealChange: vi.fn(),
		});
		const added = join(tempDir, "added");
		expect(source.watchedPaths()).not.toContain(added);

		mkdirSync(added);
		writeFileSync(join(added, "skill.md"), "content");
		source.emit("added");
		vi.advanceTimersByTime(200);

		expect(source.watchedPaths()).toContain(added);
	});

	it("releases the watcher for a directory that leaves scope", () => {
		vi.useFakeTimers();
		tempDir = mkdtempSync(join(tmpdir(), "senpi-config-reload-watch-"));
		const removable = join(tempDir, "removable");
		mkdirSync(removable);
		writeFileSync(join(removable, "skill.md"), "content");
		const source = eventSource();
		createEngine({
			targets: [{ id: "skills", kind: "dir-recursive", path: tempDir }],
			subscribe: source.subscribe,
			onRealChange: vi.fn(),
		});
		expect(source.watchedPaths()).toContain(removable);

		rmSync(removable, { recursive: true });
		source.emit("removable");
		vi.advanceTimersByTime(200);

		expect(source.watchedPaths()).not.toContain(removable);
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
		let resolveSettingsChange: ((change: { readonly changedPaths: readonly string[] }) => void) | undefined;
		const settingsChanged = new Promise<{ readonly changedPaths: readonly string[] }>((resolve) => {
			resolveSettingsChange = resolve;
		});
		mocks.fsWatch.mockClear();
		createEngine({
			targets: [{ id: "settings", kind: "dir-recursive", path: tempDir, allowList: ["settings.json"] }],
			// Pin the direct fs.watch backend: on Linux (issue #477) and macOS
			// (FSEvents teardown stalls) the production source routes recursive
			// watches through a worker thread, covered by
			// test/suite/regressions/477-recursive-watch-main-thread-stall.test.ts and
			// the macOS offload block in test/suite/config-reload-extension.test.ts.
			subscribe: createFsWatchEventSource(undefined, { platform: "win32" }),
			onRealChange: (change) => {
				if (change.changedPaths.includes(settingsPath)) resolveSettingsChange?.(change);
			},
		});

		const watcher = mocks.fsWatch.mock.results.at(-1)?.value as FSWatcher | undefined;
		if (!watcher) {
			throw new Error("production fs.watch was not registered");
		}
		const watcherReady = once(watcher, "change");
		const awaitChange = async <T>(change: Promise<T>, label: string): Promise<T> => {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					change,
					new Promise<never>((_resolve, reject) => {
						timeout = setTimeout(() => reject(new Error(`fs.watch ${label} was not delivered`)), 30_000);
					}),
				]);
			} finally {
				if (timeout) clearTimeout(timeout);
			}
		};

		// Subscribe to the production FSWatcher event before arming the assertion write.
		// macOS FSEvents establishes asynchronously with no ready callback and silently
		// drops operations performed before the stream is live, so a one-shot probe can
		// starve forever. Re-arm the probe until the watcher proves it is delivering.
		const armReadiness = setInterval(() => {
			writeFileSync(watchReadyPath, String(Date.now()));
		}, 250);
		try {
			renameSync(watchReadyPath, `${watchReadyPath}.armed`);
			writeFileSync(watchReadyPath, "armed");
			await awaitChange(watcherReady, "readiness event");
		} finally {
			clearInterval(armReadiness);
		}
		// Re-arm the assertion write too: under heavy host load FSEvents can starve a
		// single one-shot write past any fixed deadline, and rewriting identical bytes
		// would be hash-deduped by the engine - so every re-arm writes fresh content.
		let settingsRevision = 0;
		const armSettingsChange = setInterval(() => {
			settingsRevision += 1;
			writeFileSync(settingsPath, `after-${settingsRevision}`);
		}, 250);
		try {
			writeFileSync(settingsPath, "after");
			const result = await awaitChange(settingsChanged, "settings.json change");
			expect(result.changedPaths).toEqual([settingsPath]);
		} finally {
			clearInterval(armSettingsChange);
		}
	});
});
