// senpi#5728 (S36): one production-built session (services -> createAgentSessionFromServices -> createAgentSession) whose
// faux model issues one tool call, and a witness sink that resolves when the call enters its pipeline.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionPipelineWitness } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import type { ExtensionAPI } from "../../../src/index.ts";

export const preparedCall = [{ pipeline: "prepared", toolCallId: "entry-call" }];

export type Cleanups = Array<() => Promise<void> | void>;

export interface Witnessed {
	readonly witnesses: ExecutionPipelineWitness[];
	readonly witnessed: Promise<void>;
}

export function watch(runtime: AgentSessionRuntime): Witnessed {
	const witnesses: ExecutionPipelineWitness[] = [];
	let settle = (): void => {};
	const witnessed = new Promise<void>((resolve) => {
		settle = resolve;
	});
	runtime.session.agent.onExecutionPipeline = (witness) => {
		witnesses.push(witness);
		settle();
	};
	return { witnesses, witnessed };
}

export async function productionFactory(
	cleanups: Cleanups,
): Promise<{ dir: string; createRuntime: CreateAgentSessionRuntimeFactory }> {
	const dir = join(tmpdir(), `s36-entry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	const faux = registerFauxProvider({ models: [{ id: "faux-entry", reasoning: false }] });
	const call = { ...fauxToolCall("entry_probe", {}), id: "entry-call" };
	faux.setResponses([fauxAssistantMessage([call], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
	const model = faux.getModel();
	const extension = (pi: ExtensionAPI) => {
		pi.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((registered) => ({ ...registered })),
		});
		pi.registerTool({
			name: "entry_probe",
			label: "probe",
			description: "fixture",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "probed" }], details: {} }),
		});
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			agentDir: dir,
			cwd,
			resourceLoaderOptions: {
				extensionFactories: [extension],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
			services,
			diagnostics: services.diagnostics,
		};
	};
	cleanups.push(() => {
		faux.unregister();
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	});
	return { dir, createRuntime };
}
