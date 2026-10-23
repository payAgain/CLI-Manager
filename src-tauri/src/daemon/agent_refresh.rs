//! A Hook may use the exceptional Windows watchdog scope only when the sample
//! began after the Hook arrived. This is a generation barrier, not a TTL cache.
use std::sync::{Condvar, Mutex};
use std::time::Duration;

#[derive(Default)]
struct State {
    started: u64,
    completed: u64,
}

#[derive(Default)]
pub(super) struct AgentRefreshSignal {
    state: Mutex<State>,
    changed: Condvar,
}

impl AgentRefreshSignal {
    pub fn arrival(&self) -> Option<u64> {
        Some(self.state.lock().ok()?.started)
    }

    pub fn begin(&self) -> Option<u64> {
        let mut state = self.state.lock().ok()?;
        state.started = state.started.checked_add(1)?;
        Some(state.started)
    }

    pub fn complete(&self, generation: u64) {
        if let Ok(mut state) = self.state.lock() {
            state.completed = state.completed.max(generation);
            self.changed.notify_all();
        }
    }

    pub fn wait_after(&self, arrival: u64, timeout: Duration) -> bool {
        let Ok(state) = self.state.lock() else {
            return false;
        };
        self.changed
            .wait_timeout_while(state, timeout, |state| state.completed <= arrival)
            .is_ok_and(|(state, _)| state.completed > arrival)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completed_or_in_flight_samples_cannot_authorize_later_hooks() {
        let signal = AgentRefreshSignal::default();
        let first = signal.begin().unwrap();
        signal.complete(first);
        let arrival = signal.arrival().unwrap();
        assert!(!signal.wait_after(arrival, Duration::ZERO));
        let in_flight = signal.begin().unwrap();
        let later_arrival = signal.arrival().unwrap();
        signal.complete(in_flight);
        assert!(!signal.wait_after(later_arrival, Duration::ZERO));
        let fresh = signal.begin().unwrap();
        // A failed native read does not call complete and cannot clear identity.
        assert!(!signal.wait_after(later_arrival, Duration::ZERO));
        signal.complete(fresh);
        assert!(signal.wait_after(later_arrival, Duration::ZERO));
    }

    #[test]
    fn waiting_hook_releases_barrier_lock_so_watchdog_can_finish() {
        let signal = std::sync::Arc::new(AgentRefreshSignal::default());
        let arrival = signal.arrival().unwrap();
        let waiter = signal.clone();
        let thread = std::thread::spawn(move || waiter.wait_after(arrival, Duration::from_secs(1)));
        let fresh = signal.begin().unwrap();
        signal.complete(fresh);
        assert!(thread.join().unwrap());
    }
}
