import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
import cmdCliExtension, {
	CMD_CLI_DISPLAY_NAME,
	CMD_CLI_PROVIDER_ID,
	isCmdCliProviderEnabled,
	readCmdCliSettings,
	registerCmdCliExtension,
} from "../../src/core/extensions/builtin/cmd-cli/index.ts";
import { STATIC_CMD_CLI_MODELS } from "../../src/core/extensions/builtin/cmd-cli/models.ts";
import {
	createExtensionRuntime,
	drainPendingProviderRegistrations,
	loadExtensionFromFactory,
} from "../../src/core/extensions/loader.ts";
import type { ExtensionAPI, ProviderConfig } from "../../src/core/extensions/types.ts";

const testModel: Model<Api> = {
	id: "default",
	name: "Command Code CLI (Default)",
	api: "cmd-cli",
	provider: "cmd-cli",
	baseUrl: "cmd-cli",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};

const testContext: Context = {
	messages: [{ role: "user", content: "ping", timestamp: 1 }],
};

function createMockExtensionApi(settings: Record<string, unknown> = {}): ExtensionAPI & {
	registeredProviders: Array<{ id: string; config: ProviderConfig }>;
} {
	const registeredProviders: Array<{ id: string; config: ProviderConfig }> = [];
	return {
		getSettings: () => settings,
		registerProvider: (idOrProvider: string | (ProviderConfig & { id: string }), config?: ProviderConfig) => {
			if (typeof idOrProvider === "string" && config) {
				registeredProviders.push({ id: idOrProvider, config });
			} else if (typeof idOrProvider !== "string") {
				registeredProviders.push({ id: idOrProvider.id, config: idOrProvider });
			}
		},
		registeredProviders,
	} as unknown as ExtensionAPI & { registeredProviders: Array<{ id: string; config: ProviderConfig }> };
}

function createTempWorkspace(settings?: Record<string, unknown>): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "senpi-cmd-cli-provider-test-"));
	if (settings !== undefined) {
		const targetDirs = new Set([".senpi", CONFIG_DIR_NAME]);
		for (const configDir of targetDirs) {
			const targetConfigDir = join(dir, configDir);
			mkdirSync(targetConfigDir, { recursive: true });
			writeFileSync(join(targetConfigDir, "settings.json"), JSON.stringify(settings));
		}
	}
	return {
		dir,
		cleanup: () => {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		},
	};
}

describe("cmd-cli provider extension (unit tests)", () => {
	it("is disabled by default when cmdCliProvider setting is omitted", () => {
		const api = createMockExtensionApi({});
		expect(isCmdCliProviderEnabled(api)).toBe(false);

		registerCmdCliExtension(api);
		expect(api.registeredProviders).toHaveLength(0);
	});

	it("is not registered when cmdCliProvider.enabled is false", () => {
		const api = createMockExtensionApi({
			cmdCliProvider: { enabled: false },
		});
		expect(isCmdCliProviderEnabled(api)).toBe(false);

		registerCmdCliExtension(api);
		expect(api.registeredProviders).toHaveLength(0);
	});

	it("registers provider when cmdCliProvider.enabled is explicitly true", () => {
		const api = createMockExtensionApi({
			cmdCliProvider: { enabled: true },
		});
		expect(isCmdCliProviderEnabled(api)).toBe(true);

		registerCmdCliExtension(api);
		expect(api.registeredProviders).toHaveLength(1);
		const registered = api.registeredProviders[0];
		expect(registered.id).toBe(CMD_CLI_PROVIDER_ID);
		expect(registered.config.name).toBe(CMD_CLI_DISPLAY_NAME);
		expect(registered.config.baseUrl).toBe(CMD_CLI_PROVIDER_ID);
		expect(registered.config.apiKey).toBe(CMD_CLI_PROVIDER_ID);
		expect(registered.config.api).toBe(CMD_CLI_PROVIDER_ID);
		expect(registered.config.models).toEqual(STATIC_CMD_CLI_MODELS);
		expect(typeof registered.config.refreshModels).toBe("function");
		expect(typeof registered.config.streamSimple).toBe("function");
	});

	it("default export delegates to registerCmdCliExtension", () => {
		const api = createMockExtensionApi({
			cmdCliProvider: { enabled: true },
		});
		cmdCliExtension(api);
		expect(api.registeredProviders).toHaveLength(1);
		expect(api.registeredProviders[0].id).toBe(CMD_CLI_PROVIDER_ID);
		expect(api.registeredProviders[0].config.apiKey).toBe(CMD_CLI_PROVIDER_ID);
	});

	it("refreshModels returns resolved models", async () => {
		const api = createMockExtensionApi({
			cmdCliProvider: { enabled: true },
		});
		registerCmdCliExtension(api, {
			executableDeps: {
				env: () => undefined,
				settings: {},
				isExecutableFile: () => false,
			},
		});
		const provider = api.registeredProviders[0];
		const { refreshModels } = provider.config;
		if (!refreshModels) throw new Error("provider must expose refreshModels");
		const models = await refreshModels({} as Parameters<typeof refreshModels>[0]);
		expect(models).toEqual(STATIC_CMD_CLI_MODELS);
	});

	it("reads settings helper parses cmdCliProvider structure", () => {
		const api = createMockExtensionApi({
			cmdCliProvider: { enabled: true, executablePath: "/custom/bin/cmd" },
		});
		const settings = readCmdCliSettings(api);
		expect(settings).toEqual({ enabled: true, executablePath: "/custom/bin/cmd" });
	});
});

describe("cmd-cli provider extension (extension loading boundary)", () => {
	it("default behavior: loading succeeds without error and 0 providers queued when settings omitted", async () => {
		const { dir, cleanup } = createTempWorkspace();
		try {
			const runtime = createExtensionRuntime();
			const eventBus = createEventBus();
			await expect(
				loadExtensionFromFactory(cmdCliExtension, dir, eventBus, runtime, "<builtin:cmd-cli>"),
			).resolves.toBeDefined();
			const queued = drainPendingProviderRegistrations(runtime);
			expect(queued).toHaveLength(0);
		} finally {
			cleanup();
		}
	});

	it("default behavior: loading succeeds without error and 0 providers queued when settings are empty", async () => {
		const { dir, cleanup } = createTempWorkspace({});
		try {
			const runtime = createExtensionRuntime();
			const eventBus = createEventBus();
			await expect(
				loadExtensionFromFactory(cmdCliExtension, dir, eventBus, runtime, "<builtin:cmd-cli>"),
			).resolves.toBeDefined();
			const queued = drainPendingProviderRegistrations(runtime);
			expect(queued).toHaveLength(0);
		} finally {
			cleanup();
		}
	});

	it("disabled behavior: loading succeeds without error and 0 providers queued when cmdCliProvider.enabled is false", async () => {
		const { dir, cleanup } = createTempWorkspace({
			cmdCliProvider: { enabled: false },
		});
		try {
			const runtime = createExtensionRuntime();
			const eventBus = createEventBus();
			await expect(
				loadExtensionFromFactory(cmdCliExtension, dir, eventBus, runtime, "<builtin:cmd-cli>"),
			).resolves.toBeDefined();
			const queued = drainPendingProviderRegistrations(runtime);
			expect(queued).toHaveLength(0);
		} finally {
			cleanup();
		}
	});

	it("enabled behavior: loading succeeds without error and registers 1 provider with expected descriptor", async () => {
		const { dir, cleanup } = createTempWorkspace({
			cmdCliProvider: { enabled: true },
		});
		try {
			const runtime = createExtensionRuntime();
			const eventBus = createEventBus();
			await expect(
				loadExtensionFromFactory(cmdCliExtension, dir, eventBus, runtime, "<builtin:cmd-cli>"),
			).resolves.toBeDefined();
			const queued = drainPendingProviderRegistrations(runtime);
			expect(queued).toHaveLength(1);

			const registered = queued[0];
			expect(registered.kind).toBe("config");
			if (registered.kind === "config") {
				expect(registered.name).toBe(CMD_CLI_PROVIDER_ID);
				expect(registered.config.name).toBe(CMD_CLI_DISPLAY_NAME);
				expect(registered.config.apiKey).toBe(CMD_CLI_PROVIDER_ID);
				expect(registered.config.baseUrl).toBe(CMD_CLI_PROVIDER_ID);
				expect(registered.config.api).toBe(CMD_CLI_PROVIDER_ID);
				expect(registered.config.models).toEqual(STATIC_CMD_CLI_MODELS);
				expect(typeof registered.config.refreshModels).toBe("function");
				expect(typeof registered.config.streamSimple).toBe("function");
			}
		} finally {
			cleanup();
		}
	});

	it("executablePath forwarding: configured executablePath in settings is passed to executableDeps for refreshModels and streamSimple", async () => {
		const mockBinDir = mkdtempSync(join(tmpdir(), "senpi-mock-bin-"));
		const mockCmdScript = join(mockBinDir, "custom-cmd.js");
		const scriptContent = `#!/usr/bin/env node
if (process.argv.includes("--list-models")) {
  process.stdout.write("forwarded-model  Forwarded Custom Model\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ type: "event", event: { type: "text_delta", delta: "forwarded-ok" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: "stop" }) + "\\n");
process.exit(0);
`;
		writeFileSync(mockCmdScript, scriptContent, { mode: 0o755 });
		chmodSync(mockCmdScript, 0o755);

		const { dir, cleanup } = createTempWorkspace({
			cmdCliProvider: {
				enabled: true,
				executablePath: mockCmdScript,
			},
		});
		try {
			const runtime = createExtensionRuntime();
			const eventBus = createEventBus();
			await loadExtensionFromFactory(cmdCliExtension, dir, eventBus, runtime, "<builtin:cmd-cli>");
			const queued = drainPendingProviderRegistrations(runtime);
			expect(queued).toHaveLength(1);

			const registered = queued[0];
			expect(registered.kind).toBe("config");
			if (registered.kind !== "config") return;

			// Verify refreshModels executed the custom executablePath
			const { refreshModels, streamSimple } = registered.config;
			if (!refreshModels || !streamSimple) throw new Error("provider must expose refreshModels and streamSimple");
			const models = await refreshModels({} as Parameters<typeof refreshModels>[0]);
			expect(models.map((m) => m.id)).toContain("forwarded-model");

			// Verify streamSimple executed the custom executablePath
			const stream = streamSimple(testModel, testContext as Parameters<typeof streamSimple>[1], {});
			const events: AssistantMessageEvent[] = [];
			for await (const event of stream) {
				events.push(event);
			}

			const textDeltas = events.filter((e) => e.type === "text_delta");
			expect(textDeltas.length).toBeGreaterThanOrEqual(1);
			if (textDeltas[0].type === "text_delta") {
				expect(textDeltas[0].delta).toBe("forwarded-ok");
			}
		} finally {
			cleanup();
			try {
				rmSync(mockBinDir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}
	});
});
