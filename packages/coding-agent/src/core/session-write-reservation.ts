/** Installed only inside a shared-host session isolate, before constructing any writer. */
let reserve: ((path: string) => void) | undefined;

export function installSessionWriteReservation(reservation: (path: string) => void): void {
	if (reserve) throw new Error("Session write reservation already installed");
	reserve = reservation;
}

/** Synchronous SessionManager entry points must obtain the host grant before touching a writer. */
export function reserveSessionWrite(path: string): void {
	reserve?.(path);
}
