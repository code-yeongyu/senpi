import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import { MonitorRegistry } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import { processBootAtMs, sameBoot } from "../../src/core/extensions/builtin/terminal/process-identity.ts";
import { TerminalManifestWriter } from "../../src/core/extensions/builtin/terminal/terminal-manifest.ts";
import type { TerminalToolContext } from "../../src/core/extensions/builtin/terminal/tools/context.ts";
import {
	bindTerminalManifestWriter,
	createMonitorTool,
	unbindTerminalManifestWriter,
} from "../../src/core/extensions/builtin/terminal/tools/monitor.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

let seq = 0;

async function harness() {
	seq += 1;
	const sessionId = `runtime-identity-${process.pid}-${seq}`;
	const sessionDir = await mkdtemp(join(tmpdir(), "senpi-runtime-identity-"));
	const writer = new TerminalManifestWriter({
		session: { getSessionDir: () => sessionDir, getSessionId: () => sessionId },
	});
	const manager = new TerminalManager();
	const registry = new MonitorRegistry(() => {}, {
		onChange: (snapshot) => void writer.observeMonitorState(snapshot),
	});
	const ctx: TerminalToolContext = {
		manager,
		cwd: sessionDir,
		defaultCols: 120,
		defaultRows: 40,
		getEnv: () => ({ ...process.env }),
		monitorRegistry: registry,
		getSessionContext: () => ({ sessionManager: { getSessionId: () => sessionId } }) as unknown as ExtensionContext,
	};
	bindTerminalManifestWriter(sessionId, writer);
	cleanups.push(async () => {
		registry.dispose();
		await manager.teardown();
		await writer.flush();
		unbindTerminalManifestWriter(sessionId);
		await rm(sessionDir, { recursive: true, force: true });
	});
	return { writer, tool: createMonitorTool(ctx) };
}

describe("monitor create records the child's runtime identity", () => {
	it.runIf(process.platform !== "win32")(
		"persists pid, start instant, boot instant and argv of the real child for a persistent watch",
		async () => {
			const { writer, tool } = await harness();
			const before = Date.now();
			const created = await tool.execute("create", {
				description: "identity watch",
				command: "while true; do sleep 1; done",
				persistent: true,
			});
			expect(created.isError).not.toBe(true);
			const entry = (await writer.store.read())?.monitors[0];
			const runtime = entry?.runtime;
			expect(runtime).toBeDefined();
			if (runtime === undefined) return;
			expect(runtime.pid).toBeGreaterThan(0);
			expect(execFileSync("ps", ["-o", "pid=", "-p", String(runtime.pid)], { encoding: "utf8" }).trim()).toBe(
				String(runtime.pid),
			);
			expect(runtime.startedAtMs).toBeGreaterThanOrEqual(before - 1_000);
			expect(runtime.startedAtMs).toBeLessThanOrEqual(Date.now());
			// The boot instant is now - uptime (whole seconds), so two reads can differ by a second.
			expect(sameBoot(runtime.bootAtMs, processBootAtMs())).toBe(true);
			expect(runtime.argv.at(-1)).toBe("while true; do sleep 1; done");
			expect(entry?.deadlineMs).toBeUndefined();
		},
	);

	it("persists the absolute deadline of an ephemeral watch", async () => {
		const { writer, tool } = await harness();
		const before = Date.now();
		await tool.execute("create", { description: "ephemeral watch", command: "cat", timeout_ms: 60_000 });
		const entry = (await writer.store.read())?.monitors[0];
		expect(entry?.durabilityClass).toBe("ephemeral");
		expect(entry?.deadlineMs).toBeGreaterThanOrEqual(before + 60_000);
		expect(entry?.deadlineMs).toBeLessThanOrEqual(Date.now() + 60_000);
	});
});
