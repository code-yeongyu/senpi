import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	monitorStateDir,
	removeMonitorStateDir,
} from "../../../src/core/extensions/builtin/terminal/monitor-state-dir.ts";
import type { TerminalToolContext } from "../../../src/core/extensions/builtin/terminal/tools/context.ts";
import { createKillBashTool } from "../../../src/core/extensions/builtin/terminal/tools/kill-bash.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";

// senpi#2883: kill_bash stopped the watch, then let a failing state-dir `rm` replace the
// `Killed ...` result (and stop the `all: true` loop at the first failing dir).

const roots: string[] = [];
const lockedDirs: string[] = [];

afterEach(async () => {
	for (const dir of lockedDirs.splice(0)) await chmod(dir, 0o700);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionRoot(): Promise<{ root: string; terminalDir: string }> {
	const root = await mkdtemp(join(process.env.TMPDIR ?? process.cwd(), "senpi-2883-"));
	roots.push(root);
	return { root, terminalDir: join(root, "extensions", "terminal") };
}

/** A monitor state dir whose content cannot be unlinked: a real `rm` failure, not a mock. */
async function lockedStateDir(terminalDir: string, monitorId: string): Promise<void> {
	const held = join(monitorStateDir(terminalDir, monitorId), "held");
	await mkdir(held, { recursive: true });
	await writeFile(join(held, "checkpoint.json"), "{}");
	await chmod(held, 0o500);
	lockedDirs.push(held);
}

async function plainStateDir(terminalDir: string, monitorId: string): Promise<void> {
	const dir = monitorStateDir(terminalDir, monitorId);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "checkpoint.json"), "{}");
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

function toolContext(root: string, monitorIds: string[]): TerminalToolContext {
	const sessionContext = {
		mode: "interactive",
		sessionManager: { getSessionDir: () => root },
	} as unknown as ExtensionContext;
	return {
		manager: {
			size: 0,
			get: () => undefined,
			teardown: async () => {},
			monitorIdOf: () => undefined,
		},
		monitorRegistry: {
			snapshot: () => monitorIds.map((monitorId) => ({ monitorId })),
			stopAllFiles: async () => monitorIds.length,
			stopAllRpc: () => 0,
			stopFile: async () => true,
			stopRpc: () => false,
		},
		getSessionContext: () => sessionContext,
	} as unknown as TerminalToolContext;
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("");
}

describe("senpi#2883 kill_bash state-dir cleanup is best-effort", () => {
	it("reports the stopped watch as killed even when its state dir cannot be removed", async () => {
		const { root, terminalDir } = await sessionRoot();
		await lockedStateDir(terminalDir, "mon_LOCKED0000000000");
		const tool = createKillBashTool(toolContext(root, []));

		const result = await tool.execute("call-1", { bash_id: "mon_LOCKED0000000000" });

		expect(result.isError).toBeFalsy();
		expect(text(result)).toMatch(/^Killed mon_LOCKED0000000000\./);
	});

	it("with all:true removes every other state dir after one removal fails", async () => {
		const { root, terminalDir } = await sessionRoot();
		await lockedStateDir(terminalDir, "mon_LOCKED0000000000");
		await plainStateDir(terminalDir, "mon_PLAIN00000000000");
		const tool = createKillBashTool(toolContext(root, ["mon_LOCKED0000000000", "mon_PLAIN00000000000"]));

		const result = await tool.execute("call-2", { all: true });

		expect(result.isError).toBeFalsy();
		expect(text(result)).toMatch(/^Killed 2 session\(s\)\./);
		expect(await exists(monitorStateDir(terminalDir, "mon_PLAIN00000000000"))).toBe(false);
	});

	it("concurrent removals of one state dir (kill_bash and the monitor-ended sink) both settle", async () => {
		const { terminalDir } = await sessionRoot();
		for (let index = 0; index < 20; index++) {
			const monitorId = `mon_RACE${String(index).padStart(12, "0")}`;
			const dir = monitorStateDir(terminalDir, monitorId);
			for (let file = 0; file < 50; file++) {
				await mkdir(join(dir, `d${file % 5}`), { recursive: true });
				await writeFile(join(dir, `d${file % 5}`, `f${file}`), "x");
			}
			await expect(
				Promise.all([removeMonitorStateDir(terminalDir, monitorId), removeMonitorStateDir(terminalDir, monitorId)]),
			).resolves.toEqual([undefined, undefined]);
			expect(await exists(dir)).toBe(false);
		}
	});
});
