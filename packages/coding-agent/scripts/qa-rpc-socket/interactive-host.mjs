#!/usr/bin/env node
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from "../../src/core/agent-session-runtime.ts";
import { createInteractiveHostRuntime } from "../../src/modes/interactive/interactive-host-runtime.ts";
import { RpcClient } from "../../src/modes/rpc/rpc-client.ts";
import { ensureHost } from "../../src/modes/rpc/host-ensure.ts";
import { cleanupAllAndWait, installCleanupHooks, makeScratch, startFakeModelServer, writeMockModelsJson } from "../qa-app-server/lib/env.mjs";

const lines = [];
const outPath = flag("--out");
let scratch;
installCleanupHooks();

try {
	scratch = makeScratch("interactive-host");
	const fake = await startFakeModelServer([{ text: "interactive-host-qa" }]);
	writeMockModelsJson(scratch.agentDir, fake);
	const socket = join(scratch.dir, "rpc.sock");
	await ensureHost({ socket, agentDir: scratch.agentDir });
	const publicSocketMode = (statSync(socket).mode & 0o777).toString(8).padStart(3, "0");
	if (publicSocketMode !== "600") throw new Error(`public socket mode is ${publicSocketMode}, expected 600`);
	lines.push(`assert public-socket-mode=srw------- (${publicSocketMode})`);
	const manager = SessionManager.create(scratch.cwd, scratch.sessionDir);
	const sessionPath = manager.getSessionFile();
	if (!sessionPath) throw new Error("interactive session did not allocate a path");
	const createRuntime = async ({ cwd, sessionManager }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: scratch.agentDir,
			settingsManager: SettingsManager.create(cwd, scratch.agentDir),
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		return { ...(await createAgentSessionFromServices({ services, sessionManager })), services, diagnostics: services.diagnostics };
	};
	const local = await createAgentSessionRuntime(createRuntime, {
		cwd: scratch.cwd,
		agentDir: scratch.agentDir,
		sessionManager: manager,
	});
	const runtime = await createInteractiveHostRuntime(local, { socket, agentDir: scratch.agentDir });
	const observer = new RpcClient({ socketPath: socket });
	await observer.start();
	const listed = await observer.listSessions();
	const live = listed.find((entry) => entry.status === "open");
	if (!live?.durableSessionId) throw new Error(`interactive session was not live: ${JSON.stringify(listed)}`);
	lines.push(`assert list_sessions=live durableSessionId=${live.durableSessionId}`);

	const settled = new Promise((resolve) => {
		const unsubscribe = runtime.session.subscribe((event) => {
			if (event.type !== "agent_settled") return;
			unsubscribe();
			resolve();
		});
	});
	await runtime.session.prompt("interactive-host-qa");
	await settled;
	if (!runtime.session.getLastAssistantText()) throw new Error("remote prompt produced no assistant response");
	lines.push("assert remote-prompt=response");

	await runtime.dispose();
	await observer.stop();
	const resumeClient = new RpcClient({ socketPath: socket });
	await resumeClient.start();
	const resumed = await resumeClient.openSession({ sessionPath, cwd: scratch.cwd });
	if (resumed.state.sessionId !== live.durableSessionId) {
		throw new Error(`durable id changed: ${live.durableSessionId} -> ${resumed.state.sessionId}`);
	}
	lines.push(`assert resume=stable durableSessionId=${resumed.state.sessionId}`);
	await resumeClient.closeSession(resumed.sessionId);
	await resumeClient.stop();
	await fake.stop();
	lines.push("PASS interactive-host real CLI host lifecycle");
} catch (error) {
	lines.push(`FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	process.exitCode = 1;
} finally {
	try {
		if (scratch) {
			const pidPath = join(scratch.agentDir, "rpc-host-daemon", "host.pid");
			if (existsSync(pidPath)) {
				const { pid } = JSON.parse(readFileSync(pidPath, "utf8"));
				if (Number.isInteger(pid)) {
					process.kill(pid, "SIGTERM");
					await waitForExit(pid, 15_000);
					if (isAlive(pid)) throw new Error(`ensured supervisor still alive after cleanup: ${pid}`);
					lines.push(`cleanup=supervisor-stopped pid=${pid}`);
				}
			}
		}
		await cleanupAllAndWait();
		lines.push("cleanup=sockets,scratch-removed,supervisor-stopped");
	} catch (cleanupError) {
		process.exitCode = 1;
		lines.push(`cleanup=FAIL ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
	}
	if (outPath) writeFileSync(outPath, `${lines.join("\n")}\n`);
	process.stdout.write(`${lines.join("\n")}\n`);
}

function flag(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		const state = execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim();
		return state.length > 0 && !state.startsWith("Z");
	} catch {
		return false;
	}
}

async function waitForExit(pid, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (isAlive(pid) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
