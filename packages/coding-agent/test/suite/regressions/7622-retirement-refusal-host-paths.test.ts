// senpi#7622: a retirement refusal names its store or marker relative to the agent dir. An RPC client may run on
// another machine, so no answer carries the host's absolute path; the host log keeps it.
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { inProcessRuntimeFactory } from "../rpc-inprocess-host-support.ts";

it("names a damaged marker relative to the agent dir in every RPC refusal that reads it", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "retirement-paths-"));
	const registry = new RpcSessionRegistry({ agentDir, createRuntime: inProcessRuntimeFactory().createRuntime });
	const router = new SessionCommandRouter(
		registry,
		new SessionEventWriter(() => {}),
		{ cwd: agentDir, agentDir },
		async () => ({ handle: async () => {}, dispose: async () => {} }),
	);
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const id = "retirement-paths";
	const sessionPath = join(agentDir, "sessions", `fixture_${id}.jsonl`);
	const marker = { marker: `retired-sessions/${id}.json`, action: "repair_retirement_marker" };
	try {
		await mkdir(join(agentDir, "sessions"), { recursive: true });
		await writeFile(
			sessionPath,
			`${JSON.stringify({ type: "session", version: 3, id, cwd: agentDir, timestamp: new Date(0).toISOString() })}\n`,
		);
		expect(await router.handle({ type: "open_session", sessionPath, cwd: agentDir })).toBeUndefined();
		const [row] = registry.list();
		if (!row) throw new Error("the fixture session did not open");
		await mkdir(join(agentDir, "retired-sessions"), { recursive: true });
		await writeFile(join(agentDir, "retired-sessions", `${id}.json`), "{");

		const answers = [
			await router.handle({ type: "find_session", durableSessionId: id }),
			await router.handle({ type: "list_sessions" }),
			await router.handle({ type: "close_session", sessionId: row.sessionId, retire: true }),
			await router.handle({ type: "open_session", sessionPath, cwd: agentDir }),
		];

		expect(answers).toMatchObject([
			{ errorCode: "retirement_marker_unavailable", errorData: { detail: JSON.stringify(marker) } },
			{ errorCode: "retirement_marker_unavailable", errorData: marker },
			{ errorCode: "retirement_failed", errorData: { detail: "retirement_marker_unavailable", ...marker } },
			{ errorCode: "retirement_marker_unavailable", errorData: marker },
		]);
		for (const hostPath of [agentDir, await realpath(agentDir)])
			for (const answer of answers) expect(JSON.stringify(answer)).not.toContain(hostPath);
		const hostLog = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
		expect(hostLog).toContain(join(agentDir, "retired-sessions", `${id}.json`));
	} finally {
		stderr.mockRestore();
		await router.dispose();
		await rm(agentDir, { recursive: true, force: true });
	}
});
