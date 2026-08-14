use ride_tauri::launch_intent::{
    parse_args, parse_opened_urls, LaunchIntent, LaunchIntentIdSource, LaunchIntentQueue,
    LaunchIntentRouter, LaunchSource,
};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Barrier, Mutex};
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug)]
enum FixtureKind {
    File,
    Directory,
}

#[derive(Debug)]
struct Fixture {
    path: PathBuf,
    kind: FixtureKind,
    empty_parent: Option<PathBuf>,
}

impl Fixture {
    fn file(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!("{}-{label}", Uuid::new_v4()));
        fs::write(&path, b"fixture").expect("create fixture file");
        Self {
            path,
            kind: FixtureKind::File,
            empty_parent: None,
        }
    }

    fn nested_file(label: &str) -> Self {
        let parent = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir(&parent).expect("create fixture parent");
        let path = parent.join(format!("{}-{label}", Uuid::new_v4()));
        fs::write(&path, b"fixture").expect("create nested fixture file");
        Self {
            path,
            kind: FixtureKind::File,
            empty_parent: Some(parent),
        }
    }

    fn named_file(file_name: OsString) -> Self {
        let path = std::env::temp_dir().join(file_name);
        fs::write(&path, b"fixture").expect("create named fixture file");
        Self {
            path,
            kind: FixtureKind::File,
            empty_parent: None,
        }
    }

    fn directory() -> Self {
        let path = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir(&path).expect("create fixture directory");
        Self {
            path,
            kind: FixtureKind::Directory,
            empty_parent: None,
        }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        match self.kind {
            FixtureKind::File => {
                let _ = fs::remove_file(&self.path);
            }
            FixtureKind::Directory => {
                let _ = fs::remove_dir(&self.path);
            }
        }
        if let Some(parent) = &self.empty_parent {
            let _ = fs::remove_dir(parent);
        }
    }
}

fn args(paths: impl IntoIterator<Item = OsString>) -> Vec<OsString> {
    std::iter::once(OsString::from("ignored-executable"))
        .chain(paths)
        .collect()
}

fn canonical(path: &Path) -> PathBuf {
    fs::canonicalize(path).expect("canonical fixture path")
}

fn expected(id: u64, source: LaunchSource, workspace: &Path, files: Vec<PathBuf>) -> LaunchIntent {
    LaunchIntent {
        id,
        source,
        workspace: workspace.to_path_buf(),
        files,
    }
}

fn queue_intent(id: u64) -> LaunchIntent {
    LaunchIntent {
        id,
        source: LaunchSource::SingleInstance,
        workspace: PathBuf::from(format!("workspace-{id}")),
        files: vec![PathBuf::from(format!("file-{id}.R"))],
    }
}

#[test]
fn launch_intent_ids_start_at_the_configured_nonzero_value() {
    let source = LaunchIntentIdSource::new(1).expect("nonzero ID source");

    assert_eq!(source.next(), Some(1));
    assert_eq!(source.next(), Some(2));
}

#[test]
fn launch_intent_ids_stop_after_u64_max_without_wrapping() {
    let source = LaunchIntentIdSource::new(u64::MAX - 1).expect("nonzero ID source");

    assert_eq!(source.next(), Some(u64::MAX - 1));
    assert_eq!(source.next(), Some(u64::MAX));
    assert_eq!(source.next(), None);
    assert_eq!(source.next(), None);
}

#[test]
fn launch_intent_id_source_rejects_zero_as_an_ambiguous_start() {
    assert!(LaunchIntentIdSource::new(0).is_none());
}

#[test]
fn concurrent_launch_intent_ids_are_unique() {
    let source = Arc::new(LaunchIntentIdSource::new(1).expect("nonzero ID source"));
    let workers = (0..4)
        .map(|_| {
            let source = Arc::clone(&source);
            std::thread::spawn(move || {
                (0..64)
                    .map(|_| source.next().expect("ID space remains available"))
                    .collect::<Vec<_>>()
            })
        })
        .collect::<Vec<_>>();
    let mut ids = workers
        .into_iter()
        .flat_map(|worker| worker.join().expect("ID worker"))
        .collect::<Vec<_>>();
    ids.sort_unstable();

    assert_eq!(ids, (1..=256).collect::<Vec<_>>());
}

#[test]
fn queues_intents_without_delivering_before_the_frontend_is_ready() {
    let mut queue = LaunchIntentQueue::new(4);

    assert!(queue.enqueue(queue_intent(1)).is_empty());
    assert!(queue.enqueue(queue_intent(2)).is_empty());
}

#[test]
fn marking_ready_drains_in_order_and_later_enqueues_deliver_immediately() {
    let mut queue = LaunchIntentQueue::new(4);
    let first = queue_intent(1);
    let second = queue_intent(2);
    let third = queue_intent(3);
    assert!(queue.enqueue(first.clone()).is_empty());
    assert!(queue.enqueue(second.clone()).is_empty());

    assert_eq!(queue.mark_ready(), vec![first, second]);
    assert!(queue.mark_ready().is_empty());
    assert_eq!(queue.enqueue(third.clone()), vec![third]);
}

#[test]
fn duplicate_ids_are_suppressed_while_pending_in_flight_and_acknowledged() {
    let mut queue = LaunchIntentQueue::new(4);
    let intent = queue_intent(7);

    assert!(queue.enqueue(intent.clone()).is_empty());
    assert!(queue.enqueue(intent.clone()).is_empty());
    assert!(!queue.acknowledge(intent.id));
    assert_eq!(queue.mark_ready(), vec![intent.clone()]);
    assert!(queue.enqueue(intent.clone()).is_empty());

    assert!(queue.acknowledge(intent.id));
    assert!(queue.acknowledge(intent.id));
    assert!(!queue.acknowledge(999));
    assert!(queue.enqueue(intent).is_empty());
}

#[test]
fn bounded_queue_keeps_newest_intents_and_never_revives_evicted_ids() {
    let mut queue = LaunchIntentQueue::new(2);
    let first = queue_intent(1);
    let second = queue_intent(2);
    let third = queue_intent(3);
    assert!(queue.enqueue(first.clone()).is_empty());
    assert!(queue.enqueue(second.clone()).is_empty());
    assert!(queue.enqueue(third.clone()).is_empty());

    assert_eq!(queue.mark_ready(), vec![second, third]);
    assert!(!queue.acknowledge(first.id));
    assert!(queue.acknowledge(2));
    assert!(queue.acknowledge(3));

    for id in 4..32 {
        let intent = queue_intent(id);
        assert_eq!(queue.enqueue(intent.clone()), vec![intent]);
        assert!(queue.acknowledge(id));
    }

    assert!(queue.enqueue(first).is_empty());
}

#[test]
fn zero_maximum_length_is_safely_clamped_to_one() {
    let mut queue = LaunchIntentQueue::new(0);
    let intent = queue_intent(11);

    assert!(queue.enqueue(intent.clone()).is_empty());
    assert_eq!(queue.mark_ready(), vec![intent.clone()]);
    assert!(queue.enqueue(intent).is_empty());
}

#[test]
fn owned_deliveries_allow_the_mutex_to_be_relocked_inside_the_callback() {
    let queue = Mutex::new(LaunchIntentQueue::new(2));
    let intent = queue_intent(13);
    assert!(queue
        .lock()
        .expect("queue mutex")
        .enqueue(intent.clone())
        .is_empty());

    let deliveries = {
        let mut guard = queue.lock().expect("queue mutex");
        guard.mark_ready()
    };
    let delivered_ids = deliveries
        .into_iter()
        .map(|delivery| {
            let mut callback_guard = queue
                .try_lock()
                .expect("delivery callback must run without the queue lock held");
            assert!(callback_guard.acknowledge(delivery.id));
            delivery.id
        })
        .collect::<Vec<_>>();

    assert_eq!(delivered_ids, vec![intent.id]);
}

#[test]
fn router_seeds_initial_intent_and_advances_without_id_collisions() {
    let file = Fixture::file("initial-router.R");
    let initial = parse_args(
        args([OsString::from(file.path())]),
        Path::new("cwd-is-unused-for-absolute-input"),
        LaunchSource::Initial,
        1,
    )
    .expect("valid initial launch intent");
    let router = LaunchIntentRouter::new(4, Some(initial.clone()));

    assert_eq!(router.next_id(), Some(2));

    let mut delivered = Vec::new();
    let report = router.frontend_ready(|intent| {
        delivered.push(intent.clone());
        Ok::<_, &'static str>(())
    });

    assert_eq!(delivered, vec![initial]);
    assert_eq!(report.delivered_ids, vec![1]);
    assert!(report.failures.is_empty());
    assert!(router.is_acknowledged(1));

    let invalid_initial = parse_args(
        args([OsString::from("definitely-missing-initial.R")]),
        Path::new("definitely-missing-cwd"),
        LaunchSource::Initial,
        1,
    );
    assert!(invalid_initial.is_none());
    let router_without_initial = LaunchIntentRouter::new(4, invalid_initial);
    assert_eq!(router_without_initial.next_id(), Some(1));

    let exhausted = LaunchIntentRouter::new(4, Some(queue_intent(u64::MAX)));
    assert_eq!(exhausted.next_id(), None);
    assert_eq!(exhausted.next_id(), None);
}

#[test]
fn forwarded_args_resolve_strictly_against_the_callback_cwd() {
    let file = Fixture::nested_file("callback-cwd.R");
    let callback_cwd = file.path().parent().expect("callback cwd");
    let relative = file.path().file_name().expect("fixture file name");
    let router = LaunchIntentRouter::new(4, None);

    let route_report = router.route_forwarded_args(
        args([OsString::from(relative)]),
        callback_cwd,
        || {},
        |_| -> Result<(), &'static str> { panic!("frontend is not ready") },
    );
    assert!(route_report.delivered_ids.is_empty());
    assert!(route_report.failures.is_empty());

    let mut delivered = Vec::new();
    router.frontend_ready(|intent| {
        delivered.push(intent.clone());
        Ok::<_, &'static str>(())
    });

    assert_eq!(delivered.len(), 1);
    assert_eq!(delivered[0].source, LaunchSource::SingleInstance);
    assert_eq!(delivered[0].files, vec![canonical(file.path())]);
}

#[test]
fn forwarded_activation_enqueues_unlocked_then_focuses_then_emits() {
    let file = Fixture::file("ordered-forward.R");
    let router = LaunchIntentRouter::new(4, None);
    router.frontend_ready(|_| Ok::<_, &'static str>(()));
    let events = Mutex::new(Vec::new());

    let report = router.route_forwarded_args(
        args([OsString::from(file.path())]),
        Path::new("cwd-is-unused-for-absolute-input"),
        || {
            assert!(
                router.acknowledge(1),
                "intent must already be in flight and the queue mutex unlocked"
            );
            events.lock().expect("events mutex").push("focus");
        },
        |intent| {
            assert!(!router.acknowledge(u64::MAX));
            assert_eq!(intent.id, 1);
            events.lock().expect("events mutex").push("emit");
            Ok::<_, &'static str>(())
        },
    );

    assert_eq!(*events.lock().expect("events mutex"), ["focus", "emit"]);
    assert_eq!(report.delivered_ids, vec![1]);
    assert!(report.failures.is_empty());
}

#[test]
fn invalid_forwarded_activation_still_focuses_without_emitting() {
    let router = LaunchIntentRouter::new(4, None);
    router.frontend_ready(|_| Ok::<_, &'static str>(()));
    let events = Mutex::new(Vec::new());

    let report = router.route_forwarded_args(
        args([OsString::from("definitely-missing.R")]),
        Path::new("definitely-missing-cwd"),
        || events.lock().expect("events mutex").push("focus"),
        |_| {
            events.lock().expect("events mutex").push("emit");
            Ok::<_, &'static str>(())
        },
    );

    assert_eq!(*events.lock().expect("events mutex"), ["focus"]);
    assert!(report.delivered_ids.is_empty());
    assert!(report.failures.is_empty());
}

#[test]
fn frontend_readiness_drains_forwarded_activations_once_in_order() {
    let first = Fixture::file("first-forward.R");
    let second = Fixture::file("second-forward.R");
    let router = LaunchIntentRouter::new(4, None);
    let early_emits = Mutex::new(Vec::new());

    for file in [&first, &second] {
        router.route_forwarded_args(
            args([OsString::from(file.path())]),
            Path::new("cwd-is-unused-for-absolute-input"),
            || {},
            |intent| {
                early_emits
                    .lock()
                    .expect("early emits mutex")
                    .push(intent.id);
                Ok::<_, &'static str>(())
            },
        );
    }
    assert!(early_emits.lock().expect("early emits mutex").is_empty());

    let delivered = Mutex::new(Vec::new());
    let first_report = router.frontend_ready(|intent| {
        assert!(!router.acknowledge(u64::MAX));
        delivered.lock().expect("delivered mutex").push(intent.id);
        Ok::<_, &'static str>(())
    });
    let repeated_report = router.frontend_ready(|intent| {
        delivered.lock().expect("delivered mutex").push(intent.id);
        Ok::<_, &'static str>(())
    });

    assert_eq!(*delivered.lock().expect("delivered mutex"), [1, 2]);
    assert_eq!(first_report.delivered_ids, vec![1, 2]);
    assert!(first_report.failures.is_empty());
    assert!(repeated_report.delivered_ids.is_empty());
    assert!(repeated_report.failures.is_empty());
    assert!(router.is_acknowledged(1));
    assert!(router.is_acknowledged(2));
}

#[test]
fn show_failure_does_not_prevent_ready_drain_or_acknowledgement() {
    let initial = queue_intent(1);
    let forwarded = Fixture::file("show-failure-forwarded.R");
    let router = LaunchIntentRouter::new(4, Some(initial));
    router.route_forwarded_args(
        args([OsString::from(forwarded.path())]),
        Path::new("cwd-is-unused-for-absolute-input"),
        || {},
        |_| -> Result<(), &'static str> { panic!("frontend is not ready") },
    );

    let delivered = Mutex::new(Vec::new());
    let show_errors = Mutex::new(Vec::new());
    let report = router.frontend_ready_after_show(
        || Err("show failed"),
        |error| show_errors.lock().expect("show errors mutex").push(error),
        |intent| {
            delivered.lock().expect("delivered mutex").push(intent.id);
            Ok::<_, &'static str>(())
        },
    );
    let repeated = router.frontend_ready(|_| -> Result<(), &'static str> {
        panic!("ready drain must not require a frontend retry")
    });

    assert_eq!(
        *show_errors.lock().expect("show errors mutex"),
        ["show failed"]
    );
    assert_eq!(*delivered.lock().expect("delivered mutex"), [1, 2]);
    assert_eq!(report.delivered_ids, [1, 2]);
    assert!(report.failures.is_empty());
    assert!(router.is_acknowledged(1));
    assert!(router.is_acknowledged(2));
    assert!(repeated.delivered_ids.is_empty());
    assert!(repeated.failures.is_empty());
}

#[test]
fn concurrent_ready_and_forwarded_delivery_preserve_global_arrival_order() {
    let router = Arc::new(LaunchIntentRouter::new(4, Some(queue_intent(1))));
    let forwarded = Fixture::file("concurrent-forwarded.R");
    let events = Arc::new(Mutex::new(Vec::new()));
    let release_first_emit = Arc::new(Barrier::new(2));
    let (first_emit_started_tx, first_emit_started_rx) = mpsc::channel();

    let ready_router = Arc::clone(&router);
    let ready_events = Arc::clone(&events);
    let ready_release = Arc::clone(&release_first_emit);
    let ready_thread = std::thread::spawn(move || {
        ready_router.frontend_ready(|intent| {
            first_emit_started_tx
                .send(())
                .expect("signal first emit started");
            ready_release.wait();
            ready_events.lock().expect("events mutex").push(intent.id);
            Ok::<_, &'static str>(())
        })
    });

    first_emit_started_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("first emit must reach the controlled barrier");

    let forwarded_router = Arc::clone(&router);
    let forwarded_events = Arc::clone(&events);
    let forwarded_path = forwarded.path().to_path_buf();
    let (forwarded_focused_tx, forwarded_focused_rx) = mpsc::channel();
    let (second_emit_tx, second_emit_rx) = mpsc::channel();
    let forwarded_thread = std::thread::spawn(move || {
        forwarded_router.route_forwarded_args(
            args([forwarded_path.into_os_string()]),
            Path::new("cwd-is-unused-for-absolute-input"),
            || {
                forwarded_focused_tx
                    .send(())
                    .expect("signal forwarded focus");
            },
            |intent| {
                forwarded_events
                    .lock()
                    .expect("events mutex")
                    .push(intent.id);
                second_emit_tx.send(()).expect("signal second emit");
                Ok::<_, &'static str>(())
            },
        )
    });

    forwarded_focused_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("forwarded activation must enqueue and focus");
    let second_emit_before_release = second_emit_rx.recv_timeout(Duration::from_millis(250));

    release_first_emit.wait();
    let ready_report = ready_thread.join().expect("ready thread");
    let forwarded_report = forwarded_thread.join().expect("forwarded thread");

    assert!(
        matches!(
            second_emit_before_release,
            Err(mpsc::RecvTimeoutError::Timeout)
        ),
        "id 2 emitted before the older id 1 delivery was released"
    );
    assert_eq!(*events.lock().expect("events mutex"), [1, 2]);
    assert_eq!(ready_report.delivered_ids, [1]);
    assert_eq!(forwarded_report.delivered_ids, [2]);
    assert!(ready_report.failures.is_empty());
    assert!(forwarded_report.failures.is_empty());
}

#[test]
fn opened_urls_use_the_same_router_rules_on_every_platform() {
    let file = Fixture::file("opened-router.R");
    let url = tauri::Url::from_file_path(file.path()).expect("fixture file URL");
    let router = LaunchIntentRouter::new(4, None);
    let focus_count = Mutex::new(0);

    let route_report = router.route_opened_urls(
        &[url],
        || *focus_count.lock().expect("focus count mutex") += 1,
        |_| -> Result<(), &'static str> { panic!("frontend is not ready") },
    );
    assert!(route_report.delivered_ids.is_empty());
    assert!(route_report.failures.is_empty());

    let mut delivered = Vec::new();
    router.frontend_ready(|intent| {
        delivered.push(intent.clone());
        Ok::<_, &'static str>(())
    });

    assert_eq!(*focus_count.lock().expect("focus count mutex"), 1);
    assert_eq!(delivered.len(), 1);
    assert_eq!(delivered[0].source, LaunchSource::OpenedUrl);
    assert_eq!(delivered[0].files, vec![canonical(file.path())]);
}

#[test]
fn emit_failure_is_reported_unlocked_and_never_redelivered() {
    let mut initial = queue_intent(1);
    initial.source = LaunchSource::Initial;
    let router = LaunchIntentRouter::new(4, Some(initial));
    let attempts = Mutex::new(Vec::new());

    let report = router.frontend_ready(|intent| {
        assert!(!router.acknowledge(u64::MAX));
        attempts.lock().expect("attempts mutex").push(intent.id);
        Err("emit failed")
    });
    let repeated = router.frontend_ready(|intent| {
        attempts.lock().expect("attempts mutex").push(intent.id);
        Ok::<_, &'static str>(())
    });

    assert!(report.delivered_ids.is_empty());
    assert_eq!(report.failures.len(), 1);
    assert_eq!(report.failures[0].intent.id, 1);
    assert_eq!(report.failures[0].error, "emit failed");
    assert!(!router.is_acknowledged(1));
    assert!(repeated.delivered_ids.is_empty());
    assert!(repeated.failures.is_empty());
    assert_eq!(*attempts.lock().expect("attempts mutex"), [1]);
}

#[test]
fn emit_failure_advances_the_dispatcher_for_the_next_delivery() {
    let router = LaunchIntentRouter::new(4, Some(queue_intent(1)));
    let forwarded = Fixture::file("after-failed-emit.R");
    router.route_forwarded_args(
        args([OsString::from(forwarded.path())]),
        Path::new("cwd-is-unused-for-absolute-input"),
        || {},
        |_| -> Result<(), &'static str> { panic!("frontend is not ready") },
    );
    let attempts = Mutex::new(Vec::new());

    let report = router.frontend_ready(|intent| {
        assert!(!router.acknowledge(u64::MAX));
        attempts.lock().expect("attempts mutex").push(intent.id);
        if intent.id == 1 {
            Err("first emit failed")
        } else {
            Ok(())
        }
    });

    assert_eq!(*attempts.lock().expect("attempts mutex"), [1, 2]);
    assert_eq!(report.delivered_ids, [2]);
    assert_eq!(report.failures.len(), 1);
    assert_eq!(report.failures[0].intent.id, 1);
    assert!(!router.is_acknowledged(1));
    assert!(router.is_acknowledged(2));
}

#[test]
fn exhausted_id_source_still_focuses_forwarded_activation_without_emitting() {
    let initial = queue_intent(u64::MAX);
    let router = LaunchIntentRouter::new(4, Some(initial));
    router.frontend_ready(|_| Ok::<_, &'static str>(()));
    let events = Mutex::new(Vec::new());
    let file = Fixture::file("exhausted-forward.R");

    let report = router.route_forwarded_args(
        args([OsString::from(file.path())]),
        Path::new("cwd-is-unused-for-absolute-input"),
        || events.lock().expect("events mutex").push("focus"),
        |_| {
            events.lock().expect("events mutex").push("emit");
            Ok::<_, &'static str>(())
        },
    );

    assert_eq!(*events.lock().expect("events mutex"), ["focus"]);
    assert!(report.delivered_ids.is_empty());
    assert!(report.failures.is_empty());
}

#[test]
fn ignores_executable_argv_zero() {
    let file = Fixture::file("argv-zero.rs");
    let actual = parse_args(
        [OsString::from(file.path())],
        Path::new("this-cwd-must-not-resolve-argv-zero"),
        LaunchSource::Initial,
        7,
    );

    assert_eq!(actual, None);

    let actual = parse_args(
        args([OsString::from(file.path())]),
        Path::new("."),
        LaunchSource::Initial,
        7,
    );
    assert_eq!(
        actual,
        Some(expected(
            7,
            LaunchSource::Initial,
            canonical(file.path())
                .parent()
                .expect("canonical fixture parent"),
            vec![canonical(file.path())],
        ))
    );
}

#[test]
fn resolves_relative_files_against_the_provided_cwd() {
    let file = Fixture::file("relative.R");
    let cwd = file.path().parent().expect("fixture parent");
    let relative = file.path().file_name().expect("fixture file name");

    let actual = parse_args(
        args([OsString::from(relative)]),
        cwd,
        LaunchSource::SingleInstance,
        11,
    );

    assert_eq!(
        actual,
        Some(expected(
            11,
            LaunchSource::SingleInstance,
            canonical(file.path())
                .parent()
                .expect("canonical fixture parent"),
            vec![canonical(file.path())],
        ))
    );
}

#[test]
fn preserves_spaces_and_unicode_in_file_paths() {
    let file = Fixture::file("spaced 文件.Rmd");

    let actual = parse_args(
        args([OsString::from(file.path())]),
        Path::new("."),
        LaunchSource::Initial,
        13,
    )
    .expect("valid launch intent");

    assert_eq!(actual.files, vec![canonical(file.path())]);
}

#[test]
fn returns_canonical_paths_and_uses_the_canonical_parent_as_workspace() {
    let file = Fixture::file("canonical-output.rs");
    let expected_file = canonical(file.path());

    let actual = parse_args(
        args([OsString::from(file.path())]),
        Path::new("."),
        LaunchSource::Initial,
        14,
    )
    .expect("valid launch intent");

    assert_eq!(actual.files, vec![expected_file.clone()]);
    assert_eq!(
        actual.workspace,
        expected_file.parent().expect("canonical fixture parent")
    );
}

#[test]
fn serializes_the_complete_launch_intent_to_the_frontend_json_shape() {
    let file = Fixture::file("serialized-intent.R");
    let canonical_file = canonical(file.path());
    let canonical_workspace = canonical_file
        .parent()
        .expect("canonical fixture parent")
        .to_str()
        .expect("UTF-8 canonical workspace");
    let canonical_file_string = canonical_file.to_str().expect("UTF-8 canonical file");
    let frontend_file_uri =
        tauri::Url::from_file_path(&canonical_file).expect("canonical frontend file URI");
    let intent = parse_args(
        args([OsString::from(file.path())]),
        Path::new("."),
        LaunchSource::SingleInstance,
        15,
    )
    .expect("valid launch intent");

    assert_eq!(frontend_file_uri.scheme(), "file");
    assert_eq!(
        serde_json::to_value(&intent).expect("serialize complete launch intent"),
        serde_json::json!({
            "id": 15,
            "source": "singleInstance",
            "workspace": canonical_workspace,
            "files": [canonical_file_string],
        })
    );
}

#[test]
fn collapses_duplicate_paths_without_reordering_first_occurrences() {
    let first = Fixture::file("first.rs");
    let second = Fixture::file("second.rs");
    let cwd = first.path().parent().expect("fixture parent");
    let first_relative = Path::new(".").join(first.path().file_name().expect("fixture file name"));

    let actual = parse_args(
        args([
            OsString::from(first.path()),
            OsString::from(second.path()),
            first_relative.into_os_string(),
            OsString::from(second.path()),
        ]),
        cwd,
        LaunchSource::SingleInstance,
        17,
    )
    .expect("valid launch intent");

    assert_eq!(
        actual.files,
        vec![canonical(first.path()), canonical(second.path())]
    );
}

#[test]
fn deduplicates_a_large_canonical_batch_without_changing_order() {
    let fixtures = (0..128)
        .map(|index| Fixture::file(&format!("batch-{index}.rs")))
        .collect::<Vec<_>>();
    let candidates = fixtures
        .iter()
        .flat_map(|fixture| {
            [
                OsString::from(fixture.path()),
                OsString::from(fixture.path()),
            ]
        })
        .collect::<Vec<_>>();
    let expected_files = fixtures
        .iter()
        .map(|fixture| canonical(fixture.path()))
        .collect::<Vec<_>>();

    let actual = parse_args(args(candidates), Path::new("."), LaunchSource::Initial, 18)
        .expect("large launch intent");

    assert_eq!(actual.files, expected_files);
}

#[test]
fn uses_the_first_file_parent_as_workspace_and_preserves_file_order() {
    let first = Fixture::nested_file("workspace-first.rs");
    let second = Fixture::nested_file("workspace-second.rs");

    let actual = parse_args(
        args([OsString::from(second.path()), OsString::from(first.path())]),
        Path::new("."),
        LaunchSource::Initial,
        19,
    )
    .expect("valid launch intent");

    assert_eq!(
        actual.workspace,
        canonical(second.path())
            .parent()
            .expect("canonical fixture parent")
    );
    assert_eq!(
        actual.files,
        vec![canonical(second.path()), canonical(first.path())]
    );
}

#[test]
fn rejects_invalid_candidates_without_discarding_valid_files() {
    let first = Fixture::nested_file("first-valid.rs");
    let second = Fixture::nested_file("second-valid.rs");
    let directory = Fixture::directory();
    let missing = std::env::temp_dir().join(Uuid::new_v4().to_string());

    let actual = parse_args(
        args([
            OsString::from(missing),
            OsString::from("--new-window"),
            OsString::from(first.path()),
            OsString::from(directory.path()),
            OsString::from("contains\0nul.rs"),
            OsString::from(second.path()),
        ]),
        Path::new("."),
        LaunchSource::SingleInstance,
        21,
    )
    .expect("valid files remain after rejecting invalid candidates");

    assert_eq!(
        actual.workspace,
        canonical(first.path())
            .parent()
            .expect("canonical fixture parent")
    );
    assert_eq!(
        actual.files,
        vec![canonical(first.path()), canonical(second.path())]
    );
}

#[test]
fn rejects_missing_paths_directories_embedded_nul_and_flags() {
    let missing = std::env::temp_dir().join(Uuid::new_v4().to_string());
    let directory = Fixture::directory();
    let cwd = std::env::temp_dir();

    for invalid in [
        OsString::from(missing),
        OsString::from(directory.path()),
        OsString::from("contains\0nul.rs"),
        OsString::from("--new-window"),
    ] {
        assert_eq!(
            parse_args(args([invalid]), &cwd, LaunchSource::Initial, 23),
            None
        );
    }
}

#[test]
fn accepts_an_existing_relative_dash_filename_before_flag_classification() {
    let file_name = OsString::from(format!("-report-{}.R", Uuid::new_v4()));
    let file = Fixture::named_file(file_name.clone());

    let actual = parse_args(
        args([file_name]),
        &std::env::temp_dir(),
        LaunchSource::Initial,
        25,
    )
    .expect("existing dash filename is a native file");

    assert_eq!(actual.files, vec![canonical(file.path())]);
}

#[test]
fn accepts_local_file_urls_and_rejects_non_file_urls() {
    let file = Fixture::file("opened-url.R");
    let file_url = tauri::Url::from_file_path(file.path()).expect("fixture file URL");
    let http_url = tauri::Url::parse("https://example.com/not-local.R").expect("HTTP URL");
    let nul_url = tauri::Url::parse("file:///contains%00nul.R").expect("NUL file URL");

    assert_eq!(
        parse_opened_urls(std::slice::from_ref(&http_url), LaunchSource::OpenedUrl, 29),
        None
    );
    assert_eq!(
        parse_opened_urls(&[nul_url], LaunchSource::OpenedUrl, 29),
        None
    );
    assert_eq!(
        parse_opened_urls(std::slice::from_ref(&file_url), LaunchSource::OpenedUrl, 29),
        Some(expected(
            29,
            LaunchSource::OpenedUrl,
            canonical(file.path())
                .parent()
                .expect("canonical fixture parent"),
            vec![canonical(file.path())],
        ))
    );
    assert_eq!(
        parse_opened_urls(
            &[http_url.clone(), file_url.clone()],
            LaunchSource::OpenedUrl,
            29
        ),
        Some(expected(
            29,
            LaunchSource::OpenedUrl,
            canonical(file.path())
                .parent()
                .expect("canonical fixture parent"),
            vec![canonical(file.path())],
        ))
    );
    assert_eq!(
        parse_args(
            args([OsString::from(file_url.as_str())]),
            Path::new("."),
            LaunchSource::Initial,
            30,
        ),
        Some(expected(
            30,
            LaunchSource::Initial,
            canonical(file.path())
                .parent()
                .expect("canonical fixture parent"),
            vec![canonical(file.path())],
        ))
    );
    assert_eq!(
        parse_args(
            args([OsString::from(http_url.as_str())]),
            Path::new("."),
            LaunchSource::Initial,
            30,
        ),
        None
    );
}

#[test]
fn launch_sources_serialize_with_clear_camel_case_names() {
    assert_eq!(
        serde_json::to_value(LaunchSource::Initial).expect("serialize initial source"),
        "initial"
    );
    assert_eq!(
        serde_json::to_value(LaunchSource::SingleInstance)
            .expect("serialize single-instance source"),
        "singleInstance"
    );
    assert_eq!(
        serde_json::to_value(LaunchSource::OpenedUrl).expect("serialize opened-URL source"),
        "openedUrl"
    );
}

#[test]
fn rejects_remote_file_url_hosts_even_when_the_remote_path_is_missing() {
    let remote_url = tauri::Url::parse(&format!("file://remote-host/share/{}.R", Uuid::new_v4()))
        .expect("remote file URL");

    assert_eq!(
        parse_args(
            args([OsString::from(remote_url.as_str())]),
            Path::new("."),
            LaunchSource::Initial,
            39,
        ),
        None
    );
    assert_eq!(
        parse_opened_urls(
            std::slice::from_ref(&remote_url),
            LaunchSource::OpenedUrl,
            40,
        ),
        None
    );
}

#[cfg(unix)]
#[derive(Debug)]
struct ExactUnixCleanup {
    files: Vec<PathBuf>,
    directories_deepest_first: Vec<PathBuf>,
}

#[cfg(unix)]
impl Drop for ExactUnixCleanup {
    fn drop(&mut self) {
        for file in &self.files {
            let _ = fs::remove_file(file);
        }
        for directory in &self.directories_deepest_first {
            let _ = fs::remove_dir(directory);
        }
    }
}

#[cfg(unix)]
#[test]
fn rejects_parent_traversal_through_a_regular_file() {
    let base = std::env::temp_dir().join(Uuid::new_v4().to_string());
    fs::create_dir(&base).expect("create traversal fixture root");
    let regular_file = base.join(Uuid::new_v4().to_string());
    let target_name = Uuid::new_v4().to_string();
    let target = base.join(&target_name);
    fs::write(&regular_file, b"regular").expect("create regular-file traversal component");
    fs::write(&target, b"target").expect("create traversal target");
    let _cleanup = ExactUnixCleanup {
        files: vec![regular_file.clone(), target],
        directories_deepest_first: vec![base],
    };
    let input = regular_file.join("..").join(target_name);

    assert_eq!(
        parse_args(
            args([input.into_os_string()]),
            Path::new("."),
            LaunchSource::Initial,
            51,
        ),
        None
    );
}

#[cfg(unix)]
#[test]
fn resolves_parent_components_after_following_symlink_os_semantics() {
    use std::os::unix::fs::symlink;

    let base = std::env::temp_dir().join(Uuid::new_v4().to_string());
    let lexical_parent = base.join(Uuid::new_v4().to_string());
    let real_parent = base.join(Uuid::new_v4().to_string());
    let linked_directory = real_parent.join(Uuid::new_v4().to_string());
    fs::create_dir(&base).expect("create symlink traversal root");
    fs::create_dir(&lexical_parent).expect("create lexical parent");
    fs::create_dir(&real_parent).expect("create real parent");
    fs::create_dir(&linked_directory).expect("create linked directory");

    let target_name = Uuid::new_v4().to_string();
    let lexical_target = lexical_parent.join(&target_name);
    let real_target = real_parent.join(&target_name);
    fs::write(&lexical_target, b"lexical").expect("create lexical target");
    fs::write(&real_target, b"real").expect("create real target");
    let link = lexical_parent.join(Uuid::new_v4().to_string());
    symlink(&linked_directory, &link).expect("create directory symlink");
    let _cleanup = ExactUnixCleanup {
        files: vec![link.clone(), lexical_target, real_target.clone()],
        directories_deepest_first: vec![linked_directory, lexical_parent, real_parent, base],
    };
    let input = link.join("..").join(target_name);

    let actual = parse_args(
        args([input.into_os_string()]),
        Path::new("."),
        LaunchSource::Initial,
        53,
    )
    .expect("OS-resolved symlink traversal");

    assert_eq!(actual.files, vec![canonical(&real_target)]);
}

#[cfg(unix)]
#[test]
fn deduplicates_a_symlink_alias_to_its_canonical_target() {
    use std::os::unix::fs::symlink;

    let base = std::env::temp_dir().join(Uuid::new_v4().to_string());
    fs::create_dir(&base).expect("create symlink alias root");
    let target = base.join(Uuid::new_v4().to_string());
    let alias = base.join(Uuid::new_v4().to_string());
    fs::write(&target, b"target").expect("create symlink target");
    symlink(&target, &alias).expect("create file symlink");
    let _cleanup = ExactUnixCleanup {
        files: vec![alias.clone(), target.clone()],
        directories_deepest_first: vec![base],
    };

    let actual = parse_args(
        args([
            alias.as_os_str().to_os_string(),
            target.as_os_str().to_os_string(),
        ]),
        Path::new("."),
        LaunchSource::Initial,
        55,
    )
    .expect("canonical symlink launch intent");

    assert_eq!(actual.files, vec![canonical(&target)]);
}

#[cfg(unix)]
#[test]
fn accepts_an_existing_relative_native_path_containing_a_colon() {
    let file_name = OsString::from(format!("report:{}.R", Uuid::new_v4()));
    let file = Fixture::named_file(file_name.clone());

    let actual = parse_args(
        args([file_name]),
        &std::env::temp_dir(),
        LaunchSource::Initial,
        57,
    )
    .expect("existing colon path is a native file");

    assert_eq!(actual.files, vec![canonical(file.path())]);
}

#[cfg(unix)]
#[test]
fn rejects_an_existing_non_utf8_filename_before_building_an_intent() {
    use std::os::unix::ffi::OsStringExt;

    let mut file_name = Uuid::new_v4().to_string().into_bytes();
    file_name.extend_from_slice(b"-non-utf8-\xff.R");
    let file = Fixture::named_file(OsString::from_vec(file_name));

    assert_eq!(
        parse_args(
            args([OsString::from(file.path())]),
            Path::new("."),
            LaunchSource::Initial,
            59,
        ),
        None
    );
}

#[cfg(windows)]
fn disk_drive(path: &Path) -> Option<u8> {
    use std::path::Prefix;

    match path.components().next()? {
        std::path::Component::Prefix(prefix) => match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => Some(drive),
            _ => None,
        },
        _ => None,
    }
}

#[cfg(windows)]
fn drive_relative_argument(drive: u8, file_name: &std::ffi::OsStr) -> OsString {
    let mut argument = OsString::from(format!("{}:", char::from(drive)));
    argument.push(file_name);
    argument
}

#[cfg(windows)]
#[test]
fn resolves_same_drive_relative_paths_against_supplied_raw_and_verbatim_cwds() {
    let file = Fixture::nested_file("drive-relative.R");
    let raw_cwd = file.path().parent().expect("fixture parent");
    let verbatim_cwd = canonical(raw_cwd);
    let drive = disk_drive(raw_cwd).expect("fixture disk drive");
    let argument = drive_relative_argument(
        drive.to_ascii_lowercase(),
        file.path().file_name().expect("fixture file name"),
    );

    for supplied_cwd in [raw_cwd, verbatim_cwd.as_path()] {
        let actual = parse_args(
            args([argument.clone()]),
            supplied_cwd,
            LaunchSource::SingleInstance,
            61,
        )
        .expect("same-drive relative file");
        assert_eq!(actual.files, vec![canonical(file.path())]);
    }
}

#[cfg(windows)]
#[test]
fn rejects_drive_relative_paths_for_a_different_drive_or_non_absolute_cwd() {
    let file = Fixture::nested_file("cross-drive-relative.R");
    let cwd = file.path().parent().expect("fixture parent");
    let drive = disk_drive(cwd).expect("fixture disk drive");
    let other_drive = if drive.eq_ignore_ascii_case(&b'C') {
        b'D'
    } else {
        b'C'
    };
    let file_name = file.path().file_name().expect("fixture file name");

    assert_eq!(
        parse_args(
            args([drive_relative_argument(other_drive, file_name)]),
            cwd,
            LaunchSource::SingleInstance,
            63,
        ),
        None
    );
    assert_eq!(
        parse_args(
            args([drive_relative_argument(drive, file_name)]),
            Path::new("relative-cwd"),
            LaunchSource::SingleInstance,
            65,
        ),
        None
    );
}

#[cfg(windows)]
#[test]
fn accepts_an_existing_current_drive_rooted_path_before_flag_classification() {
    let file = Fixture::file("current-drive-rooted.R");
    let mut components = file.path().components();
    assert!(matches!(
        components.next(),
        Some(std::path::Component::Prefix(_))
    ));
    let rooted_argument = components
        .as_path()
        .to_str()
        .expect("UTF-8 rooted fixture path")
        .replace('\\', "/");
    assert!(rooted_argument.starts_with('/'));
    assert!(!Path::new(&rooted_argument).is_absolute());

    let actual = parse_args(
        args([OsString::from(rooted_argument)]),
        file.path().parent().expect("fixture parent"),
        LaunchSource::Initial,
        67,
    )
    .expect("existing current-drive-rooted file");

    assert_eq!(actual.files, vec![canonical(file.path())]);
}

#[cfg(windows)]
fn accessible_remote_url(file: &Path) -> Option<tauri::Url> {
    let host = std::env::var("COMPUTERNAME").ok()?;
    if host.eq_ignore_ascii_case("localhost") {
        eprintln!("skipping remote-host regression: COMPUTERNAME is localhost");
        return None;
    }

    let drive = disk_drive(file)?;
    let mut components = file.components();
    components.next();
    if matches!(
        components.clone().next(),
        Some(std::path::Component::RootDir)
    ) {
        components.next();
    }

    let remote_path = PathBuf::from(format!(r"\\{host}\{}$", char::from(drive)))
        .join(components.collect::<PathBuf>());
    if !remote_path.is_file() {
        eprintln!(
            "skipping accessible remote-host regression: {} is unavailable",
            remote_path.display()
        );
        return None;
    }

    tauri::Url::from_file_path(remote_path).ok()
}

#[cfg(windows)]
#[test]
fn rejects_an_accessible_remote_host_file_url_from_args() {
    let file = Fixture::file("remote-args.R");
    let Some(remote_url) = accessible_remote_url(file.path()) else {
        return;
    };
    assert!(
        remote_url
            .host_str()
            .is_some_and(|host| !host.eq_ignore_ascii_case("localhost")),
        "fixture URL must have a non-local host: {remote_url}"
    );

    assert_eq!(
        parse_args(
            args([OsString::from(remote_url.as_str())]),
            Path::new("."),
            LaunchSource::Initial,
            45,
        ),
        None
    );
}

#[cfg(windows)]
#[test]
fn rejects_an_accessible_remote_host_file_url_from_opened_urls() {
    let file = Fixture::file("remote-opened-url.R");
    let Some(remote_url) = accessible_remote_url(file.path()) else {
        return;
    };

    assert_eq!(
        parse_opened_urls(
            std::slice::from_ref(&remote_url),
            LaunchSource::OpenedUrl,
            47,
        ),
        None
    );
}

#[cfg(windows)]
#[test]
fn accepts_an_accessible_raw_unc_file_path() {
    let file = Fixture::file("raw-unc.R");
    let Some(remote_url) = accessible_remote_url(file.path()) else {
        return;
    };
    let raw_unc = remote_url
        .to_file_path()
        .expect("accessible raw UNC fixture path");
    if !raw_unc.is_file() {
        eprintln!(
            "skipping accessible raw UNC regression: {} is unavailable",
            raw_unc.display()
        );
        return;
    }

    let actual = parse_args(
        args([raw_unc.as_os_str().to_os_string()]),
        Path::new(r"C:\this-cwd-must-not-be-used"),
        LaunchSource::Initial,
        48,
    )
    .expect("accessible raw UNC file path");

    assert_eq!(actual.files, vec![canonical(&raw_unc)]);
}

#[cfg(windows)]
#[test]
fn accepts_localhost_file_urls_when_the_url_maps_to_a_local_file() {
    let file = Fixture::file("localhost-url.R");
    let mut localhost_url = tauri::Url::from_file_path(file.path()).expect("fixture file URL");
    localhost_url
        .set_host(Some("LOCALHOST"))
        .expect("set localhost URL host");
    let Ok(localhost_path) = localhost_url.to_file_path() else {
        eprintln!("skipping localhost regression: URL crate does not map {localhost_url}");
        return;
    };
    if !localhost_path.is_file() {
        eprintln!(
            "skipping localhost regression: {} is unavailable",
            localhost_path.display()
        );
        return;
    }

    assert!(parse_opened_urls(
        std::slice::from_ref(&localhost_url),
        LaunchSource::OpenedUrl,
        49,
    )
    .is_some());
}

#[cfg(windows)]
#[test]
fn collapses_unicode_case_variants_that_resolve_to_the_same_windows_file() {
    let file = Fixture::file("unicode-é.R");
    let alternate_name = file
        .path()
        .file_name()
        .expect("fixture file name")
        .to_string_lossy()
        .replace('é', "É");
    let alternate = file.path().with_file_name(alternate_name);

    if !alternate.is_file() {
        eprintln!(
            "skipping Unicode case-equivalence regression: filesystem does not resolve {}",
            alternate.display()
        );
        return;
    }

    let actual = parse_args(
        args([OsString::from(file.path()), alternate.into_os_string()]),
        Path::new(r"C:\this-cwd-must-not-be-used"),
        LaunchSource::Initial,
        43,
    )
    .expect("Unicode case variants resolve to a launch intent");

    assert_eq!(actual.files, vec![canonical(file.path())]);
}

#[cfg(windows)]
#[test]
fn accepts_existing_drive_paths_and_safely_rejects_missing_unc_paths() {
    let file = Fixture::file("drive-path.rs");
    assert!(file.path().is_absolute());
    assert!(matches!(
        file.path().components().next(),
        Some(std::path::Component::Prefix(_))
    ));

    let drive_intent = parse_args(
        args([OsString::from(file.path())]),
        Path::new(r"C:\this-cwd-must-not-be-used"),
        LaunchSource::Initial,
        31,
    );
    assert!(drive_intent.is_some());

    let alternate_case = file.path().with_file_name(
        file.path()
            .file_name()
            .expect("fixture file name")
            .to_string_lossy()
            .to_ascii_uppercase(),
    );
    let deduplicated = parse_args(
        args([OsString::from(file.path()), alternate_case.into_os_string()]),
        Path::new(r"C:\this-cwd-must-not-be-used"),
        LaunchSource::Initial,
        31,
    )
    .expect("case-insensitive Windows paths");
    assert_eq!(deduplicated.files, vec![canonical(file.path())]);

    let missing_unc = format!(r"\\server\share\{}", Uuid::new_v4());
    assert_eq!(
        parse_args(
            args([OsString::from(missing_unc)]),
            Path::new(r"C:\"),
            LaunchSource::Initial,
            37,
        ),
        None
    );
    assert_eq!(
        parse_args(
            args([OsString::from("/new-window")]),
            Path::new(r"C:\"),
            LaunchSource::Initial,
            41,
        ),
        None
    );
}
