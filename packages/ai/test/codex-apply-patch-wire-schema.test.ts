import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	APPLY_PATCH_FREEFORM_DESCRIPTION,
	APPLY_PATCH_LARK_GRAMMAR,
} from "../../coding-agent/src/core/extensions/builtin/gpt-apply-patch.js";
import { convertResponsesTools } from "../src/providers/openai-responses-shared.js";
import type { Tool } from "../src/types.js";

describe("codex apply_patch wire schema", () => {
	it("emits apply_patch as a Responses custom grammar tool without function parameters", () => {
		// given
		const applyPatchTool: Tool = {
			name: "apply_patch",
			description: APPLY_PATCH_FREEFORM_DESCRIPTION,
			parameters: Type.Object({ input: Type.String() }),
			freeform: {
				type: "grammar",
				syntax: "lark",
				definition: APPLY_PATCH_LARK_GRAMMAR,
			},
		};

		// when
		const [wireTool] = convertResponsesTools([applyPatchTool]);

		// then
		expect(wireTool).toEqual({
			type: "custom",
			name: "apply_patch",
			description: APPLY_PATCH_FREEFORM_DESCRIPTION,
			format: {
				type: "grammar",
				syntax: "lark",
				definition: APPLY_PATCH_LARK_GRAMMAR,
			},
		});
		expect(wireTool).not.toHaveProperty("parameters");
		expect(wireTool).not.toHaveProperty("strict");
	});
});
