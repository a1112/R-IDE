# Tauri Rust phase evidence (Windows x64)

## Measurement identity

- Measured commit: `cf3b6ac390a86c5e9cb44351f5de33101fba778f`
- Host fingerprint: `c9d29a9892dd025c849e37d6217666e51451ce32c3c3a57390aa8d2dd1f98c37`
- Runtime/profile: Windows x64, `rust-gateway`, `tauri-critical`
- Profile digest: `1f27d23c70095c504c5c5ee06ee15ed7efb9def799a7047dda7eba975c53d91c`
- Packaged plugin digest/count: `fdb4e81d62b548385e9c124d1d61774e853e94127c50c60920a4148773067b0f`, 70 plugins
- Campaign: five runs of the uninstalled release executable, with 30 seconds idle sampling per run
- Raw artifact: `L:\R-IDE-builds\performance-evidence-2026-08-23\rust-phases-windows-x64.json`
- Release executable: `L:\R-IDE-builds\ride-rust-performance-target\release\ride-tauri.exe`

The measurement artifact uses `ride.startup-measurement@4`; every embedded startup report uses `ride.startup-report@3`. All five reports stayed in `rust-gateway` mode. The v4 artifact does not persist campaign timing options, so the exact command, run from the repository's `app` directory, is retained here:

```powershell
node scripts/measure-tauri-startup.mjs --bundle-root L:\R-IDE-builds\ride-rust-performance-target --runs 5 --idle-ms 30000 --timeout-ms 300000 --poll-ms 100 --profile-manifest L:\R-IDE-builds\ride-rust-performance-target\release\resources\backend\ride-tauri-profile.json --output L:\R-IDE-builds\performance-evidence-2026-08-23\rust-phases-windows-x64.json
```

## Disk and build containment

| Volume | Free before | Free after |
| --- | ---: | ---: |
| C: | 20.11 GiB | 20.31 GiB |
| E: | 25.60 GiB | 25.59 GiB |
| L: | 1928.83 GiB | 1915.75 GiB |

Dependencies, Cargo target data, release bundles, and raw evidence remained under `L:\R-IDE-builds`. The final executable is 18,064,384 bytes; the NSIS bundle is 49,841,504 bytes and the MSI is 79,155,992 bytes.

The local Visual Studio installation does not include the MSVC Spectre-mitigated libraries required by optional package `@vscode/windows-ca-certs`. For this local measurement only, its cached source was compiled with the MSBuild `SpectreMitigation=false` property. The resulting module passed a real Windows certificate-store load test. CI/release builders should retain the package's normal Spectre-enabled build and must not copy this local override. Consequently, this campaign supports local phase attribution and functional startup checks, but it does not certify normal CI/release package performance.

## Startup phase results

Durations are derived independently for each run and then summarized; milliseconds are monotonic from process start.

| Phase | Run values (ms) | Median | Slowest |
| --- | --- | ---: | ---: |
| Process start -> runtime paths resolved | 16, 11, 10, 10, 9 | 10 | 16 |
| Runtime paths -> gateway inventory finished | 7, 4, 3, 4, 4 | 4 | 7 |
| Process start -> Tauri setup entered | 677, 959, 460, 435, 463 | 463 | 959 |
| Backend spawn requested -> backend spawned | 12, 17, 12, 10, 12 | 12 | 17 |
| Window build started -> window built | 1060, 868, 590, 582, 591 | 591 | 1060 |
| Window built -> window shown | 0, 1, 0, 0, 0 | 0 | 1 |

The window-build median is 55.9% of the 1057 ms native-window median. Its current checkpoint interval covers the `WebviewWindowBuilder` construction chain, callback registration, and final native `.build()` call; the instrumentation does not separate those costs. The 463 ms setup-entry median includes repository proxy/logging/argument/state preparation and builder/plugin assembly before entering Tauri's setup closure, as well as Tauri runtime and event-loop initialization.

Other packaged medians and diagnostics:

- Native window visible: 1057 ms median, 1831 ms slowest.
- Target file opened: 3468 ms median, 4572 ms slowest.
- Frontend/backend startup overlap: 464 ms median.
- Idle process tree: 10 processes and 1,051,336,704 bytes RSS (1002.6 MiB) median.
- Median role RSS: main 50.3 MiB, backend 149.7 MiB, plugin host 103.8 MiB, WebView renderer 368.7 MiB, WebView GPU 90.7 MiB, WebView utility 67.3 MiB, other 171.2 MiB.
- Gateway fallbacks: 0 of 5.
- Cleanup: passed; no packaged R-IDE process remained after the campaign.

## Selective sampler structural cost

The deterministic cost-contract test presents 4003 topology facts (`N`), of which only three belong to the R-IDE tree (`K`). The sampler performs one sorted identity refresh for exactly `[10, 20, 30]`, so expensive command/executable identity collection is proportional to `K`, not `N`. Branching, process churn, conflicting duplicate PID, missing-root, and stale-sample tests preserve this contract.

## Diagnostic overhead A/B

The pre-diagnostics control was built from `579a53f` and the candidate from `cf3b6ac`, using the same Cargo target, release profile, generated frontend/backend, 70-plugin inventory, profile manifest, and host. The control executable SHA-256 is `d9e582289733f3f609d50a8cb14d08495f4d1359ad7d57ca7b3065b4ae20d8cd`; the candidate SHA-256 is `2fcb29d38b8d7cbaa0bfb67af5bcfd7f53d4ce67871d62f3281274609ae3c61a`.

Ten one-run measurements used an ABBA-balanced sequence (`control, candidate, candidate, control, control, candidate, candidate, control, control, candidate`) with one second of post-readiness idle time. This short campaign is used only for native-window overhead, not for steady-state memory. Every run used host fingerprint `c9d29a9892dd025c849e37d6217666e51451ce32c3c3a57390aa8d2dd1f98c37`, stayed in `rust-gateway`, completed cleanup, and left the target executable restored to the candidate hash.

Before each invocation, the same PowerShell loop copied the scheduled archived executable to `release\ride-tauri.exe`, then ran this command template from the repository's `app` directory with the sequence number and binary label substituted in the output filename:

```powershell
node scripts/measure-tauri-startup.mjs --bundle-root L:\R-IDE-builds\ride-rust-performance-target --runs 1 --idle-ms 1000 --timeout-ms 300000 --poll-ms 100 --profile-manifest L:\R-IDE-builds\ride-rust-performance-target\release\resources\backend\ride-tauri-profile.json --output L:\R-IDE-builds\performance-evidence-2026-08-23\ab-interleaved-<NN>-<kind>.json
```

| Binary | Native-window values (ms) | Median | Candidate delta |
| --- | --- | ---: | ---: |
| Pre-diagnostics control (`ride.startup-report@2`) | 1345, 892, 1086, 874, 858 | 892 | -- |
| Diagnostics candidate (`ride.startup-report@3`) | 996, 868, 901, 932, 849 | 901 | +9 ms |

The observed +9 ms five-sample median delta is nominally inside the design's maximum 10 ms diagnostic-overhead threshold. It does not statistically verify that upper bound: the margin is only 1 ms, individual runs vary by hundreds of milliseconds, and no non-inferiority confidence bound was pre-specified. The result does not claim a startup improvement from diagnostics. Raw one-run artifacts are retained as `L:\R-IDE-builds\performance-evidence-2026-08-23\ab-interleaved-*.json`.

The shared profile manifest identifies the candidate source commit, so its `build.commit` field is also present in control artifacts. It is not used to identify the control binary. The control source commit and archived executable hash above are external records, not fields cryptographically bound into each control JSON; a future measurement schema should persist the executable hash and separate binary/resource commits per run.

## Optimization decision

No additional startup implementation change is selected from the current evidence.

The tightly isolated deltas for runtime paths (10 ms), gateway inventory (4 ms), backend request-to-spawn (12 ms), and show (0 ms) are below the 50 ms / 10% gate. The two numerically material intervals are pre-setup and window construction, but the current checkpoints combine repository preparation with Tauri/Wry/WebView2 work. They do not isolate a bounded repository-owned operation that can be removed with a failing regression test and a credible 15% phase gain.

Changing transparency or shadow would violate the confirmed cross-platform borderless-window contract. Auto-creating a different window or substituting a splash window would alter gateway navigation, secondary-window security callbacks, launch-intent routing, and what `native_window_visible` means. Those are architectural changes, not safe evidence-selected optimizations.

Accordingly, the completed Rust optimization remains the selective process sampler plus startup diagnostics. Further startup work should first add narrower profiling around builder assembly versus Tauri runtime initialization and callback registration versus the final native window build, then separately profile backend/frontend initialization.

The same-host interleaved A/B above observes a nominal +9 ms diagnostics delta, but its noise and 1 ms margin do not conclusively verify the overhead contract. That evidence limitation and the policy failures below prevent accepting Task 7 as complete.

## Policy and packaging verification

Compared with the fixed historical `d034943` baseline, the measured candidate improves target-file median from 5310 ms to 3468 ms (34.7%), RSS from 1,154,154,496 to 1,051,336,704 bytes (8.9%), and process count from 14 to 10 (28.6%).

The Task 7 self-baseline `rust-gateway` policy check did **not** pass:

| Gate | Actual | Target | Delta |
| --- | ---: | ---: | ---: |
| Startup median | 3468 ms | 2200 ms | +1268 ms |
| Startup slowest | 4572 ms | 3000 ms | +1572 ms |
| Window median | 1057 ms | 800 ms | +257 ms |
| RSS (candidate +3% self-baseline) | 1,051,336,704 bytes | <= 1,082,876,805 bytes | -31,540,101 bytes |

The repository's default historical 30% startup / 10% memory-gain policy also does **not** pass. Startup passes at 3468 ms against a 3717 ms target (-249 ms), but RSS fails at 1,051,336,704 bytes against a 1,038,739,046-byte target (+12,597,658 bytes).

The thresholds were not weakened. These failures remain release/CI performance risks and prevent claiming that Task 7 or all performance gates pass.

Local staged-resource/profile verification passed after regenerating the complete frontend/backend profile and incrementally downloading the declared Simplified Chinese language pack. A one-run probe and the five-run campaign against the uninstalled `release\ride-tauri.exe` both reached backend listening, RPC connection, target-file open, and plugin readiness without the previous sidecar `exit code: 1` failure. NSIS and MSI files were produced, but installation, uninstallation, signing, and installed-layout behavior were not tested; their successful creation is not an installer verification result.
