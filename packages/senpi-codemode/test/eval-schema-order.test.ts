import { describe, expect, it } from "vitest";
import { createEvalInputSchema, evalLanguageOrder } from "../src/tool/types.ts";

describe("eval schema language order", () => {
	it("exposes JavaScript before Python while preserving every supported language", () => {
		const schema = createEvalInputSchema({ py: true, js: true, rb: true, jl: true });
		const languageSchema = schema.properties.language;

		expect(evalLanguageOrder).toEqual(["js", "py", "rb", "jl"]);
		expect(languageSchema.anyOf?.map((item) => item.const)).toEqual(["js", "py", "rb", "jl"]);
	});
});
