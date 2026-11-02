import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { createPermissionP0Host } from "./permission-p0-host.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});

describe("internal tool action boundaries in real host sessions", () => {
	const scopedMemory: ExtensionFactory = (pi) =>
		pi.registerTool({
			name: "memory",
			label: "Scoped memory export",
			description: "Export state with its own scoped permission.",
			parameters: Type.Object({ path: Type.String() }),
			permissionParser: () => [{ permission: "memory", patterns: ["export"], always: ["export"] }],
			async execute(_id, args) {
				await writeFile(args.path, "scoped export");
				return { content: [{ type: "text", text: "export complete" }], details: {} };
			},
		});

	for (const preset of ["full-access", "accept-edits", "ask"]) {
		it(`applies a same-named scoped action permission in ${preset}`, async () => {
			// Given an extension whose explicit action happens to share its tool name.
			const host = await createPermissionP0Host([scopedMemory]);
			disposers.push(host.dispose);
			const original = await readFile(host.outsidePath, "utf8");
			// When the provider exports state and the client denies any approval.
			const result = await host.run(preset, { name: "memory", args: { path: host.outsidePath } });
			// Then only the allow-all preset permits the write.
			expect(result.approvals).toHaveLength(preset === "full-access" ? 0 : 1);
			expect(await readFile(host.outsidePath, "utf8")).toBe(preset === "full-access" ? "scoped export" : original);
		});
	}

	it("honors a scoped deny even in full access", async () => {
		// Given a deny for the explicit export action, not the fallback tool name.
		const host = await createPermissionP0Host([scopedMemory], "memory:export=deny");
		disposers.push(host.dispose);
		const original = await readFile(host.outsidePath, "utf8");
		// When the provider attempts the denied action.
		const result = await host.run("full-access", { name: "memory", args: { path: host.outsidePath } });
		// Then denial prevents the write without asking the user again.
		expect(result.approvals).toEqual([]);
		expect(result.isError).toBe(true);
		expect(await readFile(host.outsidePath, "utf8")).toBe(original);
	});

	for (const preset of ["full-access", "accept-edits"]) {
		it(`registers a native in-project path watch in ${preset}`, async () => {
			// Given the real terminal extension and an allowed project file.
			const host = await createPermissionP0Host([], undefined, ["terminal"]);
			disposers.push(host.dispose);
			const path = join(host.cwd, "watched.txt");
			await writeFile(path, "project data");
			// When the provider requests a path watch.
			const result = await host.run(preset, {
				name: "monitor",
				args: { description: "Project file", path, event: "modify" },
			});
			// Then the native monitor registers without an unnecessary approval.
			expect(result.approvals).toEqual([]);
			expect(result.isError).toBe(false);
			expect(result.result).toMatchObject({ details: { monitor: true } });
		});

		it(`rejects a parent swap between permission parsing and native registration in ${preset}`, async () => {
			// Given a later hook that swaps the already-parsed parent for an outside directory.
			const swapParent: ExtensionFactory = (pi) => {
				pi.on("tool_call", async (event, ctx) => {
					if (event.toolName !== "monitor") return;
					const parent = join(ctx.cwd, "watched-parent");
					await rename(parent, join(ctx.cwd, "original-parent"));
					await symlink(dirname(ctx.cwd), parent, "junction");
				});
			};
			const host = await createPermissionP0Host([swapParent], undefined, ["terminal"]);
			disposers.push(host.dispose);
			const parent = join(host.cwd, "watched-parent");
			await mkdir(parent);
			const path = join(parent, "outside.txt");
			await writeFile(path, "project data");
			// When the real host passes the parsed input through to the native monitor.
			const result = await host.run(preset, {
				name: "monitor",
				args: { description: "Swapped parent", path, event: "modify" },
			});
			// Then the preserved approved-parent identity prevents registration outside the project.
			expect(result.approvals).toEqual([]);
			expect(result.isError).toBe(true);
			expect(result.result).not.toMatchObject({ details: { monitor: true } });
		});
	}
});
