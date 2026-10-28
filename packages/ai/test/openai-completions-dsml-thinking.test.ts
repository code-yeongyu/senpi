import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { AssistantMessageEvent, Context, Model } from "../src/types.ts";
import { DsmlEnvelopeFilter, stripDsmlEnvelopes } from "../src/utils/dsml-envelope.ts";

// senpi#4621: DeepSeek V4.1 Flash at thinking `max` emits DSML tool-call envelopes inside `reasoning_content`.
// The fixture reproduces the reported shape (fullwidth bars, a space after the marker, a degenerate `calls`
// envelope closed by `parameter`) with synthetic text. Nesting is strict, so the degenerate `calls` never closes
// and its text is released rather than dropped on suspicion (senpi#4623 review).
const BAR = "\uFF5C";
const open = (rest: string): string => `<${BAR}DSML${BAR}${rest}>`;
const close = (rest: string): string => `</${BAR}DSML${BAR}${rest}>`;

const REASONING_WITH_DSML = [
	"I need to confirm the build output before editing.\n",
	`${open(' invoke name="bash"')}\n`,
	`${open(' parameter name="command" string="true"')}echo done27${close(" parameter")}\n`,
	`${close(" invoke")}\n`,
	"The output should say done; then I will patch the parser.\n",
	`${open(" calls")} \u8b77${close(" parameter")}\n`,
	"Next I read the test file.",
].join("");

const REASONING_WITHOUT_DSML =
	"I need to confirm the build output before editing.\n\nThe output should say done; then I will patch the parser.\n \u8b77\nNext I read the test file.";

const activeServers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		activeServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
});

function filterInPieces(text: string, cuts: readonly number[]): string {
	const filter = new DsmlEnvelopeFilter();
	let out = "";
	let from = 0;
	for (const cut of [...cuts, text.length]) {
		out += filter.push(text.slice(from, cut));
		from = cut;
	}
	return out + filter.finish();
}

describe("DSML envelope filter (senpi#4621)", () => {
	it.each([
		{ name: "the reported envelope shape", input: REASONING_WITH_DSML, expected: REASONING_WITHOUT_DSML },
		{
			name: "an ASCII-bar envelope",
			input: 'before <|DSML|invoke name="x">payload</|DSML|invoke> after',
			expected: "before  after",
		},
		{
			name: "an envelope that never closes keeps its reasoning",
			input: `before ${open("function_calls")} the real thought continues`,
			expected: "before  the real thought continues",
		},
		{ name: "a self-closing tag", input: `a ${open('invoke name="x"/')}b`, expected: "a b" },
		{
			name: "reasoning without DSML",
			input: "a < b, <|im_end|> and <think> stay",
			expected: "a < b, <|im_end|> and <think> stay",
		},
		{ name: "a lone partial marker at the end", input: `tail <${BAR}DS`, expected: `tail <${BAR}DS` },
	])("strips $name without losing reasoning", ({ input, expected }) => {
		expect(stripDsmlEnvelopes(input)).toBe(expected);
	});

	it.each([
		{
			name: "a tool argument longer than the 64 KiB hold limit",
			input: `before ${open(' invoke name="write"')}${open(' parameter name="content"')}${"x".repeat(70 * 1024)}${close(" parameter")}${close(" invoke")} after`,
			expected: "before  after",
		},
		{
			name: "a lone parameter that closes after a 5000-char argument",
			input: `before ${open(' parameter name="content"')}${"z".repeat(5000)}${close(" parameter")} after`,
			expected: "before  after",
		},
	])("never releases $name as reasoning", ({ input, expected }) => {
		expect(stripDsmlEnvelopes(input)).toBe(expected);
		expect(
			filterInPieces(
				input,
				Array.from({ length: input.length }, (_, index) => index),
			),
		).toBe(expected);
	});

	it("keeps the prose after a quoted parameter tag that never closes (senpi#4623 review probe)", () => {
		const input = `I must not write ${open(' parameter name="path"')} in my thinking. Next I will read config.ts\u2026`;
		const expected = "I must not write  in my thinking. Next I will read config.ts\u2026";
		expect(stripDsmlEnvelopes(input)).toBe(expected);
		expect(
			filterInPieces(
				input,
				Array.from({ length: input.length }, (_, index) => index),
			),
		).toBe(expected);
	});

	it("releases the text of an opening tag that never completes at the end of the stream", () => {
		const input = `a <${BAR}DSML${BAR} invoke name=x and then the real thought`;
		expect(stripDsmlEnvelopes(input)).toBe(input);
		expect(filterInPieces(input, [5, 12])).toBe(input);
	});

	it("gives the same result for every way the stream is split", () => {
		const expected = stripDsmlEnvelopes(REASONING_WITH_DSML);
		const length = REASONING_WITH_DSML.length;
		for (let cut = 0; cut <= length; cut++) {
			expect(filterInPieces(REASONING_WITH_DSML, [cut])).toBe(expected);
		}
		expect(
			filterInPieces(
				REASONING_WITH_DSML,
				Array.from({ length }, (_, index) => index),
			),
		).toBe(expected);
	});
});

type LoneTag = "parameter" | "invoke" | "other";
type Follow =
	| "never closed"
	| "closed later"
	| "then a real envelope"
	| "then a second lone tag"
	| "nested in a real envelope";

const LONE_OPEN: Readonly<Record<LoneTag, string>> = {
	parameter: open(' parameter name="path"'),
	invoke: open(' invoke name="bash"'),
	other: open(" calls"),
};
const LONE_CLOSE: Readonly<Record<LoneTag, string>> = {
	parameter: close(" parameter"),
	invoke: close(" invoke"),
	other: close(" calls"),
};
const REAL_ENVELOPE = `${open(' invoke name="bash"')}\n${open(' parameter name="command" string="true"')}echo hi${close(" parameter")}\n${close(" invoke")}`;
const QUOTE = "I must not write ";
const AFTER = " in my thinking. Next I will read config.ts";
const LATER = " Later prose.";

function classRow(tag: LoneTag, follow: Follow, tail: string): { input: string; expected: string } {
	const lone = LONE_OPEN[tag];
	switch (follow) {
		case "never closed":
			return { input: `${QUOTE}${lone}${AFTER}${tail}`, expected: `${QUOTE}${AFTER}${tail}` };
		case "closed later":
			return { input: `${QUOTE}${lone}${AFTER}${LONE_CLOSE[tag]}${tail}`, expected: `${QUOTE}${tail}` };
		case "then a real envelope":
			return { input: `${QUOTE}${lone}${AFTER} ${REAL_ENVELOPE}${tail}`, expected: `${QUOTE}${AFTER} ${tail}` };
		case "then a second lone tag":
			return {
				input: `${QUOTE}${lone}${AFTER} or ${open(' invoke name="read"')} either.${tail}`,
				expected: `${QUOTE}${AFTER} or  either.${tail}`,
			};
		case "nested in a real envelope":
			return {
				input: `Before ${open(' invoke name="write"')}\n${open(' parameter name="content"')}${QUOTE}${lone} here${close(" parameter")}\n${close(" invoke")}${tail}`,
				expected: `Before ${tail}`,
			};
	}
}

const CLASS_TABLE = (["parameter", "invoke", "other"] as const).flatMap((tag) =>
	(
		[
			"never closed",
			"closed later",
			"then a real envelope",
			"then a second lone tag",
			"nested in a real envelope",
		] as const
	).flatMap((follow) =>
		(["at stream end", "mid-stream"] as const).map((where) => ({
			name: `lone ${tag} tag, ${follow}, ${where}`,
			...classRow(tag, follow, where === "mid-stream" ? LATER : ""),
			visibleBeforeEnd: 0,
		})),
	),
);
const LONE_HOLD_LIMIT = 64 * 1024;
const CONFIRMED_OPEN = `${open(' invoke name="write"')}\n${open(' parameter name="content"')}`;
const BIG_ARGUMENT = "data ".repeat((70 * 1024) / 5);
const NEVER_CLOSED_NEST = `${open(' invoke name="x"')}\n${open(' parameter name="y"')} I keep thinking about the loader.`;
const PROBE_QUOTED_NEST = `Format: ${open(" function_calls")} ${open(' invoke name="x"')} etc. Then I reason a lot more here.`;
const PROBE_OUTER_CLOSE_IN_VALUE = `pre ${open(" function_calls")}${open(' invoke name="x"')}${open(' parameter name="code"')}code ${close(" function_calls")} SECRETPAY${close(" parameter")}${close(" invoke")}${close(" function_calls")}`;
const EVERY_CLOSE_IN_VALUE = `pre ${open(" function_calls")}\n${open(' invoke name="write"')}\n${open(' parameter name="content"')}a ${close(" function_calls")} b ${close(" invoke")} c ${close(" calls")} d ${close(" tool_call")} e </|DSML|invoke> f </|DSML|function_calls> g ${open(' invoke name="inner"')} h ${close(" parameter")} SECRET${close(" parameter")}\n${close(" invoke")}\n${close(" function_calls")}`;
for (const where of ["at stream end", "mid-stream"] as const) {
	const tail = where === "mid-stream" ? LATER : "";
	CLASS_TABLE.push(
		{
			name: `ACCEPTED TRADE-OFF: prose quoting two whitespace-separated nested tags, never closed, is dropped as a confirmed envelope, ${where}`,
			input: `${PROBE_QUOTED_NEST}${tail}`,
			expected: "Format: ",
			visibleBeforeEnd: 0,
		},
		{
			name: `a parameter value quoting an outer closing tag (review probe 2), ${where}`,
			input: `${PROBE_OUTER_CLOSE_IN_VALUE}${tail}`,
			expected: `pre ${tail}`,
			visibleBeforeEnd: 0,
		},
		{
			name: `a parameter value containing every DSML closing tag, ${where}`,
			input: `${EVERY_CLOSE_IN_VALUE}${tail}`,
			expected: `pre ${tail}`,
			visibleBeforeEnd: 0,
		},
		{
			name: `a confirmed envelope cut off by the stream end, ${where}`,
			input: `Plan: ${NEVER_CLOSED_NEST}${tail}`,
			expected: "Plan: ",
			visibleBeforeEnd: 0,
		},
		{
			name: `a parameter that never closes inside an invoke envelope, ${where}`,
			input: `before ${open(' invoke name="write"')}${open(' parameter name="content"')}${"y".repeat(5000)}${tail}`,
			expected: "before ",
			visibleBeforeEnd: 0,
		},
		{
			name: `a confirmed envelope with a 70 KiB argument, closed, ${where}`,
			input: `pre ${CONFIRMED_OPEN}${BIG_ARGUMENT}${close(" parameter")}\n${close(" invoke")} post${tail}`,
			expected: `pre  post${tail}`,
			visibleBeforeEnd: 0,
		},
		{
			name: `a confirmed envelope with a 70 KiB argument, cut off, ${where}`,
			input: `pre ${CONFIRMED_OPEN}${BIG_ARGUMENT}${tail}`,
			expected: "pre ",
			visibleBeforeEnd: 0,
		},
		{
			name: `'echo PAY' closed by the wrong tag, ${where}`,
			input: `pre ${open(' invoke name="bash"')}\n${open(' parameter name="command"')}echo PAY${close(" invoke")} after${tail}`,
			expected: "pre ",
			visibleBeforeEnd: 0,
		},
		{
			name: `a value quoting </parameter> then </invoke> and more value text, ${where}`,
			input: `pre ${open(" function_calls")}\n${open(' invoke name="write"')}\n${open(' parameter name="content"')}a ${close(" parameter")} b ${close(" invoke")} more value${close(" parameter")}\n${close(" invoke")}\n${close(" function_calls")} post${tail}`,
			expected: `pre  post${tail}`,
			visibleBeforeEnd: 0,
		},
	);
}
const LONG_PROSE = "word ".repeat(14_000);
for (const tag of ["parameter", "invoke", "other"] as const) {
	CLASS_TABLE.push({
		name: `lone ${tag} tag, never closed, ${LONG_PROSE.length} chars of prose after it`,
		input: `${QUOTE}${LONE_OPEN[tag]}${LONG_PROSE}`,
		expected: `${QUOTE}${LONG_PROSE}`,
		visibleBeforeEnd: QUOTE.length + LONE_HOLD_LIMIT,
	});
}

describe("prose next to DSML-shaped text is never lost and never held without bound (senpi#4623 review class)", () => {
	it.each(CLASS_TABLE)("$name", ({ input, expected, visibleBeforeEnd }) => {
		expect(stripDsmlEnvelopes(input)).toBe(expected);
		const filter = new DsmlEnvelopeFilter();
		let streamed = "";
		for (const char of input) streamed += filter.push(char);
		expect(streamed.length).toBeGreaterThanOrEqual(visibleBeforeEnd);
		expect(streamed + filter.finish()).toBe(expected);
	});
});

describe("openai-completions reasoning stream with DSML (senpi#4621)", () => {
	it("never streams, stores or replays a DSML envelope in thinking", async () => {
		// given a server that streams the reported reasoning in 7-character chunks, splitting every marker
		const bodies: unknown[] = [];
		const baseUrl = await startServer(async (request, response) => {
			bodies.push(JSON.parse(await readBody(request)));
			streamReasoning(response, chunk(REASONING_WITH_DSML, 7));
		});
		const model = testModel(baseUrl);

		// when the first reply streams
		const deltas: string[] = [];
		const firstStream = streamSimple(model, userContext(), { apiKey: "test", maxRetries: 0 });
		for await (const event of firstStream) collectThinkingDelta(event, deltas);
		const first = await firstStream.result();

		// then no streamed delta and no stored block carries DSML, and the real reasoning is intact
		expect(deltas.join("")).toBe(REASONING_WITHOUT_DSML);
		expect(deltas.some((delta) => delta.includes("DSML"))).toBe(false);
		expect(first.content).toEqual([
			{ type: "thinking", thinking: REASONING_WITHOUT_DSML, thinkingSignature: "reasoning_content" },
		]);

		// when a session written before the fix replays a thinking block that still holds DSML
		const poisoned: Context = {
			messages: [
				{ role: "user", content: "check the build", timestamp: 1 },
				{
					...first,
					content: [
						{ type: "thinking", thinking: REASONING_WITH_DSML, thinkingSignature: "reasoning_content" },
						{ type: "text", text: "The build passes." },
					],
				},
				{ role: "user", content: "go on", timestamp: 2 },
			],
		};
		await streamSimple(model, poisoned, { apiKey: "test", maxRetries: 0, reasoning: "high" }).result();

		// then the request replays the reasoning without the envelope
		expect(JSON.stringify(bodies[1])).not.toContain("DSML");
		expect(JSON.stringify(bodies[1])).toContain(JSON.stringify(REASONING_WITHOUT_DSML).slice(1, -1));
	});

	it("replays OpenRouter reasoning_details without DSML, and a signed detail verbatim", async () => {
		// given a stored OpenRouter-style reply whose reasoning_details carry DSML (DeepSeek via OpenRouter)
		const bodies: unknown[] = [];
		const baseUrl = await startServer(async (request, response) => {
			bodies.push(JSON.parse(await readBody(request)));
			streamReasoning(response, ["ok"]);
		});
		const model = testModel(baseUrl);
		const signedText = `signed ${open(' invoke name="bash"')}x${close(" invoke")}`;
		const details = [
			{ type: "reasoning.text", text: REASONING_WITH_DSML, format: "unknown", index: 0 },
			{ type: "reasoning.summary", summary: `sum ${open(" calls")}z${close(" calls")}`, index: 1 },
			{ type: "reasoning.text", text: signedText, signature: "sig-1", index: 2 },
		];
		const first = await streamSimple(model, userContext(), { apiKey: "test", maxRetries: 0 }).result();
		const stored: Context = {
			messages: [
				{ role: "user", content: "check the build", timestamp: 1 },
				{
					...first,
					content: [
						{ type: "thinking", thinking: REASONING_WITH_DSML, thinkingSignature: JSON.stringify(details) },
						{ type: "text", text: "The build passes." },
					],
				},
				{ role: "user", content: "go on", timestamp: 2 },
			],
		};

		// when it is replayed
		await streamSimple(model, stored, { apiKey: "test", maxRetries: 0, reasoning: "high" }).result();

		// then the unsigned details lose the envelope and the signed one is sent exactly as signed
		const replayed = replayedReasoningDetails(bodies[1]);
		expect(replayed).toEqual([
			{ type: "reasoning.text", text: REASONING_WITHOUT_DSML, format: "unknown" },
			{ type: "reasoning.summary", summary: "sum " },
			{ type: "reasoning.text", text: signedText, signature: "sig-1" },
		]);
	});
});

function replayedReasoningDetails(body: unknown): unknown {
	if (typeof body !== "object" || body === null || !("messages" in body) || !Array.isArray(body.messages)) return [];
	const assistant: unknown = body.messages.find(
		(message: unknown) =>
			typeof message === "object" && message !== null && "role" in message && message.role === "assistant",
	);
	return typeof assistant === "object" && assistant !== null && "reasoning_details" in assistant
		? assistant.reasoning_details
		: undefined;
}

function collectThinkingDelta(event: AssistantMessageEvent, deltas: string[]): void {
	if (event.type === "thinking_delta") deltas.push(event.delta);
}

function chunk(text: string, size: number): string[] {
	const pieces: string[] = [];
	for (let index = 0; index < text.length; index += size) pieces.push(text.slice(index, index + size));
	return pieces;
}

function streamReasoning(response: ServerResponse, pieces: readonly string[]): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	for (const piece of pieces) {
		response.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-dsml",
				choices: [{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }],
			})}\n\n`,
		);
	}
	response.write(
		`data: ${JSON.stringify({ id: "chatcmpl-dsml", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
	);
	response.end("data: [DONE]\n\n");
}

function userContext(): Context {
	return { messages: [{ role: "user", content: "check the build", timestamp: 1 }] };
}

function testModel(baseUrl: string): Model<"openai-completions"> {
	const model = getModel("openai", "gpt-4o-mini");
	if (model === undefined) throw new Error("Missing gpt-4o-mini test model");
	return { ...model, api: "openai-completions", provider: "test", baseUrl, reasoning: true };
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const parts: Buffer[] = [];
		request.on("data", (part: Buffer) => parts.push(part));
		request.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
		request.on("error", reject);
	});
}

async function startServer(
	handle: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<string> {
	const server = createServer((request, response) => {
		Promise.resolve()
			.then(() => handle(request, response))
			.catch((error: unknown) => response.destroy(error instanceof Error ? error : new Error(String(error))));
	});
	activeServers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
	return `http://127.0.0.1:${address.port}/v1`;
}
