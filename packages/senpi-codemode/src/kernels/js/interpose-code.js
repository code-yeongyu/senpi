export function createCodePermissionGuard(check) {
	const scan = (source) => check(() => {
		const prepared = source?.startsWith("/*senpi:prepared-cell*/")
			? JSON.parse(source.slice("/*senpi:prepared-cell*/".length)) : undefined;
		return { granted: true, unsupported: prepared?.dynamicCodeCapability === true };
	});
	return { scan };
}
