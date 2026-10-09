import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";
import { breadcrumbBody, runTool, writeBreadcrumb } from "./moved-path-guard-fixtures.ts";

// code-yeongyu/senpi#2898 re-review H-new: a path the guard cannot resolve (EACCES, ENAMETOOLONG) is "not moved",
// and a breadcrumb that cannot be evaluated is untrusted. Neither may fail an ordinary tool call.

const guard = builtinExtensions.find((entry) => entry.id === "moved-path-guard");
const posixNonRoot = process.platform !== "win32" && process.getuid?.() !== 0;

const unknownTool: ExtensionFactory = (pi) =>
	pi.registerTool({
		name: "third_party_upload",
		label: "upload",
		description: "Uploads a blob.",
		parameters: Type.Object({ data: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "uploaded" }], details: {} }),
	});

describe.runIf(posixNonRoot)("moved-path-guard never fails a call it cannot evaluate (#2898)", () => {
	const roots: string[] = [];
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		for (const root of roots.splice(0)) {
			chmodSync(join(root, "locked"), 0o700);
			rmSync(root, { recursive: true, force: true });
		}
	});

	async function setup(cwdOf: (root: string) => string = (root) => root) {
		if (!guard) throw new Error("moved-path-guard is not registered");
		const root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-moved-failures-")));
		roots.push(root);
		mkdirSync(join(root, "locked", "inner"), { recursive: true });
		chmodSync(join(root, "locked"), 0o000);
		mkdirSync(join(root, "repo", "src"), { recursive: true });
		const harness = await createHarness({
			cwd: cwdOf(root),
			extensionFactories: [guard.factory, unknownTool],
			initialActiveToolNames: ["bash", "write", "third_party_upload"],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return { root, harness };
	}

	it("runs a command naming a path it may not search (EACCES)", async () => {
		const { root, harness } = await setup();

		const result = await runTool(harness, "bash", { command: `ls ${root}/locked/inner/foo 2>/dev/null; echo ran` });

		expect(result.outcome).toBe("ok");
		expect(result.text).toContain("ran");
	});

	it("runs a command and a third-party tool carrying a long base64 literal (ENAMETOOLONG)", async () => {
		const { harness } = await setup();
		const blob = `/9j/${"A".repeat(1700)}`;

		const bash = await runTool(harness, "bash", { command: `echo "${blob}" > /dev/null; echo ran` });
		const upload = await runTool(harness, "third_party_upload", { data: blob });

		expect(bash.outcome).toBe("ok");
		expect(upload.outcome).toBe("ok");
	});

	it("keeps write and bash working in a repo whose breadcrumb names an unreadable home and lists nothing used", async () => {
		const { root, harness } = await setup((dir) => join(dir, "repo"));
		writeBreadcrumb(join(root, "repo"), breadcrumbBody(join(root, "locked", "inner", "x"), ["nothing-listed"]));

		const write = await runTool(harness, "write", { path: join(root, "repo", "src", "a.ts"), content: "a" });
		const bash = await runTool(harness, "bash", { command: "echo hi > src/b.ts" });

		expect(write.outcome).toBe("ok");
		expect(bash.outcome).toBe("ok");
		expect(readFileSync(join(root, "repo", "src", "b.ts"), "utf8").trim()).toBe("hi");
	});
});
