import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeServer } from "../../../src/core/extensions/builtin/mcp/config.ts";
import { HostMcpRegistry } from "../../../src/core/extensions/builtin/mcp/host-registry.ts";
import { createMcpLogger } from "../../../src/core/extensions/builtin/mcp/log.ts";
import { MrtrScript, startMrtrServer } from "./mrtr-2026-server.ts";

export async function pooledMrtr(results: unknown[], cleanup: Array<() => Promise<void>>, elicitationEnabled = true) {
	const script = new MrtrScript(results);
	const server = await startMrtrServer(script);
	cleanup.push(server.close);
	const root = await mkdtemp(join(tmpdir(), "mrtr-pool-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const registry = new HostMcpRegistry();
	cleanup.push(() => registry.dispose());
	const config = normalizeServer({ type: "http", url: server.url, auth: false });
	const attach = () => {
		const connection = registry.attachShared(
			"same",
			{},
			{
				serverName: "fixture",
				config,
				configHash: "same",
				elicitationEnabled,
				agentDir: root,
				logger: createMcpLogger("fixture", { logDir: root }),
			},
		);
		return connection;
	};
	const a = attach(),
		b = attach();
	await Promise.all([a.connect(), b.connect()]);
	return { a, b, script, registry };
}
