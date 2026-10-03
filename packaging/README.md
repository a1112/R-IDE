# R-Box Windows preview

The preview includes its backend, Node runtime, native terminal addon and 70 plugins. See `ACCEPTANCE.md` for actual Windows verification and remaining limitations, including low/moderate dependency advisories.

Build with Node 24.15.0, Yarn Classic 1.22.22, Python 3.12, Rust 1.94.1 and Visual Studio C++ tools:

```
python packaging/build_windows.py
```

The existing Tauri build uses Node's public certificate store when the optional Windows CA certificate addon is unavailable. This preview follows that existing fallback; custom Windows certificate roots and enterprise proxy integration remain unverified. The build does not weaken vendor compiler options or install global compiler components.

The build checks clean source attestation, compares the installed private decompressor bridge with its source bytes, and audits real package versions contributing code to final esbuild outputs. High/critical matches fail staging. The included audit report lists remaining findings and scope exclusions. Node 24 environment proxy settings apply to the official npm advisory request.

Keep the complete payload tree together: `ride-tauri.exe`, `resources/backend` (including Node, node-pty and backend modules), `resources/plugins`, `lib/frontend`, `package.json` and notices. The frontend profile and plugins are verified using the project's existing packaged-smoke protocols. The build skips unused Electron/browser downloads, then builds the actual Tauri frontend and backend.

The backend uses a Windows Job Object and owned-loopback readiness checks. Closing the main window requests normal cleanup; forced desktop termination closes the owned process tree. Release startup uses the packaged Node runtime. Theia preferences, state, downloads and user plugins share `RIDE_CONFIG_DIR` or the current-user `~/.ride-tauri-rbox-preview`, outside the version directory. The preview identifier is separate from the original application.

The desktop resolves a relative `RIDE_CONFIG_DIR` to an absolute path before starting child processes. Paths containing `..` components are rejected consistently by backend startup and download storage. An empty override or unavailable home directory produces a startup error instead of storing a default profile in the installation directory.

WebView2 is required. Git, language servers, external AI services and language toolchains remain user-configured. Clean Windows and macOS/Linux acceptance, AI calls and remote integration remain pending.

Run the owned-process acceptance driver with Python 3.12 and `psutil`, one scenario at a time because the application is single-instance and owns port 3000:

```
python packaging/smoke_windows.py --scenario critical-empty
python packaging/smoke_windows.py --scenario critical-file
python packaging/smoke_windows.py --scenario lifecycle
python packaging/smoke_windows.py --scenario failures
python packaging/smoke_windows.py --scenario backend-retry
```
