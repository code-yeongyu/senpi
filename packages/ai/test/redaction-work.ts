// Count the scanner's character reads rather than scheduling/GC time. No production instrumentation is needed:
// every lexer/classifier walk reads via charCodeAt. The source guard separately excludes backtracking regexes.
export function characterReads(run: () => void): number {
	const original = String.prototype.charCodeAt;
	let reads = 0;
	Object.defineProperty(String.prototype, "charCodeAt", {
		configurable: true,
		writable: true,
		value(this: string, index: number): number {
			reads++;
			return original.call(this, index);
		},
	});
	try {
		run();
		return reads;
	} finally {
		Object.defineProperty(String.prototype, "charCodeAt", {
			configurable: true,
			writable: true,
			value: original,
		});
	}
}
