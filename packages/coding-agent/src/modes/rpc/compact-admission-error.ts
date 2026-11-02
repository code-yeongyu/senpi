export interface UnknownAdmissionResponse {
	readonly id?: string;
	readonly type: "response";
	readonly command: string;
	readonly success: false;
	readonly error: "unknown_admission";
	readonly errorCode: "unknown_admission";
	readonly errorData: { readonly code: "unknown_admission"; readonly admissionId: string };
	readonly code: "unknown_admission";
	readonly admissionId: string;
}

export class CompactAdmissionError extends Error {
	readonly reason:
		| "malformed_request"
		| "admission_conflict"
		| "admission_retired"
		| "admission_limit"
		| "admission_busy"
		| "storage_unavailable";

	constructor(reason: CompactAdmissionError["reason"]) {
		super(reason);
		this.reason = reason;
		this.name = "CompactAdmissionError";
	}
}
