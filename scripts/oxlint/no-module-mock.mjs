#!/usr/bin/env node
// Module-mock half of no-test-doubles from interfere-inc/landmines 0.1.0 (MIT, Copyright (c) 2026
// Interfere, Inc.), packages/landmines/src/rules/no-test-doubles.ts: vi.mock, vi.doMock and jest.mock
// keep upstream's detection, including its `{ spy: true }` observation exception. Upstream does not
// know bun:test, so bun's mock.module and its vi.mock alias are added here. Per-file counts are pinned
// in the lint ratchet.

// Each mocking object (a module's export, also a global when the runner injects it) and the methods on
// it that replace a whole module. bun:test's `vi.mock` is an alias of `mock.module`.
const mockers = [
	{ module: "bun:test", name: "mock", global: false, methods: ["module"] },
	{ module: "bun:test", name: "vi", global: false, methods: ["mock"] },
	{ module: "vitest", name: "vi", global: true, methods: ["mock", "doMock"] },
	{ module: "vitest", name: "vitest", global: true, methods: ["mock", "doMock"] },
	{ module: "@jest/globals", name: "jest", global: true, methods: ["mock", "doMock", "unstable_mockModule"] },
];

const mockerOf = (module, name) => mockers.find((mocker) => mocker.module === module && mocker.name === name);

const testModules = new Set(mockers.map((mocker) => mocker.module));

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
	const node = initial === undefined ? undefined : unwrap(initial);
	if (node === undefined) return false;
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
				if (objects.has(name) || imported.has(name)) return objects.get(name);
				return mockers.find((mocker) => mocker.global && mocker.name === name);
			}
			if (node.type !== "MemberExpression") return undefined;
			return mockerOf(namespaces.get(identifier(child(node, "object")) ?? "") ?? null, propertyName(node));
		};

		const loadedTestModule = (node) => {
			const module = loadedModule(node);
			return module !== null && testModules.has(module) ? module : null;
		};

		const namespaceOf = (node) => loadedTestModule(node) ?? namespaces.get(identifier(node) ?? "") ?? null;

		const bindExports = (pattern, module) => {
			for (const property of nodes(pattern, "properties")) {
				const mocker = property.type === "Property" ? mockerOf(module, nameOf(child(property, "key"))) : undefined;
				if (mocker === undefined) continue;
				const value = child(property, "value");
				const local = value?.type === "AssignmentPattern" ? child(value, "left") : value;
				if (local?.type === "Identifier") objects.set(String(local["name"]), mocker);
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
				const module = loadedTestModule(init);
				if (object !== undefined) objects.set(name, object);
				else if (module !== null) namespaces.set(name, module);
			} else if (id.type === "ObjectPattern") {
				const module = namespaceOf(init);
				if (module !== null) bindExports(id, module);
			}
			return objects.size + namespaces.size > before;
		};

		return {
			ImportDeclaration: (node) => {
				const source = nameOf(child(node, "source"));
				const module = node["importKind"] !== "type" && source !== null && testModules.has(source) ? source : null;
				for (const specifier of nodes(node, "specifiers")) {
					const local = nameOf(child(specifier, "local"));
					if (local === null) continue;
					imported.add(local);
					if (module === null) continue;
					if (specifier.type === "ImportNamespaceSpecifier") namespaces.set(local, module);
					const mocker =
						specifier.type === "ImportSpecifier" && specifier["importKind"] !== "type"
							? mockerOf(module, nameOf(child(specifier, "imported")))
							: undefined;
					if (mocker !== undefined) objects.set(local, mocker);
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
					const mocker = objectOf(child(callee, "object"));
					const method = propertyName(callee) ?? "";
					if (mocker === undefined || !mocker.methods.includes(method)) continue;
					if (mocker.module === "vitest" && observes(call)) continue;
					context.report({ node: call, messageId: "module" });
				}
			},
		};
	},
};

// oxlint-disable-next-line import/no-default-export -- the oxlint plugin loader reads the default export.
export default noModuleMock;
