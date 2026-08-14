/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use std::ffi::OsString;
use std::path::PathBuf;

/// The workspace-specific suffix for a backend command line.
///
/// A selected workspace follows `--` so even an option-looking path is passed
/// to Theia as one positional argument. An empty plan preserves Theia's normal
/// recent-workspace startup behavior.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackendLaunchPlan {
    arguments: Vec<OsString>,
}

impl BackendLaunchPlan {
    pub fn new(workspace: Option<PathBuf>) -> Self {
        let arguments = workspace.map_or_else(Vec::new, |workspace| {
            vec![OsString::from("--"), workspace.into_os_string()]
        });
        Self { arguments }
    }

    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }
}
