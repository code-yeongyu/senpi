import { afterEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../../src/core/extensions/builtin/mcp/config.ts";
import { shareable } from "../../src/core/extensions/builtin/mcp/host-registry.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import { sharedMcpKey } from "../../src/core/extensions/builtin/mcp/sharing-policy.ts";
import { serverConfig } from "./fixtures/reconnect.ts";
import { cleanupRoots, makeRoot, setConfig } from "./fixtures/service-lifecycle.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(() => cleanupRoots(cleanup));

describe("shared MCP eligibility and identity", () => {
	it.each(["cwd", "session", "PROJECT_CWD"])("retains resolved template provenance for %s", (variable) => {
		const template = `\${${variable}}`;
		const root = makeRoot("share-policy", cleanup);
		setConfig(root, { fx: { type: "stdio", command: "server", args: [template] } });
		const config = loadMcpConfig({
			...root,
			projectTrusted: true,
			env: { cwd: "resolved", session: "resolved", PROJECT_CWD: "resolved" },
		}).servers.fx.config;
		if (!config) throw new Error("missing config");
		expect(config.args).toEqual(["resolved"]);
		expect(shareable(config)).toBe(false);
	});

	it("includes resolved bearer credentials and agent directory but not owner policies", () => {
		const config = {
			...serverConfig(),
			type: "http" as const,
			url: "http://127.0.0.1/mcp",
			auth: "bearer" as const,
			bearerTokenEnv: "QA_TOKEN",
		};
		const options = { config, logger: createMcpLogger("fx"), serverName: "fx", env: { QA_TOKEN: "synthetic-A" } };
		const key = sharedMcpKey(options, "/agent-A");
		expect(
			sharedMcpKey(
				{ ...options, config: { ...config, idleTimeoutMin: 5, lifecycle: "keep-alive", exposure: "search" } },
				"/agent-A",
			),
		).toBe(key);
		expect(sharedMcpKey(options, "/agent-B")).not.toBe(key);
		expect(sharedMcpKey({ ...options, env: { QA_TOKEN: "synthetic-B" } }, "/agent-A")).not.toBe(key);
	});
});
