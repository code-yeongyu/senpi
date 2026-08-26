import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSettingsStorage, getSettingsPath, wasSelfWrite } from "../src/core/settings-manager.ts";

const lockState = vi.hoisted(() => ({
	acquisitions: 0,
	onNextAcquire: undefined as (() => void) | undefined,
}));

vi.mock("proper-lockfile", async (importOriginal) => {
	const actual = await importOriginal<{ default: typeof import("proper-lockfile") }>();
	const base = actual.default;
	return {
		default: {
			...base,
			lockSync: (path: string, options?: Parameters<typeof base.lockSync>[1]) => {
				lockState.acquisitions += 1;
				const hook = lockState.onNextAcquire;
				lockState.onNextAcquire = undefined;
				hook?.();
				return base.lockSync(path, options);
			},
		},
	};
});

const fsCalls = vi.hoisted(() => ({
	writes: [] as string[],
	renames: [] as { from: string; to: string }[],
}));

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	return {
		...actual,
		writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
			if (typeof args[0] === "string") fsCalls.writes.push(args[0]);
			return actual.writeFileSync(...args);
		}) as typeof actual.writeFileSync,
		renameSync: ((from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) => {
			fsCalls.renames.push({ from: String(from), to: String(to) });
			return actual.renameSync(from, to);
		}) as typeof actual.renameSync,
	};
});

describe("FileSettingsStorage lock-free reads with atomic rename publish", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;
	let settingsPath: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "senpi-lockfree-"));
		agentDir = join(root, "agent");
		cwd = join(root, "work");
		settingsPath = getSettingsPath(cwd, agentDir, "global", root);
		lockState.acquisitions = 0;
		lockState.onNextAcquire = undefined;
		fsCalls.writes.length = 0;
		fsCalls.renames.length = 0;
	});

	afterEach(() => {
		lockState.onNextAcquire = undefined;
		rmSync(root, { recursive: true, force: true });
	});

	it("#given an existing settings file #when the callback only reads #then no lock is acquired", () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }), "utf-8");
		const storage = new FileSettingsStorage(cwd, agentDir, root);
		let observed: string | undefined;

		storage.withLock("global", (current) => {
			observed = current;
			return undefined;
		});

		expect(observed).toBe(JSON.stringify({ theme: "dark" }));
		expect(lockState.acquisitions).toBe(0);
	});

	it("#given a write #then content is published only through temp-file rename, never a direct write to the settings path", () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }), "utf-8");
		fsCalls.writes.length = 0;
		const storage = new FileSettingsStorage(cwd, agentDir, root);

		storage.withLock("global", () => JSON.stringify({ theme: "light" }));

		expect(fsCalls.writes).not.toContain(settingsPath);
		expect(fsCalls.renames.some((r) => r.to === settingsPath && r.from !== settingsPath)).toBe(true);
		expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ theme: "light" });
		expect(lockState.acquisitions).toBe(1);
	});

	it("#given an existing file changed by a concurrent winner before the write lock #then the merge re-runs against the winner's content", () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }), "utf-8");
		const storage = new FileSettingsStorage(cwd, agentDir, root);
		lockState.onNextAcquire = () => {
			writeFileSync(settingsPath, JSON.stringify({ theme: "winner" }), "utf-8");
		};

		storage.withLock("global", (current) => {
			const settings: Record<string, unknown> = current ? (JSON.parse(current) as Record<string, unknown>) : {};
			settings.defaultModel = "merged-model";
			return JSON.stringify(settings);
		});

		const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
		expect(written.defaultModel).toBe("merged-model");
		expect(written.theme).toBe("winner");
	});

	it("#given a rename-published write #then the content is recorded as a self-write and no temp file is left behind", () => {
		const storage = new FileSettingsStorage(cwd, agentDir, root);
		const content = JSON.stringify({ created: true });

		storage.withLock("global", () => content);

		const hash = createHash("sha256").update(content).digest("hex");
		expect(wasSelfWrite(settingsPath, hash)).toBe(true);
		expect(existsSync(settingsPath)).toBe(true);
		const leftovers = readFileSync(settingsPath, "utf-8");
		expect(JSON.parse(leftovers)).toEqual({ created: true });
		expect(readdirSync(agentDir).filter((name) => name.includes(".tmp"))).toEqual([]);
	});
});
