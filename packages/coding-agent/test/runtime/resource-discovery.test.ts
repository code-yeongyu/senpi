// senpi#5223 (RT2, brain/hand split): resource discovery runs on an extension runner without a session and
// returns what it returns in a session. Guards the F18 discovery surface.
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { type ExtensionAPI, type ExtensionContext, ExtensionRunner } from "../../src/core/extensions/index.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { createTestExtensionsResult } from "../utilities.ts";

const contexts: ExtensionContext[] = [];

function discoveryExtension(pi: ExtensionAPI): void {
	pi.on("resources_discover", (event, ctx) => {
		contexts.push(ctx);
		return {
			skillPaths: [`${event.cwd}/skills/a`, { path: `${event.cwd}/skills/b`, scope: "project" as const }],
			promptPaths: [`${ctx.cwd}/prompts/p`],
			themePaths: [`${event.cwd}/themes/t`],
			hookPaths: [`${event.cwd}/hooks/h`],
		};
	});
}

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
	contexts.length = 0;
});

describe("resource discovery without a session (senpi#5223)", () => {
	it("returns the entries a session runner returns, with the runtime context", async () => {
		harness = await createHarness({ extensionFactories: [discoveryExtension] });
		const fromSession = await harness.getExtensionRunner().emitResourcesDiscover(harness.tempDir, "startup");
		contexts.length = 0;

		const extensionsResult = await createTestExtensionsResult([discoveryExtension], harness.tempDir);
		const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			harness.tempDir,
			undefined,
			modelRegistry,
		);
		const withoutSession = await runner.emitResourcesDiscover(harness.tempDir, "startup");

		const strip = (entries: typeof fromSession) =>
			Object.fromEntries(
				Object.entries(entries).map(([kind, list]) => [kind, list.map(({ path, scope }) => ({ path, scope }))]),
			);
		expect(strip(withoutSession)).toEqual(strip(fromSession));
		expect(withoutSession.skillPaths).toHaveLength(2);
		expect(contexts).toHaveLength(1);
		expect(contexts[0]?.cwd).toBe(harness.tempDir);
		expect(contexts[0] !== undefined && "sessionManager" in contexts[0]).toBe(false);
		expect(() => contexts[0]?.model).toThrow("model is loop-side and not bound");
	});
});
