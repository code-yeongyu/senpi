import { afterEach, describe, expect, it } from "vitest";
import { streamSimple } from "../../src/compat.ts";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "../../src/providers/faux.ts";
import type { AssistantMessage, Model, ToolCall } from "../../src/types.ts";
import { FIXTURE_TOOLS, TRUNCATION_FIXTURES, type TruncationFixture } from "./truncation-fixtures.ts";

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

function createModelWithToolCallFormat(
	faux: ReturnType<typeof registerFauxProvider>,
	format: string,
): Model<"openai-completions"> {
	const baseModel = faux.getModel();
	return {
		...baseModel,
		compat: {
			toolCallFormat: format,
		},
	} as Model<"openai-completions">;
}

type FixtureFormat = keyof typeof TRUNCATION_FIXTURES;
type FormatRow = { label: string; format: string; fixtureFormat: FixtureFormat };
type FixtureRow = FormatRow & { fixture: TruncationFixture };

const formatRows: FormatRow[] = [
	{ label: "anthropic-xml", format: "anthropic-xml", fixtureFormat: "anthropic-xml" },
	{ label: "hermes", format: "hermes", fixtureFormat: "hermes" },
	{ label: "yaml-xml", format: "yaml-xml", fixtureFormat: "yaml-xml" },
	{ label: "morph-xml alias xml", format: "xml", fixtureFormat: "morph-xml" },
	{ label: "morph-xml canonical", format: "morph-xml", fixtureFormat: "morph-xml" },
	{ label: "gemma4-delimiter", format: "gemma4-delimiter", fixtureFormat: "gemma4-delimiter" },
];

function fixtureRows(kind: TruncationFixture["expected"]["kind"]): FixtureRow[] {
	return formatRows.flatMap((formatRow) =>
		TRUNCATION_FIXTURES[formatRow.fixtureFormat]
			.filter((fixture) => fixture.expected.kind === kind)
			.map((fixture) => ({ ...formatRow, fixture })),
	);
}

function textBlocks(message: AssistantMessage): string[] {
	return message.content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map((block) => block.text);
}

function toolCalls(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

function openingMarker(format: FixtureFormat): string {
	switch (format) {
		case "anthropic-xml":
			return "<invoke";
		case "hermes":
			return "<tool_call>";
		case "yaml-xml":
		case "morph-xml":
			return "<";
		case "gemma4-delimiter":
			return "<|tool_call>";
	}
}

function completeCall(format: FixtureFormat): string {
	switch (format) {
		case "anthropic-xml":
			return '<invoke name="get_weather"><parameter name="city">Seoul</parameter></invoke>';
		case "hermes":
			return '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>';
		case "yaml-xml":
			return "<get_weather>\ncity: Seoul\n</get_weather>";
		case "morph-xml":
			return "<get_weather><city>Seoul</city></get_weather>";
		case "gemma4-delimiter":
			return '<|tool_call>call:get_weather{city:<|"|>Seoul<|"|>}<tool_call|>';
	}
}

async function streamFixture(
	faux: ReturnType<typeof registerFauxProvider>,
	format: string,
	input: string,
	stopReason: "stop" | "length" | "error" = "stop",
): Promise<AssistantMessage> {
	faux.setResponses([
		fauxAssistantMessage([fauxText(input)], {
			stopReason,
			errorMessage: stopReason === "error" ? "transport error injected by faux provider" : undefined,
		}),
	]);

	const result = await streamSimple(createModelWithToolCallFormat(faux, format), {
		messages: [{ role: "user", content: "Use the available tool.", timestamp: Date.now() }],
		tools: FIXTURE_TOOLS,
	}).result();

	expect(faux.getPendingResponseCount()).toBe(0);
	return result;
}

function createFaux() {
	const faux = registerFauxProvider({
		api: "openai-completions",
		tokensPerSecond: 10000,
	});
	registrations.push(faux);
	return faux;
}

describe("cross-format truncation e2e matrix", () => {
	it.each(fixtureRows("recovered"))("recovers $label EOF fixture: $fixture.title", async ({
		format,
		fixtureFormat,
		fixture,
	}) => {
		if (fixture.expected.kind !== "recovered") throw new Error("Expected recovered fixture");

		const result = await streamFixture(createFaux(), format, fixture.input);

		expect(result.stopReason).toBe("toolUse");
		expect(toolCalls(result)).toEqual([
			expect.objectContaining({
				name: fixture.tool,
				arguments: fixture.expected.arguments,
			}),
		]);
		expect(toolCalls(result)[0]?.incomplete).toBeUndefined();
		expect(textBlocks(result).every((text) => !text.includes(openingMarker(fixtureFormat)))).toBe(true);
	});

	it.each(fixtureRows("recovered"))("converts length to toolUse for recovered $label fixture: $fixture.title", async ({
		format,
		fixtureFormat,
		fixture,
	}) => {
		if (fixture.expected.kind !== "recovered") throw new Error("Expected recovered fixture");

		const result = await streamFixture(createFaux(), format, fixture.input, "length");

		expect(result.stopReason).toBe("toolUse");
		expect(toolCalls(result)).toEqual([
			expect.objectContaining({
				name: fixture.tool,
				arguments: fixture.expected.arguments,
			}),
		]);
		expect(toolCalls(result)[0]?.incomplete).toBeUndefined();
		expect(textBlocks(result).every((text) => !text.includes(openingMarker(fixtureFormat)))).toBe(true);
	});

	it.each(fixtureRows("incomplete"))("flags unrecoverable $label EOF fixture: $fixture.title", async ({
		format,
		fixtureFormat,
		fixture,
	}) => {
		const result = await streamFixture(createFaux(), format, fixture.input);

		expect(toolCalls(result)).toEqual([expect.objectContaining({ name: fixture.tool, incomplete: true })]);
		expect(textBlocks(result).every((text) => !text.includes(openingMarker(fixtureFormat)))).toBe(true);
	});

	it.each(fixtureRows("dropped"))("drops nameless or unknown $label EOF fixture: $fixture.title", async ({
		format,
		fixtureFormat,
		fixture,
	}) => {
		const result = await streamFixture(createFaux(), format, fixture.input);

		expect(toolCalls(result)).toHaveLength(0);
		expect(textBlocks(result).every((text) => !text.includes(fixture.input))).toBe(true);
		expect(textBlocks(result).every((text) => !text.includes(openingMarker(fixtureFormat)))).toBe(true);
	});

	it.each(fixtureRows("text"))("preserves unknown-name $label fixture verbatim as text: $fixture.title", async ({
		format,
		fixture,
	}) => {
		const result = await streamFixture(createFaux(), format, fixture.input);

		expect(toolCalls(result)).toHaveLength(0);
		expect(textBlocks(result)).toContain(fixture.input);
	});

	it.each(formatRows)("mixed recovered calls preserve $label content order", async ({ format, fixtureFormat }) => {
		const fixture = TRUNCATION_FIXTURES[fixtureFormat].find((entry) => entry.expected.kind === "recovered");
		if (fixture?.expected.kind !== "recovered") throw new Error("Expected recovered fixture");

		const result = await streamFixture(createFaux(), format, completeCall(fixtureFormat) + fixture.input);

		expect(result.stopReason).toBe("toolUse");
		expect(toolCalls(result)).toHaveLength(2);
		expect(toolCalls(result).map((call) => call.incomplete)).toEqual([undefined, undefined]);
		expect(toolCalls(result).map((call) => call.arguments)).toEqual([{ city: "Seoul" }, fixture.expected.arguments]);
	});

	it.each(formatRows)("mixed incomplete calls preserve $label content order", async ({ format, fixtureFormat }) => {
		const fixture = TRUNCATION_FIXTURES[fixtureFormat].find((entry) => entry.expected.kind === "incomplete");
		if (!fixture) throw new Error("Expected incomplete fixture");

		const result = await streamFixture(createFaux(), format, completeCall(fixtureFormat) + fixture.input);

		expect(result.stopReason).toBe("toolUse");
		expect(toolCalls(result)).toHaveLength(2);
		expect(toolCalls(result)[0]).toMatchObject({ name: "get_weather", arguments: { city: "Seoul" } });
		expect(toolCalls(result)[0]?.incomplete).toBeUndefined();
		expect(toolCalls(result)[1]).toMatchObject({ name: fixture.tool, incomplete: true });
	});

	it("recovers completed calls and flags the trailing incomplete call in an anthropic wrapper", async () => {
		const response =
			'<function_calls><invoke name="get_weather"><parameter name="city">Seoul</parameter></invoke>' +
			'<invoke name="get_weather"><parameter name="city">Seo';
		const result = await streamFixture(createFaux(), "anthropic-xml", response);

		expect(result.stopReason).toBe("toolUse");
		expect(toolCalls(result)).toHaveLength(2);
		expect(toolCalls(result)[0]).toMatchObject({ name: "get_weather", arguments: { city: "Seoul" } });
		expect(toolCalls(result)[0]?.incomplete).toBeUndefined();
		expect(toolCalls(result)[1]).toMatchObject({ name: "get_weather", incomplete: true });
		expect(textBlocks(result).every((text) => !text.includes("<function_calls>"))).toBe(true);
	});

	it("retains a finalized call when the faux provider ends with a transport error", async () => {
		const result = await streamFixture(createFaux(), "morph-xml", completeCall("morph-xml"), "error");

		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBe("transport error injected by faux provider");
		expect(toolCalls(result)).toEqual([
			expect.objectContaining({ name: "get_weather", arguments: { city: "Seoul" } }),
		]);
		expect(toolCalls(result)[0]?.incomplete).toBeUndefined();
	});
});
