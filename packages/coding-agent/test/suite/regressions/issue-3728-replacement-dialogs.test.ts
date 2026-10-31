import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startInProcessHost } from "../rpc-worker-host-support.ts";

const extension = `export default function (pi) {
	pi.registerCommand("hold-dialog", { handler: async (method, ctx) => {
		const answer = method === "select"
			? ctx.ui.select("replacement-dialog", ["yes", "no"])
			: ctx.ui.confirm("replacement-dialog", "Continue?");
		void answer.then(value => ctx.ui.notify("dialog-answer:" + value));
	} });
	pi.registerCommand("replace-session", { handler: async (args, ctx) => {
		const [method, target] = JSON.parse(args);
		switch (method) {
			case "newSession": await ctx.newSession(); break;
			case "switchSession": await ctx.switchSession(target); break;
			case "fork": await ctx.fork("aaaaaaaa"); break;
		}
	} });
}`;

const paths = [
	"new_session",
	"switch_session",
	"fork_before",
	"fork_at",
	"clone",
	"import_jsonl",
	"extension_newSession",
	"extension_switchSession",
	"extension_fork",
] as const;

afterEach(() => vi.unstubAllEnvs());

// #3728: replacing the runtime must not erase live dialogs from the recovery snapshot.
it.each(paths.flatMap((path) => ["select", "confirm"].map((method) => ({ path, method }))))(
	"keeps the live $method dialog in get_state after $path",
	async ({ path, method }) => {
		vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
		const host = await startInProcessHost(extension);
		try {
			const client = await host.connect();
			const initial = join(host.scratch, "initial.jsonl");
			const target = join(host.scratch, "target.jsonl");
			for (const [file, id] of [
				[initial, "initial-session"],
				[target, "target-session"],
			] as const) {
				await writeFile(
					file,
					`${[
						{ type: "session", version: 3, id, cwd: host.cwd, timestamp: new Date(0).toISOString() },
						{
							type: "message",
							id: "aaaaaaaa",
							parentId: null,
							timestamp: new Date(0).toISOString(),
							message: { role: "user", content: [{ type: "text", text: "fixture" }], timestamp: 0 },
						},
					]
						.map((entry) => JSON.stringify(entry))
						.join("\n")}\n`,
				);
			}
			const opened = await client.request({ type: "open_session", cwd: host.cwd, sessionPath: initial });
			expect(opened.success).toBe(true);
			const sessionId = opened.data?.sessionId;
			const asked = client.wait((record) => record.type === "extension_ui_request" && record.method === method);
			const [, dialog] = await Promise.all([
				client.request({ type: "prompt", sessionId, message: `/hold-dialog ${method}` }),
				asked,
			]);
			const before = await client.request({ type: "get_state", sessionId });
			expect(before.data?.pendingDialogs).toEqual([expect.objectContaining({ id: dialog.id, method })]);

			let command: Record<string, unknown>;
			switch (path) {
				case "new_session":
				case "clone":
					command = { type: path };
					break;
				case "switch_session":
					command = { type: path, sessionPath: target };
					break;
				case "import_jsonl":
					command = { type: path, inputPath: target };
					break;
				case "fork_before":
				case "fork_at":
					command = { type: "fork", entryId: "aaaaaaaa", position: path === "fork_at" ? "at" : "before" };
					break;
				case "extension_newSession":
				case "extension_switchSession":
				case "extension_fork":
					command = { type: "prompt", message: `/replace-session ${JSON.stringify([path.slice(10), target])}` };
					break;
			}
			expect(await client.request({ ...command, sessionId })).toMatchObject({ success: true });
			const after = await client.request({ type: "get_state", sessionId });
			expect(after.success).toBe(true);
			expect(after.data?.sessionId).not.toBe(before.data?.sessionId);
			expect(after.data?.pendingDialogs).toEqual([expect.objectContaining({ id: dialog.id, method })]);

			expect(
				await client.request({
					type: "extension_ui_response",
					sessionId,
					uiRequestId: dialog.id,
					...(method === "select" ? { value: "yes" } : { confirmed: true }),
				}),
			).toMatchObject({ success: true });
			const resolved = await client.request({ type: "get_state", sessionId });
			expect(resolved.data?.pendingDialogs).toEqual([]);
		} finally {
			await host.dispose();
		}
	},
	60_000,
);
