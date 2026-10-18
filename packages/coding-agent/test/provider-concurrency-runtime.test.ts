import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, AssistantMessageEventStream, Model, Provider } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { collectSettingsDiagnostics, collectSettingsDiagnosticsWithContext } from "../src/core/settings-diagnostics.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";

const PROVIDER_ID = "concurrency-probe";

/** Slot hand-off is promise-based; one macrotask boundary is deterministic. Never a timed sleep. */
function flush(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function settingsManagerWith(settings: Settings): SettingsManager {
	const tempDir = mkdtempSync(join(tmpdir(), "provider-concurrency-"));
	tempDirs.push(tempDir);
	const agentDir = join(tempDir, "agent");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
	return SettingsManager.create(tempDir, agentDir);
}

function probeModel(): Model<Api> {
	return {
		id: "probe-model",
		name: "probe-model",
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function doneMessage(): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: PROVIDER_ID,
		model: "probe-model",
		content: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

class ProbeProvider {
	calls = 0;
	readonly streams: AssistantMessageEventStream[] = [];

	stream = (): AssistantMessageEventStream => {
		this.calls++;
		const stream = createAssistantMessageEventStream();
		this.streams.push(stream);
		return stream;
	};

	finish(index: number): void {
		this.streams[index]?.push({ type: "done", reason: "stop", message: doneMessage() });
	}
}

async function runtimeWith(settingsManager: SettingsManager): Promise<{ runtime: ModelRuntime; probe: ProbeProvider }> {
	const model = probeModel();
	const probe = new ProbeProvider();
	const provider: Provider = {
		id: PROVIDER_ID,
		name: "Concurrency probe",
		auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "test" }, source: "test" }) } },
		getModels: () => [model],
		stream: probe.stream,
		streamSimple: probe.stream,
	};
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
		settingsManager,
	});
	await runtime.registerNativeProvider(provider);
	return { runtime, probe };
}

function selectModel(runtime: ModelRuntime): Model<Api> {
	const selected = runtime.getModel(PROVIDER_ID, "probe-model");
	if (!selected) throw new Error("probe model was not registered");
	return selected;
}

describe("ModelRuntime provider concurrency", () => {
	it("serializes provider stream requests at the configured cap", async () => {
		const settingsManager = settingsManagerWith({ providers: { [PROVIDER_ID]: { maxConcurrency: 1 } } });
		const { runtime, probe } = await runtimeWith(settingsManager);
		const model = selectModel(runtime);

		const first = runtime.stream(model, { messages: [] });
		const second = runtime.stream(model, { messages: [] });
		await flush();

		expect(probe.calls).toBe(1);

		probe.finish(0);
		await first.result();
		await flush();

		expect(probe.calls).toBe(2);
		probe.finish(1);
		await second.result();
	});

	it("leaves an unconfigured provider unlimited", async () => {
		const settingsManager = settingsManagerWith({});
		const { runtime, probe } = await runtimeWith(settingsManager);
		const model = selectModel(runtime);

		const streams = [runtime.stream(model, { messages: [] }), runtime.stream(model, { messages: [] })];
		await flush();

		expect(probe.calls).toBe(2);
		probe.finish(0);
		probe.finish(1);
		await Promise.all(streams.map((stream) => stream.result()));
	});

	it("releases queued requests when the configured cap is raised", async () => {
		const settingsManager = settingsManagerWith({ providers: { [PROVIDER_ID]: { maxConcurrency: 1 } } });
		const { runtime, probe } = await runtimeWith(settingsManager);
		const model = selectModel(runtime);

		const first = runtime.stream(model, { messages: [] });
		const second = runtime.stream(model, { messages: [] });
		await flush();
		expect(probe.calls).toBe(1);

		settingsManager.applyOverrides({ providers: { [PROVIDER_ID]: { maxConcurrency: 2 } } });
		await flush();

		expect(probe.calls).toBe(2);
		probe.finish(0);
		probe.finish(1);
		await Promise.all([first.result(), second.result()]);
	});
});

describe("provider concurrency settings", () => {
	it("reads a configured cap and treats unset, zero, negative and fractional values as unlimited", () => {
		const settingsManager = settingsManagerWith({
			providers: {
				capped: { maxConcurrency: 3 },
				zero: { maxConcurrency: 0 },
				negative: { maxConcurrency: -1 },
				fractional: { maxConcurrency: 2.5 },
			},
		});

		expect(settingsManager.getProviderConcurrencyLimit("capped")).toBe(3);
		expect(settingsManager.getProviderConcurrencyLimit("zero")).toBe(Number.POSITIVE_INFINITY);
		expect(settingsManager.getProviderConcurrencyLimit("negative")).toBe(Number.POSITIVE_INFINITY);
		expect(settingsManager.getProviderConcurrencyLimit("fractional")).toBe(Number.POSITIVE_INFINITY);
		expect(settingsManager.getProviderConcurrencyLimit("unset")).toBe(Number.POSITIVE_INFINITY);
	});

	it("reports a diagnostic for a negative or fractional cap and stays silent for valid ones", () => {
		const settingsManager = settingsManagerWith({
			providers: { good: { maxConcurrency: 2 }, zero: { maxConcurrency: 0 }, bad: { maxConcurrency: -4 } },
		});

		const messages = collectSettingsDiagnostics(settingsManager).map((diagnostic) => diagnostic.message);

		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("providers.bad.maxConcurrency");
	});

	it("reports the same cap diagnostic through the context-prefixed collector the CLI startup uses", () => {
		const settingsManager = settingsManagerWith({
			providers: { good: { maxConcurrency: 2 }, bad: { maxConcurrency: -4 } },
		});

		const messages = collectSettingsDiagnosticsWithContext(settingsManager, "startup session lookup").map(
			(diagnostic) => diagnostic.message,
		);

		expect(messages).toEqual([
			"(startup session lookup) Invalid providers.bad.maxConcurrency: expected a non-negative integer; using unlimited",
		]);
	});
});
