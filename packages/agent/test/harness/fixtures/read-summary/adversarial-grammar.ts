type Context = { readonly name: string; readonly language: "js" | "ts"; readonly wrap: (value: string) => string };
const properties = ["alpha", "bravo", "charlie", "delta", "echo"];
const object = `{\n${properties.map((name) => ` ${name}: "${name}",`).join("\n")}\n}`;
const types = `{\n${properties.map((name) => ` ${name}: string;`).join("\n")}\n}`;
const js = (name: string, wrap: Context["wrap"]): Context => ({ name, language: "js", wrap });
const ts = (name: string, wrap: Context["wrap"]): Context => ({ name, language: "ts", wrap });
// Fixed Cartesian grammar: no runtime scanner output or randomness defines these programs.
const values = [
	object,
	`{ nested: ${object} }`,
	`[${object}]`,
	`ns.factory(${object}) + suffix`,
	`(() => (${object}))()`,
	`function inner() {\nreturn ${object};\n}`,
];
const contexts: readonly Context[] = [
	js("class-heritage", (v) => `class Example extends ns.factory(${v}) {}`),
	js("computed-class", (v) => `class Example {\n[ns.factory(${v}) + suffix]() {}\n}`),
	js("class-field", (v) => `class Example {\nfield = ${v};\n}`),
	js("class-static-block", (v) => `class Example {\nstatic {\nns.consume(${v});\n}\n}`),
	js("computed-getter", (v) => `class Example {\nget [ns.factory(${v}) + suffix]() {\nreturn 0;\n}\n}`),
	js("computed-setter", (v) => `class Example {\nset [ns.factory(${v}) + suffix](value) {}\n}`),
	js("async-generator-computed", (v) => `class Example {\nasync *[ns.factory(${v}) + suffix]() {}\n}`),
	js("computed-object", (v) => `const example = {\n[ns.factory(${v}) + suffix]() {}\n};`),
	js("computed-property", (v) => `const example = {\n[ns.factory(${v}) + suffix]: 1\n};`),
	js("default-parameter", (v) => `function choose(value = ns.factory(${v})) {}`),
	js("object-parameter", (v) => `function choose({ value = ns.factory(${v}) }) {}`),
	js("array-parameter", (v) => `function choose([value = ns.factory(${v})]) {}`),
	js("object-binding", (v) => `const { value = ns.factory(${v}) } = source;`),
	js("array-binding", (v) => `const [value = ns.factory(${v})] = source;`),
	js("object-assignment", (v) => `({ value = ns.factory(${v}) } = source);`),
	js("array-assignment", (v) => `[value = ns.factory(${v})] = source;`),
	js("parenthesized-assignment", (v) => `(([value = ns.factory(${v})] = source));`),
	js("nested-assignment", (v) => `({ nested: [value = ns.factory(${v})] } = source);`),
	js("for-of-assignment", (v) => `for ([value = ns.factory(${v})] of source) {}`),
	js("assignment-in-call", (v) => `ns.consume([value = ns.factory(${v})] = source);`),
	js("assignment-in-return", (v) => `function choose() {\nreturn [value = ns.factory(${v})] = source;\n}`),
	js("arrow-default", (v) => `const choose = (value = ns.factory(${v})) => value;`),
	js("arrow-body", (v) => `const choose = () => {\nreturn ${v};\n};`),
	js("callback-arrow", (v) => `ns.consume(() => {\nreturn ${v};\n});`),
	js("nested-function", (v) => `function choose() {\nfunction inner() {\nreturn ${v};\n}\nreturn inner;\n}`),
	js("value-control", (v) => `const example = ${v};`),
	ts("accessor-field", (v) => `class Example {\naccessor field = ${v};\n}`),
	ts("decorator", (v) => `@decorate(${v})\nclass Example {}`),
	ts("method-decorator", (v) => `class Example {\n@decorate(${v})\nmethod() {}\n}`),
	ts("keyof-return", (v) => `const example = ${v};\nfunction choose(): keyof ${types} { throw 0; }`),
	ts(
		"typeof-return",
		(v) => `const example = ${v};\nfunction choose(): (typeof registry)[keyof ${types}] { throw 0; }`,
	),
	ts(
		"mapped-return",
		(v) => `const example = ${v};\nfunction choose(): { [K in keyof ${types}]: number } { throw 0; }`,
	),
	ts("satisfies-return", (v) => `function choose() {\nreturn ${v} satisfies ${types};\n}`),
	ts("as-const-return", (v) => `function choose() {\nreturn (${v}) as const;\n}`),
];
const envelopes = [
	{ name: "direct", wrap: (source: string) => source },
	{ name: "function", wrap: (source: string) => `function outer() {\n${source}\nreturn 0;\n}` },
	{ name: "arrow", wrap: (source: string) => `const outer = () => {\n${source}\nreturn 0;\n};` },
	{
		name: "nested",
		wrap: (source: string) => `function outer() {\nfunction middle() {\n${source}\nreturn 0;\n}\nreturn middle;\n}`,
	},
];
export function adversarialPrograms() {
	return contexts.flatMap((context) =>
		values.flatMap((value, index) =>
			envelopes.flatMap((envelope) =>
				(context.language === "js" ? (["js", "ts"] as const) : (["ts"] as const)).map((language) => ({
					name: `${context.name}/${index}/${envelope.name}/${language}`,
					language,
					source: envelope.wrap(context.wrap(value)),
				})),
			),
		),
	);
}
