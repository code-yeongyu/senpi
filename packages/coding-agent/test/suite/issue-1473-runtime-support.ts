import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

export async function resumeRuntime(extension: (pi: ExtensionAPI) => void = () => {}, contextWindow?: number) {
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
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [
					(pi) => {
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
						extension(pi);
					},
				],
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: faux.getModel(),
			})),
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
