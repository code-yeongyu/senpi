import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionServices } from "../../../src/core/agent-session-services.ts";
import { authMethodStatus, buildLoginProviderInfos } from "../../../src/core/auth-providers.ts";

/**
 * senpi#3537: the Claude subscription's `check` reports a CLAUDE_CODE_OAUTH_TOKEN as a sign-in
 * (`type: "oauth"`), and the router uses it as one, but `get_auth_providers` filed it on the
 * provider's api_key row. RPC clients showed the subscription as not connected beside a second
 * "API key". The rows here are built exactly as `get_auth_providers` builds them.
 */
describe("a non-stored subscription sign-in is reported on the sign-in row (senpi#3537)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		vi.unstubAllEnvs();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function rowsFor(provider: string) {
		const root = mkdtempSync(join(tmpdir(), "senpi-3537-"));
		dirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const { modelRegistry } = await createAgentSessionServices({ cwd, agentDir });
		const apiKeyRows = new Set(buildLoginProviderInfos(modelRegistry, "api_key").map((info) => info.id));
		const infos = [
			...buildLoginProviderInfos(modelRegistry, "oauth"),
			...buildLoginProviderInfos(modelRegistry, "api_key"),
		].filter((info) => info.id === provider);
		return Object.fromEntries(
			infos.map((info) => [info.authType, authMethodStatus(modelRegistry, info, apiKeyRows.has(info.id))]),
		);
	}

	it("reports a CLAUDE_CODE_OAUTH_TOKEN on the subscription's sign-in row, not its key row", async () => {
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-scripted-not-a-token");
		expect(await rowsFor("anthropic-subscription")).toEqual({
			oauth: { configured: true, source: "environment", label: "Anthropic Subscription" },
			api_key: { configured: false },
		});
	});

	it("keeps an environment API key on the provider's key row", async () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-scripted-not-a-key");
		const rows = await rowsFor("openai");
		expect(rows.api_key).toEqual({ configured: true, source: "environment", label: "OPENAI_API_KEY" });
		if ("oauth" in rows) expect(rows.oauth).toEqual({ configured: false });
	});
});
