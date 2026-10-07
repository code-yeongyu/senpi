// The shape models send: semicolon-joined statements on one line (senpi#2050).
export const DENSE_JS_CELL =
	'for(let i=0;i<4;i++){print("=== "+i+" ===");print(groupingWave[i].text.split("\\n\\nAdditional")[0]);} const d=await parallel([()=>tool.grep({pattern:"goal-cache|rule-activation",path:"/repo/apps",limit:80}),()=>tool.read({path:"/repo/notes.md"})]);for(let i=0;i<d.length;i++){print(d[i].text)}';

const LONG_TAIL = `;print("${"z".repeat(60)}")`;

/** Dense JS cells, each with the exact Bun-laid-out preview it must produce (undefined: shown as sent). */
export const BUN_DISPLAY_CASES: Readonly<Record<string, { readonly code: string; readonly expected?: string }>> = {
	dense: {
		code: DENSE_JS_CELL,
		expected: [
			"for (let i = 0; i < 4; i++) {",
			'  print("=== " + i + " ===");',
			'  print(groupingWave[i].text.split("\\n\\nAdditional")[0]);',
			"}",
			"const d = await parallel([",
			'  () => tool.grep({ pattern: "goal-cache|rule-activation", path: "/repo/apps", limit: 80 }),',
			'  () => tool.read({ path: "/repo/notes.md" })',
			"]);",
			"for (let i = 0; i < d.length; i++) {",
			"  print(d[i].text);",
			"}",
		].join("\n"),
	},
	topLevelReturn: {
		code: `const a=await load("/repo/some/long/path/to/a/file.json");if(!a){print("missing input file, stopping");return 1}print(a)`,
		expected: [
			'const a = await load("/repo/some/long/path/to/a/file.json");',
			"if (!a) {",
			'  print("missing input file, stopping");',
			"  return 1;",
			"}",
			"print(a);",
		].join("\n"),
	},
	comments: {
		code: `const first=await tool.read({path:"/repo/a.md"}); /* then the second file */ const second=await tool.read({path:"/repo/b.md"}); // done reading\nprint(first, second)`,
		expected: [
			'const first = await tool.read({ path: "/repo/a.md" });',
			"/* then the second file */",
			'const second = await tool.read({ path: "/repo/b.md" }); // done reading',
			"print(first, second);",
		].join("\n"),
	},
	literals: {
		code: `print("a\\nb", 'it\\'s', 0xff, 1_000_000, "\u{1F600}", typeof undefined, void 0, !0, /a\\/b/g, 10n, \`t \${x}\`, Bun.$\`ls \${d}\`.quiet())`,
		expected: `print("a\\nb", 'it\\'s', 0xff, 1_000_000, "\u{1F600}", typeof undefined, void 0, !0, /a\\/b/g, 10n, \`t \${x}\`, Bun.$\`ls \${d}\`.quiet());`,
	},
	directivesAndClasses: {
		code: `"use strict"; if (false) { print("never") } const o={a:1,"b-c":2,["d"]:3,e}; class A { #p=1; get p(){return this.#p} static { init() } }`,
		expected: [
			'"use strict";',
			"if (false) {",
			'  print("never");',
			"}",
			'const o = { a: 1, "b-c": 2, ["d"]: 3, e };',
			"",
			"class A {",
			"  #p = 1;",
			"  get p() {",
			"    return this.#p;",
			"  }",
			"  static {",
			"    init();",
			"  }",
			"}",
		].join("\n"),
	},
	labelsAndSwitch: {
		code: `outer: for (const i of [1]) { switch (i) { case 1: /* one */ print(1); break outer; default: continue } }${LONG_TAIL}`,
		expected: [
			"outer:",
			"  for (const i of [1]) {",
			"    switch (i) {",
			"      case 1:",
			"        /* one */",
			"        print(1);",
			"        break outer;",
			"      default:",
			"        continue;",
			"    }",
			"  }",
			`print("${"z".repeat(60)}");`,
		].join("\n"),
	},
	modules: {
		code: `import { a as b } from "./x.ts"; import * as fs from "node:fs"; const m = await import("node:path"); print(b, fs, m, import.meta.url)`,
		expected: [
			'import { a as b } from "./x.ts";',
			'import * as fs from "node:fs";',
			'const m = await import("node:path");',
			"print(b, fs, m, import.meta.url);",
		].join("\n"),
	},
	forHeaders: {
		code: `for(;;){break} for(let i=0,j=1;i<j;){j--} for(;i<n;i++){}${LONG_TAIL}`,
		expected: [
			"for (;;) {",
			"  break;",
			"}",
			"for (let i = 0, j = 1; i < j; ) {",
			"  j--;",
			"}",
			"for (; i < n; i++) {}",
			`print("${"z".repeat(60)}");`,
		].join("\n"),
	},
	nestedArrays: {
		code: `const m=[[1,2,3,"${"a".repeat(60)}"],["${"b".repeat(60)}", 2]]`,
		expected: [
			"const m = [",
			"  [",
			"    1,",
			"    2,",
			"    3,",
			`    "${"a".repeat(60)}"`,
			"  ],",
			"  [",
			`    "${"b".repeat(60)}",`,
			"    2",
			"  ]",
			"];",
		].join("\n"),
	},
	parenthesizedElements: {
		code: `const m=[(log("${"a".repeat(40)}"), 1), (log("${"b".repeat(40)}"), 2)]`,
		expected: ["const m = [", `  (log("${"a".repeat(40)}"), 1),`, `  (log("${"b".repeat(40)}"), 2)`, "];"].join("\n"),
	},
	commentInsideExpression: { code: `const x = foo(a, /* inner */ b); print(x)${LONG_TAIL}` },
	unparseable: { code: `const x = (${"a + ".repeat(40)}` },
};
