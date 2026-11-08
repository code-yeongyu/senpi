#!/usr/bin/env node
// Hosted-brain custody design 3.4: egress instances of different tenants can share one isolate, so module scope
// in src/core/egress must hold no tenant state. Only the two named, data-free exceptions may opt out.
// An object/array literal counts as a constant table only when EVERY reference to it sits in a position proven
// not to mutate it (an allowlist): any other use, including an unknown callee, fails closed.
const EXCEPTIONS = new Set(["console-redactor-install", "sealed-window-counter"]);
const STATEFUL_CONSTRUCTORS = new Set(["Map", "Set", "WeakMap", "WeakRef"]);
const READ_METHODS = new Set([
	"map",
	"filter",
	"some",
	"every",
	"find",
	"findIndex",
	"includes",
	"indexOf",
	"keys",
	"values",
	"entries",
	"has",
	"get",
]);
const PURE_STATICS = { Object: new Set(["freeze", "keys", "values", "entries"]) };
const TRANSPARENT = new Set([
	"TSAsExpression",
	"TSSatisfiesExpression",
	"TSNonNullExpression",
	"ParenthesizedExpression",
	"ChainExpression",
]);
const MARKER = /^\s*no-module-state:\s*(\S+)\s*$/u;

function unwrap(node) {
	let current = node;
	while (current && TRANSPARENT.has(current.type)) current = current.expression;
	return current;
}

function staticName(property, computed) {
	if (!computed && property.type === "Identifier") return property.name;
	if (property.type === "Literal" && typeof property.value === "string") return property.value;
	return undefined;
}

function isTypePosition(node) {
	for (let current = node.parent; current; current = current.parent) {
		if (current.type.startsWith("TS") && !TRANSPARENT.has(current.type)) return true;
		if (current.type.endsWith("Statement") || current.type.endsWith("Declaration")) return false;
	}
	return false;
}

function isReference(node) {
	const parent = node.parent;
	if (!parent) return false;
	if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return false;
	if (parent.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand) return false;
	if (parent.type === "VariableDeclarator" && parent.id === node) return false;
	if (parent.type === "ImportSpecifier" || parent.type === "ImportDefaultSpecifier") return false;
	if (parent.type === "ExportSpecifier" && parent.exported === node && parent.local !== node) return false;
	if (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement")
		return false;
	if (
		(parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") &&
		parent.key === node &&
		!parent.computed
	)
		return false;
	return !isTypePosition(node);
}

function climb(node) {
	let current = node;
	while (current.parent && TRANSPARENT.has(current.parent.type)) current = current.parent;
	return current;
}

/** True when this reference cannot change the table it names. */
function isSafeUse(reference) {
	let node = climb(reference);
	let parent = node.parent;
	if (parent?.type === "ExportSpecifier") return true;
	if (parent?.type === "UnaryExpression" && parent.operator === "typeof") return true;
	if (parent?.type === "BinaryExpression" && parent.operator === "in" && parent.right === node) return true;
	if (parent?.type === "ForOfStatement" && parent.right === node) return true;
	if (
		parent?.type === "SpreadElement" &&
		(parent.parent?.type === "ArrayExpression" || parent.parent?.type === "ObjectExpression")
	)
		return true;
	if (parent?.type === "CallExpression" && parent.arguments.includes(node)) {
		const callee = unwrap(parent.callee);
		if (callee?.type !== "MemberExpression") return false;
		const owner = unwrap(callee.object);
		const method = staticName(callee.property, callee.computed);
		return owner?.type === "Identifier" && PURE_STATICS[owner.name]?.has(method) === true;
	}
	if (parent?.type !== "MemberExpression" || parent.object !== node) return false;
	while (true) {
		node = climb(parent);
		parent = node.parent;
		if (parent?.type === "MemberExpression" && parent.object === node) continue;
		break;
	}
	if (parent?.type === "AssignmentExpression" && parent.left === node) return false;
	if (parent?.type === "UpdateExpression") return false;
	if (parent?.type === "UnaryExpression" && parent.operator === "delete") return false;
	if (parent?.type === "CallExpression" && unwrap(parent.callee) === unwrap(node)) {
		const member = unwrap(node);
		return READ_METHODS.has(staticName(member.property, member.computed));
	}
	return true;
}

function classify(declaration) {
	if (declaration.kind !== "const") return { state: true, literals: [] };
	const literals = [];
	for (const declarator of declaration.declarations) {
		const init = unwrap(declarator.init);
		if (!init) continue;
		if (
			init.type === "NewExpression" &&
			init.callee.type === "Identifier" &&
			STATEFUL_CONSTRUCTORS.has(init.callee.name)
		) {
			return { state: true, literals: [] };
		}
		if ((init.type === "ObjectExpression" || init.type === "ArrayExpression") && declarator.id.type === "Identifier") {
			literals.push(declarator.id.name);
		}
	}
	return { state: false, literals };
}

const noModuleState = {
	meta: {
		type: "problem",
		docs: { description: "Forbid tenant-capable state at module scope in src/core/egress." },
	},
	create(context) {
		const { sourceCode } = context;
		const unsafe = new Set();
		const markerOnLineAbove = (node) => {
			const comment = sourceCode
				.getAllComments()
				.find((candidate) => candidate.loc.end.line === node.loc.start.line - 1);
			return comment ? MARKER.exec(comment.value)?.[1] : undefined;
		};
		return {
			Identifier(node) {
				if (isReference(node) && !isSafeUse(node)) unsafe.add(node.name);
			},
			"Program:exit"(program) {
				for (const statement of program.body) {
					const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
					if (declaration?.type !== "VariableDeclaration") continue;
					const { state, literals } = classify(declaration);
					if (!state && !literals.some((name) => unsafe.has(name))) continue;
					if (EXCEPTIONS.has(markerOnLineAbove(statement))) continue;
					context.report({
						node: statement,
						message:
							"Module-scope state in src/core/egress is shared across tenants. Keep it on the egress instance, or use a named exception (console-redactor-install, sealed-window-counter).",
					});
				}
			},
		};
	},
};

export default {
	meta: { name: "senpi-egress" },
	rules: { "no-module-state": noModuleState },
};
