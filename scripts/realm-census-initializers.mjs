// Realm census (design #12965, 3.3): which initializers can hold module state. The rule extends the `no-module-state`
// lint in scripts/oxlint/egress.mjs: a binding is exempt only when its initializer is a primitive, a function, arrow or
// class expression, or a deeply constant literal (`as const` on an unannotated binding, or `Object.freeze` of constant
// leaves).
const TRANSPARENT = new Set(["TSNonNullExpression", "ParenthesizedExpression", "TSSatisfiesExpression"]);
const PRIMITIVE_CALLS = new Set(["Number", "String", "Boolean", "BigInt", "parseInt", "parseFloat"]);

export function unwrap(node) {
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

// egress.mjs isPrimitive with no exempt references: an identifier initializer counts, and a bare `Symbol()` counts
// because each copy mints its own identity.
function isPrimitive(raw) {
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
			return node.name === "undefined";
		case "MemberExpression": {
			const root = memberRootName(node);
			return root === "Math" || root === "Number";
		}
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
}

function isConstMember(raw) {
	const node = unwrap(raw);
	if (!node) return true;
	if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") return true;
	if (node.type === "SpreadElement") return isConstMember(node.argument);
	if (node.type === "ObjectExpression" || node.type === "ArrayExpression") return isConstLiteral(node);
	return isPrimitive(node);
}

function isConstLiteral(node) {
	if (node.type === "ArrayExpression")
		return node.elements.every((element) => element === null || isConstMember(element));
	if (node.type === "ObjectExpression") {
		return node.properties.every((property) =>
			property.type === "SpreadElement"
				? isConstMember(property.argument)
				: property.method || isConstMember(property.value),
		);
	}
	return false;
}

function isFlatLiteral(node) {
	const literal = unwrap(node);
	if (literal?.type === "ArrayExpression")
		return literal.elements.every((element) => element === null || isPrimitive(element));
	if (literal?.type === "ObjectExpression") {
		return literal.properties.every(
			(property) => property.type === "Property" && (property.method || isPrimitive(property.value)),
		);
	}
	return false;
}

function isDeepConstLiteral(raw) {
	const literal = unwrap(stripAsConst(raw));
	return (literal?.type === "ObjectExpression" || literal?.type === "ArrayExpression") && isConstLiteral(literal);
}

/** True when an initializer cannot hold module state (egress.mjs semantics, without its descriptor exemptions). */
export function isExemptInitializer(raw, annotated = false) {
	if (isAsConst(raw)) return !annotated && isDeepConstLiteral(raw);
	const node = unwrap(raw);
	if (!node) return false;
	if (isPrimitive(node)) return true;
	if (
		node.type === "ArrowFunctionExpression" ||
		node.type === "FunctionExpression" ||
		node.type === "ClassExpression"
	) {
		return true;
	}
	if (node.type === "CallExpression") {
		const callee = calleeIdentity(node.callee);
		if (callee?.root === "Object" && callee.name === "freeze" && node.arguments.length === 1) {
			const target = node.arguments[0];
			return isAsConst(target) ? isDeepConstLiteral(target) : isFlatLiteral(target);
		}
	}
	return false;
}

/** A short label for the report: what kind of state the initializer creates. */
export function initializerKind(raw, declarationKind) {
	const node = unwrap(stripAsConst(raw));
	const prefix = declarationKind === "let" || declarationKind === "var" ? `${declarationKind} ` : "";
	if (!node) return `${prefix}uninitialized`.trim();
	if (node.type === "NewExpression") {
		const callee = calleeIdentity(node.callee);
		return `${prefix}new ${callee?.name ?? "<expr>"}`;
	}
	if (node.type === "CallExpression") {
		const callee = calleeIdentity(node.callee);
		return `${prefix}call ${callee ? (callee.root === callee.name ? callee.name : `${callee.root ?? "<expr>"}.${callee.name}`) : "<expr>"}`;
	}
	if (node.type === "AwaitExpression") return `${prefix}await`;
	if (node.type === "ArrayExpression") return `${prefix}array literal`;
	if (node.type === "ObjectExpression") return `${prefix}object literal`;
	if (node.type === "Identifier") return `${prefix}identifier ${node.name}`;
	if (node.type === "MemberExpression") return `${prefix}member expression`;
	if (node.type === "Literal" && node.regex) return `${prefix}regex`;
	return `${prefix}${isExemptInitializer(raw) ? "primitive" : "expression"}`;
}

export function isAsyncLocalStorage(raw) {
	const node = unwrap(stripAsConst(raw));
	return node?.type === "NewExpression" && calleeIdentity(node.callee)?.name === "AsyncLocalStorage";
}

export function patternNames(pattern, out = []) {
	if (!pattern) return out;
	switch (pattern.type) {
		case "Identifier":
			out.push(pattern.name);
			break;
		case "ObjectPattern":
			for (const property of pattern.properties)
				patternNames(property.type === "RestElement" ? property.argument : property.value, out);
			break;
		case "ArrayPattern":
			for (const element of pattern.elements) patternNames(element, out);
			break;
		case "AssignmentPattern":
			patternNames(pattern.left, out);
			break;
		case "RestElement":
			patternNames(pattern.argument, out);
			break;
		default:
			break;
	}
	return out;
}

export function memberName(member) {
	const key = member.key;
	if (!member.computed && key.type === "Identifier") return key.name;
	if (key.type === "PrivateIdentifier") return `#${key.name}`;
	if (key.type === "Literal") return String(key.value);
	return "[computed]";
}
