import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, it } from "vitest";
import { getMcpCatalogCachePath, readMcpCatalogCache } from "../../src/core/extensions/builtin/mcp/catalog-cache.ts";
import { normalizeServer } from "../../src/core/extensions/builtin/mcp/config.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { capturingPi } from "./fixtures/register-call.ts";
import { cleanupRoots, makeRoot, setConfig } from "./fixtures/service-lifecycle.ts";
import { sharingHttpFixture } from "./fixtures/sharing-http.ts";

function legacyHash(value: unknown): string {
	function stable(item: unknown): string {
		if (Array.isArray(item)) return `[${item.map(stable).join(",")}]`;
		if (typeof item === "object" && item !== null) {
			return `{${Object.entries(item)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
				.join(",")}}`;
		}
		return JSON.stringify(item);
	}
	return createHash("sha256").update(stable(value)).digest("hex");
}

// #3858: offline lazy catalogs migrate only for the same config AND account.
it.each(["same", "changed"] as const)("adopts legacy cache only for %s credentials", async (account) => {
	const cleanup: Array<() => Promise<void>> = [];
	const fixture = await sharingHttpFixture();
	const service = new McpService();
	try {
		const root = makeRoot("3858-migrate", cleanup);
		const raw = { type: "http" as const, url: fixture.url, bearerTokenEnv: "TOKEN", exposure: "direct" as const };
		setConfig(root, { fx: raw });
		const { startupTimeoutMs: _timeout, ...hashable } = normalizeServer(raw);
		const configHash = legacyHash(hashable);
		const credentialIdentity = createHash("sha256")
			.update(JSON.stringify(["mcp-catalog-bearer", "old-account"]))
			.digest("hex");
		const path = getMcpCatalogCachePath(root.agentDir);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				servers: {
					fx: {
						configHash,
						credentialIdentity,
						fetchedAt: Date.now(),
						tools: [{ name: "offline", inputSchema: { type: "object" } }],
						resources: [],
						prompts: [],
					},
				},
			}),
		);
		fixture.holdLists();
		const pi = capturingPi();
		await service.attachSession(
			{ type: "session_start", reason: "startup" },
			{ cwd: root.cwd, isProjectTrusted: () => true },
			pi,
			{ agentDir: root.agentDir, env: { TOKEN: account === "same" ? "old-account" : "new-account" } },
		);
		expect(pi.toolDefinitions.has("mcp_fx_offline")).toBe(account === "same");
		if (account === "same") {
			const migrated = (await readMcpCatalogCache(root.agentDir)).servers.fx;
			expect(migrated?.configHash).not.toBe(configHash);
			expect(migrated?.credentialIdentity).not.toBe(credentialIdentity);
			expect(migrated?.configHash).toBe(service.getServerSnapshots()[0]?.configHash);
		}
	} finally {
		fixture.releaseLists();
		await service.whenAttachSettled(10_000);
		await service.dispose("quit");
		await fixture.close();
		await cleanupRoots(cleanup);
	}
});
