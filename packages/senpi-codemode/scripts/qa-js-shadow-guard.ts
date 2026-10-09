import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";

class QaScenarioError extends Error {
	readonly name = "QaScenarioError";
}

const runtime = Reflect.has(globalThis, "Bun") ? "bun" : "node";
const kernel = new JavaScriptKernel({
	sessionId: `qa-js-shadow-guard-${crypto.randomUUID()}`,
	cwd: process.cwd(),
	parallelPoolWidth: 1,
});

const report: Record<string, unknown> = { runtime };
try {
	const poison = await kernel.run({
		cellId: "qa-shadow-poison",
		code: 'const fetch = "shadowed";',
		timeoutMs: 10_000,
	});
	report.poison = poison;
	if (poison.ok) throw new QaScenarioError(`shadowing cell unexpectedly succeeded: ${JSON.stringify(poison)}`);
	if (!poison.error.message.includes("fetch") || !/rename/iu.test(poison.error.message))
		throw new QaScenarioError(`guard error does not name the identifier and remedy: ${poison.error.message}`);

	const probe = await kernel.run({
		cellId: "qa-shadow-probe",
		code: "return typeof fetch",
		timeoutMs: 10_000,
	});
	report.probe = probe.valueRepr;
	if (!probe.ok || probe.valueRepr !== JSON.stringify("function"))
		throw new QaScenarioError(`platform global did not survive the rejected cell: ${JSON.stringify(probe)}`);

	const destructured = await kernel.run({
		cellId: "qa-shadow-destructured",
		code: 'const [URL] = ["shadowed"];',
		timeoutMs: 10_000,
	});
	if (destructured.ok) throw new QaScenarioError("destructured shadowing unexpectedly succeeded");
	report.destructured = destructured.error.message;

	const first = await kernel.run({ cellId: "qa-shadow-reuse-1", code: "const qaShadowReuse = 1;", timeoutMs: 10_000 });
	const second = await kernel.run({
		cellId: "qa-shadow-reuse-2",
		code: "const qaShadowReuse = 2; return qaShadowReuse;",
		timeoutMs: 10_000,
	});
	if (!first.ok || !second.ok || second.valueRepr !== "2")
		throw new QaScenarioError(`cell-created global must stay re-declarable: ${JSON.stringify(second)}`);
	report.redeclare = second.valueRepr;

	console.log(`QA-SHADOW-GUARD PASS runtime=${runtime}`);
	console.log(JSON.stringify(report, null, 2));
} finally {
	await kernel.close();
}
