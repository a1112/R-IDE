/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use std::io;

pub(crate) trait StartupJobFactory {
    type Guard;

    fn create(&self) -> io::Result<Self::Guard>;
}

pub(crate) fn create_if_requested_with<Factory: StartupJobFactory>(
    requested: bool,
    factory: &Factory,
) -> io::Result<Option<Factory::Guard>> {
    if requested {
        factory.create().map(Some)
    } else {
        Ok(None)
    }
}

pub(crate) trait JobApi {
    type Handle;

    fn create_job(&self) -> io::Result<Self::Handle>;
    fn set_kill_on_close(&self, handle: &Self::Handle) -> io::Result<()>;
    fn assign_current_process(&self, handle: &Self::Handle) -> io::Result<()>;
}

pub(crate) fn create_job_with<Api: JobApi>(api: &Api) -> io::Result<Api::Handle> {
    let handle = api.create_job()?;
    api.set_kill_on_close(&handle)?;
    api.assign_current_process(&handle)?;
    Ok(handle)
}

#[cfg(windows)]
mod windows {
    use super::{create_if_requested_with, create_job_with, JobApi, StartupJobFactory};
    use std::ffi::c_void;
    use std::io;
    use std::mem::{size_of, ManuallyDrop};
    use std::ptr;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    #[derive(Debug)]
    pub(crate) struct OwnedJobHandle(HANDLE);

    impl Drop for OwnedJobHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    #[derive(Debug)]
    struct WindowsJobApi;

    impl JobApi for WindowsJobApi {
        type Handle = OwnedJobHandle;

        fn create_job(&self) -> io::Result<Self::Handle> {
            let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
            if handle.is_null() {
                let error = io::Error::last_os_error();
                Err(io::Error::new(
                    error.kind(),
                    format!("cannot create measured-startup Job Object: {error}"),
                ))
            } else {
                Ok(OwnedJobHandle(handle))
            }
        }

        fn set_kill_on_close(&self, handle: &Self::Handle) -> io::Result<()> {
            let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let succeeded = unsafe {
                SetInformationJobObject(
                    handle.0,
                    JobObjectExtendedLimitInformation,
                    &information as *const _ as *const c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if succeeded == 0 {
                let error = io::Error::last_os_error();
                Err(io::Error::new(
                    error.kind(),
                    format!("cannot configure measured-startup Job Object: {error}"),
                ))
            } else {
                Ok(())
            }
        }

        fn assign_current_process(&self, handle: &Self::Handle) -> io::Result<()> {
            let succeeded = unsafe { AssignProcessToJobObject(handle.0, GetCurrentProcess()) };
            if succeeded == 0 {
                let error = io::Error::last_os_error();
                Err(io::Error::new(
                    error.kind(),
                    format!("cannot assign R-IDE to measured-startup Job Object: {error}"),
                ))
            } else {
                Ok(())
            }
        }
    }

    #[derive(Debug)]
    struct WindowsJobFactory;

    impl StartupJobFactory for WindowsJobFactory {
        type Guard = OwnedJobHandle;

        fn create(&self) -> io::Result<Self::Guard> {
            create_job_with(&WindowsJobApi)
        }
    }

    #[derive(Debug)]
    pub(crate) struct StartupJobLease {
        // Closing the last Job handle while the root is still alive would
        // terminate the root itself. ManuallyDrop leaves the handle to the OS,
        // which closes it during actual process teardown and then kills every
        // still-running process inherited into the Job.
        _process_lifetime_handle: ManuallyDrop<OwnedJobHandle>,
    }

    impl StartupJobLease {
        fn new(handle: OwnedJobHandle) -> Self {
            Self {
                _process_lifetime_handle: ManuallyDrop::new(handle),
            }
        }
    }

    pub(crate) fn create_for_current_process_if_requested(
        requested: bool,
    ) -> io::Result<Option<StartupJobLease>> {
        create_if_requested_with(requested, &WindowsJobFactory)
            .map(|job| job.map(StartupJobLease::new))
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub(crate) fn create_kill_on_close_job_for_current_process() -> io::Result<OwnedJobHandle> {
        create_job_with(&WindowsJobApi)
    }
}

#[cfg(windows)]
pub(crate) use windows::create_for_current_process_if_requested;

#[cfg(all(windows, test))]
#[allow(unused_imports)]
pub(crate) use windows::create_kill_on_close_job_for_current_process;

#[cfg(not(windows))]
#[derive(Debug)]
pub(crate) struct StartupJobLease;

#[cfg(not(windows))]
pub(crate) fn create_for_current_process_if_requested(
    _requested: bool,
) -> io::Result<Option<StartupJobLease>> {
    Ok(None)
}
