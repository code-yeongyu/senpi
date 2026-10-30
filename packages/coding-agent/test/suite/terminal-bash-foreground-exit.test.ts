import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import { createPtyBashTool } from "../../src/core/extensions/builtin/terminal/tools/bash.ts";
import type { TerminalToolContext } from "../../src/core/extensions/builtin/terminal/tools/context.ts";

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((block) => block.type === "text")?.text ?? "";
}

describe("terminal bash foreground exit", () => {
	let manager: TerminalManager;
	let ctx: TerminalToolContext;
	let dir: string;

	beforeEach(async () => {
		manager = new TerminalManager();
		ctx = {
			manager,
			cwd: process.cwd(),
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => ({ ...process.env }),
		};
		dir = await mkdtemp(join(tmpdir(), "senpi-fg-exit-"));
	});

	afterEach(async () => {
		await manager.teardown();
		await rm(dir, { recursive: true, force: true });
	});

	it("nothing signals a normally-returning foreground job's process group: a ready nohup child stays alive across the call", async () => {
		const tool = createPtyBashTool(ctx);
		const ready = join(dir, "ready");
		const pidFile = join(dir, "bg.pid");
		try {
			// Guards a contract this PR newly documents (the docs are the change): a normal
			// foreground return never signals the job's group on either backend — native
			// PtySession::wait never kills, and the pipe fallback only kills at a deadline.
			// The readiness file makes the native SIGHUP race deterministic: it exists only
			// after the nohup'd child runs with SIGHUP ignored, so the hangup spares it.
			const start = await tool.execute("fg-nohup-start", {
				command: `nohup sh -c 'touch ${ready}; exec sleep 30' >/dev/null 2>&1 & echo $! > ${pidFile}; until test -f ${ready}; do sleep 0.05; done; echo STARTED`,
			});
			expect(start.isError).toBeFalsy();
			expect(firstText(start)).toContain("STARTED");

			const probe = await tool.execute("fg-nohup-probe", {
				command: `kill -0 $(cat ${pidFile}) 2>/dev/null && echo ALIVE || echo DEAD`,
			});
			expect(firstText(probe)).toContain("ALIVE");
		} finally {
			// teardown() cannot reach this child (it left the tool's process group), so a
			// failed assertion must not leak the 30s sleep.
			await tool.execute("fg-nohup-cleanup", {
				command: `kill $(cat ${pidFile}) 2>/dev/null; echo CLEANED`,
			});
		}
	});
});
