/**
 * #2842 on the worker runtime: an attach that names the preset the host already records still
 * reaches the worker, so a resent attach repairs a worker session whose live preset drifted from the
 * record. Real worker isolate and production routing (`reservationHost`). The drift a lost attach
 * used to leave is the precondition under test; it is injected by sending the worker a preset behind
 * the registry's back, through the same `permission_preset` request an attach sends.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { reservationHost } from "./rpc-worker-reservation-support.ts";

const RUN_BASH = `export default function (pi) {
	pi.registerCommand("run-bash", {
		description: "run one shell command through the bash tool",
		handler: async (_args, ctx) => {
			try {
				const shell = await pi.executeTool("bash", { command: "printf permission-proof" });
				ctx.ui.notify("bash:" + (shell.content ?? []).map((block) => block.text ?? "").join(""));
			} catch (error) {
				ctx.ui.notify("bash:refused:" + (error instanceof Error ? error.message : String(error)));
			}
		},
	});
}`;

const WAIT_MS = 30_000;

type WireRecord = Record<string, unknown> & { id?: string; type?: string; sessionId?: string };

async function driftHost() {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-worker-drift-"));
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const extension = join(scratch, "run-bash.mjs");
	await writeFile(extension, RUN_BASH);
	const host = reservationHost(cwd, agentDir, extension);
	const records: WireRecord[] = [];
	const listeners = new Set<(record: WireRecord) => void>();
	const observe = (line: string): void => {
		const record = JSON.parse(line) as WireRecord;
		records.push(record);
		for (const listener of [...listeners]) listener(record);
	};
	for (const connection of ["first", "second"])
		host.writer.registerConnection(connection, { writeRaw: observe, waitForBackpressure: async () => {} });
	let serial = 0;
	const send = async (connection: string, frame: Record<string, unknown>): Promise<WireRecord | undefined> => {
		const id = `req-${++serial}`;
		const direct = await host.send(connection, { ...frame, id } as RpcCommand);
		await host.writer.flush();
		return (direct as WireRecord | undefined) ?? records.find((record) => record.id === id);
	};
	/** Runs "/run-bash" once, denying every permission ask: how many asks it raised and what bash printed. */
	const runBash = async (sessionId: string): Promise<{ asked: number; output: string }> => {
		let asked = 0;
		const printed = new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`waited ${WAIT_MS}ms for the bash notice`)), WAIT_MS);
			const listener = (record: WireRecord): void => {
				if (record.type !== "extension_ui_request" || record.sessionId !== sessionId) return;
				if (record.method === "select" && String(record.title).startsWith("Permission required:")) {
					asked++;
					void send("first", {
						type: "extension_ui_response",
						uiRequestId: String(record.id),
						sessionId,
						value: "Deny",
					});
				} else if (record.method === "notify" && String(record.message).startsWith("bash:")) {
					clearTimeout(timer);
					listeners.delete(listener);
					resolve(String(record.message));
				}
			};
			listeners.add(listener);
		});
		const prompted = await send("first", { type: "prompt", sessionId, message: "/run-bash" });
		if (prompted?.success === false) throw new Error(`prompt failed: ${String(prompted.error)}`);
		const output = await printed;
		return { asked, output };
	};
	const dispose = async () => {
		await host.dispose();
		for (const connection of ["first", "second"]) host.writer.unregisterConnection(connection);
		await rm(scratch, { recursive: true, force: true });
	};
	return { registry: host.registry, cwd, send, runBash, dispose };
}

it("a resent attach repairs a worker session whose live preset drifted from the recorded one (#2842)", async () => {
	const host = await driftHost();
	try {
		const opened = await host.send("first", { type: "open_session", cwd: host.cwd, permissionPreset: "ask" });
		const data = opened?.data as { sessionId?: string; state?: { sessionFile?: string } } | undefined;
		const sessionId = String(data?.sessionId);
		expect(await host.runBash(sessionId)).toMatchObject({
			asked: 1,
			output: expect.stringMatching(/^bash:refused:/),
		});

		// The drift: the record says ask, the worker's live session enforces full-access.
		await host.registry.peek(sessionId)?.worker?.setPermissionPreset("full-access");
		expect(host.registry.peek(sessionId)?.profile.permissionPreset).toBe("ask");
		expect(await host.runBash(sessionId)).toEqual({ asked: 0, output: "bash:permission-proof" });

		const attach = await host.send("second", {
			type: "open_session",
			cwd: host.cwd,
			sessionPath: data?.state?.sessionFile,
			permissionPreset: "ask",
		});
		expect(attach?.data).toMatchObject({ sessionId, attached: true });
		expect(await host.runBash(sessionId)).toMatchObject({
			asked: 1,
			output: expect.stringMatching(/^bash:refused:/),
		});
	} finally {
		await host.dispose();
	}
}, 120_000);
