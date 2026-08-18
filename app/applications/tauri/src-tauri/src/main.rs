/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Eq, PartialEq)]
enum AppImageIntegrationAction {
    Integrate,
    Unintegrate,
}

#[cfg(any(target_os = "linux", test))]
fn parse_appimage_integration_action<I, S>(args: I) -> Option<AppImageIntegrationAction>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let mut args = args.into_iter();
    args.next()?;
    let action = args.next()?;
    if args.next().is_some() {
        return None;
    }

    if action.as_ref() == std::ffi::OsStr::new("--integrate") {
        Some(AppImageIntegrationAction::Integrate)
    } else if action.as_ref() == std::ffi::OsStr::new("--unintegrate") {
        Some(AppImageIntegrationAction::Unintegrate)
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
fn run_appimage_integration(action: AppImageIntegrationAction) -> i32 {
    let Some(appimage_path) = std::env::var_os("APPIMAGE") else {
        eprintln!("R-IDE AppImage integration requires the APPIMAGE environment variable");
        return 2;
    };
    let executable = match std::env::current_exe() {
        Ok(executable) => executable,
        Err(error) => {
            eprintln!("Cannot locate the R-IDE executable: {error}");
            return 2;
        }
    };
    let Some(usr_directory) = executable.parent().and_then(std::path::Path::parent) else {
        eprintln!("Cannot locate the R-IDE AppImage integration helper");
        return 2;
    };
    let helper = usr_directory.join("lib/R-IDE/appimage-integration.sh");
    let action_argument = match action {
        AppImageIntegrationAction::Integrate => "--integrate",
        AppImageIntegrationAction::Unintegrate => "--unintegrate",
    };

    match std::process::Command::new("/bin/sh")
        .arg(helper)
        .arg(action_argument)
        .arg(appimage_path)
        .status()
    {
        Ok(status) => status.code().unwrap_or(1),
        Err(error) => {
            eprintln!("Cannot run the R-IDE AppImage integration helper: {error}");
            2
        }
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    if let Some(action) = parse_appimage_integration_action(std::env::args_os()) {
        std::process::exit(run_appimage_integration(action));
    }

    ride_tauri::run()
}

#[cfg(test)]
mod tests {
    use super::{parse_appimage_integration_action, AppImageIntegrationAction};

    #[test]
    fn parses_only_an_exact_single_appimage_integration_switch() {
        assert_eq!(
            parse_appimage_integration_action(["R-IDE.AppImage", "--integrate"]),
            Some(AppImageIntegrationAction::Integrate)
        );
        assert_eq!(
            parse_appimage_integration_action(["R-IDE.AppImage", "--unintegrate"]),
            Some(AppImageIntegrationAction::Unintegrate)
        );
        assert_eq!(parse_appimage_integration_action(["R-IDE.AppImage"]), None);
        assert_eq!(
            parse_appimage_integration_action(["R-IDE.AppImage", "source.rs"]),
            None
        );
        assert_eq!(
            parse_appimage_integration_action(["R-IDE.AppImage", "--integrate", "source.rs"]),
            None
        );
    }
}
