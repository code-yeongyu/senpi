export type BoundaryFixture = { readonly id: string; readonly language: string; readonly source: string };

export function boundaryFixtures(): BoundaryFixture[] {
	const fixtures: BoundaryFixture[] = [];
	for (const language of ["ts", "tsx", "js", "rust"]) {
		const functionBody = (i: number) =>
			[
				language === "rust" ? `fn f${i}() {` : `function f${i}() {`,
				...Array.from({ length: 6 }, (_, n) => `  let x${n} = "brace } { [ ]";`),
				"}",
			].join("\n");
		const siblings = Array.from({ length: 20 }, (_, i) => functionBody(i)).join("\n");
		const comment = ["/*", ...Array.from({ length: 6 }, () => " * braces { [ ] } are comment bytes"), "*/"].join(
			"\n",
		);
		const wrapper = language === "rust" ? "impl Example {" : "class Example {";
		const methods = Array.from({ length: 20 }, (_, i) =>
			[
				language === "rust" ? ` fn method${i}() {` : ` method${i}() {`,
				...Array.from({ length: 6 }, (_, n) => `  let x${n} = ${n};`),
				" }",
			].join("\n"),
		).join("\n");
		for (const [name, source] of [
			["siblings", siblings],
			["strings-containing-braces", siblings.replaceAll("brace", 'escaped \\" brace')],
			["comments", `${comment}\n${siblings}`],
			["one-class", `${wrapper}\n${methods}\n}`],
			[
				"deep-nesting",
				`${language === "rust" ? "fn" : "function"} deep() {\n${"if (true) {\n".repeat(20)}${Array.from({ length: 110 }, () => "let x = 1;").join("\n")}\n${"}\n".repeat(21)}`,
			],
			["malformed", `${siblings}\n"unterminated`],
			["mixed-indentation", siblings.replaceAll("  let", "\t let")],
		])
			fixtures.push({ id: `boundary-${language}-${name}`, language, source });
	}
	const python = Array.from({ length: 20 }, (_, i) =>
		[`def f${i}():`, ...Array.from({ length: 6 }, (_, n) => `    x${n} = "brace } {"`)].join("\n"),
	).join("\n");
	for (const [name, source] of [
		["siblings", python],
		[
			"one-class",
			`class Example:\n${python
				.split("\n")
				.map((line) => `    ${line}`)
				.join("\n")}`,
		],
		["strings-containing-braces", python.replaceAll("brace", 'escaped \\" brace')],
		["comments", `${Array.from({ length: 8 }, () => "# comment { [ ] }").join("\n")}\n${python}`],
		[
			"deep-nesting",
			`def deep():\n${"    if True:\n"}${Array.from({ length: 120 }, () => "        x = 1").join("\n")}`,
		],
		["malformed", `${python}\n"unterminated`],
		["mixed-indentation", python.replaceAll("    x0", "\t x0")],
	])
		fixtures.push({ id: `boundary-python-${name}`, language: "python", source });
	const json = JSON.stringify(
		Array.from({ length: 25 }, (_, n) => ({ n, a: [1, 2, 3, 4, 5], s: 'escaped " } {' })),
		null,
		2,
	);
	fixtures.push(
		{ id: "boundary-json-arrays-objects", language: "json", source: json },
		{ id: "boundary-json-malformed", language: "json", source: `${json}\n{` },
		{
			id: "boundary-markdown-prose",
			language: "markdown",
			source: Array.from({ length: 120 }, () => "Plain prose with { braces }.").join("\n"),
		},
	);
	return fixtures;
}
