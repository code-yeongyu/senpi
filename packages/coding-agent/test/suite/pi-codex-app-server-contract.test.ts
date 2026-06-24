import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	APP_SERVER_SURFACE_INVENTORY,
	classifyAppServerSurface,
	createReviewerEvidencePacketTemplate,
	EXTERNAL_PROTOCOL_METHODS,
	OPAQUE_APP_SERVER_ENVELOPE_FIELDS,
	PI_CODEX_APP_SERVER_PROTOCOL_VERSION,
} from "../../src/core/extensions/builtin/pi-codex-app-server/protocol-core.ts";
import { PLAN_REQUIRED_APP_SERVER_SURFACES } from "../../src/core/extensions/builtin/pi-codex-app-server/protocol-required-surfaces.ts";

const extensionRoot = join(process.cwd(), "src", "core", "extensions", "builtin", "pi-codex-app-server");
const fixtureRoot = join(extensionRoot, "compatibility-fixtures");

describe("pi-codex-app-server contract lock", () => {
	it("locks the external protocol methods and opaque envelope fields", () => {
		const requiredMethods = [
			"initialize",
			"initialized",
			"session/new",
			"session/resume",
			"session/fork",
			"session/list",
			"session/read",
			"session/archive",
			"session/delete",
			"session/unsubscribe",
			"turn/start",
			"turn/steer",
			"turn/interrupt",
			"callback/respond",
			"callback/reject",
			"appServer/event",
			"appServer/request",
			"appServer/response",
			"lag",
			"disconnect",
			"resume",
		];
		const requiredFields = [
			"protocolVersion",
			"connectionId",
			"externalSessionId",
			"externalRequestId",
			"externalMessageId",
			"externalCallbackId",
			"appThreadId",
			"appSessionId",
			"appTurnId",
			"appItemId",
			"appRequestId",
			"sequence",
			"streamClass",
			"capabilityFlags",
			"originalMethod",
			"originalParams",
			"redactionClass",
		];

		const methodNames = EXTERNAL_PROTOCOL_METHODS.map((method) => method.name);
		const envelopeFields = OPAQUE_APP_SERVER_ENVELOPE_FIELDS.map((field) => field.name);

		expect(PI_CODEX_APP_SERVER_PROTOCOL_VERSION).toBe("2026-06-24.pr-001");
		expect(methodNames).toEqual(requiredMethods);
		expect(envelopeFields).toEqual(requiredFields);
		expect(EXTERNAL_PROTOCOL_METHODS.every((method) => method.errorBehavior.length > 0)).toBe(true);
	});

	it("classifies required app-server surfaces without callback, reconnect, or evidence-packet code", () => {
		const downstreamFileNames = [
			"server-request-bridge.ts",
			"reconnect-resume.ts",
			"redaction-scanner.ts",
			"evidence-packet-writer.ts",
		];

		const inventoryMethods = APP_SERVER_SURFACE_INVENTORY.map((entry) => entry.method);
		const missingSurfaces = PLAN_REQUIRED_APP_SERVER_SURFACES.filter((method) => !classifyAppServerSurface(method));
		const classifications = PLAN_REQUIRED_APP_SERVER_SURFACES.map((method) => classifyAppServerSurface(method));

		expect(inventoryMethods).toEqual(expect.arrayContaining([...PLAN_REQUIRED_APP_SERVER_SURFACES]));
		expect(missingSurfaces).toEqual([]);
		expect(classifications.map((classification) => classification?.relayClass)).not.toContain(undefined);
		for (const fileName of downstreamFileNames) {
			expect(existsSync(join(extensionRoot, fileName))).toBe(false);
		}
	});

	it("ships fixture folders and reviewer evidence packet templates", () => {
		const requiredDirectories = [
			"external_to_app",
			"app_to_external",
			"backpressure",
			"reconnect",
			"schema-snapshots",
			"evidence-packet-template",
		];

		const fixtureReadme = readFileSync(join(fixtureRoot, "README.md"), "utf-8");
		const snapshot = readFileSync(join(fixtureRoot, "schema-snapshots", "protocol-contract.json"), "utf-8");
		const packet = createReviewerEvidencePacketTemplate();

		for (const directory of requiredDirectories) {
			expect(readdirSync(join(fixtureRoot, directory)).length).toBeGreaterThan(0);
		}
		expect(fixtureReadme).toContain("App-server IDs remain authoritative");
		expect(JSON.parse(snapshot)).toMatchObject({
			protocolVersion: PI_CODEX_APP_SERVER_PROTOCOL_VERSION,
			externalMethods: EXTERNAL_PROTOCOL_METHODS.map((method) => method.name),
		});
		expect(packet.commandsFile).toContain("exact commands");
		expect(packet.cleanupReceipt).toContain("No runtime process");
		expect(packet.secretSafety).toContain("No raw secret-bearing");
	});
});
