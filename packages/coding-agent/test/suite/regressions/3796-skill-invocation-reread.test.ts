// #3796: an invocation must reauthorize bytes even after discovery succeeded.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, getMessageText } from "../harness.ts";

it("does not feed an escaped replacement to the provider on skill invocation", async () => {
	const root = mkdtempSync(join(tmpdir(), "senpi-3796-invoke-"));
	vi.stubEnv("HOME", root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const dir = join(cwd, ".senpi", "skills", "carrier");
	mkdirSync(dir, { recursive: true });
	mkdirSync(join(cwd, ".git"));
	mkdirSync(agentDir);
	const path = join(dir, "SKILL.md");
	writeFileSync(path, "---\nname: carrier\ndescription: synthetic\n---\nsafe\n");
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	let cleanup = () => {};
	try {
		await loader.reload();
		const discovered = loader.getSkills();
		expect(discovered.skills.some((skill) => skill.name === "carrier")).toBe(true);
		const resourceLoader = { ...createTestResourceLoader(), getSkills: () => discovered };
		const harness = await createHarness({ cwd, resourceLoader });
		cleanup = harness.cleanup;
		const outside = join(root, "outside.md");
		writeFileSync(outside, "SYNTHETIC_OUTSIDE_BODY");
		unlinkSync(path);
		symlinkSync(outside, path);
		let submitted = "";
		harness.setResponses([
			(context) => {
				submitted = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("please use $skill:carrier");
		expect(submitted).not.toContain("SYNTHETIC_OUTSIDE_BODY");
	} finally {
		cleanup();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});
