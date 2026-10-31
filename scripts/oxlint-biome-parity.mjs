#!/usr/bin/env node
// Biome parity for the rules ported to oxlint JS plugins (senpi#3976). Each ported rule has a probe
// corpus in scripts/oxlint/parity/<rule>.corpus, one case per line. `--update` lints every corpus with
// the Biome rule it replaces (Biome 2.5.14, run through npx) and records the flagged line numbers in
// biome-verdicts.json; scripts/oxlint-biome-parity.test.mjs fails when the oxlint port disagrees.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
export const parityDir = join(root, "scripts", "oxlint", "parity");
export const verdictsPath = join(parityDir, "biome-verdicts.json");
const BIOME = "@biomejs/biome@2.5.14";

// Ported rule -> the Biome rule it replaces, as a Biome config fragment.
export const PORTS = {
	"biome-port/no-implicit-any-let": { corpus: "no-implicit-any-let", rules: { suspicious: { noImplicitAnyLet: "error" } } },
	"biome-port/no-string-case-mismatch": {
		corpus: "no-string-case-mismatch",
		rules: { correctness: { noStringCaseMismatch: "error" } },
	},
	"senpi/model-type-comparison": { corpus: "model-type-comparison", rules: {}, plugin: "model-type-comparison.grit" },
};

const biomeLines = (port) => {
	const dir = mkdtempSync(join(tmpdir(), "oxlint-biome-parity-"));
	try {
		copyFileSync(join(parityDir, `${port.corpus}.corpus`), join(dir, "corpus.ts"));
		const config = {
			linter: { enabled: true, rules: { recommended: false, ...port.rules } },
			formatter: { enabled: false },
		};
		if (port.plugin !== undefined) {
			copyFileSync(join(parityDir, port.plugin), join(dir, port.plugin));
			config.plugins = [`./${port.plugin}`];
		}
		writeFileSync(join(dir, "biome.json"), JSON.stringify(config));
		const result = spawnSync("npx", ["--yes", BIOME, "lint", "--max-diagnostics=500", "corpus.ts"], {
			cwd: dir,
			encoding: "utf8",
			shell: process.platform === "win32",
		});
		const output = `${result.stdout}${result.stderr}`;
		if (!/Checked 1 file/.test(output)) throw new Error(`Biome did not lint the ${port.corpus} corpus:\n${output}`);
		return [...new Set([...output.matchAll(/^corpus\.ts:(\d+):\d+ (?:lint\/|plugin)/gm)].map((match) => Number(match[1])))].sort(
			(left, right) => left - right,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

// Lines the repo's oxlint config flags for `rule` when `corpus` is linted as an in-scope .ts file.
export const oxlintLines = (rule, corpus) => {
	const dir = mkdtempSync(join(root, "packages", "coding-agent", "src", "oxlint-biome-parity-"));
	try {
		const file = join(dir, "corpus.ts");
		copyFileSync(join(parityDir, `${corpus}.corpus`), file);
		const result = spawnSync(join(root, "node_modules", ".bin", "oxlint"), ["-c", ".oxlintrc.json", "-f", "json", file], {
			cwd: root,
			encoding: "utf8",
			shell: process.platform === "win32",
		});
		const code = rule.replace(/^([^/]+)\/(.+)$/, "$1($2)");
		const lines = JSON.parse(result.stdout)
			.diagnostics.filter((diagnostic) => diagnostic.code === code)
			.flatMap((diagnostic) => diagnostic.labels.map((label) => label.span.line));
		return [...new Set(lines)].sort((left, right) => left - right);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (process.argv.includes("--update")) {
		const verdicts = { biome: BIOME, rules: {} };
		for (const [rule, port] of Object.entries(PORTS)) verdicts.rules[rule] = biomeLines(port);
		writeFileSync(verdictsPath, `${JSON.stringify(verdicts, null, "\t")}\n`);
		console.log(`biome-verdicts.json written from ${BIOME}`);
	} else {
		const verdicts = JSON.parse(readFileSync(verdictsPath, "utf8"));
		let differs = false;
		for (const [rule, port] of Object.entries(PORTS)) {
			const biome = verdicts.rules[rule];
			const oxlint = oxlintLines(rule, port.corpus);
			const same = JSON.stringify(biome) === JSON.stringify(oxlint);
			differs ||= !same;
			console.log(`${same ? "same" : "DIFFERENT"} ${rule}: Biome ${JSON.stringify(biome)} oxlint ${JSON.stringify(oxlint)}`);
		}
		process.exitCode = differs ? 1 : 0;
	}
}
