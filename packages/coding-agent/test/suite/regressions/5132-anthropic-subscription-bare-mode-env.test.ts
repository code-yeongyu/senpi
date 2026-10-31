import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	overrideAuthLaneBoundary,
	queryWithAuthLane,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import { probeAmbientClaudeAuthStatus } from "../../../src/core/extensions/builtin/anthropic-subscription/availability.ts";
import { buildClaudeCliEnvironment } from "../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-environment.ts";
import type {
	Options,
	SDKMessage,
	SdkQuery,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";

// Claude Code's bare mode: with it set, Claude Code never reads the OAuth login, so the subscription goes unused.
const BARE_MODE = { CLAUDE_CODE_SIMPLE: "1" };
const UNRELATED = { PATH: "/usr/bin", KEEP_ME: "kept" };

let agentDir: string | undefined;

afterEach(() => {
	resetAuthLaneBoundary();
	if (agentDir) rmSync(agentDir, { recursive: true, force: true });
	agentDir = undefined;
});

function queryCapturing(captured: Options[]): SdkQuery {
	return ({ options }) => {
		if (!options) throw new Error("SDK query options are required");
		captured.push(options);
		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				yield { type: "result", subtype: "success", result: "ok" } as SDKMessage;
			},
			async interrupt() {},
			close() {},
		};
	};
}

async function turnEnvironment(
	hostEnvironment: NodeJS.ProcessEnv,
	tokenInjection: "ambient" | "oauth-slots" | "config-dir",
): Promise<Options["env"]> {
	agentDir = mkdtempSync(join(tmpdir(), "senpi-5132-"));
	const directory = agentDir;
	overrideAuthLaneBoundary({
		createStore: () => new InMemoryCredentialStore(),
		env: () => hostEnvironment,
		getAgentDir: () => directory,
	});
	const captured: Options[] = [];
	for await (const _message of queryWithAuthLane({
		prompt: "",
		query: queryCapturing(captured),
		providerSettings: { tokenInjection },
		buildOptions: () => ({}),
	})) {
		// Drain the synthetic query.
	}
	expect(captured).toHaveLength(1);
	return captured[0]?.env;
}

describe("senpi#5132 the Claude Code child never inherits bare mode", () => {
	it.each([
		["ambient", {}],
		["ambient", { CLAUDE_CODE_OAUTH_TOKEN: "dummy-token" }],
		["oauth-slots", { CLAUDE_CODE_OAUTH_TOKEN: "dummy-token" }],
		["config-dir", { CLAUDE_CODE_OAUTH_TOKEN: "dummy-token" }],
	] as const)("clears it on the %s lane and passes the rest through", async (lane, credential) => {
		const environment = await turnEnvironment({ ...UNRELATED, ...BARE_MODE, ...credential }, lane);

		expect(environment).not.toHaveProperty("CLAUDE_CODE_SIMPLE");
		expect(environment).toMatchObject(UNRELATED);
	});

	it("clears it regardless of the variable's case", async () => {
		const environment = await turnEnvironment({ ...UNRELATED, claude_code_simple: "1" }, "ambient");

		expect(Object.keys(environment ?? {}).map((name) => name.toUpperCase())).not.toContain("CLAUDE_CODE_SIMPLE");
		expect(environment).toMatchObject(UNRELATED);
	});

	it("clears it for `claude auth *` spawns of a CLI-store account", () => {
		const environment = buildClaudeCliEnvironment({ ...UNRELATED, ...BARE_MODE }, { configDir: "/accounts/a" });

		expect(environment).not.toHaveProperty("CLAUDE_CODE_SIMPLE");
		expect(environment).toMatchObject({ ...UNRELATED, CLAUDE_CONFIG_DIR: "/accounts/a" });
	});

	it("clears it for the ambient `claude auth status` probe", async () => {
		const spawned: NodeJS.ProcessEnv[] = [];
		const available = await probeAmbientClaudeAuthStatus({
			environment: { ...UNRELATED, ...BARE_MODE },
			spawnProbe: (_command, _args, environment) => {
				spawned.push(environment);
				const child = {
					pid: 1,
					once(event: "error" | "close", listener: (code: number | null) => void) {
						if (event === "close") queueMicrotask(() => listener(0));
						return child;
					},
					kill() {},
				};
				return child;
			},
		});

		expect(available).toBe(true);
		expect(spawned).toHaveLength(1);
		expect(spawned[0]).not.toHaveProperty("CLAUDE_CODE_SIMPLE");
		expect(spawned[0]).toMatchObject(UNRELATED);
	});
});
