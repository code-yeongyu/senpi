import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { LEGACY_LONG_CONTEXT_MODEL_IDS } from "../../../src/core/extensions/builtin/anthropic-subscription/context-window.ts";
import { claudeCodeExecutableCandidates } from "../../../src/core/extensions/builtin/anthropic-subscription/executable.ts";

describe("#3801: the legacy long-context ids follow the bundled Claude Code catalog", () => {
	it("lists exactly the bundled Claude Code catalog's opt-in-only 1M rows as legacy", () => {
		const require = createRequire(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
		const binary = claudeCodeExecutableCandidates(process.platform, process.arch)
			.map((candidate) => {
				try {
					return require.resolve(candidate);
				} catch {
					return undefined;
				}
			})
			.find((path): path is string => path !== undefined);
		if (binary === undefined) throw new Error("the bundled Claude Code binary is not installed");
		const bytes = readFileSync(binary);
		const optInOnly = new Set<string>();
		const marker = Buffer.from('{id:"claude-');
		for (let at = bytes.indexOf(marker); at !== -1; at = bytes.indexOf(marker, at + marker.length)) {
			const row = bytes.subarray(at, at + 1_500).toString("latin1");
			const id = /^\{id:"(claude-[a-z0-9-]+)",family:/.exec(row)?.[1];
			const context = /context:\{([^}]*)\}/.exec(row)?.[1];
			if (id === undefined || context === undefined) continue;
			if (context.includes("supports_1m_beta:!0") && !context.includes("native_1m:!0")) optInOnly.add(id);
		}

		expect([...optInOnly].sort()).toEqual([...LEGACY_LONG_CONTEXT_MODEL_IDS].sort());
	});
});
