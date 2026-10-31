/**
 * A provider-reported token count, or undefined when the provider sent none: absent, `null`, or not a finite number
 * all mean "not reported", never 0 (senpi#3879).
 */
export function reportedCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
