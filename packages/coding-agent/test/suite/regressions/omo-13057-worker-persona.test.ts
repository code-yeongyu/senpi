/**
 * oh-my-openagent#13057 review L3: the worker-backed registry (what a multi-session host instantiates) holds the persona on
 * the session it hands to the worker and refuses an attach naming another one, exactly as the in-process registry does.
 */
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { WorkerSessionRegistry } from "../../../src/modes/rpc/worker-session-registry.ts";
import { startWorkerHost } from "../rpc-worker-host-support.ts";

it("a worker session keeps its persona and refuses an attach naming another; the same persona is never refused for it", async () => {
	const host = await startWorkerHost();
	const registry = new WorkerSessionRegistry({
		configuration: {
			parsed: parseArgs(["--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files"]),
			cwd: host.cwd,
			agentDir: join(host.scratch, "agent"),
			appMode: "rpc",
		},
		closeGraceMs: 1000,
		now: Date.now,
	});
	// The worker reports its session path resolved; an attach must name it the same way to reach the attach checks.
	const sessionPath = join(realpathSync(host.scratch), "persona.jsonl");
	const persona = { excludeTools: ["write"] };
	const handles: string[] = [];
	try {
		const opened = await registry.openSession({ cwd: host.cwd, sessionPath, persona }, { retainOnDisconnect: true });
		handles.push(opened.sessionId);
		expect(registry.peek(opened.sessionId)?.profile.persona).toEqual(persona);

		await expect(
			registry.openSession({ cwd: host.cwd, sessionPath, persona: { excludeTools: [] } }),
		).rejects.toMatchObject({ code: "session_path_in_use", detail: { reason: "persona_mismatch" } });
		await expect(registry.openSession({ cwd: host.cwd, sessionPath, persona: {} })).rejects.toMatchObject({
			detail: { reason: "persona_mismatch" },
		});
		// No client is bound in a bare registry, so the attach itself is refused; never for a persona mismatch.
		const same = registry.openSession({ cwd: host.cwd, sessionPath, persona });
		await expect(same).rejects.toMatchObject({ code: "session_path_in_use" });
		await expect(same).rejects.not.toMatchObject({ detail: { reason: "persona_mismatch" } });
	} finally {
		for (const handle of handles) await registry.close(handle);
		await host.dispose();
	}
});
