import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentToolResult,
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@code-yeongyu/senpi";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import senpiCodemode from "../src/index.ts";
import type { CodeModeToolDetails } from "../src/codemode/tools.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";

class QaScenarioError extends Error {
	readonly name = "QaScenarioError";
}

async function main(): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "senpi-gpt-code-mode-agent-"));
	const cwd = await mkdtemp(join(tmpdir(), "senpi-gpt-code-mode-"));
	const evidenceDir = evidenceDirectory();
	await mkdir(evidenceDir, { recursive: true });
	await mkdir(join(cwd, ".senpi"), { recursive: true });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enabledBuiltinExtensions: [] }));
	await writeFile(join(cwd, "input.txt"), "gpt-code-mode-value\n");

	const settingsManager = SettingsManager.create(cwd, agentDir);
	const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"));
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [{ name: "senpi-codemode-qa", factory: senpiCodemode }],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const created = await createAgentSession({
			cwd,
			agentDir,
			settingsManager,
			sessionManager,
			resourceLoader,
			model: gptModel(),
			autoTitleSessions: false,
		});
		session = created.session;
		const extensionErrors: string[] = [];
		await session.bindExtensions({
			mode: "print",
			onError: (error) => extensionErrors.push(`${error.event}: ${error.error}`),
		});
		await verifySurface(session, evidenceDir, extensionErrors);
	} finally {
		if (session !== undefined) {
			try {
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			} finally {
				session.dispose();
			}
		}
		await rm(cwd, { recursive: true, force: true });
		await rm(agentDir, { recursive: true, force: true });
	}
}

async function verifySurface(
	session: Awaited<ReturnType<typeof createAgentSession>>["session"],
	evidenceDir: string,
	extensionErrors: readonly string[],
): Promise<void> {
	const exec = session.getToolDefinition("exec");
	const wait = session.getToolDefinition("wait");
	const evalTool = session.getToolDefinition("eval");
	if (exec === undefined || wait === undefined || evalTool === undefined) {
		throw new QaScenarioError(
			`GPT session did not expose eval, exec, and wait together; registered=${session
				.getAllTools()
				.map((tool) => tool.name)
				.join(",")}; active=${session.extensionRunner.getActiveTools().join(",")}; extensionErrors=${extensionErrors.join("|")}`,
		);
	}

	const nestedStarted = await session.executeTool<CodeModeToolDetails>("exec", {
		code: 'const file = await tools.read({ path: "input.txt" }); print(file.text);',
		yield_time_ms: 1_000,
	});
	const nested = await settleCell(session, nestedStarted);
	const nestedText = textOf(nested);
	if (!nestedText.includes("gpt-code-mode-value") || nested.details.state !== "result") {
		throw new QaScenarioError(`nested tool scenario failed: ${nestedText}`);
	}

	const yielded = await session.executeTool<CodeModeToolDetails>("exec", {
		code: 'await new Promise((resolve) => setTimeout(resolve, 50)); print("gpt-code-mode-resumed");',
		yield_time_ms: 1,
	});
	if (yielded.details.state !== "yielded") throw new QaScenarioError("exec did not return a yielded cell");
	const resumed = await session.executeTool<CodeModeToolDetails>("wait", {
		cell_id: yielded.details.cellId,
		yield_time_ms: 5_000,
	});
	const resumedText = textOf(resumed);
	if (resumed.details.state !== "result" || !resumedText.includes("gpt-code-mode-resumed")) {
		throw new QaScenarioError(`wait scenario failed: ${resumedText}`);
	}

	const evalResult = await session.executeTool<EvalToolDetails>("eval", {
		language: "js",
		code: 'print("eval-still-available")',
	});
	if (!textOf(evalResult).includes("eval-still-available")) {
		throw new QaScenarioError("eval did not remain available beside GPT Code Mode");
	}

	const missing = await session.executeTool<CodeModeToolDetails>("wait", { cell_id: "does-not-exist" });
	if (missing.details.state !== "missing" || missing.details.isError !== true) {
		throw new QaScenarioError("wait did not report a missing cell");
	}

	const receipt = {
		tools: ["eval", "exec", "wait"],
		nestedTool: "read",
		nestedState: nested.details.state,
		yieldedState: yielded.details.state,
		resumedState: resumed.details.state,
		evalState: "available",
		missingState: missing.details.state,
	};
	const evidencePath = join(evidenceDir, "gpt-code-mode.json");
	await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
	console.log(`NESTED: ${nested.details.state}`);
	console.log(`YIELDED: ${yielded.details.state}`);
	console.log(`RESUMED: ${resumed.details.state}`);
	console.log("EVAL: available");
	console.log(`MISSING: ${missing.details.state}`);
	console.log(`EVIDENCE: ${evidencePath}`);
}

async function settleCell(
	session: Awaited<ReturnType<typeof createAgentSession>>["session"],
	result: AgentToolResult<CodeModeToolDetails>,
): Promise<AgentToolResult<CodeModeToolDetails>> {
	if (result.details.state !== "yielded") return result;
	return await session.executeTool<CodeModeToolDetails>("wait", {
		cell_id: result.details.cellId,
		yield_time_ms: 1_000,
	});
}

function gptModel(): Model<Api> {
	return {
		id: "gpt-5.6",
		name: "gpt-5.6",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://mock.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part): part is Extract<(typeof result.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function evidenceDirectory(): string {
	const index = process.argv.indexOf("--evidence-dir");
	if (index === -1) {
		return join(process.cwd(), "local-ignore", "qa-evidence", "20260722-gpt-code-mode");
	}
	const value = process.argv[index + 1];
	if (value === undefined) throw new QaScenarioError("--evidence-dir requires a directory");
	return value;
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
	process.exitCode = 1;
}
