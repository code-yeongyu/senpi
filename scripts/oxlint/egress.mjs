#!/usr/bin/env node
// Custody design 3.4 as ruled in r11.1 R8: egress instances of different tenants can share one isolate, so every
// module-level binding in src/core/egress (and every static class field) is an error unless its initializer is in
// a closed exempt class. Literals are exempt only `as const`: tsc, not this rule, then proves no write reaches them.
const MARKERS = new Set(["console-redactor-install", "sealed-window-counter"]);
const MARKER = /^\s*no-module-state:\s*(\S+)\s*$/u;
const STATELESS_CONSTRUCTORS = new Set(["TextEncoder", "TextDecoder"]);
const PRIMITIVE_CALLS = new Set(["Symbol", "Number", "String", "Boolean", "BigInt", "parseInt", "parseFloat"]);
// E5: construct-once descriptors, keyed by import source + export name. Extending this list is a reviewed change.
const DESCRIPTOR_IMPORTS = {
	"@sinclair/typebox": new Set(["Type"]),
	typebox: new Set(["Type"]),
	"@sinclair/typebox/compiler": new Set(["TypeCompiler", "Compile"]),
	"typebox/compile": new Set(["Compile"]),
};
const TRANSPARENT = new Set(["TSNonNullExpression", "ParenthesizedExpression", "TSSatisfiesExpression"]);

function unwrap(node) {
	let current = node;
	while (current && TRANSPARENT.has(current.type)) current = current.expression;
	return current;
}

function isAsConst(node) {
	let current = node;
	while (current && (current.type === "ParenthesizedExpression" || current.type === "TSSatisfiesExpression")) {
		current = current.expression;
	}
	return (
		current?.type === "TSAsExpression" &&
		current.typeAnnotation.type === "TSTypeReference" &&
		current.typeAnnotation.typeName.type === "Identifier" &&
		current.typeAnnotation.typeName.name === "const"
	);
}

function stripAsConst(node) {
	let current = node;
	while (current && (current.type === "ParenthesizedExpression" || current.type === "TSSatisfiesExpression")) {
		current = current.expression;
	}
	return current?.type === "TSAsExpression" ? current.expression : current;
}

function memberRootName(node) {
	let current = unwrap(node);
	while (current?.type === "MemberExpression") current = unwrap(current.object);
	return current?.type === "Identifier" ? current.name : undefined;
}

function calleeIdentity(callee) {
	const target = unwrap(callee);
	if (target?.type === "Identifier") return { root: target.name, name: target.name };
	if (target?.type === "MemberExpression" && !target.computed && target.property.type === "Identifier") {
		return { root: memberRootName(target), name: target.property.name };
	}
	return undefined;
}

function createChecker(imports, exemptNames) {
	const isExemptReference = (name) => exemptNames.has(name);

	const isPrimitive = (raw) => {
		const node = unwrap(raw);
		if (!node) return false;
		switch (node.type) {
			case "Literal":
				return !node.regex || !/[gy]/u.test(node.regex.flags);
			case "TemplateLiteral":
				return node.expressions.every(isPrimitive);
			case "UnaryExpression":
				return node.operator !== "delete" && isPrimitive(node.argument);
			case "BinaryExpression":
			case "LogicalExpression":
				return isPrimitive(node.left) && isPrimitive(node.right);
			case "ConditionalExpression":
				return isPrimitive(node.test) && isPrimitive(node.consequent) && isPrimitive(node.alternate);
			case "Identifier":
				return node.name === "undefined" || isExemptReference(node.name);
			case "MemberExpression":
				return memberRootName(node) !== undefined && (isExemptReference(memberRootName(node)) || memberRootName(node) === "Math" || memberRootName(node) === "Number");
			case "CallExpression": {
				const callee = calleeIdentity(node.callee);
				if (!callee) return false;
				const primitiveCall =
					(callee.root === callee.name && PRIMITIVE_CALLS.has(callee.name)) ||
					(callee.root === "Symbol" && callee.name === "for") ||
					callee.root === "Math";
				return primitiveCall && node.arguments.every(isPrimitive);
			}
			default:
				return false;
		}
	};

	const isConstMember = (raw) => {
		const node = unwrap(raw);
		if (!node) return true;
		if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") return true;
		if (node.type === "SpreadElement") return isConstMember(node.argument);
		if (node.type === "ObjectExpression" || node.type === "ArrayExpression") return isConstLiteral(node);
		return isPrimitive(node);
	};

	const isConstLiteral = (node) => {
		if (node.type === "ArrayExpression") return node.elements.every((element) => element === null || isConstMember(element));
		if (node.type === "ObjectExpression") {
			return node.properties.every((property) =>
				property.type === "SpreadElement" ? isConstMember(property.argument) : property.method || isConstMember(property.value),
			);
		}
		return false;
	};

	const isFlatLiteral = (node) => {
		const literal = unwrap(node);
		if (literal?.type === "ArrayExpression") return literal.elements.every((element) => element === null || isPrimitive(element));
		if (literal?.type === "ObjectExpression") {
			return literal.properties.every((property) => property.type === "Property" && (property.method || isPrimitive(property.value)));
		}
		return false;
	};

	const isDescriptorCall = (node) => {
		const callee = calleeIdentity(node.callee);
		if (!callee?.root) return false;
		const source = imports.get(callee.root);
		return source !== undefined && DESCRIPTOR_IMPORTS[source.module]?.has(source.imported) === true;
	};

	return (raw) => {
		if (isAsConst(raw)) {
			const literal = unwrap(stripAsConst(raw));
			return (literal?.type === "ObjectExpression" || literal?.type === "ArrayExpression") && isConstLiteral(literal);
		}
		const node = unwrap(raw);
		if (!node) return false;
		if (isPrimitive(node)) return true;
		if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression" || node.type === "ClassExpression")
			return true;
		if (node.type === "NewExpression") {
			return (
				unwrap(node.callee)?.type === "Identifier" &&
				STATELESS_CONSTRUCTORS.has(unwrap(node.callee).name) &&
				node.arguments.length === 0
			);
		}
		if (node.type === "CallExpression") {
			const callee = calleeIdentity(node.callee);
			if (callee?.root === "Object" && callee.name === "freeze" && node.arguments.length === 1) {
				const target = node.arguments[0];
				if (isAsConst(target)) {
					const literal = unwrap(stripAsConst(target));
					return (literal?.type === "ObjectExpression" || literal?.type === "ArrayExpression") && isConstLiteral(literal);
				}
				return isFlatLiteral(target);
			}
			return isDescriptorCall(node);
		}
		return false;
	};
}

const noModuleState = {
	meta: {
		type: "problem",
		docs: { description: "Forbid tenant-capable state at module scope in src/core/egress (custody design 3.4, r11.1 R8)." },
	},
	create(context) {
		const { sourceCode } = context;
		const markerAbove = (node) => {
			const comment = sourceCode.getAllComments().find((candidate) => candidate.loc.end.line === node.loc.start.line - 1);
			return comment ? MARKER.exec(comment.value)?.[1] : undefined;
		};
		const report = (node) =>
			context.report({
				node,
				message:
					"Module-scope state in src/core/egress is shared across tenants. Keep it on the egress instance, make the literal `as const`, or use a named exception (console-redactor-install, sealed-window-counter).",
			});

		return {
			Program(program) {
				for (const comment of sourceCode.getAllComments()) {
					const name = MARKER.exec(comment.value)?.[1];
					if (name !== undefined && !MARKERS.has(name)) {
						context.report({ loc: comment.loc, message: `Unknown no-module-state exception '${name}'. The named exceptions are closed.` });
					}
				}

				const imports = new Map();
				for (const statement of program.body) {
					if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
					for (const specifier of statement.specifiers) {
						const imported =
							specifier.type === "ImportSpecifier"
								? specifier.imported.name ?? specifier.imported.value
								: specifier.type === "ImportNamespaceSpecifier"
									? "*"
									: "default";
						imports.set(specifier.local.name, { module: statement.source.value, imported });
					}
				}

				// A value imported from a sibling egress module was itself checked by this rule; anything else is unproven.
				const exemptNames = new Set(
					[...imports].filter(([, source]) => /^\.\/[^/]+\.ts$/u.test(source.module)).map(([local]) => local),
				);
				const isExempt = createChecker(imports, exemptNames);

				const checkClass = (node) => {
					for (const member of node.body.body) {
						if (member.type !== "PropertyDefinition" || !member.static || member.declare) continue;
						if (member.value && isExempt(member.value)) continue;
						if (MARKERS.has(markerAbove(member))) continue;
						report(member);
					}
				};

				for (const statement of program.body) {
					const declaration =
						statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
							? statement.declaration
							: statement;
					if (!declaration) continue;
					if (declaration.type === "ClassDeclaration" || declaration.type === "ClassExpression") {
						checkClass(declaration);
						continue;
					}
					if (declaration.type !== "VariableDeclaration" || declaration.declare) continue;
					const marked = MARKERS.has(markerAbove(statement));
					const exempt =
						declaration.kind === "const" &&
						declaration.declarations.every((declarator) => {
							if (declarator.init && unwrap(declarator.init)?.type === "ClassExpression") checkClass(unwrap(declarator.init));
							if (declarator.id.type === "Identifier") return declarator.init !== null && isExempt(declarator.init);
							return declarator.init !== null && unwrap(declarator.init)?.type === "Identifier" && exemptNames.has(unwrap(declarator.init).name);
						});
					if (exempt || marked) {
						for (const declarator of declaration.declarations) {
							if (declarator.id.type === "Identifier") exemptNames.add(declarator.id.name);
						}
						continue;
					}
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
