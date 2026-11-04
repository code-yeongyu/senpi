// S18b part 3: execution-pipeline receipts go to a sink OUTSIDE the session. A session takes the sink it is given;
// without one, SENPI_EXECUTION_PIPELINE_WITNESS names a file that gets one JSON line per call; with neither, no receipts.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import { resolveWitnessSink } from "../../src/core/execution/pipeline-witness-sink.ts";

const dirs: string[] = [];
const fauxRegistrations: Array<{ unregister(): void }> = [];
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const registration of fauxRegistrations.splice(0)) registration.unregister();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const witnessFile = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "pipeline-witness-"));
	dirs.push(dir);
	return join(dir, "witness.jsonl");
};
const lines = (path: string): unknown[] =>
	readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line));

async function session() {
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	return {
		modelRuntime,
		cwd: process.cwd(),
		settingsManager: SettingsManager.inMemory(),
		sessionManager: SessionManager.inMemory(),
	};
}

describe("resolveWitnessSink", () => {
	it("takes the configured sink over the env file", () => {
		const sink = () => {};
		expect(resolveWitnessSink(sink, { SENPI_EXECUTION_PIPELINE_WITNESS: witnessFile() })).toBe(sink);
	});

	it("appends one JSON line per receipt to the env file", () => {
		const path = witnessFile();
		const sink = resolveWitnessSink(undefined, { SENPI_EXECUTION_PIPELINE_WITNESS: path });
		sink?.({ pipeline: "prepared", toolCallId: "call-1" });
		sink?.({ pipeline: "prepared", toolCallId: "call-2" });
		expect(lines(path)).toEqual([
			{ pipeline: "prepared", toolCallId: "call-1" },
			{ pipeline: "prepared", toolCallId: "call-2" },
		]);
	});

	it("installs no sink when neither is set", () => {
		expect(resolveWitnessSink(undefined, {})).toBeUndefined();
		expect(resolveWitnessSink(undefined, { SENPI_EXECUTION_PIPELINE_WITNESS: "" })).toBeUndefined();
	});
});

describe("createAgentSession", () => {
	it("gives the session's agent the configured witness sink", async () => {
		const sink = vi.fn();
		const { session: created } = await createAgentSession({ ...(await session()), executionPipelineWitness: sink });
		expect(created.agent.onExecutionPipeline).toBe(sink);
	});

	it("writes receipts to the SENPI_EXECUTION_PIPELINE_WITNESS file when it is given no sink", async () => {
		const path = witnessFile();
		vi.stubEnv("SENPI_EXECUTION_PIPELINE_WITNESS", path);
		const { session: created } = await createAgentSession(await session());
		await created.agent.onExecutionPipeline?.({ pipeline: "prepared", toolCallId: "call-1" });
		expect(lines(path)).toEqual([{ pipeline: "prepared", toolCallId: "call-1" }]);
	});
});

describe("the witness sink's edges", () => {
	it("reports a receipt it cannot write as a warning instead of throwing into the tool batch", () => {
		const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		const sink = resolveWitnessSink(undefined, {
			SENPI_EXECUTION_PIPELINE_WITNESS: join(witnessFile(), "missing", "w.jsonl"),
		});
		expect(() => sink?.({ pipeline: "legacy", toolCallId: "call-1" })).not.toThrow();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("execution-pipeline witness not written"),
			"ExecutionPipelineWitnessWarning",
		);
	});
});

async function fauxServices() {
	const faux = registerFauxProvider();
	fauxRegistrations.push(faux);
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const dir = mkdtempSync(join(tmpdir(), "pipeline-witness-services-"));
	dirs.push(dir);
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: join(dir, "models.json") });
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});
	const services = await createAgentSessionServices({
		cwd: dir,
		agentDir: dir,
		modelRuntime,
		resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
	});
	return { faux, model, services, cwd: dir };
}

describe("createAgentSessionFromServices", () => {
	it("passes the configured witness sink to the session's agent", async () => {
		const { model, services } = await fauxServices();
		const sink = vi.fn();
		const { session: created } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(),
			model,
			executionPipelineWitness: sink,
		});
		expect(created.agent.onExecutionPipeline).toBe(sink);
	});

	it.each([
		["default (unset)", "prepared", {}],
		["legacy", "legacy", { SENPI_EXECUTION_PIPELINE: "legacy" }],
		["prepared", "prepared", { SENPI_EXECUTION_PIPELINE: "prepared" }],
	] as const)(
		"writes a real %s tool call's receipt to the env file and keeps receipts out of the session",
		async (_label, pipeline, pipelineEnv) => {
			const path = witnessFile();
			vi.stubEnv("SENPI_EXECUTION_PIPELINE_WITNESS", path);
			for (const [key, value] of Object.entries(pipelineEnv)) vi.stubEnv(key, value);
			const { faux, model, services, cwd } = await fauxServices();
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: join(cwd, "absent.txt") }, { id: "call-read" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			const sessionManager = SessionManager.inMemory();
			const { session: created } = await createAgentSessionFromServices({
				services,
				sessionManager,
				model,
				tools: ["read"],
			});
			await created.prompt("read it");
			expect(lines(path)).toEqual([{ pipeline, toolCallId: "call-read" }]);
			expect(
				sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === "execution-pipeline"),
			).toEqual([]);
		},
	);
});
