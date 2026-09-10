/** Installed only inside a shared-host session isolate, before constructing any writer. */
let reserve: ((path: string) => (() => void) | undefined) | undefined;

export function installSessionWriteReservation(reservation: (path: string) => (() => void) | undefined): void {
	if (reserve) throw new Error("Session write reservation already installed");
	reserve = reservation;
}

/** Obtain the host grant before touching a writer. Only a newly acquired grant can be rolled back. */
export function reserveSessionWrite(path: string): (() => void) | undefined {
	return reserve?.(path);
}
