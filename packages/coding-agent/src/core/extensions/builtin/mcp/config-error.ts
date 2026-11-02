export class McpConfigValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpConfigValidationError";
	}
}
