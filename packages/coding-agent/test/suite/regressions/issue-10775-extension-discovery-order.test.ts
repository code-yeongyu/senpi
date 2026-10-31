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
