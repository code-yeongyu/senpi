#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// senpi#6497: the MCP SDK imports `zod/v4`, `zod/v4-mini` and `zod/v3` and parses remote-server responses with them.
// Which zod those subpaths reach depends on the install layout: npm used to hoist a 3.25.x root copy whose `zod/v4`
// reports a 4.0.0 core, bun hoists 4.6.x. The root `overrides` pin the SDK's zod in every lockfile; this plugin keeps
// the bundle independent of the layout it is built from by resolving every zod import made by the SDK's OWN modules
// to the zod `packages/coding-agent` depends on. A package nested under the SDK's node_modules and every other package
// (sandbox-runtime) keep the zod their own range selects. An import the pinned copy cannot serve fails the build
// instead of falling back to the layout's copy, which is the copy this plugin exists to avoid. The Claude agent SDK
// embeds a minified zod inside sdk.mjs rather than importing it, so no resolver can reach that copy.

const codingAgentDir = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "packages", "coding-agent");
const MCP_SDK_SEGMENT = /[/\\]@modelcontextprotocol[/\\]sdk[/\\]/g;
const NESTED_NODE_MODULES = /(^|[/\\])node_modules[/\\]/;

/** True for a file of the MCP SDK package itself; false for one under the SDK's own nested `node_modules`. */
export function isMcpSdkOwnModule(importer) {
	let last;
	for (const match of importer.matchAll(MCP_SDK_SEGMENT)) last = match;
	if (!last) return false;
	return !NESTED_NODE_MODULES.test(importer.slice(last.index + last[0].length));
}

export function zodSingleCopyPlugin(resolveDir = codingAgentDir) {
	return {
		name: "zod-single-copy",
		setup(build) {
			build.onResolve({ filter: /^zod(\/.*)?$/ }, async (args) => {
				if (args.pluginData === "zod-single-copy") return undefined;
				if (!isMcpSdkOwnModule(args.importer)) return undefined;
				const resolved = await build.resolve(args.path, { kind: args.kind, resolveDir, pluginData: "zod-single-copy" });
				if (resolved.errors.length > 0) return { errors: resolved.errors };
				return resolved;
			});
		},
	};
}
