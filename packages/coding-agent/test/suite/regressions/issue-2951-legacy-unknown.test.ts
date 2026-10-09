import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { processIsLive } from "../../../src/modes/app-server/daemon/process.ts";
import { createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { startSessionHolder } from "./issue-2951-holder-support.ts";

const run = promisify(execFile);

it("logs an unknown legacy identity across caller restarts without retiring it, then recovers after owner exit", async () => {
	const root = await mkdtemp(join(tmpdir(), "held-legacy-unknown-"));
	const id = "29510000-0000-4000-8000-000000000006";
	const file = join(root, "held.jsonl");
	await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id, cwd: root })}\n`);
	try {
		await using holder = await startSessionHolder(file, id, root);
		const paths = createHostDaemonPaths({ agentDir: root, socket: join(root, "rpc", "rpc.sock") });
		await mkdir(dirname(paths.legacyPidFile), { recursive: true });
		const record = `${JSON.stringify({ pid: holder.pid, processStartTime: "legacy timestamp unavailable" })}\n`;
		await writeFile(paths.legacyPidFile, record);
		const legacyModule = fileURLToPath(new URL("../../../src/modes/rpc/host-legacy.ts", import.meta.url));
		const pathsModule = fileURLToPath(new URL("../../../src/modes/rpc/host-daemon-paths.ts", import.meta.url));
		const identityModule = fileURLToPath(new URL("../../../src/modes/app-server/daemon/process.ts", import.meta.url));
		const stopModule = fileURLToPath(new URL("../../../src/modes/rpc/host-stop.ts", import.meta.url));
		const source = `
			import { retireIdleLegacyHost } from ${JSON.stringify(legacyModule)};
			import { createHostDaemonPaths } from ${JSON.stringify(pathsModule)};
			import { readProcessStartTime } from ${JSON.stringify(identityModule)};
			import { stopHost } from ${JSON.stringify(stopModule)};
			const paths = createHostDaemonPaths(${JSON.stringify({ agentDir: root, socket: paths.socket })});
			const detail = await retireIdleLegacyHost(paths, readProcessStartTime, 100);
			const stop = detail === undefined ? undefined : await stopHost({ socket: paths.socket, agentDir: ${JSON.stringify(root)}, drain: true });
			console.log(JSON.stringify({ refused: detail !== undefined, ...(stop === undefined ? {} : { stop }) }));
		`;
		const invoke = () =>
			run(process.execPath, ["--input-type=module", "-e", source], {
				encoding: "utf8",
				timeout: 20_000,
				env: {
					PATH: process.env.PATH,
					HOME: root,
					TMPDIR: root,
					SENPI_CODING_AGENT_DIR: join(root, "agent"),
				},
			});
		const unknownEvent = { event: "legacy_host_identity_unknown", record: "legacy_host.pid", pid: holder.pid };
		for (const attempt of [1, 2]) {
			const result = await invoke();
			expect(JSON.parse(result.stdout), `caller ${attempt}`).toEqual({
				refused: true,
				stop: { action: "refuse", reason: "unknown_owner" },
			});
			expect(
				result.stderr
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line)),
			).toEqual([unknownEvent]);
			expect(processIsLive(holder.pid)).toBe(true);
			expect(await readFile(paths.legacyPidFile, "utf8")).toBe(record);
		}
		await holder.stop();
		const restarted = await invoke();
		expect(JSON.parse(restarted.stdout)).toEqual({ refused: false });
		expect(restarted.stderr).toBe("");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 90_000);
