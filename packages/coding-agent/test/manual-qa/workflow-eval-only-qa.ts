/**
 * Real-surface QA driver for experimental.workflowEvalOnly.
 *
 * Drives the shipped SDK entrypoint (createAgentSession) against a scratch
 * project directory whose .senpi/settings.json carries the flag, using the
 * faux provider so no credentials or network model calls are involved.
 *
 * Usage: npx tsx test/manual-qa/workflow-eval-only-qa.ts <scratchDir> <mode:armed|control> <outDir>
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession, type ExtensionFactory } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";

const [scratchDir, mode, outDir] = process.argv.slice(2);
if (!scratchDir || !mode || !outDir) {
	throw new Error("usage: workflow-eval-only-qa.ts <scratchDir> <armed|control> <outDir>");
}

const lines: string[] = [];
function log(line: string): void {
	lines.push(line);
	process.stdout.write(`${line}\n`);
}

const toolCallReceipts: Array<{ toolName: string; input: unknown }> = [];

async function main(): Promise<void> {
	const agentDir = join(scratchDir, "agent-dir");
	mkdirSync(agentDir, { recursive: true });
	const projectSettingsPath = join(scratchDir, CONFIG_DIR_NAME, "settings.json");
	mkdirSync(join(scratchDir, CONFIG_DIR_NAME), { recursive: true });
	// The project settings file is the real surface the flag ships on.
	writeFileSync(
		projectSettingsPath,
		`${JSON.stringify({ experimental: { workflowEvalOnly: mode === "armed" } }, null, 2)}\n`,
	);

	const faux = registerFauxProvider({});
	const model = faux.getModel();
	faux.setResponses([]);

	// Faux credentials only: no real provider key and no network model call.
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
	});

	// The eval tool stands in for codemode's registration: the policy is only
	// armed while a tool named "eval" is present in the registry. The workflow
	// tool stands in for the external extension that registers it at runtime.
	const extensionFactory: ExtensionFactory = (pi) => {
		pi.registerTool({
			name: "eval",
			label: "Eval",
			description: "Evaluate code in a persistent kernel",
			parameters: Type.Object({ code: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "eval" }], details: {} }),
		});
		pi.registerTool({
			name: "workflow",
			label: "Workflow",
			description: "Run a workflow action",
			parameters: Type.Object({ action: Type.String() }),
			execute: async (_toolCallId, params) => ({
				content: [{ type: "text", text: `workflow-ran:${params.action}` }],
				details: {},
			}),
		});
		pi.on("tool_call", (event) => {
			toolCallReceipts.push({ toolName: event.toolName, input: event.input });
		});
	};

	const settingsManager = SettingsManager.create(scratchDir, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: scratchDir,
		agentDir,
		settingsManager,
		extensionFactories: [extensionFactory],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: scratchDir,
		agentDir,
		model,
		settingsManager,
		resourceLoader,
		authStorage,
		modelRegistry,
		sessionManager: SessionManager.inMemory(scratchDir),
	});

	try {
		log(`# workflow-eval-only QA (${mode})`);
		log(`scratch: ${scratchDir}`);
		log(`project settings file: ${projectSettingsPath}`);
		log(`getExperimentalWorkflowEvalOnly(): ${settingsManager.getExperimentalWorkflowEvalOnly()}`);
		log(`getExperimentalBashEvalOnly(): ${settingsManager.getExperimentalBashEvalOnly()}`);
		log("");

		// (i) active tool list
		const activeTools = session.getActiveToolNames();
		log("## (i) active tool names");
		log(JSON.stringify(activeTools));
		log(`workflow present: ${activeTools.includes("workflow")}`);
		log(`bash present: ${activeTools.includes("bash")}`);
		log(`eval present: ${activeTools.includes("eval")}`);
		log(`all registered tools include workflow: ${session.getAllTools().some((tool) => tool.name === "workflow")}`);
		log("");

		// (ii) system prompt sentinel
		const prompt = session.systemPrompt;
		const sentinel = "tool.workflow(";
		const sentinelIndex = prompt.indexOf(sentinel);
		log('## (ii) system prompt sentinel "tool.workflow("');
		log(`contains sentinel: ${sentinelIndex >= 0}`);
		log(`contains shell sentinel "tool.bash(": ${prompt.includes("tool.bash(")}`);
		if (sentinelIndex >= 0) {
			log(
				`sentinel line: ${prompt
					.slice(Math.max(0, sentinelIndex - 200), sentinelIndex + 120)
					.split("\n")
					.pop()}`,
			);
		}
		log("");

		// (iii) executeTool workflow through the full pipeline
		log('## (iii) executeTool("workflow", { action: "qa-ok" })');
		try {
			const result = await session.executeTool("workflow", { action: "qa-ok" });
			const text = result.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			log(`output contains "qa-ok": ${text.includes("qa-ok")}`);
			log(`output: ${JSON.stringify(text.slice(0, 400))}`);
		} catch (error) {
			log(`executeTool threw: ${error instanceof Error ? error.message : String(error)}`);
		}
		log(`tool_call receipts: ${JSON.stringify(toolCallReceipts)}`);
		log(`active tools after execute: ${JSON.stringify(session.getActiveToolNames())}`);
		log(`workflow reactivated: ${session.getActiveToolNames().includes("workflow")}`);
		log("");

		// (iv) redirect hint for a direct/unknown workflow call from the model
		log("## (iv) redirect hint for a direct model workflow call");
		const hints = (session as unknown as { agent: { removedToolHints: Record<string, string> } }).agent
			.removedToolHints;
		log(`removedToolHints.workflow: ${JSON.stringify(hints.workflow)}`);
		log(`removedToolHints.bash: ${JSON.stringify(hints.bash)}`);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("workflow", { action: "direct-call" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await session.prompt("run workflow directly");
		const toolResult = session.messages.find((message) => message.role === "toolResult");
		const resultText =
			toolResult && "content" in toolResult
				? JSON.stringify((toolResult.content as Array<{ text?: string }>)[0]?.text ?? "")
				: "<no toolResult>";
		log(`model-issued workflow toolResult: ${resultText}`);
		log("");

		writeFileSync(join(outDir, `tool-call-receipts-${mode}.json`), `${JSON.stringify(toolCallReceipts, null, 2)}\n`);
		writeFileSync(join(outDir, `system-prompt-${mode}.txt`), prompt);
		log(`receipts file: ${join(outDir, `tool-call-receipts-${mode}.json`)}`);
		log(`system prompt file: ${join(outDir, `system-prompt-${mode}.txt`)}`);
	} finally {
		session.dispose();
		faux.unregister();
	}
}

await main();
writeFileSync(join(outDir, `${mode}.log`), `${lines.join("\n")}\n`);
