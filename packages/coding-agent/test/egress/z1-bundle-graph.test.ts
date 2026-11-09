// The fused / one-machine assembly reaches the shared request-auth composition and nothing of hosted custody: no sealed
// or device egress, no route or address policy, no custody sidecar reader, no hand-side call executor. It never sets the
// loop's `commitStep` and never constructs a `StepCommitError`: the only `commitStep` code it may carry is the typed
// option and the forward of a caller-injected value when set (senpi#6239), never a value of its own. The walk follows static and dynamic relative
// imports and worker entries, as `suite/no-session-write-in-tool-child.test.ts` does; `import type` is erased.
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "../..");
const FUSED_ROOTS = ["src/core/sdk.ts"];
const CUSTODY_MODULE =
	/^src\/core\/(?:egress\/(?:sealed|composite|device-proxy|aux|address-policy|route|custody-sidecar|roster-entries|key-facts-client|pinned-infra)|hand\/provider-call-executor)/u;
const SPECIFIER =
	/(?:new\s+URL|siblingWorkerUrl)\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url|(?:import|export)\s[^'"]*?from\s*["'](\.{1,2}\/[^"']+)["']|import\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)|import\s+["'](\.{1,2}\/[^"']+)["']/g;
const TYPE_SPECIFIER = /import\s+type\s[^'"]*?from\s*["'](\.{1,2}\/[^"']+)["']/g;
// The two `commitStep` code lines the fused graph may carry: the optional, typed option and the conditional forward of
// the caller's value. Any other code line naming `commitStep` would let the fused path supply one.
const COMMIT_STEP_PASS_THROUGH = [
	/^commitStep\?: (?:AgentOptions|CreateAgentSessionOptions)\["commitStep"\];$/u,
	/^\.\.\.\(options\.commitStep \? \{ commitStep: options\.commitStep \} : \{\}\),$/u,
];

function commitStepCodeLines(source: string): string[] {
	return source
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => !/^(?:\/\/|\/\*|\*)/u.test(line) && /\bcommitStep\b/u.test(line));
}

function reachable(roots: readonly string[]): Map<string, string> {
	const sources = new Map<string, string>();
	const queue = roots.map((root) => resolve(packageRoot, root));
	while (queue.length > 0) {
		const file = queue.pop();
		if (file === undefined || sources.has(relative(packageRoot, file))) continue;
		const source = readFileSync(file, "utf8");
		sources.set(relative(packageRoot, file), source);
		const typeImports = new Set<string>();
		for (const match of source.matchAll(TYPE_SPECIFIER)) typeImports.add(resolve(dirname(file), match[1] ?? ""));
		for (const match of source.matchAll(SPECIFIER)) {
			const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
			if (!specifier?.endsWith(".ts")) continue;
			const target = resolve(dirname(file), specifier);
			if (!typeImports.has(target)) queue.push(target);
		}
	}
	return sources;
}

describe("fused assembly graph (Z1)", () => {
	const graph = reachable(FUSED_ROOTS);

	it("composes request auth through the shared composition step", () => {
		expect(graph.has("src/core/egress/compose-request-auth.ts")).toBe(true);
	});

	it("reaches no hosted-custody module", () => {
		expect([...graph.keys()].filter((file) => CUSTODY_MODULE.test(file))).toEqual([]);
	});

	it("never reads the custody sidecar", () => {
		expect([...graph].filter(([, source]) => source.includes("custody.json")).map(([file]) => file)).toEqual([]);
	});

	it("never sets commitStep and never constructs a StepCommitError", () => {
		const offenders = [...graph].flatMap(([file, source]) => [
			...commitStepCodeLines(source)
				.filter((line) => !COMMIT_STEP_PASS_THROUGH.some((allowed) => allowed.test(line)))
				.map((line) => `${file}: ${line}`),
			...(/new\s+StepCommitError\s*\(/u.test(source) ? [`${file}: new StepCommitError`] : []),
		]);
		expect(offenders).toEqual([]);
	});
});
