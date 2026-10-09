import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { reservationHost } from "../rpc-worker-reservation-support.ts";
import { startSessionHolder } from "./issue-2951-holder-support.ts";

it("guards real worker-registry open and current-snapshot writes without blocking its own holder", async () => {
	const root = await mkdtemp(join(tmpdir(), "held-worker-registry-"));
	const agentDir = join(root, "agent");
	const file = join(root, "session.jsonl");
	const id = "29510000-0000-4000-8000-000000000003";
	await mkdir(agentDir);
	await writeFile(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, cwd: root, timestamp: new Date(0).toISOString() })}\n`,
	);
	const extension = join(root, "probe.mjs");
	await writeFile(
		extension,
		'export default (pi) => pi.registerCommand("held-probe", { description: "local test", handler: async () => {} });',
	);
	const host = reservationHost(root, agentDir, extension);
	host.connect("client");
	let serial = 0;
	const send = async (command: RpcCommand) => {
		const requestId = command.id ?? `request-${++serial}`;
		const direct = await host.send("client", { ...command, id: requestId });
		await host.writer.flush();
		return (
			direct ??
			host.records.findLast(
				(value) => typeof value === "object" && value !== null && "id" in value && value.id === requestId,
			)
		);
	};
	try {
		await using first = await startSessionHolder(file, id, root);
		expect(await send({ type: "open_session", sessionPath: file, cwd: root })).toMatchObject({
			success: false,
			error: "session_held",
			errorData: { holders: [{ pid: first.pid, cwd: root }] },
		});
		await first.stop();
		expect(await send({ type: "open_session", sessionPath: file, cwd: root })).toMatchObject({ success: true });
		const row = host.registry.list()[0];
		if (!row) throw new Error("Worker did not open");
		const entry = host.registry.peek(row.sessionId);
		if (!entry?.worker?.snapshot) throw new Error("Real worker snapshot missing");
		expect(entry.worker.worker.threadId).toBeGreaterThan(0);
		expect(await realpath(entry.worker.snapshot.state.sessionFile ?? "")).toBe(await realpath(file));
		// The snapshot is authoritative after a worker changes sessions, not the original open path.
		entry.sessionPath = join(root, "previous.jsonl");
		entry.durableSessionId = "previous-id";
		await using holder = await startSessionHolder(file, id, root);
		for (const type of ["prompt", "steer", "follow_up"] as const) {
			expect(await send({ type, id: type, sessionId: row.sessionId, message: "/held-probe" })).toMatchObject({
				id: type,
				success: false,
				error: "session_held",
				errorData: { holders: [{ pid: holder.pid, cwd: root }] },
			});
		}
		await holder.stop();
		expect(
			await send({ type: "set_session_name", id: "own", sessionId: row.sessionId, name: "own worker" }),
		).toMatchObject({ id: "own", success: true });
	} finally {
		await host.dispose();
		await rm(root, { recursive: true, force: true });
	}
}, 60_000);
