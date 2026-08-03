/**
 * Output-safety helpers shared by every senpi-qa probe.
 *
 * Kept in their own concept-named file so no probe is forced to depend on a
 * module named for a sibling probe.
 */

/** Collapse an arbitrary value into a single-line, length-capped detail string. */
export function safeDetail(value) {
	return String(value)
		.replace(/[\r\n]+/g, " ")
		.slice(0, 500);
}
