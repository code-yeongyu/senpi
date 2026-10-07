import { describe, expect, it } from "vitest";
import { TailLineRing, truncateTailBytes } from "../../src/output/streaming-output.ts";

const RING_MAX_BYTES = 300;
const RING_MAX_LINES = 8;

function referenceWindow(stream: string, maxBytes: number, maxLines: number): string {
	const tailText = truncateTailBytes(stream, maxBytes).text;
	let lines = tailText.split("\n");
	const endsWithNewline = tailText.endsWith("\n");
	if (endsWithNewline) lines = lines.slice(0, -1);
	return `${lines.slice(-maxLines).join("\n")}${endsWithNewline ? "\n" : ""}`;
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Scenario {
	readonly name: string;
	readonly chunks: readonly string[];
	readonly maxBytes: number;
	readonly maxLines: number;
}

function scenarios(): Scenario[] {
	const random = mulberry32(0x2262);
	const randomText = (length: number): string => {
		const alphabet = ["a", "b", "한", "글", "\r", "x", "😀", " "];
		let out = "";
		for (let index = 0; index < length; index++) out += alphabet[Math.floor(random() * alphabet.length)];
		return out;
	};
	const randomChunks = (): string[] => {
		const chunks: string[] = [];
		for (let index = 0; index < 220; index++) {
			const kind = random();
			if (kind < 0.08) chunks.push("");
			else if (kind < 0.2) chunks.push(randomText(1 + Math.floor(random() * 7)));
			else if (kind < 0.5) chunks.push(`${randomText(1 + Math.floor(random() * 12))}\n`);
			else chunks.push(`${randomText(1 + Math.floor(random() * 5))}\n${randomText(1 + Math.floor(random() * 9))}\n`);
		}
		return chunks;
	};
	return [
		{ name: "empty chunk stream", chunks: ["", "", ""], maxBytes: RING_MAX_BYTES, maxLines: RING_MAX_LINES },
		{
			name: "single partial line without newline",
			chunks: ["abc", "def"],
			maxBytes: RING_MAX_BYTES,
			maxLines: RING_MAX_LINES,
		},
		{
			name: "trailing newline",
			chunks: ["one\ntwo\n", "three\n"],
			maxBytes: RING_MAX_BYTES,
			maxLines: RING_MAX_LINES,
		},
		{
			name: "no trailing newline",
			chunks: ["one\ntwo\n", "three"],
			maxBytes: RING_MAX_BYTES,
			maxLines: RING_MAX_LINES,
		},
		{
			name: "CRLF line endings",
			chunks: ["a\r\n", "b\r", "\nc\r\n"],
			maxBytes: RING_MAX_BYTES,
			maxLines: RING_MAX_LINES,
		},
		{
			name: "multi-line chunks",
			chunks: ["l1\nl2\nl3\n", "l4\nl5", "\nl6\nl7\nl8\nl9\nl10\n"],
			maxBytes: RING_MAX_BYTES,
			maxLines: RING_MAX_LINES,
		},
		{
			name: "newline storm beyond compaction",
			chunks: Array.from({ length: 500 }, () => "\n"),
			maxBytes: RING_MAX_BYTES,
			maxLines: RING_MAX_LINES,
		},
		{
			name: "many tiny lines beyond compaction",
			chunks: Array.from({ length: 300 }, (_, index) => `${index}\n`),
			maxBytes: RING_MAX_BYTES,
			maxLines: RING_MAX_LINES,
		},
		{
			name: "line larger than 64 KiB split across chunks",
			chunks: [`${"x".repeat(40_000)}`, `${"y".repeat(40_000)}\n`, "small\n"],
			maxBytes: 90_000,
			maxLines: RING_MAX_LINES,
		},
		{
			name: "single line exceeding the byte budget",
			chunks: [`${"z".repeat(RING_MAX_BYTES + 500)}\n`, "tail-line\n"],
			maxBytes: RING_MAX_BYTES,
			maxLines: RING_MAX_LINES,
		},
		{
			name: "few huge lines exceeding the budget window",
			chunks: Array.from({ length: 6 }, (_, index) => `${String.fromCharCode(97 + index).repeat(120)}\n`),
			maxBytes: 300,
			maxLines: RING_MAX_LINES,
		},
		{
			name: "multibyte characters split across chunk boundaries",
			chunks: ["가나", "다라\n😀", "😀\n말", "문\n"],
			maxBytes: 24,
			maxLines: RING_MAX_LINES,
		},
		{
			name: "huge line followed by partial tail",
			chunks: [`${"h".repeat(RING_MAX_BYTES + 10)}\n`, "a\n", "b\n", "unterminated"],
			maxBytes: RING_MAX_BYTES,
			maxLines: RING_MAX_LINES,
		},
		{
			name: "seeded randomized stream",
			chunks: randomChunks(),
			maxBytes: RING_MAX_BYTES,
			maxLines: RING_MAX_LINES,
		},
		{
			name: "production budget with a long numbered stream",
			chunks: Array.from({ length: 400 }, (_, index) => `line-${index} padding-padding\n`),
			maxBytes: 102_400,
			maxLines: RING_MAX_LINES,
		},
	];
}

describe("TailLineRing", () => {
	for (const scenario of scenarios()) {
		it(`matches the byte-tail last-lines reference for: ${scenario.name}`, () => {
			const ring = new TailLineRing({ maxBytes: scenario.maxBytes, maxLines: scenario.maxLines });
			let stream = "";
			for (const chunk of scenario.chunks) {
				ring.append(chunk);
				stream += chunk;
				const expected = referenceWindow(stream, scenario.maxBytes, scenario.maxLines);
				expect(ring.text()).toBe(expected);
				expect(Buffer.byteLength(ring.text(), "utf8")).toBeLessThanOrEqual(scenario.maxBytes);
			}
		});
	}

	it("keeps only the last eight lines of a small stream", () => {
		const ring = new TailLineRing({ maxBytes: 102_400, maxLines: 8 });
		for (let index = 1; index <= 10; index++) ring.append(`line-${index}\n`);
		expect(ring.text()).toBe("line-3\nline-4\nline-5\nline-6\nline-7\nline-8\nline-9\nline-10\n");
	});

	it("keeps the unterminated partial line as the window's last element", () => {
		const ring = new TailLineRing({ maxBytes: 102_400, maxLines: 8 });
		for (let index = 1; index <= 9; index++) ring.append(`line-${index}\n`);
		ring.append("partial");
		expect(ring.text()).toBe("line-3\nline-4\nline-5\nline-6\nline-7\nline-8\nline-9\npartial");
	});
});
