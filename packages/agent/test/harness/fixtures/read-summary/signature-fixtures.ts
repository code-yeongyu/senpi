// Independent signature counterexample for #1639, not generated from scanner ranges.
export const functionReturningObjectType = Array.from({ length: 20 }, (_, index) =>
	[
		`function make${index}(): () => {`,
		"  alphaProperty: string;",
		"  bravoProperty: string;",
		"  charlieProperty: string;",
		"  deltaProperty: string;",
		"  echoProperty: string;",
		"} {",
		'  return () => ({ alphaProperty: "a", bravoProperty: "b", charlieProperty: "c", deltaProperty: "d", echoProperty: "e" });',
		"}",
	].join("\n"),
).join("\n");
