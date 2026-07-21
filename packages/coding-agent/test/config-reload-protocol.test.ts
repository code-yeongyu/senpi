import { describe, expect, it } from "vitest";

import {
	type ConfigWatchRegistration,
	configWatchChannels,
	isConfigWatchChanged,
	isConfigWatchRegistration,
	isConfigWatchRejected,
	isConfigWatchReloaded,
	isConfigWatchValidation,
	matchesConfigWatchFilter,
	resolveConfigWatchRegistrations,
} from "../src/core/extensions/builtin/config-reload/protocol.ts";

describe("config-watch protocol", () => {
	const registration: ConfigWatchRegistration = {
		id: "omo",
		displayName: ".omo config",
		targets: [
			{ path: "/workspace/.omo", kind: "dir", filterGlobs: ["omo.json", "omo.jsonc"] },
			{ path: "/workspace/.omo/omo.json", kind: "file" },
		],
		validate: (changedPaths) => (changedPaths.length > 0 ? { ok: true } : { ok: false, errors: [] }),
	};

	it("accepts valid registration and lifecycle payloads", () => {
		expect(isConfigWatchRegistration(registration)).toBe(true);
		expect(isConfigWatchValidation({ ok: true })).toBe(true);
		expect(isConfigWatchValidation({ ok: false, errors: ["invalid config"] })).toBe(true);
		expect(isConfigWatchChanged({ registrationId: "omo", paths: ["/workspace/.omo/omo.json"], deferred: true })).toBe(
			true,
		);
		expect(isConfigWatchReloaded({ registrationId: "omo", paths: ["/workspace/.omo/omo.json"] })).toBe(true);
		expect(
			isConfigWatchRejected({
				registrationId: "omo",
				paths: ["/workspace/.omo/omo.json"],
				errors: ["invalid config"],
			}),
		).toBe(true);
	});

	it("rejects malformed unknown event payloads", () => {
		expect(isConfigWatchRegistration({ displayName: ".omo config", targets: [] })).toBe(false);
		expect(isConfigWatchRegistration({ id: "omo", displayName: ".omo config", targets: {} })).toBe(false);
		expect(
			isConfigWatchRegistration({
				id: "omo",
				displayName: ".omo config",
				targets: [],
				validate: "not a callback",
			}),
		).toBe(false);
		expect(isConfigWatchValidation({ ok: false, errors: [1] })).toBe(false);
		expect(isConfigWatchChanged({ registrationId: "omo", paths: "not an array", deferred: false })).toBe(false);
		expect(isConfigWatchRejected({ registrationId: "omo", paths: [], errors: "not an array" })).toBe(false);
	});

	it("matches filename and suffix filters without a glob dependency", () => {
		expect(matchesConfigWatchFilter("/workspace/.omo/omo.json", ["omo.json", "omo.jsonc"])).toBe(true);
		expect(matchesConfigWatchFilter("/workspace/.omo/omo.jsonc", ["omo.json", "omo.jsonc"])).toBe(true);
		expect(matchesConfigWatchFilter("/workspace/.omo/other.json", ["omo.json", "omo.jsonc"])).toBe(false);
		expect(matchesConfigWatchFilter("/workspace/.omo/settings.json", ["*.json"])).toBe(true);
	});

	it("uses the registration id as a last-wins key", () => {
		const replacement: ConfigWatchRegistration = {
			...registration,
			displayName: "replacement .omo config",
		};

		const registrations = resolveConfigWatchRegistrations([registration, replacement]);

		expect(registrations).toHaveLength(1);
		expect(registrations[0]).toBe(replacement);
	});

	it("publishes the six config-watch channels", () => {
		expect(configWatchChannels).toEqual({
			register: "config-watch:register",
			unregister: "config-watch:unregister",
			ready: "config-watch:ready",
			changed: "config-watch:changed",
			reloaded: "config-watch:reloaded",
			rejected: "config-watch:rejected",
		});
	});
});
