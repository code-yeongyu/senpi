export function whoami(args: { readonly from: string }): { pid: number; from: string } {
	return { pid: process.pid, from: args.from };
}
