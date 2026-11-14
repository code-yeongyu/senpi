// The kill guard against procps-ng `kill`'s own reading of its argv. On 2026-11-14 `kill -9 -1429035` was allowed as
// "process group 1429035" and procps signalled every process of the user: it reads a target before `--` by its first
// digit. Every argv the guard lets run must signal only the pids and groups the argv names. Nothing here sends a signal.
import { describe, expect, it } from "vitest";
import { judgeCommand } from "../../src/core/kill-guard/index.ts";
import { fixture } from "./judge-fixtures.ts";
import { PROCPS_MATRIX, procpsKill } from "./procps-kill-model.ts";

const named = (args: readonly string[]) => new Set(args.filter((word) => /^-?\d+$/.test(word)).map(Number));

describe("kill guard against procps kill's argv parsing", () => {
	it("lets no argv run that procps turns into -1 or a pid or group the argv does not name", () => {
		const context = fixture({ table: [] }).context;
		const escapes: string[] = [];
		for (const args of PROCPS_MATRIX) {
			const procps = procpsKill(args);
			if (procps.signal === 0 || procps.signal === undefined) continue;
			if (judgeCommand(["kill", ...args].join(" "), context).action === "refuse") continue;
			const names = named(args);
			const stray = procps.pids.filter((pid) => pid === -1 || !names.has(pid));
			if (stray.length > 0) escapes.push(`kill ${args.join(" ")} -> kill(${stray.join(", ")})`);
		}
		expect(escapes).toEqual([]);
	});

	it("covers the incident: procps broadcasts these, and the guard refuses each as R3", () => {
		const broadcasts = PROCPS_MATRIX.filter((args) => {
			const procps = procpsKill(args);
			return procps.signal !== 0 && procps.pids.includes(-1) && !args.includes("-1");
		});
		expect(broadcasts.map((args) => args.join(" "))).toContain("-9 -1429035");
		expect(broadcasts.map((args) => args.join(" "))).toContain("-1429035");
		const context = fixture({ table: [] }).context;
		for (const args of broadcasts) {
			const verdict = judgeCommand(["kill", ...args].join(" "), context);
			expect(verdict.action === "refuse" && verdict.rule, `kill ${args.join(" ")}`).toBe("R3");
		}
	});
});
