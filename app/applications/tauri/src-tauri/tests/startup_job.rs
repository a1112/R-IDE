/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#[allow(dead_code, unused_imports)]
#[path = "../src/startup_job.rs"]
mod startup_job;

use std::cell::RefCell;
use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

#[derive(Debug)]
struct ProbeGuard {
    drops: Arc<AtomicUsize>,
}

impl Drop for ProbeGuard {
    fn drop(&mut self) {
        self.drops.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Debug)]
struct ProbeFactory {
    calls: RefCell<usize>,
    drops: Arc<AtomicUsize>,
    fail: bool,
}

impl startup_job::StartupJobFactory for ProbeFactory {
    type Guard = ProbeGuard;

    fn create(&self) -> io::Result<Self::Guard> {
        *self.calls.borrow_mut() += 1;
        if self.fail {
            Err(io::Error::other("injected Job Object failure"))
        } else {
            Ok(ProbeGuard {
                drops: Arc::clone(&self.drops),
            })
        }
    }
}

#[test]
fn startup_job_gate_only_calls_the_factory_for_a_requested_report() {
    let drops = Arc::new(AtomicUsize::new(0));
    let factory = ProbeFactory {
        calls: RefCell::new(0),
        drops: Arc::clone(&drops),
        fail: false,
    };

    assert!(startup_job::create_if_requested_with(false, &factory)
        .expect("disabled startup job")
        .is_none());
    assert_eq!(*factory.calls.borrow(), 0);

    let guard = startup_job::create_if_requested_with(true, &factory)
        .expect("enabled startup job")
        .expect("startup job guard");
    assert_eq!(*factory.calls.borrow(), 1);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    drop(guard);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[test]
fn startup_job_gate_propagates_factory_failure() {
    let factory = ProbeFactory {
        calls: RefCell::new(0),
        drops: Arc::new(AtomicUsize::new(0)),
        fail: true,
    };

    assert_eq!(
        startup_job::create_if_requested_with(true, &factory)
            .expect_err("Job Object failure must stop measured startup")
            .to_string(),
        "injected Job Object failure"
    );
    assert_eq!(*factory.calls.borrow(), 1);
}

#[derive(Debug)]
struct ProbeJobApi {
    events: RefCell<Vec<&'static str>>,
    fail_at: Option<&'static str>,
    drops: Arc<AtomicUsize>,
}

impl startup_job::JobApi for ProbeJobApi {
    type Handle = ProbeGuard;

    fn create_job(&self) -> io::Result<Self::Handle> {
        self.events.borrow_mut().push("create");
        if self.fail_at == Some("create") {
            return Err(io::Error::other("create failed"));
        }
        Ok(ProbeGuard {
            drops: Arc::clone(&self.drops),
        })
    }

    fn set_kill_on_close(&self, _handle: &Self::Handle) -> io::Result<()> {
        self.events.borrow_mut().push("set");
        if self.fail_at == Some("set") {
            Err(io::Error::other("set failed"))
        } else {
            Ok(())
        }
    }

    fn assign_current_process(&self, _handle: &Self::Handle) -> io::Result<()> {
        self.events.borrow_mut().push("assign");
        if self.fail_at == Some("assign") {
            Err(io::Error::other("assign failed"))
        } else {
            Ok(())
        }
    }
}

#[test]
fn startup_job_creation_orders_configuration_before_assignment_and_owns_the_handle() {
    let drops = Arc::new(AtomicUsize::new(0));
    let api = ProbeJobApi {
        events: RefCell::new(Vec::new()),
        fail_at: None,
        drops: Arc::clone(&drops),
    };

    let guard = startup_job::create_job_with(&api).expect("configured Job Object");
    assert_eq!(&*api.events.borrow(), &["create", "set", "assign"]);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    drop(guard);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[test]
fn startup_job_creation_releases_partial_handles_and_stops_at_the_failed_stage() {
    for (failed_stage, expected_events, expected_drops) in [
        ("create", vec!["create"], 0),
        ("set", vec!["create", "set"], 1),
        ("assign", vec!["create", "set", "assign"], 1),
    ] {
        let drops = Arc::new(AtomicUsize::new(0));
        let api = ProbeJobApi {
            events: RefCell::new(Vec::new()),
            fail_at: Some(failed_stage),
            drops: Arc::clone(&drops),
        };

        assert!(startup_job::create_job_with(&api).is_err());
        assert_eq!(&*api.events.borrow(), expected_events.as_slice());
        assert_eq!(drops.load(Ordering::SeqCst), expected_drops);
    }
}

#[test]
fn startup_job_initialization_precedes_the_first_startup_milestone() {
    let source = include_str!("../src/lib.rs");
    let containment = source
        .find("create_for_current_process_if_requested")
        .expect("startup Job Object initialization");
    let metrics = source
        .find("StartupMetrics::from_env")
        .expect("startup metrics initialization");
    let first_milestone = source
        .find("StartupMilestone::ProcessStarted")
        .expect("process_started milestone");

    assert!(containment < metrics);
    assert!(metrics < first_milestone);
}

#[cfg(windows)]
mod windows_job_integration {
    use super::startup_job;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, STILL_ACTIVE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE,
    };

    const MODE_ENV: &str = "RIDE_STARTUP_JOB_TEST_MODE";
    const PID_PATH_ENV: &str = "RIDE_STARTUP_JOB_TEST_PID_PATH";
    const READY_PATH_ENV: &str = "RIDE_STARTUP_JOB_TEST_READY_PATH";
    const RELEASE_PATH_ENV: &str = "RIDE_STARTUP_JOB_TEST_RELEASE_PATH";
    const SURVIVED_PATH_ENV: &str = "RIDE_STARTUP_JOB_TEST_SURVIVED_PATH";

    struct ProcessHandle(HANDLE);

    impl Drop for ProcessHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    fn unique_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "ride-startup-job-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn wait_for_file(path: &Path, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        while !path.exists() {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {}",
                path.display()
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn windows_job_helper_parent() {
        if std::env::var(MODE_ENV).as_deref() != Ok("parent") {
            return;
        }
        let guard = startup_job::create_kill_on_close_job_for_current_process()
            .expect("create helper Job Object");
        let pid_path = PathBuf::from(std::env::var_os(PID_PATH_ENV).expect("pid path"));
        let ready_path = PathBuf::from(std::env::var_os(READY_PATH_ENV).expect("ready path"));
        let release_path = PathBuf::from(std::env::var_os(RELEASE_PATH_ENV).expect("release path"));
        let survived_path =
            PathBuf::from(std::env::var_os(SURVIVED_PATH_ENV).expect("survived path"));
        let mut child = Command::new(std::env::current_exe().expect("test executable"))
            .args([
                "--exact",
                "windows_job_integration::windows_job_helper_descendant",
                "--nocapture",
            ])
            .env(MODE_ENV, "descendant")
            .env(READY_PATH_ENV, &ready_path)
            .spawn()
            .expect("spawn Job descendant");
        fs::write(&pid_path, child.id().to_string()).expect("publish descendant pid");
        wait_for_file(&ready_path, Duration::from_secs(5));
        wait_for_file(&release_path, Duration::from_secs(5));
        drop(guard);
        fs::write(survived_path, "survived").expect("record unexpected survival");
        let _ = child.kill();
        let _ = child.wait();
        panic!("closing the last Job handle should terminate this helper process");
    }

    #[test]
    fn windows_job_helper_descendant() {
        if std::env::var(MODE_ENV).as_deref() != Ok("descendant") {
            return;
        }
        let ready_path = PathBuf::from(std::env::var_os(READY_PATH_ENV).expect("ready path"));
        fs::write(ready_path, "ready").expect("publish descendant readiness");
        thread::sleep(Duration::from_secs(15));
    }

    #[test]
    fn closing_the_helper_job_terminates_its_unobserved_descendant() {
        if std::env::var_os(MODE_ENV).is_some() {
            return;
        }
        let pid_path = unique_path("pid");
        let ready_path = unique_path("ready");
        let release_path = unique_path("release");
        let survived_path = unique_path("survived");
        let mut helper = Command::new(std::env::current_exe().expect("test executable"))
            .args([
                "--exact",
                "windows_job_integration::windows_job_helper_parent",
                "--nocapture",
            ])
            .env(MODE_ENV, "parent")
            .env(PID_PATH_ENV, &pid_path)
            .env(READY_PATH_ENV, &ready_path)
            .env(RELEASE_PATH_ENV, &release_path)
            .env(SURVIVED_PATH_ENV, &survived_path)
            .spawn()
            .expect("run isolated Job helper");
        wait_for_file(&pid_path, Duration::from_secs(5));
        wait_for_file(&ready_path, Duration::from_secs(5));
        let pid = fs::read_to_string(&pid_path)
            .expect("descendant pid")
            .parse::<u32>()
            .expect("numeric descendant pid");
        let descendant_handle = ProcessHandle(unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        });
        if descendant_handle.0.is_null() {
            let _ = helper.kill();
            let _ = helper.wait();
            panic!("could not open Job descendant {pid} before releasing the helper");
        }
        let mut exit_code = 0;
        let queried = unsafe { GetExitCodeProcess(descendant_handle.0, &mut exit_code) };
        if queried == 0 || exit_code as i32 != STILL_ACTIVE {
            let _ = helper.kill();
            let _ = helper.wait();
            panic!("Job descendant {pid} was not running before helper release");
        }
        fs::write(&release_path, "release").expect("release helper Job handle");
        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = helper.try_wait().expect("query helper status") {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = helper.kill();
                let _ = helper.wait();
                panic!("timed out waiting for isolated Job helper");
            }
            thread::sleep(Duration::from_millis(10));
        };
        let wait_result = unsafe { WaitForSingleObject(descendant_handle.0, 5_000) };
        assert_eq!(
            wait_result, WAIT_OBJECT_0,
            "Job descendant {pid} survived helper exit ({status:?})"
        );
        assert!(
            !survived_path.exists(),
            "helper continued after closing the last Job handle ({status:?})"
        );
        let _ = fs::remove_file(pid_path);
        let _ = fs::remove_file(ready_path);
        let _ = fs::remove_file(release_path);
        let _ = fs::remove_file(survived_path);
    }
}
