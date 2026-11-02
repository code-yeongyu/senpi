/**
 * Formats a version string for user-facing display. Release versions (semver or
 * CalVer, starting with a digit) render with a `v` prefix; branded build labels
 * such as `omo@c6e7dd7 2026-09-04 10:17 +09:00` render verbatim.
 */
export function formatDisplayVersion(version: string): string {
	return /^[0-9]/.test(version) ? `v${version}` : version;
}
