import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { createLoopHookHost, createReliableTransport } from "@earendil-works/pi-agent-core";
import { expect, it } from "vitest";
import { parseHookConfig } from "../../../src/core/extensions/builtin/hooks/index.ts";
import { createHookTrustEntry, hookTrustId } from "../../../src/core/extensions/builtin/hooks/trust.ts";
import type { HookSourceMetadata, HookTrustEntry } from "../../../src/core/extensions/builtin/hooks/types.ts";
import { handSocketPath } from "../../../src/modes/hand/hand-entry.ts";
import { attachSocketCarrier } from "../../../src/modes/hand/socket-carrier.ts";
import { scratch, spawnRpc, stopChild, waitForStderr } from "../../helpers/rpc-socket-host-support.ts";

// senpi#5898: `--hand` serves a hosted loop's loop hooks as its extensions' home, so a forwarded session_start runs the
// user's SessionStart shell hook on the hand's machine and its context comes back for the loop to send.
it("a spawned --hand runs the user's SessionStart shell hook for a forwarded session_start", async () => {
	const qa = scratch("s5898h");
	const senpiDir = join(qa.cwd, ".senpi");
	mkdirSync(senpiDir, { recursive: true });
	const script = join(senpiDir, "start.mjs");
	writeFileSync(
		script,
		"import { appendFileSync } from 'node:fs'; process.stdin.resume(); process.stdin.on('end', () => { appendFileSync('hook-ran.txt', 'SessionStart\\n'); process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'context from the hand machine' } })); });",
	);
	const hookConfig = {
		hooks: { SessionStart: [{ hooks: [{ type: "command", command: `${process.execPath} ${script}` }] }] },
	};
	const sourcePath = join(senpiDir, "hooks.json");
	writeFileSync(sourcePath, JSON.stringify(hookConfig));
	const source = {
		discoveredAt: "pre-session",
		displayOrder: 0,
		scope: "project",
		sourcePath,
	} satisfies HookSourceMetadata;
	const hooks: Record<string, HookTrustEntry> = {};
	for (const handler of parseHookConfig(hookConfig, source).executableHandlers)
		hooks[hookTrustId(handler)] = createHookTrustEntry(handler, {
			platform: process.platform,
			updatedAt: "2026-11-15T00:00:00.000Z",
		});
	writeFileSync(join(senpiDir, "hooks-state.json"), JSON.stringify({ version: 1, hooks }));

	const agentDir = mkdtempSync(join("/tmp", "s5898h-"));
	const endpoint = handSocketPath(agentDir);
	const child = spawnRpc(["--hand", "--no-skills", "--no-context-files"], qa, undefined, {
		SENPI_CODING_AGENT_DIR: agentDir,
	});
	let socket: Socket | undefined;
	try {
		await waitForStderr(child, `senpi hand: listening on ${endpoint}`);
		const failures: string[] = [];
		const brain = createReliableTransport({
			clock: {
				now: () => Date.now(),
				setTimer: (cb, ms) => {
					const t = setTimeout(cb, ms);
					return () => clearTimeout(t);
				},
			},
			onHandlerError: (error) => {
				failures.push(String(error));
			},
		});
		socket = createConnection(endpoint);
		await new Promise<void>((resolve, reject) => {
			socket?.once("connect", resolve);
			socket?.once("error", reject);
		});
		attachSocketCarrier(socket, brain, () => {});
		const host = createLoopHookHost({ transport: brain, lane: "loop-hooks" });
		const reply = (await host.run("session_start", {
			sessionId: "s5898-session",
			idle: false,
			scope: { id: "session-s5898", root: qa.cwd },
			reason: "startup",
		})) as { sent?: { message: { content: unknown } }[]; errors?: unknown[] };
		const marks = readFileSync(join(qa.cwd, "hook-ran.txt"), "utf8");
		expect(marks).toBe("SessionStart\n");
		expect(reply.errors).toBeUndefined();
		expect(JSON.stringify(reply.sent)).toContain("context from the hand machine");
		expect(failures).toEqual([]);
		host.close();
		brain.close();
	} finally {
		socket?.destroy();
		await stopChild(child);
		rmSync(agentDir, { recursive: true, force: true });
	}
}, 90_000);
