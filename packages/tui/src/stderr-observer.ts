/** Observe a stream without taking ownership of any later writer installed above it. */
export function observeProcessStderrWrites(listener: () => void): () => void {
	const original = process.stderr.write;
	const observed: typeof process.stderr.write = function (this: NodeJS.WriteStream, ...args) {
		listener();
		return Reflect.apply(original, this, args);
	};
	process.stderr.write = observed;
	return () => {
		if (process.stderr.write === observed) process.stderr.write = original;
	};
}
