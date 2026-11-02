import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { registerCursorCliOauthExtension } from "../../src/core/extensions/builtin/cursor-cli-oauth/index.ts";
import type { CursorCliOauthProviderSettings } from "../../src/core/extensions/builtin/cursor-cli-oauth/settings.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { ProviderConfigInput } from "../../src/core/provider-composer.ts";

function settings(overrides: Partial<CursorCliOauthProviderSettings> = {}): CursorCliOauthProviderSettings {
	return {
		enabled: true,
		explicitlyDisabled: false,
		executablePath: undefined,
		forceExecution: true,
		noApprovalAcknowledgedAt: undefined,
		executionMode: "agent",
		resumeMode: "auto",
		pinnedAccount: undefined,
		contextRecapOnModelSwitch: true,
		modelCatalogTtlHours: 24,
		sandboxMode: undefined,
		...overrides,
	};
}

function registeredEligibility(current: CursorCliOauthProviderSettings): boolean | undefined {
	let captured: ProviderConfigInput | undefined;
	const pi = {
		registerProvider: (_name: string, config: ProviderConfigInput) => {
			captured = config;
		},
		registerCommand: () => {},
		on: () => {},
	} as unknown as ExtensionAPI;
	registerCursorCliOauthExtension(pi, {
		cwd: "/tmp",
		agentDir: "/tmp",
		store: new InMemoryCredentialStore(),
		loadSettings: () => current,
		resolveExecutable: () => "/usr/bin/false",
	});
	if (!captured) throw new Error("extension did not register a provider");
	return captured.fallbackEligible?.();
}

describe("cursor-cli-oauth fallback eligibility", () => {
	it("declares the lane ineligible while the unacknowledged --force gate guarantees a refusal", () => {
		expect(registeredEligibility(settings())).toBe(false);
	});

	it("declares the lane eligible once the acknowledgement is persisted", () => {
		expect(registeredEligibility(settings({ noApprovalAcknowledgedAt: "2026-08-19T00:00:00.000Z" }))).toBe(true);
	});

	it("declares the lane eligible in plan mode, which never forces", () => {
		expect(registeredEligibility(settings({ executionMode: "plan" }))).toBe(true);
	});

	it("declares the lane eligible when force execution is disabled", () => {
		expect(registeredEligibility(settings({ forceExecution: false }))).toBe(true);
	});

	it("declares the lane ineligible under the verbatim enabled:false kill switch", () => {
		expect(
			registeredEligibility(
				settings({
					enabled: false,
					explicitlyDisabled: true,
					noApprovalAcknowledgedAt: "2026-08-19T00:00:00.000Z",
				}),
			),
		).toBe(false);
	});

	it("keeps a merely flagless lane eligible - an explicit login is the opt-in", () => {
		expect(
			registeredEligibility(settings({ enabled: false, noApprovalAcknowledgedAt: "2026-08-19T00:00:00.000Z" })),
		).toBe(true);
	});
});
