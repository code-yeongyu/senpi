import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { SESSION_WORKER_LIMITS } from "../../src/modes/rpc/session-worker-protocol.ts";
import { reservationHost, reservationStep as step } from "./rpc-worker-reservation-support.ts";

async function tree(root: string): Promise<string[]> {
	const entries = await readdir(root, { recursive: true, withFileTypes: true });
	const listed = await Promise.all(
		entries.map(async (entry) => {
			const path = join(entry.parentPath, entry.name);
			// The host's diagnostic log is content-free (allowlisted keys, no message text) and is written for every
			// session, as the CLI's own --no-session writes it: its presence is compared, its growth is not.
			if (!entry.isFile() || relative(root, path) === join("agent", "logs", "session.log"))
				return relative(root, path);
			return `${relative(root, path)} ${createHash("sha256")
				.update(await readFile(path))
				.digest("hex")}`;
		}),
	);
	return listed.sort();
}

function data(response: unknown): Record<string, unknown> {
	const record = response as { success?: boolean; error?: string; data?: Record<string, unknown> } | undefined;
	if (record?.success !== true) throw new Error(`request failed: ${String(record?.error)}`);
	return record.data ?? {};
}

// senpi#7567: a worker isolate carries persistence "none" on the launch profile it is prepared with, so neither the
// isolate nor the host side of the worker open names, claims or reserves a file for the session.
it(
	"writes nothing for a memory-only session that runs in a worker isolate",
	async () => {
		// given
		const scratch = await mkdtemp(join(tmpdir(), "senpi-7567-worker-"));
		const cwd = join(scratch, "cwd");
		const agentDir = join(scratch, "agent");
		await mkdir(cwd);
		await mkdir(agentDir);
		const host = reservationHost(cwd, agentDir);
		host.connect("controller");
		const send = (command: RpcCommand) => host.send("controller", command);
		const lifecycle = async (label: string) => {
			const open = { type: "open_session", cwd, persistence: "none" } as const;
			const opened = data(await step(`${label}-open`, send({ id: `${label}-open`, ...open })));
			const sessionId = String(opened.sessionId);
			const bash = data(await step(`${label}-bash`, send({ type: "bash", sessionId, command: "echo hi" })));
			const state = data(await send({ type: "get_state", sessionId }));
			const row = host.registry.list().find((listed) => listed.sessionId === sessionId);
			await step(`${label}-close`, send({ type: "close_session", sessionId }));
			return { opened, bash, state, row };
		};
		try {
			await lifecycle("warm");
			const before = await tree(scratch);

			// when
			const { opened, bash, state, row } = await lifecycle("ephemeral");

			// then
			expect(bash.output).toContain("hi");
			expect(state.sessionFile ?? null).toBeNull();
			expect(opened.sessionPath ?? null).toBeNull();
			expect(row?.persistence).toBe("none");
			expect(row?.sessionPath).toBeUndefined();
			expect(await tree(scratch)).toEqual(before);
			expect(before.filter((path) => path.includes(".jsonl"))).toEqual([]);
		} finally {
			await host.dispose();
			await rm(scratch, { recursive: true, force: true });
		}
	},
	4 * SESSION_WORKER_LIMITS.openMs,
);
