const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A deterministic, varied fake secret built at runtime, so no secret-shaped literal sits in the source for a
 * secret scanner to flag. The same seed always yields the same string.
 */
export function syntheticSecret(seed: number, length: number): string {
	let state = seed >>> 0 || 1;
	let out = "";
	for (let i = 0; i < length; i++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		out += ALPHABET[state % ALPHABET.length];
	}
	return out;
}
