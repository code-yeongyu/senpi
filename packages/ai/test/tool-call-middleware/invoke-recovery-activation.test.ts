import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shouldRecoverTextToolCalls } from "../../src/index.ts";
import { getToolCallFormat } from "../../src/tool-call-middleware/index.ts";
import type { Model } from "../../src/types.ts";

const rootEntryUrl = new URL("../../src/index.ts", import.meta.url).href;
const supportedTextFormats = [
	"hermes",
	"xml",
	"morph-xml",
	"yaml-xml",
	"gemma4-delimiter",
	"anthropic-xml",
	"antml",
] as const;

function createModel(id: string, overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		...overrides,
	};
}

function createMalformedRecoveryModel(value: unknown): Model<"openai-completions"> {
	return { ...createModel("claude-opus"), recoverTextToolCalls: value } as unknown as Model<"openai-completions">;
}

describe("invoke recovery activation", () => {
	it("matches the locked Claude-family identifiers across APIs", () => {
		for (const id of [
			"claude-opus-4-8",
			"anthropic/claude-fable-5",
			"anthropic.claude-3-5-sonnet-20241022",
			"claude-sonnet@2025-01-01",
			"claude",
			"anthropic/claude-opus",
			"x-claude",
			"claude_opus",
			"CLAUDE.SONNET@2025",
			"éclaude",
			"claudeé",
		]) {
			expect(shouldRecoverTextToolCalls(createModel(id))).toBe(true);
		}

		for (const id of ["exclaude", "claudius", "claudel", "myclaude", "claude3", "xclaude", "claudex", "gpt-5"]) {
			expect(shouldRecoverTextToolCalls(createModel(id))).toBe(false);
		}

		const differentApi: Model<"anthropic-messages"> = {
			...createModel("claude"),
			api: "anthropic-messages",
			provider: "another-provider",
		};
		expect(shouldRecoverTextToolCalls(differentApi)).toBe(true);
	});

	it("rejects substring false positives and gives text-protocol mutual exclusion precedence", () => {
		for (const format of supportedTextFormats) {
			const model = createModel("claude-opus", {
				recoverTextToolCalls: true,
				compat: { toolCallFormat: format },
			});
			expect(getToolCallFormat(model)).toBe(format);
			expect(shouldRecoverTextToolCalls(model)).toBe(false);
		}

		expect(shouldRecoverTextToolCalls(createModel("claude-opus", { recoverTextToolCalls: false }))).toBe(false);
		expect(shouldRecoverTextToolCalls(createModel("gpt-5", { recoverTextToolCalls: true }))).toBe(true);
		expect(shouldRecoverTextToolCalls(createModel("claude", { provider: "unrelated-provider" }))).toBe(true);

		for (const value of [null, "false", 0, "true", 1]) {
			expect(shouldRecoverTextToolCalls(createMalformedRecoveryModel(value))).toBe(false);
		}
	});

	it("exports the activation helper from the side-effect-free root", () => {
		const script = `
			import { registerHooks } from "node:module";

			const globals = new Set(Object.getOwnPropertyNames(globalThis));
			const compatImports = [];
			registerHooks({
				resolve(specifier, context, nextResolve) {
					if (specifier === "./compat.ts" || specifier.endsWith("/compat.ts")) compatImports.push(specifier);
					return nextResolve(specifier, context);
				},
			});
			const root = await import(${JSON.stringify(rootEntryUrl)});
			console.log(JSON.stringify({
				helperType: typeof root.shouldRecoverTextToolCalls,
				compatImports,
				addedGlobals: Object.getOwnPropertyNames(globalThis).filter((key) => !globals.has(key)),
			}));
		`;
		const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
		expect(
			JSON.parse(result.stdout) as { helperType: string; compatImports: string[]; addedGlobals: string[] },
		).toEqual({
			helperType: "function",
			compatImports: [],
			addedGlobals: [],
		});
	});
});
