import { existsSync } from "node:fs";
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
import senpiCodemode from "../src/index.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";

class QaScenarioError extends Error {
	readonly name = "QaScenarioError";
}

async function main(): Promise<void> {
	const suppliedAgentDir = process.env.SENPI_CODING_AGENT_DIR;
	const agentDir = suppliedAgentDir ?? (await mkdtemp(join(tmpdir(), "senpi-codemode-agent-")));
	const settingsJson = settingsJsonFromArgs();
	const cwd = await mkdtemp(join(tmpdir(), "senpi-codemode-e2e-"));
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(cwd, ".senpi"), { recursive: true });
	await writeFile(join(cwd, ".senpi", "codemode.json"), settingsJson);
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enabledBuiltinExtensions: [] }));
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
			tools: ["eval"],
			autoTitleSessions: false,
		});
		session = created.session;
		await session.bindExtensions({ mode: "print" });
		if (process.argv.includes("--abort-scenario")) {
			await runAbortScenario(session);
		} else {
			await runDefaultScenario(session);
		}
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

function settingsJsonFromArgs(): string {
	const index = process.argv.indexOf("--settings");
	if (index === -1) return "{}";
	const value = process.argv[index + 1];
	if (value === undefined) throw new QaScenarioError("--settings requires a JSON value");
	return value;
}

async function runDefaultScenario(
	session: Awaited<ReturnType<typeof createAgentSession>>["session"],
): Promise<void> {
	const definition = session.getToolDefinition("eval");
	if (definition === undefined) throw new QaScenarioError("eval tool was not registered");
	const tokens = ["py", "js", "rb", "jl"].filter((language) =>
		definition.description.includes(`\`"${language}"\``),
	);
	console.log(`LANGS: ${tokens.join(",")}`);
	const result = await session.executeTool<EvalToolDetails>("eval", {
		language: "js",
		code: "for(let i=0;i<3000;i++)console.log('L'+i)",
	});
	const artifactPath = result.details.meta?.artifactId;
	const spillExists = artifactPath !== undefined && existsSync(artifactPath);
	console.log(`TRUNCATED: ${result.details.truncated}`);
	console.log(`SPILL_EXISTS: ${spillExists}`);
	let rubyRejected = false;
	try {
		await session.executeTool("eval", { language: "rb", code: "puts 1" });
	} catch (error) {
		if (error instanceof Error) rubyRejected = true;
		else throw error;
	}
	console.log(`RB_REJECTED: ${rubyRejected}`);
	if (tokens.join(",") !== "py,js") throw new QaScenarioError(`unexpected eval languages: ${tokens.join(",")}`);
	if (!result.details.truncated) throw new QaScenarioError("eval output was not truncated");
	if (!spillExists) throw new QaScenarioError("eval spill artifact was not written");
	if (!rubyRejected) throw new QaScenarioError("disabled Ruby input was accepted");
}

async function runAbortScenario(
	session: Awaited<ReturnType<typeof createAgentSession>>["session"],
): Promise<void> {
	await session.executeTool<EvalToolDetails>("eval", { language: "py", code: "x=42" });
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new DOMException("QA abort", "AbortError")), 500);
	let interrupted: AgentToolResult<EvalToolDetails>;
	try {
		interrupted = await session.executeTool<EvalToolDetails>(
			"eval",
			{ language: "py", code: "while True: pass" },
			{ signal: controller.signal },
		);
	} finally {
		clearTimeout(timer);
	}
	const interruptedText = textOf(interrupted);
	const cancelled =
		interrupted.details.isError === true ||
		interruptedText.includes("QA abort") ||
		interruptedText.toLowerCase().includes("interrupt");
	const resumed = await session.executeTool<EvalToolDetails>("eval", { language: "py", code: "print(x)" });
	const resumedText = textOf(resumed);
	console.log(`CANCELLED: ${cancelled}`);
	console.log(`STATE: ${resumedText.trim()}`);
	if (!cancelled) throw new QaScenarioError(`abort result was not marked cancelled: ${interruptedText}`);
	if (!resumedText.includes("42")) throw new QaScenarioError(`Python state did not survive interrupt: ${resumedText}`);
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part): part is Extract<(typeof result.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
	process.exitCode = 1;
}
