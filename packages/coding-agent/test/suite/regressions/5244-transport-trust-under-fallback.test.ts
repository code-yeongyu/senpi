import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { transportProviderDiagnosticFromError } from "../../../../ai/src/utils/provider-diagnostic-sources.ts";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { type EngineTrustMarker, recordAdoptedEngineTrust } from "../../../src/engine-trust/index.ts";
import { serverMarker } from "../engine-trust-fixtures.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#5244 (omo#10762 design 6.6): a provider request that fails TLS chain verification while the engine runs
// on a fallback trust generation carries `agent_end.failure.trust` with the fallback reason and its catalog
// action, and the engine trust diagnostics record gets one entry per process and reason. Hostname mismatch,
// expiry, plain network failures and a complete ("os") generation never do. The code is read from the
// synthetic transport error's structured `code`, the way the provider adapters classify it.

const TLS_CHAIN_CODES = [
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_GET_ISSUER_CERT",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"CERT_UNTRUSTED",
] as const;

const HOST = "tls.corp.example.test";
const PEM_MARK = "BEGIN CERTIFICATE";

/** A failed turn whose diagnostic the transport classifier minted from a synthetic handshake error. */
function transportFailure(code: string): AssistantMessage {
	const handshake = Object.assign(new Error(`certificate verify failed for ${HOST}`), { code });
	const providerDiagnostic = transportProviderDiagnosticFromError(
		new Error("Connection error.", { cause: new TypeError("fetch failed", { cause: handshake }) }),
	);
	const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: `Connection error. (${HOST})` });
	return providerDiagnostic === undefined ? message : { ...message, providerDiagnostic };
}

describe("transport trust under a fallback generation (#5244)", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	/** Adopt a generation living in a fresh temporary trust directory; returns that directory. */
	function adopt(patch: Pick<EngineTrustMarker, "automatic" | "fallbackReason">): string {
		const dir = mkdtempSync(join(tmpdir(), "senpi-5244-"));
		dirs.push(dir);
		recordAdoptedEngineTrust({ ...serverMarker, ...patch, file: join(dir, `${serverMarker.sha256}.pem`) });
		return dir;
	}

	async function agentEnds(
		responses: AssistantMessage[],
	): Promise<Extract<AgentSessionEvent, { type: "agent_end" }>[]> {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses(responses);
		for (let turn = 0; turn < responses.length; turn++) await harness.session.prompt("go");
		return harness.eventsOfType("agent_end");
	}

	function records(dir: string): unknown[] {
		const file = join(dir, "diagnostics.jsonl");
		if (!existsSync(file)) return [];
		return readFileSync(file, "utf8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line));
	}

	it.each(TLS_CHAIN_CODES)("attaches the trust object to a %s failure", async (code) => {
		adopt({ automatic: "fallback", fallbackReason: "helper-missing" });
		const [end] = await agentEnds([transportFailure(code)]);
		expect(end?.failure).toMatchObject({ category: "network", code });
		expect(end?.failure?.trust).toEqual({
			code: "trust-tls-failed-under-fallback",
			reason: "helper-missing",
			action: "reinstall-omo",
		});
	});

	it.each([
		["hostname mismatch", "ERR_TLS_CERT_ALTNAME_INVALID"],
		["expiry", "CERT_HAS_EXPIRED"],
		["network", "ECONNRESET"],
	])("never attaches it to a %s failure (%s) or records one", async (_kind, code) => {
		const dir = adopt({ automatic: "fallback", fallbackReason: "linux-bundle-unreadable" });
		const [end] = await agentEnds([transportFailure(code)]);
		expect(end?.failure).toBeDefined();
		expect(end?.failure).not.toHaveProperty("trust");
		expect(records(dir)).toEqual([]);
	});

	it("never attaches it under a complete os generation", async () => {
		const dir = adopt({ automatic: "os", fallbackReason: null });
		const ends = await agentEnds(TLS_CHAIN_CODES.map(transportFailure));
		expect(ends).toHaveLength(TLS_CHAIN_CODES.length);
		for (const end of ends) expect(end.failure).not.toHaveProperty("trust");
		expect(records(dir)).toEqual([]);
	});

	it("writes one diagnostics record per process and reason, holding no host, path or certificate", async () => {
		const first = adopt({ automatic: "fallback", fallbackReason: "helper-timeout" });
		const timeouts = await agentEnds([
			transportFailure("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"),
			transportFailure("SELF_SIGNED_CERT_IN_CHAIN"),
		]);
		for (const end of timeouts) {
			expect(end.failure?.trust).toEqual({
				code: "trust-tls-failed-under-fallback",
				reason: "helper-timeout",
				action: "retry-after-store-ready",
			});
		}
		expect(records(first)).toEqual([
			expect.objectContaining({
				v: 1,
				pid: process.pid,
				generation: serverMarker.sha256,
				codes: ["trust-tls-failed-under-fallback", "helper-timeout"],
			}),
		]);
		if (process.platform !== "win32") expect(statSync(join(first, "diagnostics.jsonl")).mode & 0o777).toBe(0o600);

		const second = adopt({ automatic: "fallback", fallbackReason: "access-denied" });
		const [denied] = await agentEnds([transportFailure("CERT_UNTRUSTED"), transportFailure("CERT_UNTRUSTED")]);
		expect(denied?.failure?.trust).toMatchObject({ reason: "access-denied", action: "check-store-access" });
		expect(records(second)).toEqual([
			expect.objectContaining({ codes: ["trust-tls-failed-under-fallback", "access-denied"] }),
		]);

		const written = [
			JSON.stringify(timeouts.map((end) => end.failure?.trust)),
			JSON.stringify(denied?.failure?.trust),
			readFileSync(join(first, "diagnostics.jsonl"), "utf8"),
			readFileSync(join(second, "diagnostics.jsonl"), "utf8"),
		].join("\n");
		for (const forbidden of [HOST, first, second, tmpdir(), PEM_MARK]) expect(written).not.toContain(forbidden);
	});
});
