import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const command = `printf '%s' "\${OMO_BROWSER_ENGINE-unset}"`;

describe("core bash browser engine environment (#2611)", () => {
	let harness: Harness;
	beforeEach(async () => {
		vi.stubEnv("OMO_BROWSER_ENGINE", "connected");
		harness = await createHarness({ extensionFactories: [() => {}] });
		await harness.session.bindExtensions({});
	});
	afterEach(() => {
		harness.cleanup();
		vi.unstubAllEnvs();
	});

	function run(browserEngine: "connected" | "builtin" | "none" | undefined) {
		const ctx = harness.getExtensionRunner().createContext();
		const tool = createBashToolDefinition(harness.tempDir);
		return tool.execute("engine", { command }, undefined, undefined, {
			...ctx,
			browserEngine,
		} as ExtensionToolContext);
	}

	it.each(["connected", "builtin", "none"] as const)("gives a shell child the session's %s engine", async (engine) => {
		expect(getMessageText(await run(engine))).toBe(engine);
	});

	it("replaces an inherited process-wide value with the session's own choice", async () => {
		expect(getMessageText(await run("builtin"))).toBe("builtin");
	});

	it("clears an inherited process-wide value for a session that chose no engine", async () => {
		expect(getMessageText(await run(undefined))).toBe("unset");
	});
});
