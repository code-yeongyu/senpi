import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../../../src/core/agent-session-services.ts";
import { buildLoginProviderInfos } from "../../../src/core/auth-providers.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";

/**
 * senpi#3434: a session on the multi-session host shares the host's ModelRuntime. Extension
 * provider registrations reach the runtime's credential store, so the session's ModelRegistry
 * must read that same store; otherwise extension OAuth providers (anthropic-subscription,
 * cursor-cli-oauth) vanish from get_auth_providers and the desktop offers only an API key.
 */
describe("host sessions list the same OAuth providers as standalone sessions (senpi#3434)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function workspace() {
		const root = mkdtempSync(join(tmpdir(), "senpi-3434-"));
		dirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		return { agentDir, cwd };
	}

	const ids = (services: Awaited<ReturnType<typeof createAgentSessionServices>>, authType: "oauth" | "api_key") =>
		buildLoginProviderInfos(services.modelRegistry, authType)
			.map((info) => info.id)
			.sort();
	const oauthIds = (services: Awaited<ReturnType<typeof createAgentSessionServices>>) => ids(services, "oauth");

	it("lists extension OAuth providers in every session on a shared runtime", async () => {
		const { agentDir, cwd } = workspace();
		const standalone = await createAgentSessionServices({ cwd, agentDir });

		// The host's construction (main.ts, multi-session branch).
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			authPath: join(agentDir, "auth.json"),
			agentDir,
			modelsPath: join(agentDir, "models.json"),
		});
		const first = await createAgentSessionServices({ cwd, agentDir, modelRuntime });
		const second = await createAgentSessionServices({ cwd, agentDir, modelRuntime });

		expect(oauthIds(standalone)).toEqual(expect.arrayContaining(["anthropic-subscription", "cursor-cli-oauth"]));
		expect(oauthIds(first)).toEqual(oauthIds(standalone));
		expect(oauthIds(second)).toEqual(oauthIds(standalone));
		expect(first.modelRegistry.authStorage).toBe(authStorage);
		expect(ids(first, "api_key")).toEqual(ids(standalone, "api_key"));
	});
});
