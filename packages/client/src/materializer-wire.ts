import { MaterializerRefusal, type MaterializerIdentity } from "./materializer.ts";

export interface MaterializerSeed {
	readonly kind: "seed";
	readonly token: string;
	readonly sequence: number;
}
export interface MaterializerPayload {
	readonly kind: "event";
	readonly id: string;
	readonly admissionId: string;
	readonly sessionEpoch: string;
	readonly sequence: number;
	readonly componentRef: string;
	readonly length: number;
	readonly digest: string;
}
export interface MaterializerEnvelope extends MaterializerIdentity {
	readonly sequence: number;
	readonly controls: readonly MaterializerSeed[];
	readonly payload: MaterializerPayload;
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(v);
const invalid = (): never => {
	throw new MaterializerRefusal("invalid_unit");
};

/** Decode only the bounded header. The ingress owner enforces H before JSON decode and owns its reservation.
 * S15a frames remain accepted verbatim; selected S16 payloads stay under the shared S13 lease/page owner.
 */
export function parseMaterializerFrame(
	input: unknown,
):
	| { readonly kind: "legacy"; readonly frame: Record<string, unknown> }
	| { readonly kind: "unit"; readonly envelope: MaterializerEnvelope } {
	if (!object(input) || !id(input.sessionId) || !id(input.admissionId) || !count(input.generation)) return invalid();
	if (input.type === "materializer_control") throw new MaterializerRefusal("stray_control");
	if (input.materializer === undefined) return { kind: "legacy", frame: input };
	const m = input.materializer;
	if (
		!object(m) ||
		!id(m.sessionEpoch) ||
		!count(m.sequence) ||
		m.sequence === 0 ||
		m.generation !== input.generation ||
		!Array.isArray(m.controls) ||
		m.controls.length > 1
	)
		return invalid();
	const controls: MaterializerSeed[] = [];
	for (const c of m.controls) {
		if (!object(c) || c.kind !== "seed" || !id(c.token) || !count(c.sequence) || c.sequence >= m.sequence)
			return invalid();
		controls.push({ kind: "seed", token: c.token, sequence: c.sequence });
	}
	const p = m.payload;
	if (
		!object(p) ||
		p.kind !== "event" ||
		!id(p.id) ||
		!id(p.admissionId) ||
		p.sessionEpoch !== m.sessionEpoch ||
		p.sequence !== m.sequence ||
		!id(p.componentRef) ||
		!count(p.length) ||
		typeof p.digest !== "string" ||
		!/^[0-9a-f]{64}$/.test(p.digest)
	)
		return invalid();
	return {
		kind: "unit",
		envelope: {
			sessionId: input.sessionId,
			sessionEpoch: m.sessionEpoch,
			generation: input.generation,
			sequence: m.sequence,
			controls,
			payload: {
				kind: "event",
				id: p.id,
				admissionId: p.admissionId,
				sessionEpoch: m.sessionEpoch,
				sequence: m.sequence,
				componentRef: p.componentRef,
				length: p.length,
				digest: p.digest,
			},
		},
	};
}
