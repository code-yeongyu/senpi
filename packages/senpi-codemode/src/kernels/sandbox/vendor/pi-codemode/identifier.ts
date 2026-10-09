// Vendored from https://github.com/earendil-works/pi (packages/codemode/src) at v1.0.1, commit a7229ddc21810d6245105978033b7df645ecc2f7.
// MIT license; see LICENSE beside this file. Local changes are listed in VENDORED.md.
/**
 * The identifier a script uses for a tool: characters that are not valid in a JavaScript
 * identifier become `_`. `mcp__docs__search` stays as is, `my-tool` becomes `my_tool`.
 */
export function toCodemodeIdentifier(name: string): string {
	let identifier = "";
	for (const char of name) {
		const valid = identifier === "" ? /^[A-Za-z_$]$/.test(char) : /^[A-Za-z0-9_$]$/.test(char);
		identifier += valid ? char : "_";
	}
	return identifier === "" ? "_" : identifier;
}
