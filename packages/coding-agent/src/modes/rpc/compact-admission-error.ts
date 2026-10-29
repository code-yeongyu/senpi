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
