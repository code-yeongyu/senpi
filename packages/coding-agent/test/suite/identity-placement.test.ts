import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createHarness } from "./harness.ts";

it.each(["in-process", "child"] as const)("file effects and shell output on the %s runtime", async (toolRuntime) => {
	const cwd = mkdtempSync(join(tmpdir(), "identity-placement-"));
	vi.stubEnv("HOME", cwd);
	const secret = "Q".repeat(43);
	const path = join(cwd, ".omo/device-identity.json");
	mkdirSync(join(cwd, ".omo"));
	writeFileSync(path, JSON.stringify({ signing: secret, message: "fixture" }));
	symlinkSync(path, join(cwd, "alias"));
	linkSync(path, join(cwd, "hard"));
	writeFileSync(join(cwd, "notes"), "ordinary");
	const h = await createHarness({ cwd, toolRuntime });
	try {
		await h.session.bindExtensions({});
		const result = await h.session.executeTool("read", { path: "notes" });
		expect(result.content.some((c) => c.type === "text" && c.text.includes("ordinary"))).toBe(true);
		for (const alias of ["alias", "hard", ".omo/../.omo/device-identity.json"]) {
			for (const [name, params] of [
				["read", { path: alias }],
				["edit", { path: alias, edits: [{ oldText: "fixture", newText: "changed" }] }],
			] as const) {
				const denied = await h.session.executeTool(name, params).then(
					(r) => r.content.some((c) => c.type === "text" && c.text.includes("IDENTITY_FILE_REFUSED")),
					(e: unknown) => String(e).includes("IDENTITY_FILE_REFUSED"),
				);
				expect(denied, `${toolRuntime}: ${name} ${alias}`).toBe(true);
			}
		}
		const shell = await h.session.executeTool("bash", { command: "cat .omo/device-identity.json" });
		const clean = JSON.stringify(shell);
		expect(!clean.includes(secret) && clean.includes("[REDACTED]") && clean.includes("fixture")).toBe(true);
	} finally {
		h.cleanup();
		await h.session.whenToolChildClosed();
		vi.unstubAllEnvs();
		rmSync(cwd, { recursive: true, force: true });
	}
});
