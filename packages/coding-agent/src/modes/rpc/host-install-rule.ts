/** The one rule every handover path asks about a host's install (senpi#7086); dependency-free, so the supervisor graph stays small. */

/**
 * Whether another install of the serving host's engine may replace it. Only a host that reports its install gone is
 * replaced; a present install, or a host that does not report one, keeps serving.
 */
export function installGoneReplaces(installPresent: boolean | undefined): boolean {
	return installPresent === false;
}
