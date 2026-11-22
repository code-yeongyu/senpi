import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths } from "../src/modes/rpc/host-daemon-paths.ts";
import { readHandoverParkedSessions, recordHandoverParkedSession } from "../src/modes/rpc/host-handover-parked.ts";
import { SessionCommandRouter } from "../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../src/modes/rpc/session-event-writer.ts";

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function sessionEntry(sessionFile: string | undefined, cwd: string) {
	const sessionManager = {
		getCwd: () => cwd,
		getSessionFile: () => sessionFile,
		getSessionName: () => undefined,
		getEntries: () => [],
		getUsageTotals: () => undefined,
	};
	const base: Record<string, unknown> = {
		model: undefined,
		pendingModelSwitch: undefined,
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		sessionFile,
		sessionId: "durable-manual-reopen",
		sessionName: undefined,
		agentDir: cwd,
		effectiveServiceTier: undefined,
		retryAttempt: 0,
		isBashRunning: false,
		autoCompactionEnabled: false,
		pendingMessageCount: 0,
		favoriteModels: [],
		scopedModels: [],
		messages: [],
		agent: { state: { providerDiagnostic: undefined } },
		sessionManager,
		isFastModeActive: () => false,
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		// buildRpcSessionState spreads this; the catch-all proxy below would return undefined (senpi#3396).
		getQueuedInputs: () => [],
		getContextUsage: () => undefined,
	};
	// Any member buildRpcSessionState touches that the base does not define resolves to a value
	// that is callable (method), iterable (spread), and readable (data), so the mock does not have
	// to enumerate the whole AgentSession surface.
	const anyValue: unknown = new Proxy(() => undefined, {
		get: (_t, prop) => (prop === Symbol.iterator ? function* () {} : anyValue),
		apply: () => undefined,
	});
	const session = new Proxy(base, {
		get(target, prop, receiver) {
			if (prop in target) return Reflect.get(target, prop, receiver);
			return anyValue;
		},
	});
	return { runtime: { session } };
}

describe("manual open-by-path clears its handover-parked record entry (M-A)", () => {
	it("removes the entry after a successful manual open_session by path", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "hhp-router-"));
		dirs.push(agentDir);
		const socket = join(agentDir, "rpc.sock");
		const sessionFile = join(agentDir, "session.jsonl");
		await writeFile(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: "durable-manual-reopen", timestamp: new Date(0).toISOString(), cwd: agentDir })}\n`,
			"utf8",
		);
		const daemonDir = createHostDaemonPaths({ socket, agentDir }).dir;
		await mkdir(daemonDir, { recursive: true });
		await recordHandoverParkedSession(daemonDir, {
			sessionPath: sessionFile,
			retainOnDisconnect: true,
			cwd: agentDir,
		});
		expect((await readHandoverParkedSessions(daemonDir)).some((entry) => entry.sessionPath === sessionFile)).toBe(
			true,
		);

		const entry = sessionEntry(sessionFile, agentDir);
		const registry = {
			openSession: async () => ({ sessionId: "rpc-manual-reopen" }),
			getForCommand: () => entry,
			list: () => [],
			beginClose: () => entry,
			closeMarked: async () => {},
			peek: () => entry,
		} as never;
		const writer = new SessionEventWriter(() => {});
		const router = Reflect.construct(SessionCommandRouter, [
			registry,
			writer,
			{ cwd: agentDir },
			async () => ({ handle: async () => {}, dispose: async () => {} }),
			{},
			{ handoverParkedDir: daemonDir },
		]) as SessionCommandRouter;

		await writer.withConnection("conn-manual", () =>
			router.handle({ id: "open", type: "open_session", cwd: agentDir, sessionPath: sessionFile }),
		);

		const deadline = Date.now() + 10_000;
		let cleared = false;
		while (!cleared && Date.now() < deadline) {
			cleared = !(await readHandoverParkedSessions(daemonDir)).some(
				(recorded) => recorded.sessionPath === sessionFile,
			);
			if (!cleared) await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(cleared, `record entry for ${sessionFile} still present after the manual open-by-path`).toBe(true);
	});
});
