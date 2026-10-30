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
		const catalogStart = bytes.indexOf(Buffer.from('models:[{id:"claude-'));
		const catalogEnd = bytes.indexOf(Buffer.from("}],aliases:"), catalogStart);
		expect(catalogStart).toBeGreaterThanOrEqual(0);
		expect(catalogEnd).toBeGreaterThan(catalogStart);
		const catalog = bytes.subarray(catalogStart, catalogEnd + 1);
		const optInOnly = new Set<string>();
		const marker = Buffer.from('{id:"claude-');
		for (let at = catalog.indexOf(marker); at !== -1; ) {
			const next = catalog.indexOf(marker, at + marker.length);
			const row = catalog.subarray(at, next === -1 ? catalog.length : next).toString("latin1");
			at = next;
			const id = /^\{id:"(claude-[a-z0-9-]+)",family:/.exec(row)?.[1];
			const context = /context:\{([^}]*)\}/.exec(row)?.[1];
			if (id === undefined) throw new Error("unrecognized Claude Code catalog row");
			const legacy = context?.includes("supports_1m_beta:!0") === true && !context.includes("native_1m:!0");
			expect(LEGACY_LONG_CONTEXT_MODEL_IDS.has(id), id).toBe(legacy);
			if (legacy) optInOnly.add(id);
		}

		expect([...optInOnly].sort()).toEqual([...LEGACY_LONG_CONTEXT_MODEL_IDS].sort());
	});
});
