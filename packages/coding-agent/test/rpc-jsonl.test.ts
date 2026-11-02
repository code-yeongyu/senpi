import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS, serializeJsonLine } from "../src/modes/rpc/jsonl.ts";

describe("RPC JSONL framing", () => {
	test("serializes strict JSONL records without escaping Unicode separators", () => {
		const line = serializeJsonLine({ text: "a\u2028b\u2029c" });

		expect(line).toContain("a\u2028b\u2029c");
		expect(line.endsWith("\n")).toBe(true);
		expect(JSON.parse(line.trim())).toEqual({ text: "a\u2028b\u2029c" });
	});

	test("splits on LF only and preserves U+2028/U+2029 inside payloads", async () => {
		const lines: string[] = [];
		const stream = Readable.from([serializeJsonLine({ text: "a\u2028b\u2029c" })]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toEqual({ text: "a\u2028b\u2029c" });
	});

	test("handles CRLF-delimited input", async () => {
		const lines: string[] = [];
		const stream = Readable.from([Buffer.from('{"a":1}\r\n{"b":2}\r\n')]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
	});

	test("emits a final line without trailing LF", async () => {
		const lines: string[] = [];
		const stream = Readable.from([Buffer.from('{"a":1}')]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toEqual(['{"a":1}']);
	});

	test("reports one oversized record, discards through LF, and resynchronizes", async () => {
		const lines: string[] = [];
		let oversized = 0;
		const stream = Readable.from(["123456789", "discarded\n{}\n"]);
		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(
			stream,
			(line) => {
				lines.push(line);
			},
			{
				maxLineLength: 8,
				onOversizedLine: () => {
					oversized++;
				},
			},
		);

		await done;

		expect(oversized).toBe(1);
		expect(lines).toEqual(["{}"]);
	});

	test("accepts a fully escaped maximum-size RPC message record", async () => {
		const lines: string[] = [];
		const record = serializeJsonLine({ type: "prompt", message: "\0".repeat(1_000_000) });
		expect(record.length).toBeLessThan(MAX_RPC_LINE_CHARACTERS);
		const stream = Readable.from([record]);
		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(
			stream,
			(line) => {
				lines.push(line);
			},
			{ maxLineLength: MAX_RPC_LINE_CHARACTERS },
		);

		await done;

		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toEqual({ type: "prompt", message: "\0".repeat(1_000_000) });
	});
});
