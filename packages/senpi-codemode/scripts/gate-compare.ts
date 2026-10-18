import { Type } from "typebox";
import { Check } from "typebox/value";
import { canonical, type GateReport } from "./gate-report.ts";

type Comparison = {
	readonly baseline: GateReport;
	readonly report: GateReport;
	readonly additions: readonly string[];
};

export function compareReports(input: Comparison) {
	const unmeasured = input.report.unmeasured ?? [];
	const failures: string[] = unmeasured.map((section) => `unmeasured section: ${section}`);
	const additions: string[] = [];
	for (const runtime of input.baseline.runtimes) {
		if (!isMeasured(`runtimes/${runtime.id}`)) continue;
		if (!input.report.runtimes.find((item) => item.id === runtime.id)?.available)
			failures.push(`required interpreter missing: ${runtime.id}`);
	}
	for (const runtime of input.report.runtimes) {
		if (!isMeasured(`runtimes/${runtime.id}`)) continue;
		if (!runtime.available && !input.baseline.runtimes.some((item) => item.id === runtime.id))
			failures.push(`required interpreter missing: ${runtime.id}`);
	}
	for (const [language, helpers] of Object.entries(input.baseline.helperCensus)) {
		if (!isMeasured(`helperCensus/${language}`)) continue;
		const actual = input.report.helperCensus[language] ?? [];
		const removed = helpers.filter((name) => !actual.includes(name));
		if (removed.length > 0) failures.push(`helper census: ${language} removed [${removed.join(", ")}]`);
	}
	for (const [language, helpers] of Object.entries(input.report.helperCensus)) {
		if (!isMeasured(`helperCensus/${language}`)) continue;
		for (const name of helpers) {
			if (!(input.baseline.helperCensus[language] ?? []).includes(name)) recordAddition(`helperCensus/${language}/${name}`);
		}
	}
	compareSection("prompt surface", "prompts");
	compareSection("schema surface", "schemas");
	compareSection("invariant", "invariants");
	for (const [phase, modules] of Object.entries(input.baseline.imports)) {
		if (!isMeasured(`imports/${phase}`)) continue;
		const actual = input.report.imports[phase];
		if (!actual) failures.push(`eager imports: ${phase} removed`);
		else {
			const removed = modules.filter((name) => !actual.includes(name));
			if (removed.length > 0) failures.push(`eager imports: ${phase} removed [${removed.join(", ")}]`);
		}
	}
	for (const [phase, modules] of Object.entries(input.report.imports)) {
		if (!isMeasured(`imports/${phase}`)) continue;
		if (!(phase in input.baseline.imports)) recordAddition(`imports/${phase}`);
		for (const name of modules) {
			if (!(input.baseline.imports[phase] ?? []).includes(name)) recordAddition(`imports/${phase}/${name}`);
		}
	}
	const legacySchema = Type.Record(Type.String(), Type.String());
	const before = input.baseline.observations?.legacyContracts ?? {};
	const after = input.report.observations?.legacyContracts ?? {};
	if (isMeasured("legacyContracts") && (!Check(legacySchema, before) || !Check(legacySchema, after))) {
		failures.push("legacy contracts: invalid observation");
	} else if (isMeasured("legacyContracts") && Check(legacySchema, before) && Check(legacySchema, after)) {
		for (const key of Object.keys(before)) {
			if (!(key in after)) failures.push(`legacy contract: ${key} removed`);
			else if (after[key] === "failed") failures.push(`legacy contract: ${key} failed`);
			else if (input.baseline.observations?.platform === input.report.observations?.platform && before[key] !== after[key])
				failures.push(`legacy contract: ${key} outcome changed`);
		}
		for (const key of Object.keys(after)) {
			if (!(key in before)) recordAddition(`legacyContracts/${key}`);
		}
	}
	return { exitCode: failures.length === 0 ? 0 : 1, failures, additions };

	function isMeasured(path: string): boolean {
		return !unmeasured.some((section) => path === section || path.startsWith(`${section}/`));
	}

	function recordAddition(path: string): void {
		additions.push(path);
		if (!input.additions.includes(path)) failures.push(`unreviewed addition: ${path}`);
	}

	function compareSection(label: string, section: "prompts" | "schemas" | "invariants"): void {
		const before = input.baseline[section];
		const after = input.report[section];
		for (const [key, value] of Object.entries(before)) {
			if (!isMeasured(`${section}/${key}`)) continue;
			if (!(key in after)) failures.push(`${label}: ${key} removed`);
			else if (canonical(value) !== canonical(after[key])) failures.push(`${label}: ${key} changed`);
		}
		for (const key of Object.keys(after)) {
			if (!isMeasured(`${section}/${key}`)) continue;
			if (!(key in before)) recordAddition(`${section}/${key}`);
		}
	}
}
