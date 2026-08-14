/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use ride_tauri::startup::BackendLaunchPlan;
use std::ffi::OsString;
use std::path::PathBuf;

#[test]
fn workspace_is_a_single_positional_argument() {
    let workspace = PathBuf::from("workspace with spaces");
    let plan = BackendLaunchPlan::new(Some(workspace.clone()));

    assert_eq!(
        plan.arguments(),
        [OsString::from("--"), workspace.into_os_string()]
    );
}

#[test]
fn option_looking_workspace_is_protected_by_the_argument_terminator() {
    let workspace = PathBuf::from("--inspect");
    let plan = BackendLaunchPlan::new(Some(workspace.clone()));

    assert_eq!(
        plan.arguments(),
        [OsString::from("--"), workspace.into_os_string()]
    );
}

#[test]
fn no_workspace_adds_no_arguments_and_preserves_recent_workspace_behavior() {
    let plan = BackendLaunchPlan::new(None);

    assert!(plan.arguments().is_empty());
}
