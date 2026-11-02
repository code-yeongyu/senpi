// #3796: real shared leases and connection generations, with only policy IO held.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { normalizeServer } from "../../../src/core/extensions/builtin/mcp/config.ts";
import { HostMcpRegistry } from "../../../src/core/extensions/builtin/mcp/host-registry.ts";
import { createMcpLogger } from "../../../src/core/extensions/builtin/mcp/log.ts";
import type { ProjectMcpAuthority } from "../../../src/core/extensions/builtin/mcp/project-skill-policy.ts";

it("separates identical transports by authority and aborts pending shared materialization", async () => {
	const root = mkdtempSync(join(tmpdir(), "senpi-3796-shared-"));
	const registry = new HostMcpRegistry();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const config = normalizeServer({ command: "synthetic-command" });
	const authority: ProjectMcpAuthority = {
		identity: "synthetic-authority-a",
		storePath: join(root, "mcp-env-grants.json"),
		policyDigest: "synthetic-policy",
		provenanceDigest: "synthetic-provenance",
		initial: { config, env: {}, grantedNames: [] },
		resolve: async () => {
			entered.resolve();
			await release.promise;
			return { config, env: {}, grantedNames: [] };
		},
	};
	const base = {
		agentDir: root,
		serverName: "probe",
		config,
		configHash: "synthetic-config",
		logger: createMcpLogger("probe", { logDir: root }),
	};
	const first = registry.attachShared("first", {}, { ...base, projectPolicy: authority });
	const same = registry.attachShared("same", {}, { ...base, projectPolicy: authority });
	const other = registry.attachShared(
		"other",
		{},
		{
			...base,
			projectPolicy: { ...authority, identity: "synthetic-authority-b" },
		},
	);
	try {
		expect(registry.size()).toBe(2);
		const pending = first.connect();
		const rejected = expect(pending).rejects.toMatchObject({ retriable: true });
		await entered.promise;
		await registry.invalidateIdentity(authority.identity);
		release.resolve();
		await rejected;
		expect(first.generation).toBe(same.generation);
		expect(other.generation).toBe(0);
	} finally {
		release.resolve();
		await registry.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
