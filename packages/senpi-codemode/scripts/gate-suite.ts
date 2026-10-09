import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { GateInputError } from "./gate-report.ts";
import { runProcess } from "./gate-process.ts";

const suiteSchema = Type.Object({
	testResults: Type.Array(Type.Object({
		name: Type.String(),
		status: Type.Optional(Type.String()),
		message: Type.Optional(Type.String()),
		assertionResults: Type.Array(Type.Object({
			fullName: Type.String(),
			status: Type.String(),
			failureMessages: Type.Optional(Type.Array(Type.String())),
		})),
	})),
});

/** Existing contracts are the behavior of record; assertion outcomes are load invariant. */
export async function measureSuite(target: string, cli: string): Promise<Record<string, unknown>> {
	const root = await mkdtemp(join(tmpdir(), "senpi-gate-suite-"));
	try {
		const path = join(root, "suite.json");
		const result = await runProcess([
			"node", cli, "run", "test/", "--exclude", "test/gate/**",
			"--reporter=json", `--outputFile=${path}`, "--maxWorkers=2",
		], target);
		const raw: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!Check(suiteSchema, raw)) throw new GateInputError("Vitest report");
		const cases: Record<string, unknown> = {};
		const failures: string[] = [];
		for (const file of raw.testResults) {
			const name = file.name.replaceAll("\\", "/").replace(/.*\/packages\/senpi-codemode\//u, "");
			if (file.status === "failed" && file.message) failures.push(`${name}: ${file.message}`);
			for (const assertion of file.assertionResults) {
				cases[`${name}/${assertion.fullName}`] = assertion.status;
				if (assertion.status === "failed")
					failures.push(`${name}/${assertion.fullName}: ${assertion.failureMessages?.join("\n") ?? "failed"}`);
			}
		}
		if (result.exitCode !== 0)
			throw new GateInputError(`legacy suite failed (${result.exitCode}):\n${failures.join("\n")}\n${result.stdout}\n${result.stderr}`);
		if (Object.keys(cases).length === 0) throw new GateInputError("legacy suite ran zero cases");
		return cases;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
