//! A small worker pool for the audio callback: runs `count` independent tasks (one per
//! track) on the calling thread and a few helpers, and returns when all are done.
//! No allocation or locks per run: helpers spin briefly for the next job, then park; tasks
//! are claimed with a compare-and-swap on a counter tagged with the job's epoch, so a
//! helper that wakes late can never run a task of a job that is already over.
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU64, AtomicUsize, Ordering};
use std::thread::JoinHandle;

type Job<'a> = &'a (dyn Fn(usize) + Sync);
/// Claim value while a new job is being set up (its epoch matches no job).
const CLOSED: u64 = u64::MAX;

struct Shared {
    /// (epoch << 32) | next task index.
    claim: AtomicU64,
    epoch: AtomicU64,
    count: AtomicUsize,
    done: AtomicUsize,
    /// Points at a `Job` on the running caller's stack while a job is open.
    job: AtomicPtr<()>,
    quit: AtomicBool,
}

pub struct Pool {
    shared: Arc<Shared>,
    helpers: Vec<JoinHandle<()>>,
}

/// How long helpers spin for the next job before parking: between segments of one
/// callback jobs come microseconds apart; between callbacks (~10 ms) they park, so idle
/// helpers do not take CPU from the rest of the system.
const SPIN: u32 = 2_000;

impl Pool {
    /// A pool with `helpers` extra threads (0 = everything runs on the caller).
    pub fn new(helpers: usize) -> Pool {
        let shared = Arc::new(Shared {
            claim: AtomicU64::new(0),
            epoch: AtomicU64::new(0),
            count: AtomicUsize::new(0),
            done: AtomicUsize::new(0),
            job: AtomicPtr::new(std::ptr::null_mut()),
            quit: AtomicBool::new(false),
        });
        let helpers = (0..helpers)
            .filter_map(|i| {
                let shared = shared.clone();
                std::thread::Builder::new().name(format!("tabstudio-audio-worker-{i}")).spawn(move || helper(&shared)).ok()
            })
            .collect();
        Pool { shared, helpers }
    }

    /// The number of helpers worth having on this machine (cores minus the caller, at most 3).
    /// TABSTUDIO_AUDIO_HELPERS overrides it (0 renders serially). Unit tests run many engines
    /// at once, so they default to none; the pool has its own tests.
    pub fn default_helpers() -> usize {
        if let Some(n) = std::env::var("TABSTUDIO_AUDIO_HELPERS").ok().and_then(|v| v.parse().ok()) {
            return usize::min(n, 8);
        }
        if cfg!(test) {
            return 0;
        }
        std::thread::available_parallelism().map_or(0, |n| n.get().saturating_sub(1)).min(3)
    }

    pub fn helpers(&self) -> usize {
        self.helpers.len()
    }

    /// Runs `task(0..count)` across the caller and the helpers; returns when all finished.
    pub fn run(&self, count: usize, task: Job<'_>) {
        if count == 0 {
            return;
        }
        if self.helpers.is_empty() || count == 1 {
            (0..count).for_each(task);
            return;
        }
        let s = &*self.shared;
        let epoch = s.epoch.load(Ordering::Relaxed) + 1;
        let job: *const Job<'_> = &task;
        // Close claiming first: a helper that read the last job's claim but then sees this
        // job's count/job (Acquire below) is ordered after this store, so its CAS fails.
        s.claim.store(CLOSED, Ordering::SeqCst);
        s.job.store(job as *mut (), Ordering::Release);
        s.count.store(count, Ordering::Release);
        s.done.store(0, Ordering::Relaxed);
        s.claim.store(epoch << 32, Ordering::SeqCst);
        s.epoch.store(epoch, Ordering::Release);
        for h in &self.helpers {
            h.thread().unpark();
        }
        // The caller works too, then waits for tasks helpers took.
        work(s, epoch);
        // Helpers finish within microseconds; if one was preempted, let it run.
        let mut spins = 0u32;
        while s.done.load(Ordering::Acquire) < count {
            spins += 1;
            if spins < 4096 {
                std::hint::spin_loop();
            } else {
                std::thread::yield_now();
            }
        }
        s.job.store(std::ptr::null_mut(), Ordering::Relaxed);
    }
}

/// Claims and runs tasks of job `epoch` until none are left.
fn work(s: &Shared, epoch: u64) {
    loop {
        let claim = s.claim.load(Ordering::Acquire);
        if claim >> 32 != epoch {
            return;
        }
        let index = (claim & 0xffff_ffff) as usize;
        let count = s.count.load(Ordering::Acquire);
        let job = s.job.load(Ordering::Acquire) as *const Job<'_>;
        if index >= count || job.is_null() {
            return;
        }
        if s.claim.compare_exchange(claim, claim + 1, Ordering::SeqCst, Ordering::Relaxed).is_err() {
            continue;
        }
        // SAFETY: the claim succeeded for this epoch, so the job is still open: the caller
        // keeps `task` alive until `done` reaches `count`, which needs this task too.
        unsafe { (**job)(index) };
        s.done.fetch_add(1, Ordering::Release);
    }
}

fn helper(s: &Shared) {
    raise_priority();
    let mut seen = 0;
    while !s.quit.load(Ordering::Relaxed) {
        let mut spins = 0;
        let epoch = loop {
            let e = s.epoch.load(Ordering::Acquire);
            if e != seen || s.quit.load(Ordering::Relaxed) {
                break e;
            }
            spins += 1;
            if spins < SPIN {
                std::hint::spin_loop();
            } else {
                std::thread::park_timeout(std::time::Duration::from_millis(5));
            }
        };
        seen = epoch;
        work(s, epoch);
    }
}

/// Helpers render audio: run them at the audio thread's urgency.
fn raise_priority() {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL};
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
    }
}

impl Drop for Pool {
    fn drop(&mut self) {
        self.shared.quit.store(true, Ordering::Relaxed);
        for h in self.helpers.drain(..) {
            h.thread().unpark();
            let _ = h.join();
        }
    }
}

/// A raw pointer that may cross to helper threads; each task touches only its own index.
#[derive(Clone, Copy)]
pub struct Parts<T>(pub *mut T);
// SAFETY: used only to hand disjoint elements of one slice to the pool's tasks.
unsafe impl<T> Send for Parts<T> {}
unsafe impl<T> Sync for Parts<T> {}

impl<T> Parts<T> {
    /// Element `i` (closures must call this rather than touch `.0`, so they capture the
    /// whole Sync wrapper and not the raw pointer field).
    ///
    /// # Safety
    /// `i` is in bounds and no other task uses element `i` at the same time.
    #[allow(clippy::mut_from_ref)]
    pub unsafe fn at(&self, i: usize) -> &mut T {
        &mut *self.0.add(i)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_task_runs_once_per_job_across_many_jobs() {
        let pool = Pool::new(3);
        let hits: Vec<AtomicUsize> = (0..16).map(|_| AtomicUsize::new(0)).collect();
        for round in 0..20000 {
            let count = 1 + round % 16;
            pool.run(count, &|i| {
                hits[i].fetch_add(1, Ordering::Relaxed);
            });
        }
        let expected = |i: usize| (0..20000).filter(|r| 1 + r % 16 > i).count();
        for (i, h) in hits.iter().enumerate() {
            assert_eq!(h.load(Ordering::Relaxed), expected(i), "task {i}");
        }
    }

    #[test]
    fn tasks_write_disjoint_parts() {
        let pool = Pool::new(2);
        let mut data = vec![0u64; 9];
        let parts = Parts(data.as_mut_ptr());
        pool.run(9, &|i| unsafe { *parts.at(i) = (i * i) as u64 });
        assert_eq!(data, (0..9).map(|i| (i * i) as u64).collect::<Vec<_>>());
    }
}
