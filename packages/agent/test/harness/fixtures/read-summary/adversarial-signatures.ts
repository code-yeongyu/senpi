const properties = ["alphaProperty", "bravoProperty", "charlieProperty", "deltaProperty", "echoProperty"];
const values = properties.map((name) => `  ${name}: "${name}",`).join("\n");
const types = properties.map((name) => `  ${name}: string;`).join("\n");

// Independently specified declaration text, not ranges obtained from the candidate.
export const adversarialSignatures = [
	{
		name: "class-heritage",
		language: "js",
		header: "class Example extends ns.factory({",
		members: values,
		tail: "}) {}",
	},
	{
		name: "keyof-return",
		language: "ts",
		header: "function choose(): keyof {",
		members: types,
		tail: '} { return "alphaProperty"; }',
	},
	{
		name: "decorator-arguments",
		language: "ts",
		header: "@decorate({",
		members: values,
		tail: "})\nclass Example {}",
	},
	{
		name: "default-parameter",
		language: "js",
		header: "function choose(value = ns.factory({",
		members: values,
		tail: "})) {}",
	},
	{
		name: "multiline-implements",
		language: "ts",
		header: "class Example implements\n Base<{",
		members: types,
		tail: "}> {}",
	},
	{
		name: "binding-initializer",
		language: "js",
		header: "const { value = ns.factory({",
		members: values,
		tail: "}) } = source;",
	},
	{
		name: "conditional-return",
		language: "ts",
		header: "function choose<T>(): T extends string ? {",
		members: types,
		tail: "} : never { throw 0; }",
	},
	{
		name: "mapped-return",
		language: "ts",
		header: "function choose(): { [K in keyof {",
		members: types,
		tail: "}]: number } { throw 0; }",
	},
	{
		name: "typeof-indexed-return",
		language: "ts",
		header: "function choose(): (typeof registry)[keyof {",
		members: types,
		tail: "}] { throw 0; }",
	},
	{
		name: "heritage-callback",
		language: "js",
		header: "class Example extends ns.factory(() => ({",
		members: values,
		tail: "})) {}",
	},
] as const;

export function signatureSource(fixture: (typeof adversarialSignatures)[number]): string {
	return `${fixture.header}\n${fixture.members}\n${fixture.tail}`;
}
