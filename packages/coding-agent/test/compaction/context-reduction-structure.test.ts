import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "@typescript/typescript6";
import { expect, it } from "vitest";

const modules = [
	"src/core/extensions/context-event.ts",
	"src/core/extensions/context-dispatch.ts",
	"src/core/extensions/builtin/compaction/context-reduction-frontier.ts",
	"src/core/extensions/builtin/compaction/context-reduction-state.ts",
	"src/core/extensions/builtin/compaction/context-reduction-lifecycle.ts",
	"src/core/extensions/builtin/compaction/context-reduction-handoff.ts",
	"test/support/cache-replay-model.ts",
	"test/support/cache-replay-fixture.ts",
	"test/support/replay-context-cache.ts",
	"test/support/context-reduction-fixture.ts",
	"test/support/sdk-alignment-reduction-fixture.ts",
	"test/suite/regressions/900-frontier-review.test.ts",
	"test/suite/regressions/900-stable-reduction-prefix.test.ts",
	"test/compaction/context-reduction-projection.test.ts",
	"test/compaction/context-reduction-budget.test.ts",
	"test/compaction/context-reduction-ownership.test.ts",
	"test/compaction/cache-replay.test.ts",
	"test/compaction/cache-replay-cli.test.ts",
	"test/compaction/context-reduction-structure.test.ts",
];

it.each(modules)("keeps %s within 250 pure lines and uses static imports", (name) => {
	const path = fileURLToPath(new URL(`../../${name}`, import.meta.url));
	const text = readFileSync(path, "utf8");
	const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
	const lines = new Set<number>();
	for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
		if (token <= ts.SyntaxKind.LastTriviaToken) continue;
		const start = source.getLineAndCharacterOfPosition(scanner.getTokenStart()).line;
		const end = source.getLineAndCharacterOfPosition(scanner.getTextPos() - 1).line;
		for (let line = start; line <= end; line++) lines.add(line);
	}
	expect(lines.size).toBeLessThanOrEqual(250);
	const dynamicImports: ts.Node[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) dynamicImports.push(node);
		ts.forEachChild(node, visit);
	};
	visit(source);
	expect(dynamicImports).toHaveLength(0);
});
