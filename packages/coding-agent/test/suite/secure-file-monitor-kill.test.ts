import { existsSync, watch, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import { MonitorRegistry } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import { SecureFileMonitorWorkerPool } from "../../src/core/extensions/builtin/terminal/secure-file-monitor-worker.ts";
import { createKillBashTool } from "../../src/core/extensions/builtin/terminal/tools/kill-bash.ts";
import { createMonitorTool, type MonitorInput } from "../../src/core/extensions/builtin/terminal/tools/monitor.ts";

const gatedCancelWorker = `
const { existsSync, statSync, watch, writeFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const identity = statSync(".", { bigint: true });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
send({ type: "ready", device: String(identity.dev), inode: String(identity.ino) });
createInterface({ input: process.stdin }).on("line", (line) => {
	const request = JSON.parse(line);
	if (request.type === "register") send({ type: "registered", requestId: request.requestId });
	else if (request.type === "cancel") {
		const release = () => {
			if (!existsSync("release-cancel")) return;
			watcher.close();
			send({ type: "cancelled", requestId: request.requestId });
		};
		const watcher = watch(".", release);
		writeFileSync("cancel-ready", "ready");
		release();
	} else if (request.type === "shutdown") process.exit(0);
});
`;

function waitForFile(path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const watcher = watch(join(path, ".."), settle);
		const timeout = setTimeout(() => {
			watcher.close();
			reject(new Error(`Timed out waiting for ${path}`));
		}, 3000);
		function settle(): void {
			if (!existsSync(path)) return;
			clearTimeout(timeout);
			watcher.close();
			resolve();
		}
		settle();
	});
}

describe("secure file monitor kill lifecycle", () => {
	it("does not report kill success before worker cancellation completes", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-secure-monitor-kill-")));
		const workers = new SecureFileMonitorWorkerPool({
			workerCommand: [process.execPath, "-e", gatedCancelWorker],
		});
		const manager = new TerminalManager();
		const registry = new MonitorRegistry(() => {}, { fileMonitor: { secureWorkers: workers } });
		const context = {
			manager,
			monitorRegistry: registry,
			cwd: root,
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => ({ ...process.env }),
		};
		const monitor = createMonitorTool(context);
		const kill = createKillBashTool(context);

		try {
			const started = await monitor.execute("secure-kill-start", {
				description: "secure kill",
				path: join(root, "claim.json"),
				event: "create",
			} as MonitorInput);
			const cancellationReady = waitForFile(join(root, "cancel-ready"));
			let settled = false;
			const bashId = (started.details as { bash_id?: string } | undefined)?.bash_id;
			const killing = kill.execute("secure-kill", { bash_id: bashId }).then((result) => {
				settled = true;
				return result;
			});
			await cancellationReady;
			expect(settled).toBe(false);

			writeFileSync(join(root, "release-cancel"), "release");
			const result = await killing;
			expect(result.isError).toBeFalsy();
			expect(workers.workerCount).toBe(0);
			expect(registry.snapshot()).toEqual([]);
		} finally {
			await registry.teardown();
			await manager.teardown();
			await rm(root, { recursive: true, force: true });
		}
	});
});
