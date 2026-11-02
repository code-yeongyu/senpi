import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as agent from "../../src/index.ts";
import { boundaryFixtures } from "./fixtures/read-summary/boundary-fixtures.ts";

function summarize(text: string, path = "source.ts") {
	const parsed = agent.selectedReadFolder.fold({ path, text, settings: agent.READ_FOLD_SETTINGS });
	return agent.createSegmentedReadView({ text, parsed });
}

function coverage(text: string, segments: readonly agent.ReadSegment[]) {
	const lines = text.split("\n");
	let next = 1;
	const reconstructed: string[] = [];
	const omitted: { startLine: number; endLine: number }[] = [];
	for (const segment of segments) {
		expect(segment.startLine).toBe(next);
		expect(segment.endLine).toBeGreaterThanOrEqual(next);
		const original = lines.slice(next - 1, segment.endLine);
		switch (segment.kind) {
			case "kept":
				expect(segment.text).toBe(original.join("\n"));
				reconstructed.push(...segment.text.split("\n"));
				break;
			case "elided":
				omitted.push({ startLine: next, endLine: segment.endLine });
				reconstructed.push(...original);
				break;
			default:
				throw new Error(`Unexpected segment: ${JSON.stringify(segment satisfies never)}`);
		}
		next = segment.endLine + 1;
	}
	expect(next).toBe(lines.length + 1);
	expect(reconstructed.join("\n")).toBe(text);
	return omitted;
}

describe("segmented read views (#1639)", () => {
	it("BFS preserves source and reaches visible budget", () => {
		// Given frozen source fixtures, not the prototype's output or coordinate projection.
		const inputs = boundaryFixtures().filter((f) =>
			["boundary-ts-one-class", "boundary-js-siblings", "boundary-json-arrays-objects"].includes(f.id),
		);
		// When each real production folder/view processes the original bytes.
		const results = inputs.map((input) => ({ input, result: summarize(input.source, `source.${input.language}`) }));
		// Then exact coverage, source-only budgets and offset/limit rereads agree.
		for (const { input, result } of results) {
			expect(result.status).toBe("summary");
			if (result.status !== "summary") throw new Error(JSON.stringify(result));
			const omitted = coverage(input.source, result.segments);
			expect(result.rendered.elidedRanges).toEqual(omitted);
			expect(result.visibleSourceLines).toBeGreaterThanOrEqual(50);
			expect(result.visibleSourceLines).toBeLessThanOrEqual(100);
			expect(result.rendered.text.length).toBeLessThan(input.source.length);
			expect(result.rendered.text.split("\n").filter((line) => line === "…")).toHaveLength(omitted.length);
			expect(result.rendered.footer.rereads).toEqual(
				omitted.map((r) => ({ offset: r.startLine, limit: r.endLine - r.startLine + 1 })),
			);
			expect(
				[...result.rendered.footer.text.matchAll(/offset=(\d+) limit=(\d+)/g)].map((m) => ({
					offset: Number(m[1]),
					limit: Number(m[2]),
				})),
			).toEqual(result.rendered.footer.rereads);
			if (input.id === "boundary-ts-one-class") {
				for (let i = 0; i < 20; i++) expect(result.rendered.text.split("\n")).toContain(` method${i}() {`);
			}
		}
		const out = process.env.OMP_READ_VIEW_QA_DIR;
		if (out) {
			mkdirSync(out, { recursive: true });
			writeFileSync(join(out, "happy.json"), JSON.stringify({ cases: results, passed: true }, null, 2));
		}
	});

	it("exposes siblings before grandchildren even when an earlier child fits", () => {
		// Given two outer folds: exposing each costs 20; exposing A's child costs 10.
		const text = Array.from({ length: 210 }, (_, i) => `source line ${i + 1}`).join("\n");
		const aChild = { startLine: 12, endLine: 81, children: [{ startLine: 17, endLine: 76, children: [] }] };
		const bChild = { startLine: 112, endLine: 181, children: [] };
		const parsed: agent.ReadFolderResult = {
			status: "parsed",
			text,
			ranges: [
				{ startLine: 2, endLine: 91, children: [aChild] },
				{ startLine: 102, endLine: 191, children: [bChild] },
			],
		};
		// When BFS refines a 30-line skeleton to its first safe >=50 view.
		const result = agent.createSegmentedReadView({ text, parsed });
		// Then the first outer step is enough; its child is not greedily expanded.
		expect(result.status).toBe("summary");
		if (result.status !== "summary") throw new Error(JSON.stringify(result));
		expect(result.visibleSourceLines).toBe(50);
		expect(result.rendered.elidedRanges).toEqual([
			{ startLine: 12, endLine: 81 },
			{ startLine: 102, endLine: 191 },
		]);
	});

	it("uses a FIFO frontier rather than depth-first source order", () => {
		// Given a 10-line skeleton and two 20-line outer refinements.
		const text = Array.from({ length: 190 }, (_, i) => `line ${i}`).join("\n");
		const parsed: agent.ReadFolderResult = {
			status: "parsed",
			text,
			ranges: [
				{ startLine: 2, endLine: 91, children: [{ startLine: 12, endLine: 81, children: [] }] },
				{ startLine: 99, endLine: 188, children: [{ startLine: 109, endLine: 178, children: [] }] },
			],
		};
		// When the first refinement still leaves fewer than 50 visible lines.
		const result = agent.createSegmentedReadView({ text, parsed });
		// Then B is exposed before A's 70-line child (which also fits under 100).
		expect(result.status).toBe("summary");
		if (result.status !== "summary") throw new Error(JSON.stringify(result));
		expect(result.visibleSourceLines).toBe(50);
		expect(result.rendered.elidedRanges).toEqual([
			{ startLine: 12, endLine: 81 },
			{ startLine: 109, endLine: 178 },
		]);
	});

	it("preserves CRLF, trailing whitespace, Unicode and a terminal empty line", () => {
		// Given exact reader-normalized line slices, including CR bytes.
		const text = "signature {  \r\nomit\r\n}\t\r\n… actual source\r\n";
		const segments: agent.ReadSegment[] = [
			{ kind: "kept", startLine: 1, endLine: 1, text: "signature {  \r" },
			{ kind: "elided", startLine: 2, endLine: 2 },
			{ kind: "kept", startLine: 3, endLine: 5, text: "}\t\r\n… actual source\r\n" },
		];
		// When rendering synthetic markers between, not inside, source lines.
		const result = agent.renderSegmentedReadView({ text, segments });
		// Then bytes reconstruct and the sentinel never becomes a merged edit anchor.
		expect(result.elidedRanges).toEqual(coverage(text, segments));
		expect(result.text.startsWith("signature {  \r\n…\n}\t\r\n… actual source\r\n")).toBe(true);
	});

	it.each([
		[{ kind: "kept", startLine: 1, endLine: 3, text: "altered" }],
		[{ kind: "elided", startLine: 0, endLine: 3 }],
		[{ kind: "elided", startLine: 1, endLine: 4 }],
		[{ kind: "elided", startLine: 1, endLine: 1 }],
		[
			{ kind: "elided", startLine: 1, endLine: 2 },
			{ kind: "elided", startLine: 2, endLine: 3 },
		],
		[{ kind: "elided", startLine: 1, endLine: Number.NaN }],
	] satisfies agent.ReadSegment[][])("rejects invalid or misleading segments %j", (...segments) => {
		// Given missing, overlapping, noninteger or altered coverage; when rendering; then reject.
		expect(agent.InvalidReadSegmentsError).toBeTypeOf("function");
		expect(() => agent.renderSegmentedReadView({ text: "a\nb\nc", segments })).toThrow(
			agent.InvalidReadSegmentsError,
		);
	});

	it("rejects crossing, duplicate, cyclic and stale folder ranges", () => {
		// Given untrusted injected-folder outputs.
		const text = Array.from({ length: 120 }, () => "line").join("\n");
		const children: agent.ReadFoldRange[] = [];
		const cycle = { startLine: 2, endLine: 119, children };
		cycle.children.push(cycle);
		const ranges: agent.ReadFoldRange[][] = [
			[
				{ startLine: 2, endLine: 80, children: [] },
				{ startLine: 70, endLine: 119, children: [] },
			],
			[{ startLine: 2, endLine: 80, children: [{ startLine: 2, endLine: 80, children: [] }] }],
			[cycle],
		];
		// When building each view; then explicit fallback, without looping or partial output.
		for (const folds of ranges)
			expect(agent.createSegmentedReadView({ text, parsed: { status: "parsed", text, ranges: folds } })).toEqual({
				status: "no_summary",
				reason: "invalid_ranges",
			});
		expect(
			agent.createSegmentedReadView({ text: `${text}\nnew`, parsed: { status: "parsed", text, ranges: [] } }),
		).toEqual({ status: "no_summary", reason: "stale_source" });
	});

	it("skips an oversized unfolding step but still exposes a safe sibling", () => {
		// Given a 20-line skeleton whose first 180-line leaf cannot be exposed.
		const text = Array.from({ length: 300 }, (_, i) => `source line ${i}`).join("\n");
		const parsed: agent.ReadFolderResult = {
			status: "parsed",
			text,
			ranges: [
				{ startLine: 2, endLine: 181, children: [] },
				{ startLine: 195, endLine: 294, children: [{ startLine: 215, endLine: 274, children: [] }] },
			],
		};
		// When the FIFO frontier advances; then the second refinement yields exactly 60 source lines.
		const result = agent.createSegmentedReadView({ text, parsed });
		expect(result.status).toBe("summary");
		if (result.status !== "summary") throw new Error(JSON.stringify(result));
		expect(result.visibleSourceLines).toBe(60);
		expect(result.rendered.elidedRanges).toEqual([
			{ startLine: 2, endLine: 181 },
			{ startLine: 215, endLine: 274 },
		]);
		coverage(text, result.segments);
	});

	it("is deterministic without retaining caller-owned state", () => {
		// Given fresh bytes at the same path, repeatedly interleaved with unrelated input.
		const input = boundaryFixtures().find((f) => f.id === "boundary-ts-one-class");
		if (!input) throw new Error("Missing frozen fixture");
		// When calls are interleaved; then the original input has exactly the original result.
		const result = summarize(input.source);
		summarize(`${input.source}\n"unterminated`);
		expect(summarize(input.source)).toEqual(result);
	});
});
