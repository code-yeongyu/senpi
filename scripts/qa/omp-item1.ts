import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { bakeoff } from "../../packages/agent/test/harness/fixtures/read-summary/bakeoff.ts";
import { invalidCases } from "../../packages/agent/test/harness/fixtures/read-summary/invalid-cases.ts";
import { cancellationParity } from "../../packages/coding-agent/test/support/read-summary-cancel.ts";
import {
	summaryRereadEdit,
	syntheticEditRefusal,
} from "../../packages/coding-agent/test/support/read-summary-edit-cases.ts";
import {
	fallbackParity,
	folderFallbacks,
	summaryParity,
} from "../../packages/coding-agent/test/support/read-summary-parity-cases.ts";
import { consumeSessionFixture } from "../../packages/coding-agent/test/support/read-summary-session-fixture.ts";
import { buildReadBinaries, sha256 } from "./read-summary-build.mjs";
import { missingAssetAndBudget } from "./read-summary-packaging.mjs";
import { compiledReadParity } from "./read-summary-parity.mjs";

const { values } = parseArgs({ options: { case: { type: "string" }, out: { type: "string" } }, strict: true });
const out = values.out;
if (!out || !isAbsolute(out)) throw new Error("--out must be an absolute path");
mkdirSync(dirname(out), { recursive: true });
const startedAt = new Date().toISOString();
try {
	switch (values.case) {
		case "bakeoff": {
			const input = process.env.OMP_BAKEOFF_INPUT;
			const manifestHash = process.env.OMP_BAKEOFF_CORPUS_SHA256;
			const omp = process.env.OMP_BAKEOFF_REFERENCE;
			if (!input || !manifestHash || !omp)
				throw new Error(
					"Execution-owned input, frozen manifest SHA and omp copy are required: OMP_BAKEOFF_INPUT, OMP_BAKEOFF_CORPUS_SHA256, OMP_BAKEOFF_REFERENCE",
				);
			const result = await bakeoff({
				input,
				manifestHash,
				omp,
				out,
				baseline: process.env.OMP_BAKEOFF_BASELINE,
				gate: process.env.OMP_BAKEOFF_GATE,
			});
			console.log(JSON.stringify({ status: result.status, languages: result.languages, out }));
			break;
		}
		case "bakeoff-invalid": {
			const result = invalidCases();
			writeFileSync(
				out,
				`${JSON.stringify({ ...result, head_sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), startedAt, finishedAt: new Date().toISOString(), command: process.argv, cwd: process.cwd() }, null, 2)}\n`,
			);
			if (!result.pass) throw new Error("Negative gate accepted invalid measurement");
			console.log(JSON.stringify({ pass: result.pass, cases: result.cases.length, out }));
			break;
		}
		case "summary-reread-edit":
		case "read-fallback-parity": {
			const result =
				values.case === "summary-reread-edit"
					? { parity: await summaryParity(), edit: await summaryRereadEdit() }
					: {
							fallback: await fallbackParity(),
							folders: await folderFallbacks(),
							cancellation: await cancellationParity(),
							syntheticEdit: await syntheticEditRefusal(),
						};
			const fixtureConsumer = await consumeSessionFixture();
			writeFileSync(
				out,
				`${JSON.stringify(
					{
						passed: true,
						case: values.case,
						...result,
						fixtureConsumer,
						head_sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
						tree_sha: execFileSync("git", ["write-tree"], { encoding: "utf8" }).trim(),
						startedAt,
						finishedAt: new Date().toISOString(),
						command: process.argv,
						cwd: process.cwd(),
					},
					null,
					2,
				)}\n`,
			);
			console.log(JSON.stringify({ passed: true, case: values.case, fixtureConsumer, out }));
			break;
		}
		case "compiled-parity":
		case "package-missing-asset-and-budget": {
			const gatePath = process.env.OMP_READ_GATE;
			if (!gatePath) throw new Error("OMP_READ_GATE is required");
			const gate = JSON.parse(readFileSync(gatePath, "utf8"));
			// #1685: an approved grammar engine must declare the dependencies it ships, and a
			// refusal must declare none. Either way the receipt, not a default, states the decision.
			if (gate.gate !== "OQ1" || gate.decision.wasm_allowed !== gate.decision.candidate_dependencies.length > 0)
				throw new Error("Gate receipt must state the approved candidate dependencies");
			const directory = dirname(out);
			const ceiling = gate.decision.max_embedded_delta_bytes;
			let result:
				| {
						readonly build: ReturnType<typeof buildReadBinaries>;
						readonly parity: Awaited<ReturnType<typeof compiledReadParity>>;
						readonly baselineHead: string;
				  }
				| Awaited<ReturnType<typeof missingAssetAndBudget>>;
			if (values.case === "compiled-parity") {
				const baseline = process.env.OMP_READ_BASELINE_ROOT;
				const corpus = process.env.OMP_READ_CORPUS;
				if (!baseline || !corpus) throw new Error("OMP_READ_BASELINE_ROOT and OMP_READ_CORPUS are required");
				const build = buildReadBinaries(directory, baseline, ceiling);
				const parity = await compiledReadParity(directory, build.binary.path, corpus);
				result = {
					build,
					parity,
					baselineHead: execFileSync("git", ["-C", baseline, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
				};
			} else {
				result = await missingAssetAndBudget(directory, join(directory, "senpi"), ceiling);
			}
			writeFileSync(
				out,
				`${JSON.stringify(
					{
						passed: true,
						case: values.case,
						...result,
						gateSha256: sha256(gatePath),
						paidProviderCalls: 0,
						head_sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
						tree_sha: execFileSync("git", ["write-tree"], { encoding: "utf8" }).trim(),
						startedAt,
						finishedAt: new Date().toISOString(),
						command: process.argv,
						cwd: process.cwd(),
					},
					null,
					2,
				)}\n`,
			);
			console.log(JSON.stringify({ passed: true, case: values.case, out }));
			break;
		}
		default:
			throw new Error("Unknown --case for omp-item1");
	}
} catch (error) {
	writeFileSync(
		`${out}.error.json`,
		`${JSON.stringify({ status: "inconclusive", adoptable: false, startedAt, finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
	);
	throw error;
}
