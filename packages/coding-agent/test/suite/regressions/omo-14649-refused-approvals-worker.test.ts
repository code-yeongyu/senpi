/**
 * oh-my-openagent#14649 on the worker runtime (`--session-runtime worker`): real worker isolates and production routing.
 * A labelled open of a session a worker already runs cannot reach that worker's permission system, so it is refused
 * before the attach changes anything; and once a worker replaced its session, the record a host keeps to reopen it
 * after a restart no longer carries the opener's label.
 */
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import type { RouterContext } from "../../../src/modes/rpc/session-router-context.ts";
import { recordRetainedSession } from "../../../src/modes/rpc/session-router-residency.ts";
import { reservationHost } from "../rpc-worker-reservation-support.ts";

type WireRecord = Record<string, unknown> & { success?: boolean; data?: unknown; errorData?: unknown };

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function workerHost() {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-omo-14649-worker-"));
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const host = reservationHost(cwd, agentDir);
	disposers.push(async () => {
		await host.dispose();
		await rm(scratch, { recursive: true, force: true });
	});
	for (const connection of ["first", "second"]) host.connect(connection);
	let serial = 0;
	const send = async (connection: string, frame: Record<string, unknown>) => {
		const id = `req-${++serial}`;
		const direct = await host.send(connection, { ...frame, id } as RpcCommand);
		await host.writer.flush();
		return (direct as WireRecord | undefined) ?? (host.records as WireRecord[]).find((record) => record.id === id);
	};
	return { scratch, cwd, host, send, sessionPath: join(scratch, "session.jsonl") };
}

it("a labelled open of a session a worker already runs is refused, and the session keeps its attachments", async () => {
	const { cwd, host, send, sessionPath } = await workerHost();
	const first = await send("first", { type: "open_session", cwd, sessionPath });
	const handle = (first?.data as { sessionId?: string } | undefined)?.sessionId;
	expect(first?.success).toBe(true);

	const labelled = await send("second", { type: "open_session", cwd, sessionPath, context: { approvals: "refuse" } });

	expect(labelled?.success).toBe(false);
	expect(labelled?.errorData).toMatchObject({ reason: "approvals_label_unsupported" });
	expect(host.registry.peek(String(handle))?.attachments).toBe(1);
});

it("a worker session that replaced its labelled session is recorded for a restart without the label", async () => {
	const { scratch, cwd, host, send, sessionPath } = await workerHost();
	const opened = await send("first", { type: "open_session", cwd, sessionPath, context: { approvals: "refuse" } });
	const handle = String((opened?.data as { sessionId?: string } | undefined)?.sessionId);
	const openedId = host.registry.peek(handle)?.durableSessionId;
	expect((await send("first", { type: "new_session", sessionId: handle }))?.success).toBe(true);
	// A request after the replacement reaches the worker behind it, so its snapshot names the new session.
	await send("first", { type: "get_state", sessionId: handle });
	const entry = host.registry.peek(handle);
	if (entry === undefined) throw new Error("the replaced session left the registry");
	expect(entry.worker?.snapshot?.state.sessionId).not.toBe(openedId);

	const parkedDir = join(scratch, "parked");
	await mkdir(parkedDir);
	const router = { handoverParkedDir: parkedDir, defaults: {}, registry: host.registry } as unknown as RouterContext;
	await recordRetainedSession(router, entry, String(entry.worker?.snapshot?.sessionPath), false);

	const entries = await readdir(parkedDir, { recursive: true, withFileTypes: true });
	const written = await Promise.all(
		entries.filter((file) => file.isFile()).map((file) => readFile(join(file.parentPath, file.name), "utf8")),
	);
	expect(written.length).toBeGreaterThan(0);
	expect(written.join("\n")).not.toContain('"approvals"');
});
