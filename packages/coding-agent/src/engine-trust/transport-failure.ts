/**
 * The `trust` object a provider failure carries when the request failed TLS chain verification while
 * this engine runs on a fallback trust generation (omo#10762, design r13 6.6; senpi#5244). The code
 * comes only from the adapter's structured transport diagnostic, which reads the native error's
 * `code`, never message text. The object and its diagnostics record name no host, path or certificate.
 */
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isTlsChainVerificationCode, type ProviderDiagnostic } from "@earendil-works/pi-ai";
import { type EngineTrustActionId, engineTrustAction } from "./actions.ts";
import { adoptedEngineTrust } from "./adopted.ts";
import type { ENGINE_TRUST_FALLBACK_REASONS } from "./marker.ts";

type FallbackReason = (typeof ENGINE_TRUST_FALLBACK_REASONS)[number];

export interface TransportTrustFailure {
	readonly code: "trust-tls-failed-under-fallback";
	readonly reason: FallbackReason;
	readonly action: EngineTrustActionId;
}

/** Reasons this process already wrote a record for: one record per process and reason. */
const recordedReasons = new Set<FallbackReason>();

export function transportTrustFailure(diagnostic: ProviderDiagnostic | undefined): TransportTrustFailure | undefined {
	if (diagnostic?.evidence !== "structured_transport" || diagnostic.code === undefined) return undefined;
	if (!isTlsChainVerificationCode(diagnostic.code)) return undefined;
	const trust = adoptedEngineTrust();
	if (trust?.automatic !== "fallback" || trust.fallbackReason === null) return undefined;
	const reason = trust.fallbackReason;
	if (!recordedReasons.has(reason)) {
		recordedReasons.add(reason);
		appendDiagnosticsRecord(trust.file, {
			v: 1,
			at: new Date().toISOString(),
			pid: process.pid,
			generation: trust.sha256,
			codes: ["trust-tls-failed-under-fallback", reason],
		});
	}
	return { code: "trust-tls-failed-under-fallback", reason, action: engineTrustAction(reason).id };
}

/**
 * One line, in one append, to `diagnostics.jsonl` beside the generation file (design 5.3). A record
 * that cannot be written costs only the record: the failure still carries its `trust` object.
 */
function appendDiagnosticsRecord(generationFile: string, record: object): void {
	try {
		appendFileSync(join(dirname(generationFile), "diagnostics.jsonl"), `${JSON.stringify(record)}\n`, {
			mode: 0o600,
		});
	} catch {
		// The trust directory may be gone or read-only; the record is diagnostic only.
	}
}
