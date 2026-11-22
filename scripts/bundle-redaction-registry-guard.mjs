import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The key `packages/coding-agent/src/core/config-reference-redaction.ts` pins its registry under (omo#12965). */
export const REDACTION_REGISTRY_SLOT_KEY = "@code-yeongyu/senpi/config-reference-redaction/v1";
const DEFINES_REDACTION_MODULE = /function rememberResolvedReferenceValue\d*\(/;

/**
 * Every emitted file that carries a copy of the redaction module must read the process-wide registry: a copy with a
 * private set would let values another copy resolved reach its sinks unredacted. Returns the copies it checked.
 */
export function assertRedactionRegistryCopies(bundleDir) {
	const copies = readdirSync(bundleDir, { recursive: true, encoding: "utf8" })
		.filter((name) => name.endsWith(".js"))
		.map((name) => ({ name: name.replaceAll("\\", "/"), text: readFileSync(join(bundleDir, name), "utf8") }))
		.filter((file) => DEFINES_REDACTION_MODULE.test(file.text))
		.sort((left, right) => left.name.localeCompare(right.name));
	if (copies.length === 0) throw new Error("no emitted file defines the config-reference redaction module");
	const unshared = copies.filter((copy) => !copy.text.includes(REDACTION_REGISTRY_SLOT_KEY));
	if (unshared.length > 0) {
		throw new Error(
			`emitted redaction module copies without the process-wide registry: ${unshared.map((copy) => copy.name).join(", ")}`,
		);
	}
	return copies.map((copy) => copy.name);
}
