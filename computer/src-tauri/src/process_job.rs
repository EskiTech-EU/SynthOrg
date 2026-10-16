//! Keep the entire editor process tree attached to the Windows application.
//! The OS closes this handle even after a crash or forced termination.
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

pub struct ProcessJob(HANDLE);

impl ProcessJob {
    pub fn new() -> std::io::Result<Self> {
        // SAFETY: all handles and buffer sizes come from the Windows API; the
        // owned handle is closed on every failure path through Drop.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() { return Err(std::io::Error::last_os_error()); }
            let job = Self(handle);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(handle, JobObjectExtendedLimitInformation,
                &info as *const _ as *const _, std::mem::size_of_val(&info) as u32) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            if AssignProcessToJobObject(handle, GetCurrentProcess()) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(job)
        }
    }
}

impl Drop for ProcessJob {
    fn drop(&mut self) {
        // SAFETY: this instance uniquely owns a valid job handle.
        unsafe { CloseHandle(self.0); }
    }
}
