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

it("set_permission_preset moves a classic --mode rpc session and refuses an unknown preset", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "senpi-6189-classic-"));
	writeRpcModelsJson(agentDir, "http://127.0.0.1:9");
	const child = spawn(
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
		child.kill("SIGTERM");
		await once(child, "close");
		rmSync(agentDir, { recursive: true, force: true });
	}
}, 120_000);
