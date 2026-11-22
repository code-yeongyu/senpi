/** A command the host refused; `errorCode` carries the typed code when the command defines one. */
export class RpcCommandError extends Error {
	readonly errorCode: string | undefined;
	readonly errorData: unknown;

	constructor(message: string, errorCode: string | undefined, errorData: unknown) {
		super(message);
		this.name = "RpcCommandError";
		this.errorCode = errorCode;
		this.errorData = errorData;
	}
}
