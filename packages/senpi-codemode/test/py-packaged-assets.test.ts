import { globSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// #5048: the CI sidecar, not npm's broader "src" files entry, owns this package contract.
it("ships every Python runtime sibling in the isolated Windows startup host", () => {
	const root = fileURLToPath(new URL("../../../", import.meta.url));
	const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
	const step = workflow.split("- name: Build isolated packaged Python host")[1]?.split("- name:")[0];
	expect(step).toBeDefined();
	const copy = step?.match(/Copy-Item (\S+) "\$sidecar[^"]*"/);
	expect(copy).not.toBeNull();
	if (!copy) throw new Error("Missing Python sidecar copy step");
	const selected = globSync(resolve(root, copy[1]))
		.map((path) => basename(path))
		.sort();
	const runtime = resolve(root, "packages/senpi-codemode/src/kernels/py/prelude.py");
	const required = readdirSync(dirname(runtime))
		.filter((name) => name.endsWith(".py"))
		.sort();
	expect(selected).toEqual(required);
});
