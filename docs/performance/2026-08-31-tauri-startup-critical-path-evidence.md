# Tauri startup critical-path evidence (2026-08-31)

## Scope and identity

- Branch: `codex/codex-app-server-integration`
- Measured commit: `70786321b9e5357ad41b44fe1a668d10df2cfaa3`
- Runtime: Windows x64, `rust-gateway`, `tauri-critical`
- Profile build ID: `802a0274-e30c-46c6-b8a2-4d1bb98fbc78`
- Profile digest: `7968e170a8201128c26ac25a3a52290a19f0b4aa2147b6698e077014472848f2`
- Host fingerprint: `c9d29a9892dd025c849e37d6217666e51451ce32c3c3a57390aa8d2dd1f98c37`
- Runtime EXE SHA-256: `60AD521E9AC48B7BA44CF2B4EBD771CCED94C32A70EE0331FA221307EF8581A3`

The runtime and evidence were placed on `H:` because the repository drive had no
usable free space. Cargo output remained on `L:`. No measurement artifact was
written to the repository drive.

## Verification gates

The following gates completed with no test failure:

- all script tests: 526 passed;
- Product extension tests: 274 passed;
- Codex extension tests: 815 passed;
- Rust `--locked --all-targets`: all suites passed, with one explicitly ignored
  test and no failure;
- Product, Codex, launcher, and updater extension production builds;
- Tauri profile verification and Codex packaging verification;
- release EXE, NSIS, and MSI generation.

The final installers are:

| Artifact | SHA-256 |
| --- | --- |
| `L:\R-IDE-builds\ride-codex-app-server-tauri-target\release\bundle\nsis\R-IDE_1.72.100_x64-setup.exe` | `B688E74D96E957A4489C9704E9CBF6BDFFDF8B82DCF0EAFA890B238695429814` |
| `L:\R-IDE-builds\ride-codex-app-server-tauri-target\release\bundle\msi\R-IDE_1.72.100_x64_en-US.msi` | `D622C80A70510FCE23105FF7E421BD261CF984D145110989B7AB6569DCC3F80B` |

The first packaged diagnostic run exposed that the new command was rejected by
the release ACL even though its dedicated permission was embedded. Commit
`7078632` adds the diagnostic command to the already-granted startup milestone
permission as a duplicate narrow authorization. The permission audit followed a
RED/GREEN cycle, all 526 script tests passed afterwards, and the rebuilt runtime
contained no further ACL rejection.

## Packaged smoke

The final clean-commit runtime was staged at:

`H:\R-IDE-builds\startup-critical-path-7078632-20260831-0003`

Commands:

```powershell
node app/scripts/run-tauri-packaged-smoke.mjs --scenario critical-file --executable 'H:\R-IDE-builds\startup-critical-path-7078632-20260831-0003\ride-tauri.exe' --output 'H:\R-IDE-builds\startup-critical-path-7078632-20260831-0003\critical-file-smoke.json' --timeout-ms 60000
node app/scripts/run-tauri-packaged-smoke.mjs --scenario codex --executable 'H:\R-IDE-builds\startup-critical-path-7078632-20260831-0003\ride-tauri.exe' --output 'H:\R-IDE-builds\startup-critical-path-7078632-20260831-0003\codex-smoke.json' --timeout-ms 60000
```

Both scenarios passed on their formal attempt. `critical-file` completed all
seven actions in 2,762 ms; `codex` completed all eight actions in 1,196 ms. Both
reported `rust-gateway`, one backend generation, and zero old backend-tree
processes after cleanup.

## Five-run campaign

Command:

```powershell
node app/scripts/measure-tauri-startup.mjs --executable 'H:\R-IDE-builds\startup-critical-path-7078632-20260831-0003\ride-tauri.exe' --runs 5 --idle-ms 3000 --timeout-ms 30000 --poll-ms 25 --output 'H:\R-IDE-builds\startup-critical-path-7078632-20260831-0003\startup-5-run.json' --diagnostics-output 'H:\R-IDE-builds\startup-critical-path-7078632-20260831-0003\startup-diagnostics-5-run.json' --profile-manifest 'H:\R-IDE-builds\startup-critical-path-7078632-20260831-0003\resources\backend\ride-tauri-profile.json'
```

The ordinary and diagnostic artifacts each contain five runs with identical
build and host identity. No failure companion was created and no runtime process
survived cleanup.

| Metric | Runs | Median | Range |
| --- | --- | ---: | ---: |
| target file opened (ms) | 2768, 2405, 2389, 2828, 2389 | 2405 | 2389-2828 |
| native window visible (ms) | 446, 456, 427, 455, 431 | 446 | 427-456 |
| whole-tree RSS (bytes) | 1347473408, 1320468480, 1322987520, 1332969472, 1318395904 | 1322987520 | 1318395904-1347473408 |

Critical-path segments:

| Segment | Runs (ms) | Median | Spread |
| --- | --- | ---: | ---: |
| frontend initialization -> attached shell | 13, 5, 13, 29, 9 | 13 | 24 |
| attached shell -> workspace ready | 291, 292, 253, 274, 2 | 274 | 290 |
| workspace ready -> native listener | 33, 25, 33, 39, 18 | 33 | 21 |
| native listener -> initial request | 6, 11, 2, 1, 245 | 6 | 244 |
| initial request -> target open | 2, 1, 6, 4, 97 | 4 | 96 |
| target open -> model resolved | 89, 58, 59, 124, 27 | 59 | 97 |
| model resolved -> widget activated | 19, 41, 44, 12, 19 | 19 | 32 |
| widget activated -> milestone requested | 1, 5, 6, 2, 4 | 4 | 5 |

Only `attached shell -> workspace ready` has a median of at least 100 ms. Its
290 ms slowest/fastest spread exceeds its 274 ms median, so it is not bounded
enough to distinguish a code change from host noise. Under the approved
selection rule no speculative source optimization was retained.

## Release policy result

The absolute policy was checked against the campaign itself to isolate the
fixed release limits from historical cross-profile memory differences:

```powershell
node app/scripts/check-tauri-performance.mjs --baseline 'H:\R-IDE-builds\startup-critical-path-7078632-20260831-0003\startup-5-run.json' --candidate 'H:\R-IDE-builds\startup-critical-path-7078632-20260831-0003\startup-5-run.json' --policy rust-gateway --max-startup-median-ms 2200 --max-startup-slowest-ms 3000 --max-window-median-ms 800 --max-memory-regression-percent 3
```

The check failed only the startup-median limit: 2,405 ms actual versus 2,200 ms
target, a +205 ms miss. The 2,828 ms slowest run, 446 ms window median, and
self-baseline RSS policy were within limits.

Conclusion: diagnostics, packaging, smoke coverage, and cleanup are healthy, but
the branch is not eligible for push/release under the unchanged 2,200 ms startup
gate. Keep the diagnostic implementation and the ACL fix; do not push until a
separate stable optimization closes the 205 ms gap or an explicit exception is
approved with this miss disclosed.
