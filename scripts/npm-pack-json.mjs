export function parseNpmPackJson(output) {
	for (let index = output.indexOf("["); index !== -1; index = output.indexOf("[", index + 1)) {
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let cursor = index; cursor < output.length; cursor += 1) {
			const character = output[cursor];
			if (inString) {
				if (escaped) {
					escaped = false;
				} else if (character === "\\") {
					escaped = true;
				} else if (character === '"') {
					inString = false;
				}
				continue;
			}
			if (character === '"') {
				inString = true;
			} else if (character === "[") {
				depth += 1;
			} else if (character === "]") {
				depth -= 1;
				if (depth === 0) {
					try {
						const parsed = JSON.parse(output.slice(index, cursor + 1));
						if (Array.isArray(parsed)) {
							return parsed;
						}
					} catch {
						break;
					}
				}
			}
		}
	}
	throw new Error("npm pack --json did not return a JSON array");
}
