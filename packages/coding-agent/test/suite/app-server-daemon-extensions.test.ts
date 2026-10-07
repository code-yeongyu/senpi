import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packageRoot, runDaemonCli, startDaemonOnQaPort } from "./app-server-daemon-cli-harness.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function readLaunchIntent(agentDir: string): Promise<unknown> {
	return JSON.parse(await readFile(join(agentDir, "app-server-daemon", "settings.json"), "utf8"));
}

describe("app-server daemon extensions (omo#9117)", () => {
	it("launches the daemon with --extension, records it, and keeps it across restart", async () => {
		// Given: a scratch agent dir and a relative extension path resolved against the invoking cwd.
		const root = await mkdtemp(join(tmpdir(), "senpi-daemon-ext-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const extension = resolve(packageRoot, "plugin-fixture");

		try {
			// When: the daemon starts with the extension, then restarts without naming it.
			const { listen, started } = await startDaemonOnQaPort(agentDir, 18999, ["--extension", "./plugin-fixture"]);
			const startedIntent = await readLaunchIntent(agentDir);
			const restarted = await runDaemonCli(agentDir, ["restart"]);
			const restartedIntent = await readLaunchIntent(agentDir);

			// Then: the child accepted the flag (it answered initialize) and the intent survives restart.
			expect(started.json).toMatchObject({ status: "started", listen });
			expect(startedIntent).toMatchObject({ extensions: [extension] });
			expect(restarted.json).toMatchObject({ status: "started", listen });
			expect(restarted.json.pid).not.toBe(started.json.pid);
			expect(restartedIntent).toMatchObject({ extensions: [extension] });
		} finally {
			await runDaemonCli(agentDir, ["stop"]).catch(() => undefined);
		}
	}, 180_000);
});
