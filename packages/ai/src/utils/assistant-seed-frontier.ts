export class SeedFrontierError extends Error {
	readonly code: "missing_next_offset" | "invalid_next_offset";

	constructor(nextOffset: number | undefined) {
		super("Block seed requires nextOffset equal to zero or its full UTF-16 length");
		this.name = "SeedFrontierError";
		this.code = nextOffset === undefined ? "missing_next_offset" : "invalid_next_offset";
	}
}

/** No inference at a consumer: only full replay or full continuation is supported. */
export function seedNextOffset(nextOffset: number | undefined, seedLength: number): number {
	if (nextOffset === undefined || !Number.isSafeInteger(nextOffset) || (nextOffset !== 0 && nextOffset !== seedLength))
		throw new SeedFrontierError(nextOffset);
	return nextOffset;
}
