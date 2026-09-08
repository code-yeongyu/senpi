import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { AgentSession } from "../../src/core/agent-session.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../../src/core/models-store.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { assertConfiguredSessionResumeUsable, createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { prepareConfiguredSessionResume } from "../../src/main.ts";

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(storedModel: string | undefined = "small", defaultModel = "large") {
	const dir = mkdtempSync(join(tmpdir(), "senpi-resume-preflight-"));
	dirs.push(dir);
	const models = [
		{ id: "small", name: "Small", contextWindow: 600_000, maxTokens: 4_000 },
		{ id: "large", name: "Large", contextWindow: 1_050_000, maxTokens: 4_000 },
	].map((model) => ({
		...model,
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}));
	writeFileSync(
		join(dir, "models.json"),
		JSON.stringify({
			providers: {
				fixture: {
					api: "openai-completions",
					baseUrl: "https://invalid.invalid",
					apiKey: "fixture-not-real",
					models,
				},
			},
		}),
	);
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel }));
	const sessionManager = SessionManager.inMemory(dir);
	if (storedModel) sessionManager.appendModelChange("fixture", storedModel);
	sessionManager.appendMessage({ role: "user", content: "x".repeat(600_585), timestamp: 1 });
	return { dir, target: { cwd: dir, agentDir: dir, sessionManager }, models };
}

describe("configured resume read-only admission", () => {
	it("installs classic preflight only after the initial runtime exists and multi-session dispatch has returned", () => {
		const source = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
		const dispatch = source.indexOf("await runMultiSessionHost({");
		const creation = source.indexOf("const runtime = await createAgentSessionRuntime(createRuntime,");
		const install = source.indexOf("createRuntime.prepareResume =");
		expect(dispatch).toBeGreaterThan(0);
		expect(creation).toBeGreaterThan(dispatch);
		expect(install).toBeGreaterThan(creation);
		expect(source.match(/createRuntime\.prepareResume =/g)).toHaveLength(1);
	});

	it("disposes an SDK admission rejection without cleaning provider resources or masking its budget error", async () => {
		const { dir, target } = fixture();
		const modelRuntime = await ModelRuntime.create({
			modelsPath: join(dir, "models.json"),
			modelsStore: new InMemoryCodingAgentModelsStore(),
		});
		const dispose = vi.spyOn(AgentSession.prototype, "dispose");
		const cleanup = vi.fn(() => {
			throw new Error("provider resources still owned by another runtime");
		});
		const unregister = registerSessionResourceCleanup(cleanup);
		try {
			await expect(
				createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, sessionManager: target.sessionManager }),
			).rejects.toMatchObject({
				name: "ModelUsabilityBudgetError",
				projection: { admission: "resume", usable: false },
			});
			expect(dispose).toHaveBeenCalledExactlyOnceWith({ skipProviderResourceCleanup: true });
			expect(cleanup).not.toHaveBeenCalled();
			const rejected = dispose.mock.contexts[0];
			if (!(rejected instanceof AgentSession)) throw new Error("missing rejected candidate");
			expect(rejected.extensionRunner.isActive).toBe(false);
		} finally {
			unregister();
		}
	});

	it("rejects the stored model before resource loading without changing files or session entries", async () => {
		const { dir, target } = fixture();
		const beforeFiles = new Map(readdirSync(dir).map((file) => [file, readFileSync(join(dir, file), "utf8")]));
		const beforeEntries = [...target.sessionManager.getEntries()];
		const reload = vi.spyOn(DefaultResourceLoader.prototype, "reload");
		const dispose = vi.spyOn(AgentSession.prototype, "dispose");
		await expect(prepareConfiguredSessionResume(parseArgs([]), target, true)).rejects.toMatchObject({
			name: "ModelUsabilityBudgetError",
			projection: {
				model: "fixture/small",
				contextWindow: 600_000,
				liveContextTokens: 600_585,
				admission: "resume",
				systemPromptTokens: 0,
				activeToolSchemaTokens: 0,
				speculationLeadTokens: 0,
			},
		});
		expect(reload).not.toHaveBeenCalled();
		expect(dispose).not.toHaveBeenCalled();
		expect(target.sessionManager.getEntries()).toEqual(beforeEntries);
		expect(new Map(readdirSync(dir).map((file) => [file, readFileSync(join(dir, file), "utf8")]))).toEqual(
			beforeFiles,
		);
	});

	it.each([
		["--model", "fixture/large"],
		["--provider", "fixture", "--model", "large"],
	])("honors an explicit larger-context model override: %j", async (...args) => {
		const { target } = fixture();
		await expect(prepareConfiguredSessionResume(parseArgs(args), target, true)).resolves.toBeUndefined();
	});

	it("uses the configured default only when the saved session has no model", async () => {
		const { target } = fixture("", "small");
		await expect(prepareConfiguredSessionResume(parseArgs([]), target, true)).rejects.toMatchObject({
			projection: { model: "fixture/small" },
		});
	});

	it("does not substitute a scoped model for the restored model during resume", async () => {
		const { target } = fixture();
		await expect(
			prepareConfiguredSessionResume(parseArgs(["--models", "fixture/large"]), target, true),
		).rejects.toMatchObject({
			projection: { model: "fixture/small" },
		});
	});

	it("defers unresolved stored models instead of rejecting their speculative fallback", async () => {
		const { target } = fixture("extension-only", "small");
		await expect(prepareConfiguredSessionResume(parseArgs([]), target, true)).resolves.toBeUndefined();
	});

	it("defers synthetic CLI models whose configured budget is unknown", async () => {
		const { target } = fixture();
		await expect(
			prepareConfiguredSessionResume(
				parseArgs(["--provider", "fixture", "--model", "extension-only"]),
				target,
				true,
			),
		).resolves.toBeUndefined();
	});

	it("defers same-id cached geometry mismatches even without extension registrations", async () => {
		const { dir, target } = fixture();
		const active = await ModelRuntime.create({
			modelsPath: join(dir, "models.json"),
			modelsStore: new InMemoryCodingAgentModelsStore(),
		});
		expect(active.getRegisteredProviderIds()).toEqual([]);
		const original = active.getModel.bind(active);
		vi.spyOn(active, "getModel").mockImplementation((provider, id) => {
			const model = original(provider, id);
			return model ? { ...model, contextWindow: 1_050_000 } : undefined;
		});
		await expect(prepareConfiguredSessionResume(parseArgs([]), target, true, active)).resolves.toBeUndefined();
	});

	it.each([0, -1])(
		"defers unknown/nonpositive context limits like final SDK admission (%s)",
		async (contextWindow) => {
			const { dir, target } = fixture();
			const runtime = await ModelRuntime.create({
				modelsPath: join(dir, "models.json"),
				modelsStore: new InMemoryCodingAgentModelsStore(),
			});
			const configured = runtime.getModel("fixture", "small");
			if (!configured) throw new Error("missing configured model");
			await expect(
				assertConfiguredSessionResumeUsable(
					{ model: { ...configured, contextWindow } },
					target.sessionManager,
					runtime,
					SettingsManager.create(dir, dir),
					[],
				),
			).resolves.toBeUndefined();
		},
	);

	it("defers speculative fallback when the saved session has no model and an extension may supply the default", async () => {
		const { target } = fixture("", "extension-only");
		await expect(prepareConfiguredSessionResume(parseArgs([]), target, true)).resolves.toBeUndefined();
	});

	it("does not reject a configured id whose active extension overrides its budget", async () => {
		const { dir, target, models } = fixture();
		const active = await ModelRuntime.create({
			modelsPath: join(dir, "models.json"),
			modelsStore: new InMemoryCodingAgentModelsStore(),
		});
		active.registerProvider(
			"fixture",
			{
				api: "openai-completions",
				baseUrl: "https://invalid.invalid",
				apiKey: "fixture-not-real",
				models: models.map((model) => ({ ...model, contextWindow: 1_050_000 })),
			},
			{ refresh: false },
		);
		await expect(prepareConfiguredSessionResume(parseArgs([]), target, true, active)).resolves.toBeUndefined();
	});

	it("rejects when the active extension corroborates the configured budget", async () => {
		const { dir, target, models } = fixture();
		const active = await ModelRuntime.create({
			modelsPath: join(dir, "models.json"),
			modelsStore: new InMemoryCodingAgentModelsStore(),
		});
		active.registerProvider(
			"fixture",
			{
				api: "openai-completions",
				baseUrl: "https://invalid.invalid",
				apiKey: "fixture-not-real",
				models,
			},
			{ refresh: false },
		);
		await expect(prepareConfiguredSessionResume(parseArgs([]), target, true, active)).rejects.toMatchObject({
			projection: { model: "fixture/small", contextWindow: 600_000 },
		});
	});
});
