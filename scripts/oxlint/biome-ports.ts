// Biome recommended rules that oxlint 1.89.0 has no rule for, ported so replacing Biome loses no check:
// suspicious/noImplicitAnyLet and correctness/noStringCaseMismatch. Each is checked against Biome 2.5.14
// on one probe corpus (scripts/oxlint-biome-ports.test.mjs holds the verdicts).
type AstNode = { readonly type: string; readonly start?: number; readonly end?: number; readonly [key: string]: unknown };
type Token = { readonly type: string; readonly value: string };
type SourceCode = {
	getTokensBetween(left: AstNode, right: AstNode): readonly Token[];
	getTokenBefore(node: AstNode | Token): Token | null;
};
type RuleContext = {
	readonly filename?: string;
	readonly sourceCode: SourceCode;
	report(descriptor: { node: AstNode; message: string }): void;
};
type Case = "upper" | "lower";

const isNode = (value: unknown): value is AstNode =>
	typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string";
const child = (node: AstNode, key: string): AstNode | undefined => {
	const value = node[key];
	return isNode(value) ? value : undefined;
};
const nodes = (value: unknown): readonly AstNode[] => (Array.isArray(value) ? value.filter(isNode) : []);

// The constant text of a string literal or of a template literal with no expressions.
const constantText = (node: AstNode | undefined): string | undefined => {
	if (node?.type === "Literal") return typeof node["value"] === "string" ? node["value"] : undefined;
	if (node?.type !== "TemplateLiteral" || nodes(node["expressions"]).length > 0) return undefined;
	const value = nodes(node["quasis"])[0]?.["value"];
	const cooked = typeof value === "object" && value !== null ? Reflect.get(value, "cooked") : undefined;
	return typeof cooked === "string" ? cooked : undefined;
};

// `s.toUpperCase()`, `s?.toUpperCase()` and `s["toUpperCase"]()` change case; anything else does not.
const caseOf = (node: AstNode | undefined): Case | undefined => {
	const call = node?.type === "ChainExpression" ? child(node, "expression") : node;
	const callee = call?.type === "CallExpression" ? child(call, "callee") : undefined;
	if (callee?.type !== "MemberExpression") return undefined;
	const property = child(callee, "property");
	const name = callee["computed"] === true ? constantText(property) : property?.type === "Identifier" ? property["name"] : undefined;
	return name === "toUpperCase" ? "upper" : name === "toLowerCase" ? "lower" : undefined;
};

// A literal mismatches when it holds a letter of the other case. Titlecase letters (ǅ) and letters
// without case belong to neither, as in Biome.
const mismatches = (text: string | undefined, expected: Case): boolean =>
	text !== undefined &&
	[...text].some((char) => {
		const upper = char.toUpperCase();
		const lower = char.toLowerCase();
		return expected === "upper" ? char === lower && char !== upper : char === upper && char !== lower;
	});

const caseMessage = (expected: Case): string =>
	`This compares a ${expected}-cased string with a literal that is not ${expected}case, so it never matches (Biome noStringCaseMismatch).`;

// oxlint's AST drops parentheses, and Biome skips a parenthesized operand, so the tokens around a node
// tell. Comments are not tokens, so a ( inside a comment never counts.
const isPunctuator = (token: Token | null | undefined, value: string): boolean =>
	token?.type === "Punctuator" && token.value === value;
const operandsParenthesized = (context: RuleContext, left: AstNode, right: AstNode): boolean =>
	context.sourceCode.getTokensBetween(left, right).some((token) => isPunctuator(token, "(") || isPunctuator(token, ")"));
const wrappedTimes = (context: RuleContext, node: AstNode, times: number): boolean => {
	let token: Token | null = context.sourceCode.getTokenBefore(node);
	for (let wraps = 0; wraps < times; wraps += 1) {
		if (!isPunctuator(token, "(")) return false;
		if (token !== null) token = context.sourceCode.getTokenBefore(token);
	}
	return true;
};

const noImplicitAnyLet = {
	create: (context: RuleContext) => {
		// A for-in or for-of loop variable is assigned by the loop, so Biome does not report it.
		const loopVariables = new WeakSet<AstNode>();
		const markLoopVariable = (node: AstNode): void => {
			const left = child(node, "left");
			if (left !== undefined) loopVariables.add(left);
		};
		return {
			ForInStatement: markLoopVariable,
			ForOfStatement: markLoopVariable,
			VariableDeclaration: (node: AstNode) => {
				// JavaScript has no type annotations, so Biome checks TypeScript files only.
				if (!/\.[cm]?tsx?$/.test(context.filename ?? "")) return;
				if (node["kind"] !== "let" && node["kind"] !== "var") return;
				if (loopVariables.has(node)) return;
				for (const declarator of nodes(node["declarations"])) {
					const id = child(declarator, "id");
					if (child(declarator, "init") === undefined && id?.type === "Identifier" && child(id, "typeAnnotation") === undefined)
						context.report({
							node: declarator,
							message: `This ${String(node["kind"])} has no type and no initial value, so it is implicitly any: give it a type (Biome noImplicitAnyLet).`,
						});
				}
			},
		};
	},
};

const noStringCaseMismatch = {
	create: (context: RuleContext) => ({
		// Biome checks equality only (== and ===), with the call on either side.
		BinaryExpression: (node: AstNode) => {
			if (node["operator"] !== "===" && node["operator"] !== "==") return;
			const left = child(node, "left");
			const right = child(node, "right");
			if (left === undefined || right === undefined) return;
			if (operandsParenthesized(context, left, right)) return;
			for (const [call, other] of [
				[left, right],
				[right, left],
			] as const) {
				const expected = caseOf(call);
				if (expected !== undefined && mismatches(constantText(other), expected))
					context.report({ node, message: caseMessage(expected) });
			}
		},
		SwitchStatement: (node: AstNode) => {
			const discriminant = child(node, "discriminant");
			// `switch (x)` always has one ( before the discriminant; a second one means it is parenthesized.
			if (discriminant === undefined || wrappedTimes(context, discriminant, 2)) return;
			const expected = caseOf(discriminant);
			if (expected === undefined) return;
			for (const switchCase of nodes(node["cases"])) {
				const test = child(switchCase, "test");
				if (test === undefined || wrappedTimes(context, test, 1)) continue;
				if (mismatches(constantText(test), expected)) context.report({ node: test, message: caseMessage(expected) });
			}
		},
	}),
};

// oxlint-disable-next-line import/no-default-export -- the oxlint plugin loader reads the default export.
export default {
	meta: { name: "biome-port" },
	rules: { "no-implicit-any-let": noImplicitAnyLet, "no-string-case-mismatch": noStringCaseMismatch },
};
