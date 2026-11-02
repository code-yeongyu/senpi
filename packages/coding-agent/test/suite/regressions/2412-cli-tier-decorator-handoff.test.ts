import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createCliRuntimeFactory } from "../../../src/main.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";

/**
 * #2412: `buildSessionOptions` used to drop a decorator tier (`:priority`, `:flex`,
 * `:auto`, `:ultrafast`) for both `--model` and `--models`. The suites that import
 * the resolver stayed green with those two assignments removed; only a session
 * opened through the CLI factory observes them.
 */
describe("CLI service-tier decorator handoff (#2412)", () => {
	let scratch: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "senpi-tier-handoff-"));
		cwd = join(scratch, "cwd");
		agentDir = join(scratch, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		vi.stubEnv("SENPI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("OMO_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_OFFLINE", "1");
		vi.stubEnv("SENPI_OFFLINE", "1");
		// --models resolves against authenticated providers only. A dummy key makes the
		// built-in OpenAI catalog visible without a real credential. --model does not need it.
		vi.stubEnv("OPENAI_API_KEY", "sk-tier-handoff-test");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(scratch, { recursive: true, force: true });
	});

	async function open(flag: "--model" | "--models", pattern: string) {
		const parsed = parseArgs([
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			flag,
			pattern,
		]);
		const factory = createCliRuntimeFactory(
			{ parsed, cwd, agentDir, appMode: "rpc" },
			{ startupSettingsManager: SettingsManager.create(cwd, agentDir) },
		);
		const registry = new RpcSessionRegistry({ agentDir, createRuntime: factory });
		const opened = await registry.openSession({ cwd });
		const runtime = registry.getForCommand(opened.sessionId, "get_state").runtime;
		if (!runtime) throw new Error("session runtime missing");
		return {
			session: runtime.session,
			diagnostics: runtime.diagnostics,
			close: () => registry.close(opened.sessionId),
		};
	}

	it.each(["priority", "flex", "auto", "ultrafast"] as const)(
		"carries :%s from --model into the session",
		async (tier) => {
			const opened = await open("--model", `openai/gpt-6-astra:xhigh:${tier}`);
			try {
				expect(opened.session.model?.provider).toBe("openai");
				expect(opened.session.model?.id).toBe("gpt-6-astra");
				expect(opened.session.thinkingLevel).toBe("xhigh");
				expect(opened.session.serviceTier).toBe(tier);
				expect(
					opened.diagnostics.some((diagnostic) => diagnostic.message.includes("Ultrafast is documented")),
				).toBe(false);
			} finally {
				await opened.close();
			}
		},
		30_000,
	);

	it.each(["priority", "flex", "auto", "ultrafast"] as const)(
		"carries :%s from --models into the session",
		async (tier) => {
			const opened = await open("--models", `openai/gpt-6-astra:xhigh:${tier}`);
			try {
				expect(opened.session.model?.provider).toBe("openai");
				expect(opened.session.model?.id).toBe("gpt-6-astra");
				expect(opened.session.thinkingLevel).toBe("xhigh");
				expect(opened.session.serviceTier).toBe(tier);
			} finally {
				await opened.close();
			}
		},
		30_000,
	);

	it("carries Sol's documented Ultrafast tier without a warning", async () => {
		const opened = await open("--model", "openai/gpt-6.1-sol:ultrafast");
		try {
			expect(opened.session.model?.id).toBe("gpt-6.1-sol");
			expect(opened.session.serviceTier).toBe("ultrafast");
			expect(opened.diagnostics.some((diagnostic) => diagnostic.message.includes("Ultrafast is documented"))).toBe(
				false,
			);
		} finally {
			await opened.close();
		}
	}, 30_000);
});
