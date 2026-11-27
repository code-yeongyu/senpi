import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createHostDaemonPaths, generationPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { readGenerationRows } from "../../../src/modes/rpc/host-generations.ts";
import * as metrics from "../../../src/modes/rpc/host-process-metrics.ts";

it("reports the footprint measured for a live generation rather than discarding it", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "generation-footprint-"));
	const paths = createHostDaemonPaths({ socket: join(agentDir, "host.sock"), agentDir });
	const generation = generationPaths(paths, "live");
	const read = vi.spyOn(metrics, "readHostProcessMetrics").mockResolvedValue({
		rss_mb: 50,
		host_rss_mb: 20,
		host_footprint_mb: 37,
		open_fds: null,
		zombies: null,
	});
	try {
		await mkdir(generation.dir, { recursive: true });
		await writeFile(generation.pidFile, JSON.stringify({ pid: process.pid }));
		const rows = await readGenerationRows(paths, { includeDead: true });
		expect(read).toHaveBeenCalledExactlyOnceWith(process.pid);
		expect(rows).toMatchObject([{ instanceId: "live", host_footprint_mb: 37 }]);
	} finally {
		read.mockRestore();
		await rm(agentDir, { recursive: true, force: true });
	}
});
