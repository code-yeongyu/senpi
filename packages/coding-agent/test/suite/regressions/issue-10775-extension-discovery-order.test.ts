import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { discoverAndLoadExtensions } from "../../../src/core/extensions/loader.ts";

const directoryOrder = vi.hoisted(() => ({ directory: "", reverse: false }));

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs")>();
	return {
		...original,
		readdirSync: (...args: Parameters<typeof original.readdirSync>) => {
			const entries = original.readdirSync(...args);
			if (args[0].toString() !== directoryOrder.directory) return entries;
			entries.sort((a, b) => a.name.toString().localeCompare(b.name.toString()));
			return directoryOrder.reverse ? entries.reverse() : entries;
		},
	};
});

let root: string | undefined;
afterEach(() => {
	if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
	directoryOrder.directory = "";
});

it.each(["node", "bun"])("%s loads direct .mjs and .mts extensions from the user directory (#4049)", (runtime) => {
	root = fs.mkdtempSync(join(tmpdir(), "esm-extension-discovery-"));
	const dir = join(root, "extensions");
	fs.mkdirSync(dir);
	for (const name of ["alpha.mjs", "beta.mts"]) {
		fs.writeFileSync(join(dir, name), "export default function() {}");
	}
	const unsupported = join(dir, "legacy.cjs");
	fs.writeFileSync(unsupported, "throw new Error('must not execute');");
	// Bun's virtual extension namespace is resolved by its native module loader, not Vitest's.
	const loader = new URL("../../../src/core/extensions/loader.ts", import.meta.url).href;
	const script = `
		import { discoverAndLoadExtensions } from ${JSON.stringify(loader)};
		import { basename } from "node:path";
		const dir = ${JSON.stringify(root)};
		const { errors, warnings, extensions } = await discoverAndLoadExtensions([], dir, dir);
		console.log(JSON.stringify({ errors, warnings, names: extensions.map(e => basename(e.path)) }));`;
	const args = runtime === "node" ? ["--import", "tsx", "--input-type=module", "-e", script] : ["-e", script];
	const loaded = JSON.parse(execFileSync(runtime, args, { encoding: "utf8", timeout: 20_000 }));
	expect(loaded.errors).toEqual([]);
	expect(loaded.warnings).toEqual([
		{ path: unsupported, warning: expect.stringContaining(".ts, .js, .mts, or .mjs") },
	]);
	expect(loaded.names).toEqual(["alpha.mjs", "beta.mts"]);
});

it("keeps contributor registration order when directory enumeration changes", async () => {
	root = fs.mkdtempSync(join(tmpdir(), "prefix-extension-order-"));
	directoryOrder.directory = join(root, "extensions");
	fs.mkdirSync(directoryOrder.directory);
	for (const name of ["alpha", "zebra"]) {
		fs.writeFileSync(join(directoryOrder.directory, `${name}.ts`), "export default function() {}");
	}
	directoryOrder.reverse = false;
	const first = await discoverAndLoadExtensions([], root, root);
	directoryOrder.reverse = true;
	const second = await discoverAndLoadExtensions([], root, root);
	expect(first.errors).toEqual([]);
	expect(second.errors).toEqual([]);
	expect(second.extensions.map((extension) => basename(extension.path))).toEqual(
		first.extensions.map((extension) => basename(extension.path)),
	);
});
