import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, InMemoryCredentialStore, type Model, type Provider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";

let agentDir: string;
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "model-blacklist-runtime-"));
});
afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

const blacklistFile = () => join(agentDir, "model-blacklist.json");
const saveRules = (models: string[]) => writeFileSync(blacklistFile(), JSON.stringify({ models }));
const savedRules = () => (JSON.parse(readFileSync(blacklistFile(), "utf8")) as { models: string[] }).models;

function chatModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "bl",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
		baseUrl: "http://127.0.0.1:1",
	};
}

/** Static alpha/beta plus a gamma that only a network-allowed refresh discovers. */
function createProvider() {
	const transportCalls: string[] = [];
	let models: readonly Model<Api>[] = [chatModel("alpha"), chatModel("beta")];
	const provider: Provider = {
		id: "bl",
		name: "bl",
		auth: { apiKey: { name: "bl key", resolve: async () => ({ auth: { apiKey: "test-key" }, source: "test" }) } },
		getModels: () => models,
		refreshModels: async (context) => {
			if (context.allowNetwork) models = [chatModel("alpha"), chatModel("beta"), chatModel("gamma")];
		},
		stream: () => {
			transportCalls.push("stream");
			throw new Error("transport reached");
		},
		streamSimple: (model) => {
			transportCalls.push(model.id);
			throw new Error("transport reached");
		},
	};
	return { provider, transportCalls };
}

async function createRuntime(options: { agentDir?: string; modelsPath?: string | null } = { agentDir }) {
	const { provider, transportCalls } = createProvider();
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
		...options,
	});
	await runtime.registerNativeProvider(provider);
	await runtime.getAvailable();
	return { runtime, transportCalls };
}

const ids = (models: readonly { provider: string; id: string }[]) =>
	models.filter((model) => model.provider === "bl").map((model) => model.id);

async function sendOutcome(runtime: ModelRuntime, model: Model<Api>): Promise<string> {
	try {
		const message = await runtime.completeSimple(model, {
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		});
		return message.errorMessage ?? "completed";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

describe("ModelRuntime native model blacklist", () => {
	it("blocks nothing when the saved file is missing and still offers an adapter", async () => {
		const { runtime } = await createRuntime();

		expect(ids(runtime.getModels())).toEqual(["alpha", "beta"]);
		expect(ids(runtime.getAvailableSnapshot())).toEqual(["alpha", "beta"]);
		expect(runtime.getModelBlacklistAdapter()?.getState(chatModel("alpha"))).toEqual({
			blocked: false,
			activeBlocked: false,
		});
	});

	it("keeps an in-memory runtime isolated unless an agentDir is given", async () => {
		saveRules(["bl/*"]);
		const { runtime } = await createRuntime({ modelsPath: null });
		expect(runtime.getModelBlacklistAdapter()).toBeUndefined();
		expect(ids(runtime.getModels())).toEqual(["alpha", "beta"]);

		const withDir = await createRuntime({ agentDir, modelsPath: null });
		expect(ids(withDir.runtime.getModels())).toEqual([]);
	});

	it("filters every catalog view by ordered globs with exceptions", async () => {
		saveRules(["bl/*", "!bl/alpha"]);
		const { runtime } = await createRuntime();

		expect(ids(runtime.getModels())).toEqual(["alpha"]);
		expect(ids(runtime.getAllModels())).toEqual(["alpha"]);
		expect(ids(runtime.getModelsOfType("chat"))).toEqual(["alpha"]);
		expect(ids(runtime.getAvailableSnapshot())).toEqual(["alpha"]);
		expect(ids(await runtime.getAvailable())).toEqual(["alpha"]);
		expect(ids(await runtime.getAvailable("bl"))).toEqual(["alpha"]);
		expect(ids(await runtime.getAllAvailable())).toEqual(["alpha"]);
		expect(runtime.getModel("bl", "beta")).toBeUndefined();
		expect(runtime.getModelOfType("chat", "bl", "beta")).toBeUndefined();
		expect(runtime.getModel("bl", "alpha")).toBeDefined();

		// Synchronous construction cannot read the policy: deny access until explicitly initialized.
		const synchronous = ModelRuntime.createSync({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			agentDir,
		});
		const { provider, transportCalls } = createProvider();
		await synchronous.registerNativeProvider(provider, { refresh: false });
		expect(ids(synchronous.getModels())).toEqual([]);
		await expect(synchronous.prepareSimpleRequest(chatModel("beta"))).rejects.toThrow(/model blacklist/);
		const refreshing = synchronous.refresh({ allowNetwork: false });
		expect(ids(synchronous.getModels())).toEqual([]);
		await expect(synchronous.prepareSimpleRequest(chatModel("beta"))).rejects.toThrow(/model blacklist/);
		await refreshing;
		expect(ids(synchronous.getModels())).toEqual(["alpha"]);
		await expect(synchronous.prepareSimpleRequest(chatModel("beta"))).rejects.toThrow(/model blacklist/);
		expect(transportCalls).toEqual([]);
	});

	it("fails closed on a malformed saved policy and reports it", async () => {
		writeFileSync(blacklistFile(), "{broken");
		const { runtime } = await createRuntime();

		expect(ids(runtime.getModels())).toEqual([]);
		expect(ids(runtime.getAvailableSnapshot())).toEqual([]);
		expect(runtime.getError()).toContain("Model blacklist");
		const adapter = runtime.getModelBlacklistAdapter();
		expect(adapter?.getState(chatModel("alpha")).blocked).toBe(true);
		await expect(adapter?.toggle(chatModel("alpha"))).rejects.toThrow(/malformed/);
		expect(readFileSync(blacklistFile(), "utf8")).toBe("{broken");
	});

	it("saves a toggle immediately, keeps the running policy through reload, and applies it after restart", async () => {
		const { runtime } = await createRuntime();
		const adapter = runtime.getModelBlacklistAdapter();
		if (!adapter) throw new Error("expected an adapter");
		const beta = chatModel("beta");

		await adapter.toggle(beta);
		expect(savedRules()).toEqual(["bl/beta"]);
		expect(adapter.getState(beta)).toEqual({ blocked: true, activeBlocked: false, rule: "bl/beta" });
		expect(ids(runtime.getModels())).toEqual(["alpha", "beta"]);

		await runtime.reloadConfig();
		await runtime.refresh({ allowNetwork: false });
		expect(ids(runtime.getAvailableSnapshot())).toEqual(["alpha", "beta"]);
		expect(adapter.getState(beta).activeBlocked).toBe(false);

		const restarted = await createRuntime();
		expect(ids(restarted.runtime.getModels())).toEqual(["alpha"]);
		expect(restarted.runtime.getModelBlacklistAdapter()?.getState(beta)).toEqual({
			blocked: true,
			activeBlocked: true,
			rule: "bl/beta",
		});

		await restarted.runtime.getModelBlacklistAdapter()?.toggle(beta);
		expect(savedRules()).toEqual([]);
	});

	it("writes the exception rule when a wildcard blocks the toggled model", async () => {
		saveRules(["bl/*"]);
		const { runtime } = await createRuntime();
		const adapter = runtime.getModelBlacklistAdapter();

		await adapter?.toggle(chatModel("alpha"));
		expect(savedRules()).toEqual(["bl/*", "!bl/alpha"]);
		expect(adapter?.getState(chatModel("alpha"))).toEqual({ blocked: false, activeBlocked: true, rule: "!bl/alpha" });
	});

	it("refreshes external saved changes asynchronously while retaining active enforcement", async () => {
		saveRules(["bl/alpha"]);
		const { runtime } = await createRuntime();
		const adapter = runtime.getModelBlacklistAdapter();
		if (!adapter) throw new Error("expected an adapter");
		const beta = chatModel("beta");

		saveRules(["bl/beta"]);
		expect(adapter.getState(beta)).toEqual({ blocked: false, activeBlocked: false });
		await runtime.refresh({ allowNetwork: false });
		expect(adapter.getState(beta)).toEqual({ blocked: true, activeBlocked: false, rule: "bl/beta" });
		expect(ids(runtime.getModels())).toEqual(["beta"]);

		// A toggle reads the latest file even when no runtime refresh has observed that edit.
		saveRules(["bl/*"]);
		await adapter.toggle(beta);
		expect(savedRules()).toEqual(["bl/*", "!bl/beta"]);
		expect(adapter.getState(beta)).toEqual({ blocked: false, activeBlocked: false, rule: "!bl/beta" });
		expect(ids(runtime.getModels())).toEqual(["beta"]);
	});

	it("exposes pre-filter rows through the adapter and filters models discovered by refresh", async () => {
		saveRules(["bl/g*"]);
		const { runtime } = await createRuntime();
		expect(ids(runtime.getModels())).toEqual(["alpha", "beta"]);

		const result = await runtime.refresh({ providers: ["bl"], allowNetwork: true });
		expect(result.errors.size).toBe(0);

		expect(ids(runtime.getModels())).toEqual(["alpha", "beta"]);
		expect(ids(runtime.getAvailableSnapshot())).toEqual(["alpha", "beta"]);
		expect(ids(await runtime.getAvailable())).toEqual(["alpha", "beta"]);
		expect(runtime.getModel("bl", "gamma")).toBeUndefined();
		expect(ids(runtime.getModelBlacklistAdapter()?.getModels() ?? [])).toEqual(["alpha", "beta", "gamma"]);
	});

	it("rejects a blocked model before the transport, including a stale object held across a restart", async () => {
		const stale = (await createRuntime()).runtime.getModel("bl", "beta");
		if (!stale) throw new Error("expected beta");
		saveRules(["bl/beta"]);
		const { runtime, transportCalls } = await createRuntime();

		expect(await sendOutcome(runtime, stale)).toContain("blocked by the model blacklist");
		expect(await sendOutcome(runtime, chatModel("beta"))).toContain("bl/beta");
		await expect(runtime.prepareSimpleRequest(stale)).rejects.toThrow(/blocked by the model blacklist/);
		expect(transportCalls).toEqual([]);

		const alphaOutcome = await sendOutcome(runtime, chatModel("alpha"));
		expect(alphaOutcome).toContain("transport reached");
		expect(transportCalls).toEqual(["alpha"]);
	});
});
