use ride_tauri::launch_intent::{parse_args, parse_opened_urls, LaunchIntent, LaunchSource};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
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

    #[cfg(unix)]
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
fn accessible_remote_url(file: &Path) -> Option<tauri::Url> {
    use std::path::Prefix;

    let host = std::env::var("COMPUTERNAME").ok()?;
    if host.eq_ignore_ascii_case("localhost") {
        eprintln!("skipping remote-host regression: COMPUTERNAME is localhost");
        return None;
    }

    let mut components = file.components();
    let drive = match components.next()? {
        std::path::Component::Prefix(prefix) => match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive,
            _ => return None,
        },
        _ => return None,
    };
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
