import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { expect, it } from "vitest";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { reservationHost, reservationStep as step } from "./rpc-worker-reservation-support.ts";

const MARKER = "senpi7567-worker-marker-k4w";

/** Every path under `root` that names a session file or a sessions directory, or whose bytes hold `MARKER`. */
async function sessionTraces(root: string): Promise<string[]> {
	const entries = await readdir(root, { recursive: true, withFileTypes: true });
	const traces = await Promise.all(
		entries.map(async (entry) => {
			const path = join(entry.parentPath, entry.name);
			const rel = relative(root, path);
			if (rel.endsWith(".jsonl") || rel.split(sep).includes("sessions")) return rel;
			if (entry.isFile() && (await readFile(path, "utf8")).includes(MARKER)) return rel;
			return undefined;
		}),
	);
	return traces.filter((trace) => trace !== undefined);
}

function data(response: unknown): Record<string, unknown> {
	const record = response as { success?: boolean; error?: string; data?: Record<string, unknown> } | undefined;
	if (record?.success !== true) throw new Error(`request failed: ${String(record?.error)}`);
	return record.data ?? {};
}

// senpi#7567: a worker isolate carries persistence "none" on the launch profile it is prepared with, so neither the
// isolate nor the host side of the worker open names, claims or reserves a file for the session. The whole-tree
// comparison of what a memory-only session leaves is owned by rpc-open-session-no-persistence.test.ts.
it("names, claims and writes no session file for a memory-only session that runs in a worker isolate", async () => {
	// given
	const scratch = await mkdtemp(join(tmpdir(), "senpi-7567-worker-"));
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const host = reservationHost(cwd, agentDir);
	host.connect("controller");
	let serial = 0;
	// A worker session answers through the writer, so a reply is looked up by its request id.
	const send = async (command: RpcCommand) => {
		const id = `req-${++serial}`;
		const direct = await host.send("controller", { ...command, id });
		return direct ?? host.records.find((record) => (record as { id?: string }).id === id);
	};
	try {
		// when
		const opened = data(await step("open", send({ type: "open_session", cwd, persistence: "none" })));
		const sessionId = String(opened.sessionId);
		const bash = data(await step("bash", send({ type: "bash", sessionId, command: `echo ${MARKER}` })));
		const state = data(await send({ type: "get_state", sessionId }));
		const row = host.registry.list().find((listed) => listed.sessionId === sessionId);
		await step("close", send({ type: "close_session", sessionId }));

		// then
		expect(bash.output).toContain(MARKER);
		expect(state.sessionFile ?? null).toBeNull();
		expect(opened.sessionPath ?? null).toBeNull();
		expect(row?.persistence).toBe("none");
		expect(row?.sessionPath).toBeUndefined();
		expect(await sessionTraces(scratch)).toEqual([]);
	} finally {
		await host.dispose();
		await rm(scratch, { recursive: true, force: true });
	}
});
