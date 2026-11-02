/**
 * Join two independent startup branches.
 *
 * Both promises are always driven to settlement so a rejection on one side
 * cannot become an unhandled rejection while the other is still running.
 * When both reject, the primary (model-runtime) reason is thrown so error
 * ordering matches the historical sequential `await create(); await reload()`.
 */
export async function joinStartupBranches<TPrimary, TSecondary>(
	primary: Promise<TPrimary>,
	secondary: Promise<TSecondary>,
): Promise<{ primary: TPrimary; secondary: TSecondary }> {
	const [primaryResult, secondaryResult] = await Promise.allSettled([primary, secondary]);
	if (primaryResult.status === "rejected") {
		throw primaryResult.reason;
	}
	if (secondaryResult.status === "rejected") {
		throw secondaryResult.reason;
	}
	return { primary: primaryResult.value, secondary: secondaryResult.value };
}
