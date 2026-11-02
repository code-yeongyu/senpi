import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { runChild } from "../eval/child-probe.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const reportSchema = Type.Array(
	Type.Object({
		route: Type.String(),
		live: Type.Number(),
		sites: Type.Array(Type.String()),
		retired: Type.Number(),
	}),
);

it.each(["bun", "node"])(
	"observes and retires every real timer route on %s",
	async (runtime) => {
		// Given: a fresh runtime with real named imports, promises and AbortSignal polls.
		const fixture = fileURLToPath(new URL("./timer-routes-fixture.ts", import.meta.url));
		// When: each timer runs or stays pending, then is explicitly retired.
		const result = await runChild({
			command: runtime,
			args: [...(runtime === "node" ? ["--import", "tsx"] : []), fixture],
			cwd: packageRoot,
		});
		expect(result.code, result.stderr).toBe(0);
		const reports: unknown = JSON.parse(result.stdout);
		if (!Check(reportSchema, reports)) throw new TypeError("Invalid timer route report");
		// Then: the timer oracle alone names every leak and accepts every retirement.
		for (const report of reports) {
			expect.soft(report.live, report.route).toBeGreaterThan(0);
			expect
				.soft(report.sites, report.route)
				.toEqual(
					expect.arrayContaining([
						expect.stringMatching(
							/(?:setInterval|setTimeout|setImmediate|scheduler\.|AbortSignal\.timeout).*timer-routes-fixture\.ts:\d+/,
						),
					]),
				);
			expect.soft(report.retired, report.route).toBe(0);
		}
	},
	240_000,
);
