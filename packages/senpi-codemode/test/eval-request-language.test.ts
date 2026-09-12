import { describe, expect, it } from "vitest";
import { parseEvalRequest } from "../src/tool/eval-request.ts";

function languageError(language: unknown): TypeError {
	try {
		parseEvalRequest({ language, code: "return 1", summary: "Evaluate a number" });
	} catch (error) {
		if (error instanceof TypeError) return error;
		throw error;
	}
	throw new Error("Expected an invalid run request to be rejected");
}

// Regression for #1395: callers must distinguish an omitted language from an invalid value.
describe("eval request language validation", () => {
	it.each([null, "", "python", 42])("distinguishes invalid language %j from an omission", (language) => {
		expect(languageError(language).message).not.toBe(languageError(undefined).message);
	});

	it("rejects an omitted language instead of selecting a default kernel", () => {
		expect(() => parseEvalRequest({ code: "return 1", summary: "Evaluate a number" })).toThrow(TypeError);
	});

	it.each(["peek", "stop"])("accepts %s without a language", (action) => {
		expect(parseEvalRequest({ action, cell_id: "cell-1395" })).toEqual({ action, cell_id: "cell-1395" });
	});
});
