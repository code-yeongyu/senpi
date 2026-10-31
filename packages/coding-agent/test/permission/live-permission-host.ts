import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ExtensionFactory } from "../../src/index.ts";
import { createTestUiContext } from "../suite/harness.ts";

export const ASK_TIMEOUT_MS = 5_000;

export interface PendingPrompt {
	readonly title: string;
	readonly options: readonly string[];
	resolve: (choice: string | undefined) => void;
}

export interface FixtureTool {
	readonly name: string;
	readonly input: Record<string, unknown>;
}

export const FIXTURE_TOOLS: readonly FixtureTool[] = [
	{ name: "task", input: { description: "probe", prompt: "probe" } },
	{ name: "browser", input: { action: "navigate", url: "https://example.invalid" } },
	{ name: "mcp_fixture", input: { value: "probe" } },
	{ name: "fetch_fixture", input: { url: "https://example.invalid" } },
	// A custom tool whose meaningful argument is free `input` (no URL, command or path).
	{ name: "query_fixture", input: { input: "probe" } },
	// Command-class stand-in for bash (bash itself is eval-exposed and never reaches the
	// tool_call permission gate): a no-network gated tool in the same permission family.
	{ name: "shell_fixture", input: { command: "echo probe-2465" } },
];

export const SHELL_FIXTURE_INPUT = { command: "echo probe-2465" } as const;

export const BASH_INPUT = { command: "echo probe-2465" } as const;
export const FETCH_INPUT = { url: "https://example.invalid/probe-2465" } as const;

export const readInside = (host: LivePermissionHost) => ({ path: join(host.cwd, "probe-read.txt") });
export const writeInside = (host: LivePermissionHost) => ({
	path: join(host.cwd, "probe-write.txt"),
	content: "probe",
});
export const editInside = (host: LivePermissionHost) => ({
	path: join(host.cwd, "probe-write.txt"),
	oldText: "probe",
	newText: "probed",
});
export const writeOutside = () => ({
	path: join(tmpdir(), `senpi-2465-external-${process.pid}.txt`),
	content: "external",
});

export function titlePermission(title: string): string {
	return title.split("\n", 1)[0].replace(/^Permission required:\s*/, "");
}

export interface LivePermissionHost {
	readonly runtimeHost: AgentSessionRuntime;
	readonly cwd: string;
	readonly agentDir: string;
	prompts(): number;
	waitForPrompt(): Promise<PendingPrompt>;
	bind(): Promise<void>;
	setPreset(preset: string): void;
	runProbe(toolName: string, input: Record<string, unknown>, text?: string): Promise<void>;
	toolResultText(toolName: string): string;
	toolResultIsError(toolName: string): boolean;
	forkLastUserMessage(): Promise<void>;
}

export interface LiveHostOptions {
	readonly preset: string;
	readonly projectSettings?: Record<string, unknown>;
	readonly globalSettings?: Record<string, unknown>;
	readonly persist?: boolean;
	readonly shareHostWith?: LivePermissionHost;
}

const closers: Array<() => Promise<void> | void> = [];
let hostCounter = 0;

export async function closeLiveHosts(): Promise<void> {
	while (closers.length > 0) {
		await closers.pop()?.();
	}
}

function lastToolResult(host: AgentSessionRuntime, toolName: string): ToolResultMessage {
	const result = host.session.messages.findLast(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === toolName,
	);
	if (!result) throw new Error(`no ${toolName} tool result`);
	return result;
}

export async function createLiveHost(options: LiveHostOptions): Promise<LivePermissionHost> {
	hostCounter += 1;
	const shared = options.shareHostWith;
	const tempDir = shared
		? shared.cwd
		: join(tmpdir(), `senpi-2465-live-${Date.now()}-${hostCounter}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	const agentDir = shared ? shared.agentDir : join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	if (options.globalSettings) {
		writeFileSyncPortable(join(agentDir, "settings.json"), options.globalSettings);
	}
	if (options.projectSettings) {
		mkdirSync(join(tempDir, ".senpi"), { recursive: true });
		writeFileSyncPortable(join(tempDir, ".senpi", "settings.json"), options.projectSettings);
	}

	const lane = `faux-2465-${hostCounter}-${Math.random().toString(36).slice(2)}`;
	const faux = registerFauxProvider({ api: `${lane}-api`, provider: lane });
	faux.setResponses([]);
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(tempDir, `models-${hostCounter}.json`),
	});
	const model = faux.getModel();
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

	const toolExtension: ExtensionFactory = (pi) => {
		for (const fixture of FIXTURE_TOOLS) {
			pi.registerTool({
				name: fixture.name,
				label: fixture.name,
				description: `fixture ${fixture.name}`,
				parameters: Type.Object({}, { additionalProperties: true }),
				async execute() {
					return { content: [{ type: "text", text: `${fixture.name} executed` }], details: {} };
				},
			});
		}
	};

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		// permission-system is a builtin and loads with the default set; only the fixture tools
		// need an explicit factory. Registering it here too would double the tool_call handler and
		// ask twice per call.
		const services = await createAgentSessionServices({
			agentDir,
			modelRuntime,
			resourceLoaderOptions: {
				extensionFactories: [toolExtension],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
			cwd,
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model,
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};

	const runtimeHost = await createAgentSessionRuntime(createRuntime, {
		cwd: tempDir,
		agentDir,
		sessionManager: options.persist
			? SessionManager.create(tempDir, join(tempDir, "sessions"))
			: SessionManager.inMemory(tempDir),
		launchProfile: { cwd: tempDir, permissionPreset: options.preset },
	});
	runtimeHost.session.extensionRunner.setFlagValue("permission-preset", options.preset);

	let promptCount = 0;
	const pending: PendingPrompt[] = [];
	const waiters: Array<(prompt: PendingPrompt) => void> = [];

	const host: LivePermissionHost = {
		runtimeHost,
		cwd: tempDir,
		agentDir,
		prompts: () => promptCount,
		waitForPrompt: () =>
			new Promise<PendingPrompt>((resolve, reject) => {
				const existing = pending.shift();
				if (existing) {
					resolve(existing);
					return;
				}
				const timer = setTimeout(
					() => reject(new Error("timed out waiting for a permission prompt")),
					ASK_TIMEOUT_MS,
				);
				waiters.push((prompt) => {
					clearTimeout(timer);
					resolve(prompt);
				});
			}),
		bind: async () => {
			await runtimeHost.session.bindExtensions({
				uiContext: createTestUiContext({
					select: (title: string, options: string[] = []) => {
						promptCount += 1;
						return new Promise<string | undefined>((resolve) => {
							const prompt: PendingPrompt = { title, options, resolve };
							const waiter = waiters.shift();
							if (waiter) waiter(prompt);
							else pending.push(prompt);
						});
					},
				}),
			});
		},
		setPreset: (preset) => {
			runtimeHost.setPermissionPreset(preset);
		},
		runProbe: async (toolName, input, text = "probe") => {
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall(toolName, input as never), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await runtimeHost.session.prompt(text);
		},
		toolResultText: (toolName) =>
			lastToolResult(runtimeHost, toolName)
				.content.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
		toolResultIsError: (toolName) => lastToolResult(runtimeHost, toolName).isError,
		forkLastUserMessage: async () => {
			const candidates = runtimeHost.session.getUserMessagesForForking();
			const last = candidates.at(-1);
			if (!last) throw new Error("no user message to fork");
			await runtimeHost.fork(last.entryId);
		},
	};

	closers.push(async () => {
		for (const prompt of pending.splice(0)) prompt.resolve(undefined);
		await runtimeHost.dispose();
		faux.unregister();
		if (!shared && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	return host;
}

function writeFileSyncPortable(path: string, value: Record<string, unknown>): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
