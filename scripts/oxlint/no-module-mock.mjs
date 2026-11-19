#!/usr/bin/env node
// Module-mock half of no-test-doubles from interfere-inc/landmines 0.1.0 (MIT, Copyright (c) 2026
// Interfere, Inc.), packages/landmines/src/rules/no-test-doubles.ts: vi.mock, vi.doMock and jest.mock
// keep upstream's detection, including its `{ spy: true }` observation exception. Upstream does not
// know bun:test, so bun's mock.module is added here. Per-file counts are pinned in the lint ratchet.

// Where each mocking object comes from, and the methods on it that replace a whole module.
const frameworks = [
	{ module: "bun:test", exports: ["mock"], globals: [], methods: ["module"] },
	{ module: "vitest", exports: ["vi", "vitest"], globals: ["vi", "vitest"], methods: ["mock", "doMock"] },
	{
		module: "@jest/globals",
		exports: ["jest"],
		globals: ["jest"],
		methods: ["mock", "doMock", "unstable_mockModule"],
	},
];

const isNode = (value) => typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string";

const child = (node, key) => {
	const value = node[key];
	return isNode(value) ? value : undefined;
};

const nodes = (node, key) => {
	const values = Array.isArray(node[key]) ? node[key] : [];
	return values.filter(isNode);
};

const unwrap = (initial) => {
	let node = initial;
	while (
		node.type === "TSAsExpression" ||
		node.type === "TSSatisfiesExpression" ||
		node.type === "TSNonNullExpression" ||
		node.type === "TSTypeAssertion" ||
		node.type === "ParenthesizedExpression" ||
		node.type === "AwaitExpression"
	) {
		node = child(node, node.type === "AwaitExpression" ? "argument" : "expression");
	}
	return node;
};

const nameOf = (node) => {
	if (node?.type === "Identifier") return String(node["name"]);
	return node?.type === "Literal" && typeof node["value"] === "string" ? node["value"] : null;
};

const propertyName = (member) => {
	const property = child(member, "property");
	if (member["computed"] !== true) return property?.type === "Identifier" ? String(property["name"]) : null;
	return property?.type === "Literal" ? nameOf(property) : null;
};

const identifier = (node) => {
	const target = node === undefined ? undefined : unwrap(node);
	return target?.type === "Identifier" ? String(target["name"]) : null;
};

// A require function: `require` itself, or one made inline by `createRequire(import.meta.url)`.
const isRequire = (initial) => {
	const node = unwrap(initial);
	if (identifier(node) === "require") return true;
	return node.type === "CallExpression" && identifier(child(node, "callee")) === "createRequire";
};

// `require(x)`, `createRequire(...)(x)` and `import(x)` load the same module as a static import.
const loadedModule = (initial) => {
	const node = unwrap(initial);
	if (node.type === "ImportExpression") return nameOf(child(node, "source"));
	if (node.type !== "CallExpression" || !isRequire(child(node, "callee"))) return null;
	return nameOf(nodes(node, "arguments")[0]);
};

const frameworkOf = (module) => frameworks.find((framework) => framework.module === module);

// upstream: `vi.mock(path, { spy: true })` keeps the real module and only observes it.
const observes = (call) => {
	const args = nodes(call, "arguments");
	const options = args[1];
	if (args.length !== 2 || options?.type !== "ObjectExpression") return false;
	const properties = nodes(options, "properties");
	const [only] = properties;
	return (
		properties.length === 1 &&
		only?.type === "Property" &&
		only["computed"] !== true &&
		nameOf(child(only, "key")) === "spy" &&
		child(only, "value")?.type === "Literal" &&
		child(only, "value")?.["value"] === true
	);
};

const noModuleMock = {
	meta: {
		type: "problem",
		docs: {
			description: "Disallow replacing a whole module in a test (bun mock.module, vi.mock, jest.mock).",
		},
		messages: {
			module:
				"Do not replace a module in a test: the replacement leaks to every importer in the test process and hides the real wiring. Inject the dependency instead (a parameter, option, or factory argument the test passes a fake to), or use a real fake at a boundary (a temp directory, a local server, an in-memory implementation of the interface).",
		},
	},
	create: (context) => {
		const objects = new Map();
		const namespaces = new Map();
		const imported = new Set();
		const declarators = [];
		const calls = [];

		const objectOf = (initial) => {
			const node = unwrap(initial);
			if (node.type === "Identifier") {
				const name = String(node["name"]);
				const bound = objects.get(name);
				if (bound !== undefined || imported.has(name)) return bound;
				return frameworks.find((framework) => framework.globals.includes(name));
			}
			if (node.type !== "MemberExpression") return undefined;
			const framework = namespaces.get(identifier(child(node, "object")) ?? "");
			return framework !== undefined && framework.exports.includes(propertyName(node) ?? "") ? framework : undefined;
		};

		const namespaceOf = (node) => frameworkOf(loadedModule(node)) ?? namespaces.get(identifier(node) ?? "");

		const bindExports = (pattern, framework) => {
			for (const property of nodes(pattern, "properties")) {
				const exported = property.type === "Property" ? nameOf(child(property, "key")) : null;
				if (exported === null || !framework.exports.includes(exported)) continue;
				const value = child(property, "value");
				const local = value?.type === "AssignmentPattern" ? child(value, "left") : value;
				if (local?.type === "Identifier") objects.set(String(local["name"]), framework);
			}
		};

		// Returns whether the declarator bound a new name, so aliases of aliases resolve too.
		const bind = (declarator) => {
			const id = child(declarator, "id");
			const init = child(declarator, "init");
			if (id === undefined || init === undefined) return false;
			const before = objects.size + namespaces.size;
			if (id.type === "Identifier") {
				const name = String(id["name"]);
				const object = objectOf(init);
				const namespace = frameworkOf(loadedModule(init));
				if (object !== undefined) objects.set(name, object);
				else if (namespace !== undefined) namespaces.set(name, namespace);
			} else if (id.type === "ObjectPattern") {
				const framework = namespaceOf(init);
				if (framework !== undefined) bindExports(id, framework);
			}
			return objects.size + namespaces.size > before;
		};

		return {
			ImportDeclaration: (node) => {
				const framework = node["importKind"] === "type" ? undefined : frameworkOf(nameOf(child(node, "source")));
				for (const specifier of nodes(node, "specifiers")) {
					const local = nameOf(child(specifier, "local"));
					if (local === null) continue;
					imported.add(local);
					if (framework === undefined) continue;
					if (specifier.type === "ImportNamespaceSpecifier") namespaces.set(local, framework);
					else if (
						specifier.type === "ImportSpecifier" &&
						specifier["importKind"] !== "type" &&
						framework.exports.includes(nameOf(child(specifier, "imported")) ?? "")
					)
						objects.set(local, framework);
				}
			},
			VariableDeclarator: (node) => {
				declarators.push(node);
			},
			CallExpression: (node) => {
				if (unwrap(child(node, "callee")).type === "MemberExpression") calls.push(node);
			},
			// Resolved after the whole file is read, so a call above its import or require still counts.
			"Program:exit": () => {
				let bound = true;
				while (bound) bound = declarators.map(bind).includes(true);
				for (const call of calls) {
					const callee = unwrap(child(call, "callee"));
					const framework = objectOf(child(callee, "object"));
					const method = propertyName(callee) ?? "";
					if (framework === undefined || !framework.methods.includes(method)) continue;
					if (framework.module !== "bun:test" && method !== "unstable_mockModule" && observes(call)) continue;
					context.report({ node: call, messageId: "module" });
				}
			},
		};
	},
};

// oxlint-disable-next-line import/no-default-export -- the oxlint plugin loader reads the default export.
export default noModuleMock;
