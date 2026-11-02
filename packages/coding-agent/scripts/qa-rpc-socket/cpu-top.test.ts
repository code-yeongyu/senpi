/**
 * Hotspots are ranked by inclusive SAMPLE COUNT from the `.cpuprofile` `samples` array, never from
 * `--cpu-prof-md` time columns. The fixture is the run10 server profile of the planning run, with
 * home-directory paths in frame urls rewritten to `~` (samples and frames unchanged).
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { rankProfile, renderCpuTop, shareOf } from "./lib/cpu-top.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/run10-server.cpuprofile.json", import.meta.url), "utf8"));

describe("cpu-top sample-count ranking", () => {
	const rows = rankProfile(fixture);

	test("re-ranking the run10 profile reproduces the planning shares within 0.1 pt", () => {
		expect(Math.abs(shareOf(rows, "enumerateCandidates") - 31.0)).toBeLessThanOrEqual(0.1);
		expect(Math.abs(shareOf(rows, "spawn") - 19.0)).toBeLessThanOrEqual(0.1);
		expect(Math.abs(shareOf(rows, "JSON.stringify") - 10.8)).toBeLessThanOrEqual(0.1);
		expect(Math.abs(shareOf(rows, "loadEntriesFromFile") - 6.5)).toBeLessThanOrEqual(0.1);
	});

	test("watchdog, reaper and handover cost ranks below 1%", () => {
		for (const name of ["tick", "proc_listchildpids", "reopenHandoverParkedSessions"]) {
			expect(shareOf(rows, name)).toBeLessThan(1);
		}
	});

	test("rows are sorted by inclusive samples and counted once per sample", () => {
		for (let index = 1; index < rows.length; index++) {
			expect(rows[index - 1].samples).toBeGreaterThanOrEqual(rows[index].samples);
		}
		const total = fixture.samples.length;
		expect(rows.every((row: { samples: number }) => row.samples <= total)).toBe(true);
	});

	test("a recursive frame is counted once per sample", () => {
		const profile = {
			nodes: [
				{ id: 1, callFrame: { functionName: "(root)", url: "" }, children: [2] },
				{ id: 2, callFrame: { functionName: "walk", url: "a.js" }, children: [3] },
				{ id: 3, callFrame: { functionName: "walk", url: "a.js" }, children: [] },
			],
			samples: [3, 3, 2, 1],
		};
		const ranked = rankProfile(profile);
		expect(shareOf(ranked, "walk")).toBe(75);
	});

	test("an absent function has share 0 and the markdown names the sample metric", () => {
		expect(shareOf(rows, "noSuchFunction")).toBe(0);
		const markdown = renderCpuTop(rows, { limit: 5, totalSamples: fixture.samples.length });
		expect(markdown).toContain("inclusive samples");
		expect(markdown).toContain("enumerateCandidates");
		expect(markdown.split("\n").filter((line: string) => line.startsWith("| ") && /\d/.test(line))).toHaveLength(5);
	});

	test("a profile without samples is refused", () => {
		expect(() => rankProfile({ nodes: [], samples: [] })).toThrow(/no samples/);
	});
});
