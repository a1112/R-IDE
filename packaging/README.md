# R-Box Windows preview

Build with Node 24.15.0, Yarn Classic 1.22.22, Python 3.12, Rust 1.94.1 and Visual Studio C++ tools:

```
python packaging/build_windows.py
```

The Windows CA certificate addon requires Visual Studio's Spectre runtime libraries by default. On a preview build machine without that optional toolchain component, an explicit `--allow-no-spectre-libraries` option keeps `/Qspectre` on the addon compilation and links the installed regular MSVC runtime libraries. `build-info.json` records this limitation; use the default build with Spectre libraries for the hardened release. This option does not install or alter the global compiler.

Keep the complete payload tree together: `ride-tauri.exe`, `resources/backend` (including Node, node-pty and backend modules), `resources/plugins`, `lib/frontend`, `package.json` and notices. The frontend profile and plugins are verified using the project's existing packaged-smoke protocols. The build skips unused Electron/browser downloads, then builds the actual Tauri frontend and backend.

The backend uses a Windows Job Object and owned-loopback readiness checks. Closing the main window requests normal cleanup; forced desktop termination closes the owned process tree. Release startup uses the packaged Node runtime. Theia preferences and state use `RIDE_CONFIG_DIR` or the current-user `~/.ride-tauri`; downloaded user plugins use `~/.ride`, outside the version directory. The preview identifier is separate from the original application.

WebView2 is required. Git, language servers, external AI services and language toolchains remain user-configured. Clean Windows and macOS/Linux acceptance, AI calls and remote integration remain pending.
