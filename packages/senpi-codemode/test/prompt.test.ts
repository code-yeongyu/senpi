import { describe, expect, it } from "vitest";
import { buildEvalPrompt } from "../src/prompt/eval-prompt.ts";

const excludedSurfaces = ["agent", "budget", "output", "local://", "Bun"] as const;
const helperNames = [
	"display(value)",
	"print(value",
	"read(path",
	"write(path",
	"env(key",
	"tool.<name>(args)",
	"completion(prompt",
	"parallel(thunks)",
	"pipeline(items",
	"log(message)",
	"phase(title)",
] as const;

function fullPrompt(enabled: {
	readonly py: boolean;
	readonly js: boolean;
	readonly rb: boolean;
	readonly jl: boolean;
}): string {
	const prompt = buildEvalPrompt(enabled);
	return [prompt.description, prompt.promptSnippet ?? "", ...prompt.promptGuidelines].join("\n");
}

describe("buildEvalPrompt", () => {
	it.each([
		["js", { py: false, js: true, rb: false, jl: false }],
		["js-py", { py: true, js: true, rb: false, jl: false }],
		["all", { py: true, js: true, rb: true, jl: true }],
	] as const)("renders the %s enabled-language prompt", (_name, enabled) => {
		expect(buildEvalPrompt(enabled)).toMatchSnapshot();
	});

	it("documents only enabled language fields and reset scope", () => {
		const prompt = fullPrompt({ py: true, js: true, rb: false, jl: false });

		expect(prompt).toContain('`"py"` IPython kernel');
		expect(prompt).toContain('`"js"` persistent JavaScript VM');
		expect(prompt).not.toContain('`"rb"` persistent Ruby kernel');
		expect(prompt).not.toContain('`"jl"` persistent Julia kernel');
		expect(prompt).toContain("a `py` reset never touches the JS VM");
	});

	it("omits disabled and missing languages from the prompt", () => {
		const prompt = fullPrompt({ py: false, js: true, rb: false, jl: false });

		expect(prompt).toContain('`"js"` persistent JavaScript VM');
		expect(prompt).not.toContain('`"py"` IPython kernel');
		expect(prompt).not.toContain('`"rb"` persistent Ruby kernel');
		expect(prompt).not.toContain('`"jl"` persistent Julia kernel');
	});

	it("exposes the allowed prelude helpers and no excluded surfaces", () => {
		const prompt = fullPrompt({ py: true, js: true, rb: true, jl: true });

		for (const helperName of helperNames) {
			expect(prompt).toContain(helperName);
		}
		for (const excludedSurface of excludedSurfaces) {
			expect(prompt).not.toContain(excludedSurface);
		}
	});

	it("throws when no kernels are enabled", () => {
		expect(() => buildEvalPrompt({ py: false, js: false, rb: false, jl: false })).toThrow(/no kernels enabled/i);
	});
});
