import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelCallabilityStore } from "../../src/core/model-callability.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "senpi-callability-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("ModelCallabilityStore", () => {
	it("marks selectors unavailable and persists them across instances", async () => {
		const agentDir = await temporaryDirectory();
		const now = 1_000_000;
		const store = new ModelCallabilityStore(agentDir, { now: () => now });
		await store.load();

		expect(store.unavailableSelectors().size).toBe(0);
		await store.mark("cursor-cli-oauth/kimi-k3", "access-denied");
		expect(store.isUnavailable("cursor-cli-oauth/kimi-k3")).toBe(true);

		const reloaded = new ModelCallabilityStore(agentDir, { now: () => now });
		await reloaded.load();
		expect(reloaded.isUnavailable("cursor-cli-oauth/kimi-k3")).toBe(true);

		const persisted = JSON.parse(await readFile(join(agentDir, "model-callability.json"), "utf8"));
		expect(persisted.entries["cursor-cli-oauth/kimi-k3"].reason).toBe("access-denied");
	});

	it("expires marks after the TTL and prunes them from disk", async () => {
		const agentDir = await temporaryDirectory();
		let now = 1_000_000;
		const store = new ModelCallabilityStore(agentDir, { now: () => now, ttlMs: 60_000 });
		await store.mark("cursor-cli-oauth/glm-5.2", "access-denied");

		now += 59_000;
		expect(store.isUnavailable("cursor-cli-oauth/glm-5.2")).toBe(true);
		now += 2_000;
		expect(store.isUnavailable("cursor-cli-oauth/glm-5.2")).toBe(false);

		const reloaded = new ModelCallabilityStore(agentDir, { now: () => now, ttlMs: 60_000 });
		await reloaded.load();
		expect(reloaded.isUnavailable("cursor-cli-oauth/glm-5.2")).toBe(false);
	});

	it("unmark clears a mark and is a no-op for unknown selectors", async () => {
		const agentDir = await temporaryDirectory();
		const store = new ModelCallabilityStore(agentDir, { now: () => 1_000_000 });
		await store.mark("a/b", "access-denied");
		await store.unmark("a/b");
		expect(store.isUnavailable("a/b")).toBe(false);
		await store.unmark("never/marked");

		const reloaded = new ModelCallabilityStore(agentDir, { now: () => 1_000_000 });
		await reloaded.load();
		expect(reloaded.unavailableSelectors().size).toBe(0);
	});

	it("survives a corrupt store file by starting empty", async () => {
		const agentDir = await temporaryDirectory();
		const store = new ModelCallabilityStore(agentDir, { now: () => 1_000_000 });
		await store.mark("a/b", "access-denied");
		const { writeFile } = await import("node:fs/promises");
		await writeFile(join(agentDir, "model-callability.json"), "not json", "utf8");

		const reloaded = new ModelCallabilityStore(agentDir, { now: () => 1_000_000 });
		await reloaded.load();
		expect(reloaded.unavailableSelectors().size).toBe(0);
	});
});
