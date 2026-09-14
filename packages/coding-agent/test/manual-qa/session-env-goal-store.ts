import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@code-yeongyu/senpi";
import senpiCodemode from "../../../senpi-codemode/src/index.ts";
import { goalFilePath } from "../../src/core/extensions/builtin/goal/persistence.ts";
import { goalStoreRef } from "../../src/core/extensions/builtin/goal/store-ref.ts";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import { createPtyBashTool } from "../../src/core/extensions/builtin/terminal/tools/bash.ts";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";

// Run after the workspace build: node --import tsx test/manual-qa/session-env-goal-store.ts.
// No model request is made; every probe uses the real AgentSession tool-execution surface.
const root = await mkdtemp(join(tmpdir(), "senpi-session-env-qa-"));
const previousAgentDir = process.env.SENPI_CODING_AGENT_DIR;
process.env.SENPI_CODING_AGENT_DIR = root;
try {
	for (const mode of ["persisted", "override", "in-memory"]) await probe(mode);
} finally {
	if (previousAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
	else process.env.SENPI_CODING_AGENT_DIR = previousAgentDir;
	await rm(root, { recursive: true, force: true });
	console.log("QA_CLEANUP=REMOVED");
}

async function probe(mode: string): Promise<void> {
	const cwd = await mkdtemp(join(root, `${mode}-`));
	const settingsManager = SettingsManager.inMemory({ enabledBuiltinExtensions: [] });
	let sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
	if (mode === "override") {
		const path = join(cwd, "original.jsonl");
		await writeFile(
			path,
			`${JSON.stringify({ type: "session", version: 3, id: "qa-override", timestamp: new Date(0).toISOString(), cwd })}\n`,
		);
		sessionManager = SessionManager.open(path, join(cwd, "other-sessions"));
	} else if (mode === "in-memory") {
		sessionManager = SessionManager.inMemory(cwd);
	}
	const manager = new TerminalManager();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: root,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			{ name: "session-env-eval-qa", factory: senpiCodemode },
			{
				name: "session-env-shell-qa",
				factory: (pi) => {
					pi.registerTool({ ...createBashToolDefinition(cwd), name: "core_bash" });
					pi.registerTool({
						...createPtyBashTool({
							manager,
							cwd,
							defaultCols: 120,
							defaultRows: 40,
							getEnv: () => ({ ...process.env }),
						}),
						name: "pty_bash",
					});
				},
			},
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir: root,
		settingsManager,
		sessionManager,
		resourceLoader,
		tools: ["eval", "core_bash", "pty_bash"],
		autoTitleSessions: false,
	});
	try {
		await session.bindExtensions({ mode: "print" });
		const goal = goalFilePath(goalStoreRef(sessionManager, cwd));
		assert.equal(session.extensionRunner.createContext().goalStoreFile, goal);
		const evalResult = await session.executeTool("eval", {
			language: "js",
			code: 'print("SESSION_PATHS=" + JSON.stringify([env("PI_SESSION_CWD"), env("PI_GOAL_STORE_FILE")]))',
			summary: "Inspect session cwd and goal-store file through a real eval cell",
		});
		const evalText = evalResult.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		assert.ok(evalText.includes(`SESSION_PATHS=${JSON.stringify([cwd, goal])}`), evalText);
		console.log(JSON.stringify({ mode, surface: "eval", cwd, goal, output: evalText }));
		for (const tool of ["core_bash", "pty_bash"]) {
			const result = await session.executeTool(tool, {
				command: 'printf \'%s|%s\' "$PI_SESSION_CWD" "$PI_GOAL_STORE_FILE"',
			});
			const output = result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("");
			assert.equal(output, `${cwd}|${goal}`);
			console.log(JSON.stringify({ mode, surface: tool, output }));
		}
	} finally {
		try {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		} finally {
			session.dispose();
			await manager.teardown();
		}
	}
}
