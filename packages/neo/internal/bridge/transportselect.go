package bridge

// TransportMode selects how a neo instance reaches its runtime.
type TransportMode int

const (
	// TransportDaemon: attach to (or spawn) the shared per-cwd daemon.
	TransportDaemon TransportMode = iota
	// TransportIsolated: spawn a per-instance `node <cli> --mode rpc` child
	// (StdioTransport), bypassing the daemon entirely.
	TransportIsolated
)

func (m TransportMode) String() string {
	if m == TransportIsolated {
		return "isolated"
	}
	return "daemon"
}

// windowsDefaultsToIsolated is the WINDOWS DEFAULT GATE (plan task 17): a code
// switch — not documentation — that plan task 20 flips to `true` if the Windows
// daemon-attach scenario is red at integration time. When true, a Windows neo
// instance defaults to the isolated transport unless the user passes an explicit
// flag. It is intentionally a single constant so task 20 flips exactly one thing.
//
// Current value: false — Windows defaults to the shared daemon like every other
// platform. Task 20 will flip this to true only if it proves the attach path is
// not yet reliable on Windows.
const windowsDefaultsToIsolated = false

// SelectTransportMode decides the transport for this instance from the neo
// launcher argv and the current platform (runtime.GOOS is passed in so the
// decision is testable). --isolated forces isolated on every platform; otherwise
// the per-platform default applies (Windows honors windowsDefaultsToIsolated).
func SelectTransportMode(neoArgv []string, goos string) TransportMode {
	return selectTransportModeWith(neoArgv, goos, windowsDefaultsToIsolated)
}

// selectTransportModeWith is the testable core: it takes the Windows-default gate
// explicitly so a test can pin both gate positions without editing the constant.
func selectTransportModeWith(neoArgv []string, goos string, windowsIsolated bool) TransportMode {
	if argvHasIsolated(neoArgv) {
		return TransportIsolated
	}
	if goos == "windows" && windowsIsolated {
		return TransportIsolated
	}
	return TransportDaemon
}

// argvHasIsolated reports whether the launcher forwarded the leading --isolated
// flag (build-argv.ts emits it first when neoIsolated is set).
func argvHasIsolated(neoArgv []string) bool {
	for _, a := range neoArgv {
		if a == "--isolated" {
			return true
		}
	}
	return false
}
