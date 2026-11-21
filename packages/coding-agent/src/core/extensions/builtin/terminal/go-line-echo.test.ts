import { describe, expect, it } from "vitest";
import { GoLineEchoFilter } from "./go-line-echo.ts";

/** senpi#7120: a gated command's go-line echo never reaches its output, however the PTY splits the bytes. */
describe("GoLineEchoFilter", () => {
	const goLine = "~senpi-go-0123456789abcdef";
	const run = (chunks: readonly string[]): string => {
		const filter = new GoLineEchoFilter(goLine);
		return chunks.map((chunk) => filter.push(chunk)).join("") + filter.flush();
	};

	it.each([
		["echo and output in one chunk", [`${goLine}\r\nOUT\r\n`], "OUT\r\n"],
		["echo split across chunks", ["~senpi-", `go-0123456789abcdef\r`, "\nOUT"], "OUT"],
		["echo with a bare newline", [`${goLine}\nOUT`], "OUT"],
		["no echo (echo was already off)", ["OUT\r\n", `${goLine}\r\n`], `OUT\r\n${goLine}\r\n`],
		["output that only starts like the go-line", ["~senpi-", "gone\r\n"], "~senpi-gone\r\n"],
		["a session that ends while undecided", ["~senpi"], "~senpi"],
	])("%s", (_name, chunks, output) => {
		expect(run(chunks)).toBe(output);
	});
});
