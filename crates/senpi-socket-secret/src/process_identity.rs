//! The Windows actual-target identity rule of the #4199 design (4.2a "OS identity", observation
//! table), as a pure function of what reopening a recorded PID observed. A participant is recorded as
//! its PID, the complete 64-bit creation FILETIME and the `TokenUser` SID read on one process handle.
//! A later observation decides `Live`, `Gone` or `Unknown`; only `Gone` may satisfy a retirement
//! census entry, and it never authorizes signalling or adopting whatever now holds the PID.

/// What a participant was recorded as. HANDLE values are process-local and never part of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessRecord {
    pub pid: u32,
    /// The complete creation FILETIME, kept lossless (never rounded, never a JavaScript Number).
    pub creation_time: u64,
    /// `TokenUser` SID in string form (`S-1-5-21-...`).
    pub user_sid: String,
}

/// What one opened process handle answered. `None` means that query failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessFacts {
    /// `GetProcessId` on the opened handle.
    pub handle_pid: Option<u32>,
    pub creation_time: Option<u64>,
    pub user_sid: Option<String>,
    /// Whether the process object is signalled (the process has exited).
    pub exited: Option<bool>,
}

/// The result of reopening a recorded PID.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Observation {
    Opened(ProcessFacts),
    /// `OpenProcess` reported that no process has this PID.
    NoSuchProcess,
    AccessDenied,
    /// Any other open failure, with its Win32 error.
    OpenFailed(u32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GoneReason {
    PidAbsent,
    CreationTimeDiffers,
    Exited,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnknownReason {
    AccessDenied,
    OpenFailed,
    InvalidRecord,
    ProcessIdMismatch,
    CreationTimeUnreadable,
    SidUnreadable,
    SidMismatch,
    ExitStateUnreadable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Liveness {
    Live,
    Gone(GoneReason),
    Unknown(UnknownReason),
}

/// Applies the design's observation table to one observation of `record`.
pub fn observe(record: &ProcessRecord, observation: &Observation) -> Liveness {
    use Liveness::{Gone, Live, Unknown};
    if record.pid == 0 || record.creation_time == 0 {
        return Unknown(UnknownReason::InvalidRecord);
    }
    let facts = match observation {
        Observation::Opened(facts) => facts,
        Observation::NoSuchProcess => return Gone(GoneReason::PidAbsent),
        Observation::AccessDenied => return Unknown(UnknownReason::AccessDenied),
        Observation::OpenFailed(_) => return Unknown(UnknownReason::OpenFailed),
    };
    if facts.handle_pid != Some(record.pid) {
        return Unknown(UnknownReason::ProcessIdMismatch);
    }
    match facts.creation_time {
        None | Some(0) => return Unknown(UnknownReason::CreationTimeUnreadable),
        Some(created) if created != record.creation_time => {
            return Gone(GoneReason::CreationTimeDiffers);
        }
        Some(_) => {}
    }
    match facts.user_sid.as_deref() {
        None => return Unknown(UnknownReason::SidUnreadable),
        Some(sid) if sid != record.user_sid => return Unknown(UnknownReason::SidMismatch),
        Some(_) => {}
    }
    match facts.exited {
        None => Unknown(UnknownReason::ExitStateUnreadable),
        Some(true) => Gone(GoneReason::Exited),
        Some(false) => Live,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "S-1-5-21-1000-2000-3000-1001";
    const CREATED: u64 = 134_000_000_000_000_000;

    fn record() -> ProcessRecord {
        ProcessRecord {
            pid: 4242,
            creation_time: CREATED,
            user_sid: SID.to_string(),
        }
    }

    fn opened(pid: u32, created: Option<u64>, sid: Option<&str>, exited: Option<bool>) -> Observation {
        Observation::Opened(ProcessFacts {
            handle_pid: Some(pid),
            creation_time: created,
            user_sid: sid.map(str::to_string),
            exited,
        })
    }

    // The design's observation table, one assertion per row, in its order.
    #[test]
    fn the_observation_table_rows() {
        let r = record();
        let live = opened(4242, Some(CREATED), Some(SID), Some(false));
        assert_eq!(observe(&r, &live), Liveness::Live, "matching live identity");
        let signalled = opened(4242, Some(CREATED), Some(SID), Some(true));
        assert_eq!(
            observe(&r, &signalled),
            Liveness::Gone(GoneReason::Exited),
            "signalled object"
        );
        let reused = opened(4242, Some(CREATED + 10_000_000), Some(SID), Some(false));
        assert_eq!(
            observe(&r, &reused),
            Liveness::Gone(GoneReason::CreationTimeDiffers),
            "same-account PID reuse"
        );
        assert_eq!(
            observe(&r, &Observation::NoSuchProcess),
            Liveness::Gone(GoneReason::PidAbsent)
        );
        assert_eq!(
            observe(&r, &Observation::AccessDenied),
            Liveness::Unknown(UnknownReason::AccessDenied)
        );
        let unreadable = opened(4242, None, Some(SID), Some(false));
        assert_eq!(
            observe(&r, &unreadable),
            Liveness::Unknown(UnknownReason::CreationTimeUnreadable)
        );
        let foreign = opened(4242, Some(CREATED), Some("S-1-5-21-9-9-9-500"), Some(false));
        assert_eq!(
            observe(&r, &foreign),
            Liveness::Unknown(UnknownReason::SidMismatch)
        );
        let other_pid = opened(4243, Some(CREATED), Some(SID), Some(false));
        assert_eq!(
            observe(&r, &other_pid),
            Liveness::Unknown(UnknownReason::ProcessIdMismatch)
        );
    }

    // Design test 11 with deterministic PID reuse: the replacement at the same PID and SID was created
    // one second later (134000000010000000). The recorded instance is gone whether or not the
    // replacement is alive.
    #[test]
    fn test_11_deterministic_pid_reuse_is_gone_even_while_the_replacement_lives() {
        let replacement = opened(4242, Some(134_000_000_010_000_000), Some(SID), Some(false));
        assert_eq!(
            observe(&record(), &replacement),
            Liveness::Gone(GoneReason::CreationTimeDiffers)
        );
        let one_tick = opened(4242, Some(CREATED + 1), Some(SID), Some(false));
        assert_eq!(
            observe(&record(), &one_tick),
            Liveness::Gone(GoneReason::CreationTimeDiffers)
        );
    }

    #[test]
    fn every_unreadable_or_inconsistent_answer_is_unknown() {
        let r = record();
        let cases = [
            (
                opened(4242, Some(0), Some(SID), Some(false)),
                UnknownReason::CreationTimeUnreadable,
            ),
            (
                opened(4242, Some(CREATED), None, Some(false)),
                UnknownReason::SidUnreadable,
            ),
            (
                opened(4242, Some(CREATED), Some(SID), None),
                UnknownReason::ExitStateUnreadable,
            ),
            (
                opened(4242, Some(CREATED), None, Some(true)),
                UnknownReason::SidUnreadable,
            ),
            (
                Observation::Opened(ProcessFacts {
                    handle_pid: None,
                    creation_time: Some(CREATED),
                    user_sid: Some(SID.to_string()),
                    exited: Some(false),
                }),
                UnknownReason::ProcessIdMismatch,
            ),
            (Observation::OpenFailed(6), UnknownReason::OpenFailed),
        ];
        for (observation, reason) in cases {
            assert_eq!(
                observe(&r, &observation),
                Liveness::Unknown(reason),
                "{observation:?}"
            );
        }
        let unrecorded = ProcessRecord { pid: 0, ..record() };
        assert_eq!(
            observe(&unrecorded, &Observation::NoSuchProcess),
            Liveness::Unknown(UnknownReason::InvalidRecord)
        );
        let zero_creation = ProcessRecord {
            creation_time: 0,
            ..record()
        };
        assert_eq!(
            observe(
                &zero_creation,
                &opened(4242, Some(CREATED), Some(SID), Some(false))
            ),
            Liveness::Unknown(UnknownReason::InvalidRecord)
        );
    }
}
