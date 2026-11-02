/** A typed failure a tool-child job reports to the server as `job_error{code}`. */
export class ToolChildJobError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
		this.name = "ToolChildJobError";
	}
}
