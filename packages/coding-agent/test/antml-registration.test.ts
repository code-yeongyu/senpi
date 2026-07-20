import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { getProtocol, getToolCallFormat } from "../../ai/src/tool-call-middleware/index.ts";
import type { Model, Tool } from "../../ai/src/types.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

const editTool: Tool = {
	name: "Edit",
	description: "Edit a file",
	parameters: Type.Object({
		file_path: Type.String(),
		edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
	}),
};

const antmlModel = {
	id: "antml-model",
	name: "ANTML model",
	api: "openai-completions",
	provider: "registration-test",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
	compat: { toolCallFormat: "antml" },
} satisfies Model<"openai-completions">;

describe("antml registration", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir !== undefined) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("repairs a sloppy Edit invocation when the antml protocol is resolved", () => {
		// Given
		const generatedText =
			"<function_calls>" +
			'<invoke name="Edit">' +
			'<parameter name="path">a.py</parameter>' +
			'<parameter name="edits">[{"oldText":"x","newText":"y","requireUnique":true}]</parameter>' +
			"</invoke>" +
			"</function_calls>";

		// When
		const parsed = getProtocol("antml").parseGeneratedText(generatedText, [editTool]);

		// Then
		expect(parsed).toEqual([
			{
				name: "Edit",
				arguments: { file_path: "a.py", edits: [{ oldText: "x", newText: "y" }] },
			},
		]);
	});

	it("activates antml for an openai-completions model with compat", () => {
		// When
		const format = getToolCallFormat(antmlModel);

		// Then
		expect(format).toBe("antml");
	});

	it("accepts antml in a models.json compatibility block", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "senpi-antml-registration-"));
		const modelsJsonPath = join(tempDir, "models.json");
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"registration-test": {
						api: "openai-completions",
						baseUrl: "https://example.invalid/v1",
						compat: { toolCallFormat: "antml" },
						models: [{ id: "antml-model" }],
					},
				},
			}),
		);

		// When
		const registry = ModelRegistry.create(AuthStorage.create(join(tempDir, "auth.json")), modelsJsonPath);

		// Then
		expect(registry.getError()).toBeUndefined();
		expect(registry.find("registration-test", "antml-model")?.id).toBe("antml-model");
	});
});
