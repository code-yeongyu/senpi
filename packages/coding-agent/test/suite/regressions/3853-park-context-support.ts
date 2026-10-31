import type { CreateAgentSessionRuntimeResult } from "../../../src/core/agent-session-runtime.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { createHarness, type Harness } from "../harness.ts";

/** Drive the production context patch and idle park, with only the provider runtime replaced. */
export async function parkWithTaskStatus(agentDir: string, sessionPath: string, daemonDir: string, taskStatus: string) {
	const harnesses: Harness[] = [];
	const parked = Promise.withResolvers<void>();
	let now = 0;
	const registry = new RpcSessionRegistry({
		agentDir,
		now: () => now,
		createRuntime: async (options) => {
			new ProjectTrustStore(options.agentDir).set(options.cwd, true);
			const h = await createHarness({ cwd: options.cwd, sessionManager: options.sessionManager });
			harnesses.push(h);
			return {
				session: h.session,
				services: { cwd: options.cwd, agentDir: options.agentDir },
				diagnostics: [],
			} as unknown as CreateAgentSessionRuntimeResult;
		},
	});
	const writer = new SessionEventWriter((line) => {
		if (line.includes('"type":"session_parked"')) parked.resolve();
	});
	const router = new SessionCommandRouter(
		registry,
		writer,
		{ cwd: agentDir },
		async () => ({ handle: async () => {}, dispose: async () => {} }),
		{},
		{ handoverParkedDir: daemonDir, idleEvictionMs: 1, now: () => now },
	);
	try {
		await router.handle({
			type: "open_session",
			sessionPath,
			retain_on_disconnect: true,
			context: { task_status: "running" },
		});
		const opened = registry.list()[0];
		if (!opened) throw new Error("open did not register a session");
		const sessionId = opened.sessionId;
		const patched = await router.handle({
			type: "set_session_context",
			sessionId,
			patch: { task_status: taskStatus },
		});
		if (!patched?.success) throw new Error("context patch failed");
		// Exercise the router's actual park path, not a hand-written park record.
		now = 10_000;
		router.sweepIdleSessions();
		await parked.promise;
	} finally {
		await router.dispose();
		for (const h of harnesses.reverse()) h.cleanup();
	}
}
