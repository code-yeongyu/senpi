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

// senpi#3612 real-surface QA: a Python kernel killed from outside the session (kill -9 by pid) and a
// kernel lost to a session reload must both announce themselves on the next cell, naming the lost globals.

class QaScenarioError extends Error {
	readonly name = "QaScenarioError";
}

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];

async function main(): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "senpi-codemode-loss-agent-"));
	const cwd = await mkdtemp(join(tmpdir(), "senpi-codemode-loss-"));
	await mkdir(join(cwd, ".senpi"), { recursive: true });
	await writeFile(join(cwd, ".senpi", "codemode.json"), "{}");
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
	let session: Session | undefined;
	try {
		session = (
			await createAgentSession({
				cwd,
				agentDir,
				settingsManager,
				sessionManager,
				resourceLoader,
				tools: ["eval"],
				autoTitleSessions: false,
			})
		).session;
		await session.bindExtensions({ mode: "print" });
		await killedFromOutside(session);
		await lostToReload(session);
		console.log("QA_RESULT: PASS");
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

async function killedFromOutside(session: Session): Promise<void> {
	const defined = await py(session, "def helper():\n    return 41\nrows = [1, 2, 3]\nimport os\nos.getpid()");
	const pid = Number(textOf(defined).trim().split("\n")[0]);
	if (!Number.isInteger(pid) || pid <= 0) throw new QaScenarioError(`no interpreter pid in: ${textOf(defined)}`);
	console.log(`KILL: kill -9 ${pid} (from outside the session)`);
	process.kill(pid, "SIGKILL");
	await reaped(pid);
	const after = await py(session, "'helper' in globals()");
	console.log(`AFTER_KILL_RESULT:\n${textOf(after)}`);
	console.log(`AFTER_KILL_KERNEL_STATE: ${after.details.kernelState}`);
	const notice = textOf(after);
	for (const expected of ["py kernel was restarted after signal 9", "probably killed by the system", "Lost: helper, os, rows"])
		if (!notice.includes(expected)) throw new QaScenarioError(`kill notice lacks "${expected}"`);
}

async function lostToReload(session: Session): Promise<void> {
	await py(session, "def loader():\n    return 'rows'\ncache = {}");
	console.log("RELOAD: session.reload() + re-bind (the reload path; a bound host emits session_start, print mode needs the re-bind)");
	await session.reload();
	await session.bindExtensions({ mode: "print" });
	const after = await py(session, "'loader' in globals()");
	console.log(`AFTER_RELOAD_RESULT:\n${textOf(after)}`);
	console.log(`AFTER_RELOAD_KERNEL_STATE: ${after.details.kernelState}`);
	const notice = textOf(after);
	for (const expected of ["py kernel is new", "Lost: cache, loader"])
		if (!notice.includes(expected)) throw new QaScenarioError(`reload notice lacks "${expected}"`);
}

async function py(session: Session, code: string): Promise<AgentToolResult<EvalToolDetails>> {
	return await session.executeTool<EvalToolDetails>("eval", { language: "py", code, summary: "QA kernel loss notice" });
}

async function reaped(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new QaScenarioError(`interpreter ${pid} was not reaped`);
}

function textOf(result: AgentToolResult<EvalToolDetails>): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

await main();
