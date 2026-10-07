import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { runProcess } from "../../scripts/gate-process.ts";

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const jobSchema = Type.Object({
	if: Type.Literal("always()"),
	needs: Type.Array(Type.String()),
	steps: Type.Array(Type.Object({ run: Type.Optional(Type.String()) })),
});

it.skipIf(process.platform === "win32").each(["success", "failure", "cancelled"])(
	"the required fan-in observes codemode-gate %s",
	async (result) => {
		// Given: the real workflow, with every other required job successful.
		const parsed = await runProcess(
			[
				"bun",
				"-e",
				'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text()).jobs["check-and-test"]))',
				resolve(root, ".github/workflows/ci.yml"),
			],
			root,
		);
		expect(parsed.exitCode, parsed.stderr).toBe(0);
		const job: unknown = JSON.parse(parsed.stdout);
		if (!Check(jobSchema, job)) throw new TypeError("Invalid fan-in job");
		const step = job.steps.find((candidate) => candidate.run?.includes("join(needs.*.result"));
		if (!step?.run) throw new TypeError("Missing executable fan-in step");
		const results = job.needs.map((name) => (name === "codemode-gate" ? result : "success"));
		const script = step.run.replace(/\$\{\{\s*join\(needs\.\*\.result,\s*' '\)\s*\}\}/u, results.join(" "));
		// When: the workflow runner executes the actual gate with that needs context.
		const run = await runProcess(["bash", "-c", script], root);
		// Then: failure and cancellation cannot produce the required green merge status.
		expect(run.exitCode).toBe(result === "success" ? 0 : 1);
	},
);
