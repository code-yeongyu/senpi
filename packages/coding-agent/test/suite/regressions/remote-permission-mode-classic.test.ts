import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod";
import {
	hermeticProviderEnv,
	MOCK_API_KEY,
	MOCK_MODEL,
	MOCK_PROVIDER,
	writeRpcModelsJson,
} from "../../helpers/rpc-hermetic.ts";

// Remote approval-mode work (tracked privately): a task runner's spawned child is a classic `--mode rpc` process, which refuses
// open_session; set_permission_preset is the only way to move its live mode, so it must work on the stdio wire.

const reply = z.object({
	type: z.literal("response"),
	id: z.string(),
	success: z.boolean(),
	error: z.string().optional(),
	data: z.record(z.string(), z.unknown()).optional(),
});

function classicRpc(child: ChildProcessWithoutNullStreams) {
	const replies = new Map<string, (record: z.infer<typeof reply>) => void>();
	createInterface({ input: child.stdout }).on("line", (line) => {
		const parsed = reply.safeParse(JSON.parse(line));
		if (parsed.success) replies.get(parsed.data.id)?.(parsed.data);
	});
	let serial = 0;
	return (command: Record<string, unknown>): Promise<z.infer<typeof reply>> => {
		const id = `classic-${++serial}`;
		const answered = new Promise<z.infer<typeof reply>>((resolve) => replies.set(id, resolve));
		child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		return answered;
	};
}

function startClassic(agentDir: string, extraArgs: readonly string[] = []): ChildProcessWithoutNullStreams {
	return spawn(
		"node",
		[
			fileURLToPath(new URL("../../../src/cli.ts", import.meta.url)),
			"--mode",
			"rpc",
			"--no-extensions",
			"--no-skills",
			"--no-context-files",
			"--provider",
			MOCK_PROVIDER,
			"--model",
			MOCK_MODEL,
			...extraArgs,
		],
		{
			cwd: agentDir,
			env: {
				...process.env,
				...hermeticProviderEnv(),
				ANTHROPIC_API_KEY: MOCK_API_KEY,
				PI_OFFLINE: "1",
				SENPI_CODING_AGENT_DIR: agentDir,
			},
		},
	);
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
	child.kill("SIGTERM");
	await once(child, "close");
}

it("set_permission_preset moves a classic --mode rpc session and refuses an unknown preset", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "senpi-6189-classic-"));
	writeRpcModelsJson(agentDir, "http://127.0.0.1:9");
	const child = startClassic(agentDir);
	try {
		const request = classicRpc(child);

		const set = await request({ type: "set_permission_preset", permissionPreset: "ask" });
		expect(set.success).toBe(true);
		expect(set.data).toEqual({
			permissionPreset: "ask",
			permissionPresetSource: "client",
			permissionPresetStatus: "applied",
		});
		expect((await request({ type: "get_state" })).data).toMatchObject({
			permissionPreset: "ask",
			permissionPresetSource: "client",
			effectivePermissionPreset: "ask",
		});

		const refused = await request({ type: "set_permission_preset", permissionPreset: "full-acess" });
		expect(refused.success).toBe(false);
		expect(refused.error).toMatch(/^invalid_launch_profile: /);
		expect((await request({ type: "get_state" })).data).toMatchObject({ permissionPreset: "ask" });
	} finally {
		await stop(child);
		rmSync(agentDir, { recursive: true, force: true });
	}
}, 120_000);

it("keeps the operator's --permission-preset over a mode recorded in the session file", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "senpi-6189-classic-"));
	writeRpcModelsJson(agentDir, "http://127.0.0.1:9");
	const sessionFile = join(agentDir, "recorded.jsonl");
	const recording = startClassic(agentDir, ["--session", sessionFile]);
	let sessionId: unknown;
	try {
		const request = classicRpc(recording);
		expect((await request({ type: "set_permission_preset", permissionPreset: "full-access" })).success).toBe(true);
		expect((await request({ type: "append_user_message", content: "recorded turn" })).success).toBe(true);
		sessionId = (await request({ type: "get_state" })).data?.sessionId;
	} finally {
		await stop(recording);
	}
	const resumed = startClassic(agentDir, ["--session", sessionFile, "--permission-preset", "ask"]);
	try {
		const state = await classicRpc(resumed)({ type: "get_state" });
		expect(state.data).toMatchObject({
			sessionId,
			permissionPreset: "ask",
			permissionPresetSource: "host_default",
			effectivePermissionPreset: "ask",
		});
	} finally {
		await stop(resumed);
		rmSync(agentDir, { recursive: true, force: true });
	}
}, 120_000);
