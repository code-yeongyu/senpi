import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { classifyIncoming } from "../../src/modes/app-server/rpc/envelope.ts";
import {
	attachNdjsonRpcReader,
	parseNdjsonLine,
	serializeNdjsonMessage,
} from "../../src/modes/app-server/rpc/ndjson.ts";

describe("app-server JSON-RPC envelope", () => {
	it("classifies incoming envelope shapes by field presence", () => {
		// Given: representative app-server JSON-RPC envelope objects.
		const cases = [
			{ input: { id: 1, method: "initialize", params: {} }, kind: "request" },
			{ input: { id: "abc", result: { ok: true } }, kind: "response" },
			{ input: { id: 2, error: { code: -32601, message: "Method not found" } }, kind: "response" },
			{ input: { method: "initialized", params: {} }, kind: "notification" },
			{ input: {}, kind: "protocol-invalid" },
			{ input: { id: 3 }, kind: "protocol-invalid" },
		] as const;

		// When: each object is classified.
		const kinds = cases.map((entry) => classifyIncoming(entry.input).kind);

		// Then: the app-server envelope kind matches the field-presence contract.
		expect(kinds).toEqual(cases.map((entry) => entry.kind));
	});

	it("omits jsonrpc when serializing responses", () => {
		// Given: a JSON-RPC response envelope.
		const response = { id: 7, result: { ok: true } };

		// When: the response is serialized as NDJSON.
		const line = serializeNdjsonMessage(response);

		// Then: the frame is LF-delimited and does not emit the jsonrpc field.
		expect(line).toBe('{"id":7,"result":{"ok":true}}\n');
		expect(line).not.toContain("jsonrpc");
	});

	it("preserves emittedAtMs when serializing notifications", () => {
		// Given: a populated server-notification envelope.
		const notification = {
			method: "thread/status/changed",
			params: { threadId: "thread-1", status: { type: "idle" } },
			emittedAtMs: 1_900_000_041,
		};

		// When: the notification is serialized to its transport frame.
		const line = serializeNdjsonMessage(notification);

		// Then: the emission timestamp survives the final wire boundary.
		expect(JSON.parse(line)).toEqual(notification);
	});

	it("tolerates jsonrpc on parsed requests", () => {
		// Given: an upstream-compatible client request that includes jsonrpc.
		const line = '{"jsonrpc":"2.0","id":"req-1","method":"initialize","params":{}}';

		// When: the line is parsed and classified.
		const parsed = parseNdjsonLine(line);

		// Then: jsonrpc is tolerated and the string id survives.
		expect(parsed.kind).toBe("request");
		expect(parsed).toMatchObject({ message: { id: "req-1", method: "initialize" } });
	});

	it("round-trips string and integer ids", () => {
		// Given: request envelopes with both supported id forms.
		const stringIdLine = serializeNdjsonMessage({ id: "string-id", method: "thread/list" });
		const integerIdLine = serializeNdjsonMessage({ id: 42, method: "thread/read" });

		// When: the serialized lines are parsed.
		const stringId = parseNdjsonLine(stringIdLine.trimEnd());
		const integerId = parseNdjsonLine(integerIdLine.trimEnd());

		// Then: both ids remain intact.
		expect(stringId).toMatchObject({ kind: "request", message: { id: "string-id" } });
		expect(integerId).toMatchObject({ kind: "request", message: { id: 42 } });
	});

	it("emits -32700 for malformed lines and continues the stream", async () => {
		// Given: a stream with one malformed line followed by a valid request.
		const stream = Readable.from(['not-json\n{"id":5,"method":"x"}\n']);
		const messages: unknown[] = [];

		// When: the LF-only reader consumes the stream.
		await new Promise<void>((resolve) => {
			attachNdjsonRpcReader(stream, (message) => {
				messages.push(message);
			});
			stream.on("end", resolve);
		});

		// Then: the first emission is a JSON-RPC parse error and the second line survives.
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({
			kind: "parse-error",
			message: { id: null, error: { code: -32700, message: "Parse error" } },
		});
		expect(messages[1]).toMatchObject({ kind: "request", message: { id: 5, method: "x" } });
	});

	it("keeps U+2028 inside strings during LF-only round-trip", async () => {
		// Given: a request containing U+2028 inside a JSON string.
		const text = "before\u2028after";
		const frame = serializeNdjsonMessage({ id: 9, method: "thread/start", params: { text } });
		const stream = Readable.from([frame]);
		const messages: unknown[] = [];

		// When: the frame is read through the NDJSON stream reader.
		await new Promise<void>((resolve) => {
			attachNdjsonRpcReader(stream, (message) => {
				messages.push(message);
			});
			stream.on("end", resolve);
		});

		// Then: U+2028 was not treated as a record boundary.
		expect(messages).toEqual([{ kind: "request", message: { id: 9, method: "thread/start", params: { text } } }]);
	});
});
