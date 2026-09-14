import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lockPathPackageChain, resolvePublishPlacements } from "./prepare-senpi-publish-placements.mjs";

const internalPackageNames = new Set(["@earendil-works/pi-ai"]);
const pkg = (version, dependencies) => ({ version, ...(dependencies ? { dependencies } : {}) });
const placementsOf = (packages) =>
	Object.fromEntries(resolvePublishPlacements(packages, internalPackageNames).map(({ lockPath, entry }) => [lockPath, entry.version]));

describe("lockPathPackageChain", () => {
	it("splits top-level, scoped and nested lock paths and rejects everything else", () => {
		assert.deepEqual(lockPathPackageChain("node_modules/typebox"), ["typebox"]);
		assert.deepEqual(lockPathPackageChain("node_modules/@scope/pkg"), ["@scope/pkg"]);
		assert.deepEqual(lockPathPackageChain("node_modules/a/node_modules/@scope/b"), ["a", "@scope/b"]);
		for (const rejected of ["", "packages/coding-agent", "node_modules/.bin", "node_modules/@scope", "node_modules/a/dist"]) {
			assert.equal(lockPathPackageChain(rejected), undefined, rejected);
		}
	});
});

describe("resolvePublishPlacements", () => {
	it("keeps nested and workspace-local entries at their manifest paths, parents before children, and skips internal workspaces", () => {
		const placements = resolvePublishPlacements(
			{
				"": { dependencies: { htmlparser2: "10.1.0", diff: "9.0.0" } },
				"node_modules/htmlparser2/node_modules/entities": pkg("7.0.1"),
				"node_modules/htmlparser2": pkg("10.1.0", { entities: "^7.0.1" }),
				"packages/coding-agent/node_modules/diff": pkg("9.0.0"),
				"node_modules/@earendil-works/pi-ai": pkg("1.0.0"),
				"node_modules/@earendil-works/pi-ai/node_modules/agent-base": pkg("9.0.0"),
				"node_modules/.bin": {},
			},
			internalPackageNames,
		);
		assert.deepEqual(
			placements.map(({ lockPath, chain }) => [lockPath, chain]),
			[
				["node_modules/diff", ["diff"]],
				["node_modules/htmlparser2", ["htmlparser2"]],
				["node_modules/htmlparser2/node_modules/entities", ["htmlparser2", "entities"]],
			],
		);
	});

	it("gives the top-level slot to the workspace-local copy and re-nests the root copy under the dependents npm resolved to it", () => {
		// The real shape behind senpi#1677: coding-agent pins the 9.x proxy agents while gaxios
		// (a root registry dependency) resolved the 7.x pair at the root.
		assert.deepEqual(
			placementsOf({
				"": { dependencies: { "http-proxy-agent": "9.1.0", "https-proxy-agent": "9.1.0", gaxios: "7.1.0" } },
				"node_modules/agent-base": pkg("7.1.4"),
				"node_modules/https-proxy-agent": pkg("7.0.6", { "agent-base": "^7.1.2" }),
				"node_modules/gaxios": pkg("7.1.0", { "https-proxy-agent": "^7.0.1" }),
				"packages/coding-agent/node_modules/agent-base": pkg("9.0.0"),
				"packages/coding-agent/node_modules/http-proxy-agent": pkg("9.1.0", { "agent-base": "9.0.0" }),
				"packages/coding-agent/node_modules/https-proxy-agent": pkg("9.1.0", { "agent-base": "9.0.0" }),
			}),
			{
				"node_modules/agent-base": "9.0.0",
				"node_modules/gaxios": "7.1.0",
				"node_modules/http-proxy-agent": "9.1.0",
				"node_modules/https-proxy-agent": "9.1.0",
				"node_modules/gaxios/node_modules/https-proxy-agent": "7.0.6",
				"node_modules/gaxios/node_modules/https-proxy-agent/node_modules/agent-base": "7.1.4",
			},
		);
	});

	it("re-nests a root copy under every dependency edge, never a peer edge, respects nearer placements, and drops a root copy nothing staged resolves", () => {
		// openai only PEERS on zod: npm never nests a peer and the packer would drop it, so it
		// resolves the top-level copy; the MCP sdk declares a real dependency and gets its own.
		assert.deepEqual(
			placementsOf({
				"": { dependencies: { zod: "4.4.3", lonely: "1.0.0" } },
				"node_modules/zod": pkg("3.25.76"),
				"node_modules/openai": { version: "6.0.0", peerDependencies: { zod: "^3.25 || ^4.0" } },
				"node_modules/@modelcontextprotocol/sdk": { version: "1.0.0", dependencies: { zod: "^3.25 || ^4.0" }, peerDependencies: { zod: "^3.25 || ^4.0" } },
				"node_modules/pinned": pkg("1.0.0", { zod: "^3.22" }),
				"node_modules/pinned/node_modules/zod": pkg("3.22.4"),
				"node_modules/@earendil-works/pi-ai/node_modules/lonely": pkg("0.1.0"),
				"node_modules/@earendil-works/pi-ai": pkg("1.0.0", { lonely: "0.1.0" }),
				"node_modules/lonely": pkg("0.1.0"),
				"packages/coding-agent/node_modules/zod": pkg("4.4.3"),
				"packages/coding-agent/node_modules/lonely": pkg("1.0.0"),
				"packages/coding-agent/node_modules/@anthropic-ai/claude-agent-sdk": pkg("0.3.259", { zod: "^4.0.0" }),
			}),
			{
				"node_modules/@anthropic-ai/claude-agent-sdk": "0.3.259",
				"node_modules/@modelcontextprotocol/sdk": "1.0.0",
				"node_modules/lonely": "1.0.0",
				"node_modules/openai": "6.0.0",
				"node_modules/pinned": "1.0.0",
				"node_modules/zod": "4.4.3",
				"node_modules/@modelcontextprotocol/sdk/node_modules/zod": "3.25.76",
				"node_modules/pinned/node_modules/zod": "3.22.4",
			},
		);
	});

	it("moves a relocated root copy's own nested resolutions with it", () => {
		// consumer resolved the root x@1, which carries its own nested y@1; the workspace-local
		// x@2 takes the top-level slot, so the old x and ITS y must both land under consumer.
		assert.deepEqual(
			placementsOf({
				"node_modules/consumer": pkg("1.0.0", { x: "1.0.0" }),
				"node_modules/x": pkg("1.0.0", { y: "1.0.0" }),
				"node_modules/x/node_modules/y": pkg("1.0.0"),
				"node_modules/y": pkg("2.0.0"),
				"packages/coding-agent/node_modules/x": pkg("2.0.0"),
			}),
			{
				"node_modules/consumer": "1.0.0",
				"node_modules/x": "2.0.0",
				"node_modules/y": "2.0.0",
				"node_modules/consumer/node_modules/x": "1.0.0",
				"node_modules/consumer/node_modules/x/node_modules/y": "1.0.0",
			},
		);
	});

	it("treats the same version at both levels as one placement", () => {
		assert.deepEqual(
			placementsOf({ "node_modules/diff": pkg("9.0.0"), "packages/coding-agent/node_modules/diff": pkg("9.0.0") }),
			{ "node_modules/diff": "9.0.0" },
		);
	});

	it("rejects two versions landing on one staged path and root copies that depend on themselves through their dependents", () => {
		assert.throws(
			() =>
				placementsOf({
					"node_modules/d": pkg("1.0.0", { x: "^1" }),
					"node_modules/x": pkg("1.0.0"),
					"packages/coding-agent/node_modules/d": pkg("1.0.0"),
					"packages/coding-agent/node_modules/d/node_modules/x": pkg("3.0.0"),
					"packages/coding-agent/node_modules/x": pkg("2.0.0"),
				}),
			/places 1\.0\.0 and 3\.0\.0 of x at the same staged path node_modules\/d\/node_modules\/x/,
		);
		assert.throws(
			() =>
				placementsOf({
					"node_modules/a": pkg("1.0.0", { b: "^1" }),
					"node_modules/b": pkg("1.0.0", { a: "^1" }),
					"packages/coding-agent/node_modules/a": pkg("2.0.0"),
					"packages/coding-agent/node_modules/b": pkg("2.0.0"),
				}),
			/depends on itself through its dependents/,
		);
	});
});
