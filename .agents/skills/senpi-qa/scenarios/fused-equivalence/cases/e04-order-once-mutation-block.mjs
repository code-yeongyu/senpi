// E04 (plan §6.4, G1 + the P0-02a fixture design): order-once + PostToolUse mutation + block. O1-O8.
//
// One batch of two calls to the inactive `qa` tool: `{legacy:"42"}` runs the whole order exactly once (activate, shim,
// handlers, the trusted shell PreToolUse hook, body, then the PostToolUse hook that replaces the result), and
// `{legacy:"7"}` is blocked by hook2, so its body never runs. trace.log (O5 tree) holds the order; the replaced result
// and the block reason reach the next request (O1) and the transcript (O7).
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveBun } from "../../../scripts/lib/common.mjs";
import { FIXTURES } from "./support/case-run.mjs";
import { ALL_OBSERVABLES } from "./support/observables.mjs";

const E04 = join(FIXTURES, "e04");

export default {
	id: "E04",
	title: "order-once + PostToolUse mutation + block (G1)",
	observables: ALL_OBSERVABLES,
	spec: {
		extensions: [join(E04, "qa-extension.mjs"), join(E04, "block-extension.mjs")],
		turns: [
			{
				toolCalls: [
					{ id: "g1-run", name: "qa", args: { legacy: "42" } },
					{ id: "g1-block", name: "qa", args: { legacy: "7" } },
				],
			},
			{ text: "E04-DONE" },
		],
	},
	async drive(run) {
		// The hook command is the hook's status message, which the product cuts at a fixed width before anything is
		// normalized; written with absolute paths it carried the host's node install and checkout path, and where the cut
		// landed followed their length. Hooks run in the session cwd, so the command is fixed relative text instead: the
		// harness node linked and the hook copied under the project's `.senpi/` (configuration, outside the O5 tree).
		const local = join(run.box.cwd, ".senpi");
		mkdirSync(local, { recursive: true });
		symlinkSync(process.execPath, join(local, "eq-node"));
		copyFileSync(join(E04, "shell-hook.mjs"), join(local, "eq-hook.mjs"));
		const command = (kind) => `.senpi/eq-node .senpi/eq-hook.mjs ${kind} trace.log`;
		const setup = spawnSync(
			resolveBun().command,
			[join(E04, "write-hooks.ts"), run.box.cwd, command("pre"), command("post")],
			{
				encoding: "utf8",
			},
		);
		if (setup.status !== 0) throw new Error(`write-hooks.ts failed: ${setup.stderr}`);
		await run.open();
		await run.prompt("run qa twice");
		await run.close();
		await run.reopenState();
	},
};
