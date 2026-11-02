import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	type AgentSessionServices,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import type { AgentSession } from "../../src/core/agent-session.ts";

export async function resumeRuntime(
	extension: (pi: ExtensionAPI) => void | Promise<void> = () => {},
	contextWindow?: number,
	options: {
		compactionEnabled?: boolean;
		resumeContextWindow?: number;
		modelRuntime?: ModelRuntime;
		configureServices?: (services: AgentSessionServices, candidate: boolean) => void;
		afterCreate?: (session: AgentSession) => void;
	} = {},
) {
	// Environment-context projections mint their timestamp when read; time is not under test here.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-11-02T00:00:00Z"));
	const cwd = mkdtempSync(join(tmpdir(), "pr1473-runtime-"));
	const faux = registerFauxProvider(
		contextWindow ? { models: [{ id: "large", contextWindow, maxTokens: 1024 }] } : {},
	);
	faux.setResponses([fauxAssistantMessage("stored"), fauxAssistantMessage("follow-up")]);
	let factories = 0;
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		factories++;
		const services = await createAgentSessionServices({
			cwd,
			agentDir: cwd,
			modelRuntime: options.modelRuntime,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [
					async (pi) => {
						const model = faux.getModel();
						pi.registerProvider(model.provider, {
							baseUrl: model.baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((m) => ({
								id: m.id,
								name: m.name,
								api: m.api,
								reasoning: m.reasoning,
								input: m.input,
								cost: m.cost,
								contextWindow: m.contextWindow,
								maxTokens: m.maxTokens,
							})),
						});
						await extension(pi);
					},
				],
			},
		});
		services.settingsManager.applyOverrides({ compaction: { enabled: options.compactionEnabled ?? true } });
		options.configureServices?.(services, sessionManager.isPrepared());
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model:
				sessionStartEvent?.reason === "resume" && options.resumeContextWindow !== undefined
					? { ...faux.getModel(), contextWindow: options.resumeContextWindow }
					: faux.getModel(),
		});
		if (sessionStartEvent?.reason === "resume") options.afterCreate?.(created.session);
		return {
			...created,
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir: cwd,
		sessionManager: SessionManager.create(cwd, join(cwd, "sessions")),
	});
	await runtime.session.bindExtensions({});
	runtime.setRebindSession(async (session) => {
		await session.bindExtensions({});
	});
	return {
		runtime,
		faux,
		cwd,
		factories: () => factories,
		async dispose() {
			try {
				await runtime.dispose();
			} finally {
				faux.unregister();
				vi.useRealTimers();
				rmSync(cwd, { recursive: true, force: true });
			}
		},
	};
}

export async function deadline<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("PR1473 event deadline")), 10_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
