#!/usr/bin/env node
// Ported from interfere-inc/landmines 0.1.0 (MIT, Copyright (c) 2026 Interfere, Inc.),
// packages/landmines/src/rules/no-flake-masking.ts. Detection is unchanged; the upstream per-file
// allowlist option is dropped because this repo pins per-file counts in the lint ratchet.
const testFunctions = new Set(["test", "it", "describe", "suite"]);
const configTimeouts = new Set(["testTimeout", "hookTimeout"]);
const testTimeouts = new Set(["timeout"]);

function keyName(property) {
	if (property.type !== "Property" || property.computed) {
		return null;
	}

	if (property.key.type === "Identifier") {
		return property.key.name;
	}

	return property.key.type === "Literal" ? String(property.key.value) : null;
}

function rootName(initial) {
	let node = initial;

	while (node.type === "MemberExpression" || node.type === "CallExpression") {
		node = node.type === "MemberExpression" ? node.object : node.callee;
	}

	return node.type === "Identifier" ? node.name : null;
}

function memberName(node) {
	return node.type === "MemberExpression" &&
		!node.computed &&
		node.property.type === "Identifier"
		? node.property.name
		: null;
}

function testCall(node) {
	const name = rootName(node.callee);
	const member = memberName(node.callee);

	return (
		name !== null &&
		testFunctions.has(name) &&
		member !== "each" &&
		member !== "for" &&
		member !== "extend" &&
		member !== "scoped" &&
		member !== "override"
	);
}

function configCall(node) {
	return (
		node.callee.type === "MemberExpression" &&
		node.callee.object.type === "Identifier" &&
		node.callee.object.name === "vi" &&
		memberName(node.callee) === "setConfig"
	);
}

const noFlakeMasking = {
	meta: {
		type: "problem",
		docs: {
			description:
				"Fix flaky tests at their cause instead of retrying them or raising their timeouts (landmines no-flake-masking).",
		},
		messages: {
			retry:
				"Do not retry tests. A test that passes on rerun is a flake: wait on the event it depends on and file the failure under the flaky-test tracker.",
			timeout:
				"Do not raise a test's timeout. Wait on the event the test depends on, or move slow shared setup into a beforeAll hook.",
		},
	},
	create(context) {
		function inspect(node, keys) {
			if (node?.type !== "ObjectExpression") {
				return;
			}

			for (const property of node.properties) {
				const key = keyName(property);

				if (key === "retry") {
					context.report({ node: property, messageId: "retry" });
				} else if (key !== null && keys.has(key)) {
					context.report({ node: property, messageId: "timeout" });
				}
			}
		}

		return {
			CallExpression(node) {
				if (configCall(node)) {
					inspect(node.arguments[0], configTimeouts);

					return;
				}

				if (!testCall(node)) {
					return;
				}

				const [, second, third] = node.arguments;

				inspect(second, testTimeouts);

				inspect(third, testTimeouts);

				if (
					third !== undefined &&
					second?.type !== "ObjectExpression" &&
					third.type !== "ObjectExpression" &&
					third.type !== "ArrowFunctionExpression" &&
					third.type !== "FunctionExpression"
				) {
					context.report({ node: third, messageId: "timeout" });
				}
			},
			Property(node) {
				if (keyName(node) === "test" && node.value.type === "ObjectExpression") {
					for (const property of node.value.properties) {
						if (keyName(property) === "retry") {
							context.report({ node: property, messageId: "retry" });
						}
					}
				}
			},
		};
	},
};

// oxlint-disable-next-line import/no-default-export -- the oxlint plugin loader reads the default export.
export default noFlakeMasking;
