#!/usr/bin/env node
// Hosted-brain custody design 3.4: egress instances of different tenants can share one isolate, so module scope
// in src/core/egress must hold no tenant state. Only the two named, data-free exceptions may opt out.
// An object/array literal is a constant table, not state, only while nothing in the module can change it.
const EXCEPTIONS = new Set(["console-redactor-install", "sealed-window-counter"]);
const STATEFUL_CONSTRUCTORS = new Set(["Map", "Set", "WeakMap", "WeakRef"]);
const MUTATING_METHODS = new Set([
	"push",
	"pop",
	"shift",
	"unshift",
	"splice",
	"sort",
	"reverse",
	"fill",
	"copyWithin",
	"set",
	"add",
	"delete",
	"clear",
]);
const MUTATING_STATICS = {
	Object: new Set(["assign", "defineProperty", "defineProperties", "setPrototypeOf"]),
	Reflect: new Set(["set", "deleteProperty", "defineProperty", "setPrototypeOf"]),
};
const MARKER = /^\s*no-module-state:\s*(\S+)\s*$/u;

function unwrap(node) {
	let current = node;
	while (
		current &&
		(current.type === "TSAsExpression" ||
			current.type === "TSSatisfiesExpression" ||
			current.type === "TSNonNullExpression" ||
			current.type === "ParenthesizedExpression" ||
			current.type === "ChainExpression")
	) {
		current = current.expression;
	}
	return current;
}

function rootName(node) {
	let current = unwrap(node);
	while (current?.type === "MemberExpression") current = unwrap(current.object);
	return current?.type === "Identifier" ? current.name : undefined;
}

function memberRoot(node) {
	const target = unwrap(node);
	return target?.type === "MemberExpression" ? rootName(target) : undefined;
}

function staticName(property) {
	if (property.type === "Identifier") return property.name;
	if (property.type === "Literal" && typeof property.value === "string") return property.value;
	return undefined;
}

function classify(declaration) {
	if (declaration.kind !== "const") return { state: true, literals: [] };
	const literals = [];
	for (const declarator of declaration.declarations) {
		const init = unwrap(declarator.init);
		if (!init) continue;
		if (init.type === "NewExpression" && init.callee.type === "Identifier" && STATEFUL_CONSTRUCTORS.has(init.callee.name)) {
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
		const mutated = new Set();
		const aliases = new Map();
		const original = (name) => {
			const seen = new Set();
			let current = name;
			while (aliases.has(current) && !seen.has(current)) {
				seen.add(current);
				current = aliases.get(current);
			}
			return current;
		};
		const markerOnLineAbove = (node) => {
			const comment = sourceCode
				.getAllComments()
				.find((candidate) => candidate.loc.end.line === node.loc.start.line - 1);
			return comment ? MARKER.exec(comment.value)?.[1] : undefined;
		};
		const markMember = (node) => {
			const name = memberRoot(node);
			if (name) mutated.add(name);
		};
		const report = (node) =>
			context.report({
				node,
				message:
					"Module-scope state in src/core/egress is shared across tenants. Keep it on the egress instance, or use a named exception (console-redactor-install, sealed-window-counter).",
			});

		return {
			AssignmentExpression(node) {
				markMember(node.left);
				const value = unwrap(node.right);
				const target = unwrap(node.left);
				if (value?.type === "Identifier" && target?.type === "Identifier") aliases.set(target.name, value.name);
			},
			UpdateExpression(node) {
				markMember(node.argument);
			},
			UnaryExpression(node) {
				if (node.operator === "delete") markMember(node.argument);
			},
			VariableDeclarator(node) {
				const value = unwrap(node.init);
				if (value?.type === "Identifier" && node.id.type === "Identifier") aliases.set(node.id.name, value.name);
			},
			CallExpression(node) {
				const callee = unwrap(node.callee);
				if (callee?.type !== "MemberExpression") return;
				const method = staticName(callee.property);
				const owner = unwrap(callee.object);
				if (owner?.type === "Identifier" && MUTATING_STATICS[owner.name]?.has(method)) {
					const target = rootName(node.arguments[0]);
					if (target) mutated.add(target);
					return;
				}
				if (method && MUTATING_METHODS.has(method)) {
					const target = rootName(callee.object);
					if (target) mutated.add(target);
				}
			},
			"Program:exit"(program) {
				for (const statement of program.body) {
					const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
					if (declaration?.type !== "VariableDeclaration") continue;
					const { state, literals } = classify(declaration);
					const mutatedRoots = new Set([...mutated].map(original));
					if (!state && !literals.some((name) => mutatedRoots.has(name))) continue;
					if (EXCEPTIONS.has(markerOnLineAbove(statement))) continue;
					report(statement);
				}
			},
		};
	},
};

export default {
	meta: { name: "senpi-egress" },
	rules: { "no-module-state": noModuleState },
};
