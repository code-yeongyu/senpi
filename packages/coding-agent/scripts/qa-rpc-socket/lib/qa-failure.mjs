/** A QA failure with a machine-readable code (`record_timeout`, `prerequisite_missing`, ...). */
export class QaFailure extends Error {
	constructor(code, message = code, detail = undefined) {
		super(`${code}: ${message}`);
		this.name = "QaFailure";
		this.code = code;
		this.detail = detail;
	}
}

/** Driver exit codes: 0 pass, 1 failed assertion/timeout, 2 usage or unknown scenario, 3 prerequisite missing. */
export const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2, prerequisite: 3 });
