import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { DrainScan } from "../src/kernels/js/process-drain-scan.d.ts";

type ScanDrainText = (carry: string, chunk: string, marker: string) => DrainScan;
const scanModuleUrl = pathToFileURL(join(process.cwd(), "src", "kernels", "js", "process-drain-scan.js")).href;
let scanDrainText: ScanDrainText = () => ({ parts: [], carry: "" });

beforeAll(async () => {
	const loaded: unknown = await import(scanModuleUrl);
	const scan: unknown =
		typeof loaded === "object" && loaded !== null ? Reflect.get(loaded, "scanDrainText") : undefined;
	if (typeof scan !== "function") throw new Error("process-drain-scan.js does not export scanDrainText");
	scanDrainText = (carry, chunk, marker) => Reflect.apply(scan, undefined, [carry, chunk, marker]);
});

const MARKER = "\u0000senpi-drain:";
const STREAM = `before${MARKER}7\u0000after${MARKER}8\u0000tail`;

type Part = { readonly text: string } | { readonly key: string };

function scanChunks(chunks: readonly string[]): Part[] {
	const parts: Part[] = [];
	let carry = "";
	for (const chunk of chunks) {
		const scanned = scanDrainText(carry, chunk, MARKER);
		carry = scanned.carry;
		parts.push(...scanned.parts);
	}
	return parts;
}

/** Adjacent text parts merged, so differently chunked reads of the same stream compare equal. */
function normalized(parts: readonly Part[]): Part[] {
	const merged: Part[] = [];
	for (const part of parts) {
		const last = merged.at(-1);
		if ("text" in part && last !== undefined && "text" in last)
			merged[merged.length - 1] = { text: last.text + part.text };
		else merged.push(part);
	}
	return merged;
}

const EXPECTED: Part[] = [{ text: "before" }, { key: "7" }, { text: "after" }, { key: "8" }, { text: "tail" }];

describe("Given the fd 1 reader scanning output for result markers", () => {
	it("When the stream arrives in one read, then the output and both result keys come out in order", () => {
		expect(normalized(scanChunks([STREAM]))).toEqual(EXPECTED);
	});

	it("When a read boundary falls anywhere, including inside a marker, then nothing is lost or reordered", () => {
		for (let cut = 1; cut < STREAM.length; cut += 1) {
			expect(normalized(scanChunks([STREAM.slice(0, cut), STREAM.slice(cut)])), `cut at ${cut}`).toEqual(EXPECTED);
		}
	});

	it("When the stream is cut twice, then every pair of boundaries still yields the same output and keys", () => {
		for (let first = 1; first < STREAM.length - 1; first += 1) {
			for (let second = first + 1; second < STREAM.length; second += 1) {
				const chunks = [STREAM.slice(0, first), STREAM.slice(first, second), STREAM.slice(second)];
				expect(normalized(scanChunks(chunks)), `cuts at ${first}, ${second}`).toEqual(EXPECTED);
			}
		}
	});

	it("When output contains a NUL that is not a marker, then it is delivered as output", () => {
		expect(normalized(scanChunks(["a\u0000b", "c"]))).toEqual([{ text: "a\u0000bc" }]);
	});
});
