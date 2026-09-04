import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const renameFault = vi.hoisted(() => ({
	failOnPathContaining: undefined as string | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rename: async (...args: Parameters<typeof actual.rename>) => {
			const target = String(args[0]);
			if (renameFault.failOnPathContaining !== undefined && target.includes(renameFault.failOnPathContaining)) {
				renameFault.failOnPathContaining = undefined;
				throw new Error("simulated rename failure");
			}
			return actual.rename(...args);
		},
	};
});

import {
	createSidecarStore,
	InvalidSidecarStoreError,
	type SidecarStore,
	UnsupportedSidecarStoreVersionError,
} from "../../src/core/session-sidecar-store.ts";

const TEST_VERSION = 1;
const TEMP_PREFIX = "sidecar";

interface TestState {
	version: number;
	sessionId: string;
	counter: number;
}

function parseTestState(raw: unknown, ref: { baseDir: string; sessionId: string }): TestState {
	if (typeof raw !== "object" || raw === null) throw new Error("test state must be an object");
	const value = raw as { counter?: unknown };
	if (typeof value.counter !== "number") throw new Error("test state has an invalid counter");
	return { version: TEST_VERSION, sessionId: ref.sessionId, counter: value.counter };
}

const tempDirs: string[] = [];

async function tempStore(sessionId: string): Promise<SidecarStore<TestState>> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-sidecar-store-"));
	tempDirs.push(dir);
	return createSidecarStore({
		baseDir: join(dir, "extensions", "sidecar"),
		sessionId,
		version: TEST_VERSION,
		tempPrefix: TEMP_PREFIX,
		parse: parseTestState,
	});
}

function stateFor(sessionId: string, counter: number): TestState {
	return { version: TEST_VERSION, sessionId, counter };
}

async function writeRawFile(store: SidecarStore<TestState>, contents: string): Promise<void> {
	await mkdir(dirname(store.filePath), { recursive: true });
	await rm(store.filePath, { force: true });
	await writeFile(store.filePath, contents, "utf8");
}

afterEach(async () => {
	renameFault.failOnPathContaining = undefined;
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("sidecar store round trip", () => {
	it("writes then reads back the same state, with the file mode 0600", async () => {
		// Given
		const store = await tempStore("session-round-trip");
		const state = stateFor("session-round-trip", 7);

		// When
		await store.write(state);

		// Then
		expect(await store.read()).toEqual(state);
		const { stat } = await import("node:fs/promises");
		const stats = await stat(store.filePath);
		expect(stats.mode & 0o777).toBe(0o600);
	});
});

describe("sidecar store mutation serialization", () => {
	it("lands all 20 concurrent counter mutations with no lost update", async () => {
		// Given
		const store = await tempStore("session-concurrent");
		const sessionId = "session-concurrent";

		// When: every mutation is started before any of them resolves.
		const increments = Array.from({ length: 20 }, () =>
			store.mutate(async (current) => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				return stateFor(sessionId, (current?.counter ?? 0) + 1);
			}),
		);
		await Promise.all(increments);

		// Then: the persisted counter reflects all 20 increments.
		const persisted = await store.read();
		expect(persisted?.counter).toBe(20);
	});
});

describe("sidecar store atomic writes", () => {
	it("keeps the previous file intact when rename fails", async () => {
		// Given: a committed state that must survive the failed write.
		const store = await tempStore("session-atomic");
		const committed = stateFor("session-atomic", 3);
		await store.write(committed);
		const committedRaw = await readFile(store.filePath, "utf8");

		// When: the next write's rename onto the target dies.
		renameFault.failOnPathContaining = `.${TEMP_PREFIX}-`;
		const failed = store.write(stateFor("session-atomic", 99));

		// Then: the failure surfaces, the committed file is untouched, and no temp debris remains.
		await expect(failed).rejects.toThrow("simulated rename failure");
		expect(await readFile(store.filePath, "utf8")).toBe(committedRaw);
		const leftovers = await readdir(dirname(store.filePath));
		expect(leftovers).toEqual([basename(store.filePath)]);
	});
});

describe("sidecar store fail-closed parsing", () => {
	it("rejects a payload with a wrong version instead of resetting it", async () => {
		// Given
		const store = await tempStore("session-wrong-version");
		const raw = `${JSON.stringify({ version: 2, sessionId: "session-wrong-version", counter: 5 })}\n`;
		await writeRawFile(store, raw);

		// When / Then
		await expect(store.read()).rejects.toBeInstanceOf(UnsupportedSidecarStoreVersionError);
		expect(await readFile(store.filePath, "utf8")).toBe(raw);
	});

	it("rejects a payload whose sessionId mismatches the ref", async () => {
		// Given
		const store = await tempStore("session-mismatch");
		const raw = `${JSON.stringify({ version: TEST_VERSION, sessionId: "someone-else", counter: 5 })}\n`;
		await writeRawFile(store, raw);

		// When / Then
		await expect(store.read()).rejects.toBeInstanceOf(InvalidSidecarStoreError);
		expect(await readFile(store.filePath, "utf8")).toBe(raw);
	});

	it("rejects malformed JSON instead of resetting the file", async () => {
		// Given
		const store = await tempStore("session-corrupt-json");
		const raw = '{"version":1,"sessionId":"session-corrupt-json",';
		await writeRawFile(store, raw);

		// When / Then
		await expect(store.read()).rejects.toBeInstanceOf(InvalidSidecarStoreError);
		expect(await readFile(store.filePath, "utf8")).toBe(raw);
	});
});

describe("sidecar store snapshot cache", () => {
	it("returns the last written state from snapshot and drops it on clear", async () => {
		// Given
		const store = await tempStore("session-snapshot");
		expect(store.snapshot()).toBeUndefined();
		const state = stateFor("session-snapshot", 5);

		// When
		await store.write(state);

		// Then
		expect(store.snapshot()).toEqual(state);

		// When
		store.clear();

		// Then
		expect(store.snapshot()).toBeUndefined();
	});
});
