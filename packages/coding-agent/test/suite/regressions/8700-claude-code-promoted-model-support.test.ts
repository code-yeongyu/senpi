import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	binaryEmbedsTokens,
	bundledClaudeCodeBinary,
	OBSERVED_CLAUDE_CODE_MODEL_FLOORS,
} from "../../../src/core/extensions/builtin/anthropic-subscription/executable-model-support.ts";
import { isNewerClaudeCodeVersion } from "../../../src/core/extensions/builtin/anthropic-subscription/executable-version.ts";
import { RECOMMENDED_DEFAULT_MODELS } from "../../../src/core/extensions/builtin/recommended-models/index.ts";
import { defaultModelPerProvider } from "../../../src/core/model-resolver.ts";
import { DEFAULT_FALLBACK_CHAINS } from "../../../src/core/retry-fallback/settings.ts";

/** Control token every Claude Code build since 2.1 embeds; a scan that cannot find it cannot read the binary. */
const KNOWN_GOOD_MODEL = "claude-sonnet-4-5";

function promotedClaudeModels(): Map<string, string[]> {
	const promoted = new Map<string, string[]>();
	const add = (id: string, by: string): void => {
		const bare = id.split(":")[0] ?? id;
		if (!bare.startsWith("claude-")) return;
		const sources = promoted.get(bare) ?? [];
		if (!sources.includes(by)) sources.push(by);
		promoted.set(bare, sources);
	};
	for (const [id] of RECOMMENDED_DEFAULT_MODELS) add(id, "RECOMMENDED_DEFAULT_MODELS (recommended-models/index.ts)");
	for (const [key, rungs] of Object.entries(DEFAULT_FALLBACK_CHAINS)) {
		add(key, "DEFAULT_FALLBACK_CHAINS key (retry-fallback/settings.ts)");
		for (const rung of rungs) add(rung, "DEFAULT_FALLBACK_CHAINS rung (retry-fallback/settings.ts)");
	}
	const anthropicDefault = defaultModelPerProvider.anthropic;
	if (anthropicDefault) add(anthropicDefault, "defaultModelPerProvider.anthropic (model-resolver.ts)");
	return promoted;
}

describe("regression omo#8700: the pinned Claude Code knows every Claude model senpi promotes", () => {
	const binary = bundledClaudeCodeBinary();

	it("finds the bundled Claude Code binary (optional dependencies installed)", () => {
		expect(
			binary,
			"no @anthropic-ai/claude-agent-sdk-<platform> binary: reinstall without --omit=optional",
		).toBeDefined();
		expect(binary?.claudeCodeVersion).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("embeds every promoted Claude model id", () => {
		if (!binary?.claudeCodeVersion) throw new Error("bundled Claude Code binary unavailable; see the test above");
		const promoted = promotedClaudeModels();
		const scan = binaryEmbedsTokens(binary.path, [binary.claudeCodeVersion, KNOWN_GOOD_MODEL, ...promoted.keys()]);
		expect(
			scan.get(binary.claudeCodeVersion) && scan.get(KNOWN_GOOD_MODEL),
			`scanner cannot read this Claude Code binary format (${binary.path}); fix binaryEmbedsTokens, do not bump the pin`,
		).toBe(true);
		const missing = [...promoted].filter(([id]) => scan.get(id) !== true);
		expect(
			missing.map(([id, by]) => `${id} (promoted by ${by.join(", ")})`),
			[
				`The bundled Claude Code ${binary.claudeCodeVersion} does not know these promoted models; the API rejects them with`,
				'400 "Claude Code X does not support this model". Bump @anthropic-ai/claude-agent-sdk in',
				"packages/coding-agent/package.json to the newest release (SDK 0.3.N ships Claude Code 2.1.N), regenerate",
				"the locks (bun run refresh-lock, then node scripts/generate-claude-agent-sdk-platform-lock.mjs), and set",
				"claudeCodeVersion in packages/ai/src/api/anthropic-messages.ts to the new SDK's claudeCodeVersion.",
			].join(" "),
		).toEqual([]);
	});

	it("meets every Claude Code floor the API has been observed to demand", () => {
		if (!binary?.claudeCodeVersion) throw new Error("bundled Claude Code binary unavailable; see the first test");
		const pinned = binary.claudeCodeVersion;
		const unmet = Object.entries(OBSERVED_CLAUDE_CODE_MODEL_FLOORS).filter(([, floor]) =>
			isNewerClaudeCodeVersion(floor, pinned),
		);
		expect(unmet.map(([id, floor]) => `${id} needs Claude Code >= ${floor}, pinned ${pinned}`)).toEqual([]);
	});
});

describe("binaryEmbedsTokens", () => {
	it("matches whole tokens only and across chunk boundaries", () => {
		const dir = mkdtempSync(join(tmpdir(), "senpi-8700-scan-"));
		try {
			const path = join(dir, "claude");
			const padding = "x".repeat(8 * 1024 * 1024 - 5);
			writeFileSync(path, `${padding} claude-opus-5-5\0claude-haiku-4-5-20251001\0`);
			const scan = binaryEmbedsTokens(path, ["claude-opus-5-5", "claude-opus-5", "claude-haiku-4-5"]);
			expect(Object.fromEntries(scan)).toEqual({
				"claude-opus-5-5": true,
				"claude-opus-5": false,
				"claude-haiku-4-5": false,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
