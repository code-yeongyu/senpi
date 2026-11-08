#!/usr/bin/env node
// Hosted-brain custody design 3.4: egress instances of different tenants can share one isolate, so module scope
// in src/core/egress must hold no tenant state. Only the two named, data-free exceptions may opt out.
const EXCEPTIONS = new Set(["console-redactor-install", "sealed-window-counter"]);
const STATEFUL_CONSTRUCTORS = new Set(["Map", "Set", "WeakMap", "WeakRef"]);
const MARKER = /^\s*no-module-state:\s*(\S+)\s*$/u;

function unwrap(node) {
	let current = node;
	while (
		current &&
		(current.type === "TSAsExpression" ||
			current.type === "TSSatisfiesExpression" ||
			current.type === "TSNonNullExpression" ||
			current.type === "ParenthesizedExpression")
	) {
		current = current.expression;
	}
	return current;
}

function holdsState(declaration) {
	if (declaration.kind !== "const") return true;
	return declaration.declarations.some((declarator) => {
		const init = unwrap(declarator.init);
		if (!init) return false;
		if (init.type === "ObjectExpression" || init.type === "ArrayExpression") return true;
		return (
			init.type === "NewExpression" && init.callee.type === "Identifier" && STATEFUL_CONSTRUCTORS.has(init.callee.name)
		);
	});
}

const noModuleState = {
	meta: {
		type: "problem",
		docs: { description: "Forbid tenant-capable state at module scope in src/core/egress." },
	},
	create(context) {
		const { sourceCode } = context;
		const markerOnLineAbove = (node) => {
			const comment = sourceCode
				.getAllComments()
				.find((candidate) => candidate.loc.end.line === node.loc.start.line - 1);
			return comment ? MARKER.exec(comment.value)?.[1] : undefined;
		};
		return {
			Program(program) {
				for (const statement of program.body) {
					const declaration =
						statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
					if (declaration?.type !== "VariableDeclaration" || !holdsState(declaration)) continue;
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
