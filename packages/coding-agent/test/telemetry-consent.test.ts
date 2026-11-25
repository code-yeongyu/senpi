import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { mergeProviderAttributionHeaders } from "../src/core/provider-attribution.ts";
import {
	openingCallersPermit,
	SessionTelemetryCallers,
	TELEMETRY_CONSENTS,
	telemetryPermitted,
} from "../src/core/telemetry-consent.ts";

describe("telemetryPermitted", () => {
	it("permits only when the host and the callers both permit", () => {
		const table = [true, false].flatMap((host) =>
			[true, false].map((callers) => [host, callers, telemetryPermitted(host, callers)]),
		);

		expect(table).toEqual([
			[true, true, true],
			[true, false, false],
			[false, true, false],
			[false, false, false],
		]);
	});
});

describe("SessionTelemetryCallers", () => {
	it("permits a wire-opened session only on an explicit grant", () => {
		const permits = TELEMETRY_CONSENTS.map((consent) => [consent, openingCallersPermit(consent)]);

		expect(permits).toEqual([
			["granted", true],
			["declined", false],
			["unanswered", false],
		]);
		expect(openingCallersPermit(undefined)).toBe(true);
	});

	it("lets any attached caller that has not granted hold the session off, and releases it when that caller leaves", () => {
		const callers = new SessionTelemetryCallers("host");
		callers.attach("desktop", "unanswered");
		const whileAttached = callers.permit();

		callers.leave("desktop");

		expect([whileAttached, callers.permit(), callers.standingConsent()]).toEqual([false, true, undefined]);
	});

	it("keeps an opener's revocation as the session's standing answer after the opener leaves", () => {
		const callers = new SessionTelemetryCallers("granted");
		callers.answer("desktop", "granted");
		callers.answer("desktop", "declined");

		callers.leave("desktop");

		expect([callers.permit(), callers.standingConsent()]).toEqual([false, "declined"]);
	});

	it("leaves the standing answer alone when a caller only attaches and leaves", () => {
		const callers = new SessionTelemetryCallers("granted");
		callers.attach("desktop", "declined");

		callers.leave("desktop");

		expect([callers.permit(), callers.standingConsent()]).toEqual([true, "granted"]);
	});

	it("never lets one caller's grant override another live caller's decline", () => {
		const callers = new SessionTelemetryCallers("granted");
		callers.answer("cli", "declined");

		callers.answer("desktop", "granted");

		expect(callers.permit()).toBe(false);
	});
});

describe("mergeProviderAttributionHeaders", () => {
	it("attributes a request only when the session's telemetry is permitted", () => {
		const model = getModel("openrouter", "openai/gpt-4o");
		if (model === undefined) throw new Error("catalog has no openrouter model");

		const permitted = mergeProviderAttributionHeaders(model, true, undefined);
		const refused = mergeProviderAttributionHeaders(model, false, undefined);

		expect(permitted?.["X-OpenRouter-Title"]).toBeDefined();
		expect(refused).toBeUndefined();
	});
});
