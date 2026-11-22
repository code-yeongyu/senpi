/**
 * #2465: `pi.getPermissionPreset()` reports the preset the permission system enforces for the
 * session, wherever it came from: the flag, settings alone, or the `full-access` default.
 */
import { afterEach, describe, expect, it } from "vitest";
import permissionSystemExtension from "../../../src/core/extensions/builtin/permission-system/index.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function presetOf(options: {
	readonly settings?: Record<string, unknown>;
	readonly flag?: string;
	readonly withPermissionSystem?: boolean;
}) {
	let api: ExtensionAPI | undefined;
	const harness = await createHarness({
		fileSettings: true,
		settings: options.settings ?? {},
		...(options.flag === undefined ? {} : { extensionFlagValues: new Map([["permission-preset", options.flag]]) }),
		extensionFactories: [
			...(options.withPermissionSystem === false ? [] : [permissionSystemExtension]),
			(pi: ExtensionAPI) => {
				api = pi;
			},
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ uiContext: createTestUiContext() });
	await harness
		.getExtensionRunner()
		.emit({ type: "session_start", reason: "startup" })
		.catch(() => undefined);
	if (!api) throw new Error("the probe extension did not load");
	return { api, harness };
}

describe("pi.getPermissionPreset() reports the enforced preset (#2465)", () => {
	it("is full-access when Full access is set in settings only, with no flag", async () => {
		const { api } = await presetOf({ settings: { permissionPreset: "full-access" } });
		expect(api.getPermissionPreset()).toBe("full-access");
	});

	it("is full-access by default, with no flag and no setting", async () => {
		const { api } = await presetOf({});
		expect(api.getPermissionPreset()).toBe("full-access");
	});

	it("is the stricter preset a setting names, with no flag", async () => {
		const { api } = await presetOf({ settings: { permissionPreset: "ask" } });
		expect(api.getPermissionPreset()).toBe("ask");
	});

	it("follows a preset flag changed on the live session before it is read", async () => {
		const { api, harness } = await presetOf({ flag: "workspace" });
		expect(api.getPermissionPreset()).toBe("workspace");
		harness.getExtensionRunner().setFlagValue("permission-preset", "read-only");
		expect(api.getPermissionPreset()).toBe("read-only");
	});

	it("is undefined when the permission setup failed", async () => {
		const { api } = await presetOf({ settings: { permissionPreset: "full-acess" } });
		expect(api.getPermissionPreset()).toBeUndefined();
	});

	it("is undefined when no permission system runs for the session", async () => {
		const { api } = await presetOf({ withPermissionSystem: false });
		expect(api.getPermissionPreset()).toBeUndefined();
	});
});
