import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentDir } from "../../../src/config.ts";
import { TerminalManager } from "../../../src/core/extensions/builtin/terminal/manager.ts";
import { createPtyBashTool } from "../../../src/core/extensions/builtin/terminal/tools/bash.ts";
import { resolvePidSession, sessionSpawnsDir } from "../../../src/core/session-spawn-attestation.ts";
import { createBashToolDefinition } from "../../../src/core/tools/bash.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * senpi#6972: both shell tool paths record the processes they spawn for a session, so a command that rewrites
 * `PI_SESSION_ID` still resolves to the session that ran it.
 */
const supported = process.platform === "linux" || process.platform === "darwin";

async function recordWritten(pid: number): Promise<void> {
	const dir = sessionSpawnsDir(getAgentDir());
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, `${pid}.json`);
	const watcher = watch(dir);
	try {
		const appeared = new Promise<void>((resolve) => watcher.on("change", () => existsSync(path) && resolve()));
		if (existsSync(path)) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`no attestation record for pid ${pid}`)), 5_000);
		});
		await Promise.race([appeared, deadline]).finally(() => clearTimeout(timer));
	} finally {
		watcher.close();
	}
}

describe.skipIf(!supported)("tool spawn attestation (#6972)", () => {
	let harness: Harness;
	let manager: TerminalManager;
	beforeEach(async () => {
		harness = await createHarness({ extensionFactories: [() => {}] });
		await harness.session.bindExtensions({});
		manager = new TerminalManager();
	});
	afterEach(async () => {
		await manager.teardown();
		harness.cleanup();
	});

	it("the PTY bash tool attests its command before it returns, whatever the command sets PI_SESSION_ID to", async () => {
		const ctx = harness.getExtensionRunner().createContext();
		const tool = createPtyBashTool({
			manager,
			cwd: harness.tempDir,
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => ({ ...process.env }),
			getSessionContext: () => ctx,
		});
		const result = await tool.execute(
			"forged",
			{ command: "exec env PI_SESSION_ID=forged-session sleep 30", run_in_background: true },
			undefined,
			undefined,
			ctx,
		);
		const id = result.details?.bash_id;
		if (typeof id !== "string") throw new Error("the background command reported no bash_id");
		const pid = manager.get(id)?.session.pid;
		if (pid === undefined) throw new Error("the PTY reported no pid");

		expect(await resolvePidSession(pid)).toMatchObject({
			attested: true,
			sessionId: harness.sessionManager.getSessionId(),
			attestedPid: pid,
			hostPid: process.pid,
		});
	});

	it("the core shell tool attests its command while it runs", async () => {
		const fifo = join(harness.tempDir, "go.fifo");
		execFileSync("mkfifo", [fifo]);
		const ctx = harness.getExtensionRunner().createToolContext("core", undefined);
		let seenPid: ((pid: number) => void) | undefined;
		const started = new Promise<number>((resolve) => {
			seenPid = resolve;
		});
		const run = createBashToolDefinition(harness.tempDir).execute(
			"core",
			{ command: `echo "pid=$$"; read _go < '${fifo}'` },
			undefined,
			(update) => {
				const text = update.content.map((block) => ("text" in block ? block.text : "")).join("");
				const match = /pid=(\d+)/.exec(text);
				if (match?.[1] !== undefined) seenPid?.(Number(match[1]));
			},
			ctx,
		);
		const pid = await started;
		await recordWritten(pid);

		expect(await resolvePidSession(pid)).toMatchObject({
			attested: true,
			sessionId: harness.sessionManager.getSessionId(),
			attestedPid: pid,
		});
		writeFileSync(fifo, "go\n");
		await run;
	});
});
