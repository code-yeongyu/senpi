export class GateInputError extends Error {
	readonly name = "GateInputError";
	readonly input: string;
	constructor(input: string) {
		super(`Invalid gate input: ${input}`);
		this.input = input;
	}
}
