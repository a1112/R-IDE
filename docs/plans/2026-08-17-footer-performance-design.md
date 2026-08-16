# R-IDE Footer Performance Indicator Design

## Goal

Add a compact CPU and memory indicator to the right side of the R-IDE footer. The indicator reports the complete R-IDE process tree rather than only the Tauri shell. Hovering it shows a role-based breakdown.

The feature is available in the Tauri desktop runtime on Windows, macOS, and Linux. Browser-only deployments do not show the indicator.

## User experience

The status bar entry uses a compact summary such as:

```text
$(pulse) CPU 2.3%  Memory 684 MB
```

It refreshes every two seconds. Memory automatically switches between MB and GB. CPU is expressed as a percentage of total machine capacity and is bounded to 0–100%.

The hover text contains:

- R-IDE total CPU, memory, and process count.
- Tauri main process CPU and memory.
- Node backend CPU and memory.
- Plugin host CPU, memory, and process count.
- Integrated terminals and other descendants CPU, memory, and process count.

The entry is informational and has no click action in the first version.

## Architecture

### Native sampler

A Rust performance module owns a reusable process sampler as Tauri managed state. Reusing the sampler is necessary because CPU usage is calculated from changes between samples.

Every request refreshes process information, starts at the current Tauri PID, recursively finds descendants through parent PIDs, and aggregates resident memory plus normalized CPU usage. The sampler classifies processes into four mutually exclusive groups:

1. The current Tauri process.
2. The managed backend process.
3. Descendants whose command line identifies the Theia plugin host.
4. All remaining descendants, including integrated terminals and language/tool processes.

The native command returns a serializable snapshot containing the total, role groups, process counts, and sample timestamp. The command performs no background polling by itself.

### Frontend contribution

A dedicated Theia frontend application contribution registers a right-aligned status bar entry after the workbench reaches the ready state. It invokes the Tauri performance command immediately and then every two seconds.

The contribution formats the compact text and multiline tooltip. It removes the timer during frontend shutdown. When the Tauri invoke bridge is unavailable, as in a browser deployment, it does not register the entry.

## Data flow

```text
Theia timer (2 s)
    -> Tauri invoke command
    -> refresh reusable process sampler
    -> discover and classify descendants
    -> aggregate CPU and resident memory
    -> return snapshot
    -> update footer text and hover details
```

Only one request may be active at a time. If a refresh is still running when the next interval fires, that interval is skipped so slow process enumeration cannot build up a request queue.

## Failure handling

- A single sampling failure keeps the last successful value visible.
- Repeated failures replace the text with a compact unavailable state and retain a diagnostic tooltip.
- Errors are rate-limited in the browser console.
- Performance sampling never blocks application startup or changes backend ownership.
- Processes that exit during enumeration are ignored instead of failing the snapshot.

## Testing

Rust unit tests cover descendant discovery, role classification, aggregation, CPU normalization, and disappearing processes through an injectable process-table model.

Frontend tests cover display formatting, MB/GB conversion, tooltip breakdown, the two-second refresh schedule, prevention of overlapping requests, browser-runtime suppression, and timer cleanup.

Integration verification builds the browser and Tauri applications, launches the release executable, confirms that the status bar entry appears, and checks that the snapshot includes the Tauri and backend groups without introducing startup errors.

## Non-goals

- Historical graphs or persistence.
- Per-core CPU charts.
- System-wide CPU or memory usage.
- User-configurable refresh intervals in the first version.
