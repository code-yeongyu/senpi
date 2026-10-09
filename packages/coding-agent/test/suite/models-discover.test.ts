import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_MAX_MODEL_ID, installMaxEffortFixtureCatalog } from "../../../ai/test/fixture-model-catalog.ts";
import { discoverProviderModels } from "../../src/core/model-discovery.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { type ListingServer, readProviderModels, startListingServer } from "./models-discover-support.ts";

// senpi#2196: `senpi models discover` honors reasoning_efforts advertised by /models.
const LISTING = {
	object: "list",
	data: [
		{ id: "effort-model", reasoning_efforts: [{ value: "low" }, { value: "High", default: true }] },
		{ id: "plain-model" },
	],
};
const LOW_HIGH_MAP = { off: null, minimal: null, low: "low", medium: null, high: "High", xhigh: null, max: null };

describe("discoverProviderModels", () => {
	let tempDir: string;
	let modelsPath: string;
	let server: ListingServer;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `senpi-2196-discover-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsPath = join(tempDir, "models.json");
		server = await startListingServer(LISTING);
	});

	afterEach(async () => {
		await server.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeProvider(provider: Record<string, unknown>, baseUrl = server.baseUrl): void {
		const local = { baseUrl, api: "openai-completions", apiKey: "test-key", ...provider };
		writeFileSync(modelsPath, JSON.stringify({ providers: { local } }, null, 2));
	}

	const providerModels = () => readProviderModels(readFileSync(modelsPath, "utf-8"), "local");
	const discover = () => discoverProviderModels({ providerId: "local", modelsPath, auth: { apiKey: "test-key" } });

	async function runtimeModel(id: string) {
		const runtime = await ModelRuntime.create({
			modelsPath,
			authPath: join(tempDir, "auth.json"),
			allowModelNetwork: false,
		});
		expect(runtime.getError()).toBeUndefined();
		const model = runtime.getModel("local", id);
		if (!model) throw new Error(`model ${id} was not loaded`);
		return model;
	}

	async function sentEffort(id: string): Promise<unknown> {
		const model = await runtimeModel(id);
		let sent: unknown = "payload was never built";
		const context = { messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] };
		await streamSimple(model, context, {
			apiKey: "test-key",
			reasoning: "high",
			onPayload: (payload) => {
				sent =
					typeof payload === "object" && payload !== null ? Reflect.get(payload, "reasoning_effort") : undefined;
				return payload;
			},
		}).result();
		return sent;
	}

	it("writes advertised efforts as a thinkingLevelMap and default when the compat flag is on", async () => {
		writeProvider({ compat: { supportsReasoningEffort: true } });

		const report = await discover();

		expect(server.requests).toHaveLength(1);
		expect(server.requests[0]?.url).toBe("/v1/models");
		expect(server.requests[0]?.headers.authorization).toBe("Bearer test-key");
		expect(report.added).toEqual(["effort-model", "plain-model"]);
		expect(report.efforts["effort-model"]).toEqual({
			levels: ["low", "high"],
			defaultThinkingLevel: "high",
			unmapped: [],
		});
		expect(providerModels()).toEqual([
			{ id: "effort-model", reasoning: true, thinkingLevelMap: LOW_HIGH_MAP, defaultThinkingLevel: "high" },
			{ id: "plain-model" },
		]);
		const model = await runtimeModel("effort-model");
		expect(model.defaultThinkingLevel).toBe("high");
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "high"]);
	});

	it("keeps discovered efforts authoritative when the same fixture id has a catalog max", async () => {
		installMaxEffortFixtureCatalog();
		writeProvider({ compat: { supportsReasoningEffort: true } });
		server.listing = {
			status: 200,
			body: {
				data: [{ id: FIXTURE_MAX_MODEL_ID, reasoning_efforts: [{ value: "low" }, { value: "high" }] }],
			},
		};

		await discover();
		const model = await runtimeModel(FIXTURE_MAX_MODEL_ID);

		expect(getSupportedThinkingLevels(model)).toEqual(["low", "high"]);
		expect(clampThinkingLevel(model, "max")).toBe("high");
	});

	it("ignores advertised efforts without compat.supportsReasoningEffort", async () => {
		writeProvider({});

		const report = await discover();

		expect(report.effortsIgnored).toBe(true);
		expect(report.efforts).toEqual({});
		expect(providerModels()).toEqual([{ id: "effort-model" }, { id: "plain-model" }]);
	});

	it("keeps an existing entry's own fields, backs up the original, and is idempotent", async () => {
		writeProvider({
			compat: { supportsReasoningEffort: true },
			models: [{ id: "effort-model", name: "Mine", contextWindow: 64000 }],
		});
		const original = readFileSync(modelsPath, "utf-8");

		const first = await discover();

		expect(first.updated).toEqual(["effort-model"]);
		expect(first.added).toEqual(["plain-model"]);
		expect(first.backupPath === undefined ? undefined : readFileSync(first.backupPath, "utf-8")).toBe(original);
		expect(providerModels()[0]).toMatchObject({
			id: "effort-model",
			name: "Mine",
			contextWindow: 64000,
			defaultThinkingLevel: "high",
		});

		const rewritten = readFileSync(modelsPath, "utf-8");
		const second = await discover();
		expect(second.written).toBe(false);
		expect(second.unchanged).toEqual(["effort-model", "plain-model"]);
		expect(readFileSync(modelsPath, "utf-8")).toBe(rewritten);
	});

	// review B1: a rediscovered ladder with nothing representable must not keep sending the old one.
	it("disables reasoning controls when a rediscovered ladder has nothing senpi can represent", async () => {
		writeProvider({ compat: { supportsReasoningEffort: true } });
		await discover();
		expect(await sentEffort("effort-model")).toBe("High");
		server.listing = {
			status: 200,
			body: { data: [{ id: "effort-model", reasoning_efforts: [{ value: "turbo" }] }] },
		};

		const report = await discover();

		expect(report.updated).toEqual(["effort-model"]);
		expect(report.efforts["effort-model"]).toEqual({ levels: [], unmapped: ["turbo"] });
		expect(providerModels()[0]).toEqual({ id: "effort-model", reasoning: false });
		expect(await sentEffort("effort-model")).toBeUndefined();
	});

	// review B3: inherited names are unknown names and never reach models.json as levels.
	it("reports inherited property names as unknown and keeps models.json loadable", async () => {
		writeProvider({ compat: { supportsReasoningEffort: true } });
		server.listing = {
			status: 200,
			body: {
				data: [{ id: "proto-model", reasoning_efforts: [{ value: "__proto__", default: true }, "constructor"] }],
			},
		};

		const report = await discover();

		expect(report.efforts["proto-model"]).toEqual({ levels: [], unmapped: ["__proto__", "constructor"] });
		expect(providerModels()).toEqual([{ id: "proto-model", reasoning: false }]);
		expect((await runtimeModel("proto-model")).reasoning).toBe(false);
	});

	it("refuses to replace models.json with a candidate that fails the models.json schema", async () => {
		writeProvider({ models: [{ id: "broken", contextWindow: "big" }] });
		const original = readFileSync(modelsPath, "utf-8");

		await expect(discover()).rejects.toThrow("models.json");
		expect(readFileSync(modelsPath, "utf-8")).toBe(original);
	});

	// review B5: credentials in the configured URL never reach reports or errors.
	it("redacts query values in the reported URL and in HTTP errors", async () => {
		writeProvider({ compat: { supportsReasoningEffort: true } }, `${server.baseUrl}?api_key=dummy-token`);

		const report = await discover();

		expect(server.requests[0]?.url).toBe("/v1/models?api_key=dummy-token");
		expect(report.url).toBe(`${server.baseUrl}/models?api_key=<redacted>`);
		server.listing = { status: 500, body: { error: "boom" } };
		const failure = await discover().catch((error: unknown) => error);
		expect(String(failure)).toContain("HTTP 500");
		expect(String(failure)).not.toContain("dummy-token");
	});

	it("never prints userinfo from the configured URL", async () => {
		writeProvider({}, server.baseUrl.replace("http://", "http://review-user:dummy-secret@"));

		const failure = await discover().catch((error: unknown) => error);

		expect(String(failure)).not.toContain("dummy-secret");
		expect(String(failure)).not.toContain("review-user");
	});

	it("fails without touching models.json when the listing request fails", async () => {
		writeProvider({ compat: { supportsReasoningEffort: true } });
		const original = readFileSync(modelsPath, "utf-8");
		server.listing = { status: 500, body: { error: "boom" } };

		await expect(discoverProviderModels({ providerId: "local", modelsPath, auth: {} })).rejects.toThrow("500");
		expect(readFileSync(modelsPath, "utf-8")).toBe(original);
	});

	it("rejects a malformed listing and an unknown provider", async () => {
		writeProvider({});
		server.listing = { status: 200, body: { data: "nope" } };

		await expect(discoverProviderModels({ providerId: "local", modelsPath, auth: {} })).rejects.toThrow("model list");
		await expect(discoverProviderModels({ providerId: "missing", modelsPath, auth: {} })).rejects.toThrow("missing");
		expect(existsSync(`${modelsPath}.backup`)).toBe(false);
	});
});
