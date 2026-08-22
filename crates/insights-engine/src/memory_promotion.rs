//! Promotion write path helpers for the Team Memory Stage 4c ops (design doc
//! `docs/team-memory-phase1-design.md` §2 tx-promotion, §4; proposal D5, §6.5).
//!
//! Provides:
//! - the git blob OID (`git hash-object` semantics) computed in pure Rust with
//!   the pinned RustCrypto `sha1` crate, so the `promotion-apply` content CAS
//!   does not depend on the Node side being honest;
//! - a strict RFC 4648 base64 decoder for `promotion-plan` sanitized content
//!   (the repository deliberately avoids a base64 crate);
//! - a fail-closed, no-follow, per-segment worktree file reader/writer: every
//!   directory level is opened with `openat(..., O_NOFOLLOW | O_DIRECTORY)`
//!   relative to the previous level's descriptor, the leaf is opened with
//!   `O_NOFOLLOW`, and writes go through a same-directory temporary file plus
//!   atomic `renameat`. Any symlink at any level aborts with
//!   [`PromotionFsError::Symlink`], which `promotion-apply` maps to voiding
//!   the plan.

use sha1::{Digest, Sha1};
use std::fmt;
use std::path::Path;

/// Errors from the worktree traversal. `Symlink` is the fail-closed signal
/// that voids the promotion plan; `Io` leaves the plan `applying` (resumable).
#[derive(Debug)]
pub enum PromotionFsError {
    /// A traversal component (directory segment or leaf) is a symlink.
    Symlink,
    Io(std::io::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConditionalMutationOutcome {
    Applied,
    Drift,
    RecoveryRequired { staging_name: String },
}

#[derive(Debug, Clone, Copy)]
pub enum ExpectedWorktreeValue<'a> {
    Missing,
    Bytes(&'a [u8]),
    GitBlob(&'a str),
}

impl ExpectedWorktreeValue<'_> {
    fn matches(self, value: Option<&[u8]>) -> bool {
        match self {
            Self::Missing => value.is_none(),
            Self::Bytes(expected) => value == Some(expected),
            Self::GitBlob(expected) => {
                value.is_some_and(|bytes| git_blob_oid_hex(bytes) == expected)
            }
        }
    }
}

impl fmt::Display for PromotionFsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Symlink => formatter.write_str("a path component is a symbolic link"),
            Self::Io(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for PromotionFsError {}

/// `sha1("blob {len}\0" + bytes)`, the git blob object id, lowercase hex40.
pub fn git_blob_oid_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", bytes.len()).as_bytes());
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn sextet(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Strict standard-alphabet base64 with mandatory padding: length must be a
/// multiple of four, `=` may only appear as the final one or two characters.
pub fn decode_base64(input: &str) -> Option<Vec<u8>> {
    let bytes = input.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let chunk_count = bytes.len() / 4;
    let mut out = Vec::with_capacity(chunk_count * 3);
    for (index, chunk) in bytes.chunks(4).enumerate() {
        let is_last = index + 1 == chunk_count;
        let mut values = [0u8; 4];
        let mut pad = 0usize;
        for (position, byte) in chunk.iter().enumerate() {
            if *byte == b'=' {
                if !is_last || position < 2 {
                    return None;
                }
                pad += 1;
            } else {
                if pad > 0 {
                    return None;
                }
                values[position] = sextet(*byte)?;
            }
        }
        let word = (u32::from(values[0]) << 18)
            | (u32::from(values[1]) << 12)
            | (u32::from(values[2]) << 6)
            | u32::from(values[3]);
        out.push((word >> 16) as u8);
        if pad < 2 {
            out.push((word >> 8) as u8);
        }
        if pad < 1 {
            out.push(word as u8);
        }
    }
    Some(out)
}

/// Reads the current bytes of `segments` below `root` with the no-follow
/// traversal. `Ok(None)` when the file (or any intermediate directory) does
/// not exist. Fails closed on any symlink component.
pub fn read_worktree_file(
    root: &Path,
    segments: &[&str],
) -> Result<Option<Vec<u8>>, PromotionFsError> {
    imp::read_worktree_file(root, segments)
}

/// Lists one directory below `root` through the same no-follow descriptor
/// traversal as promotion reads. `Ok(None)` means a directory in the path is
/// absent. Returned names are UTF-8 and sorted bytewise.
pub fn list_worktree_directory(
    root: &Path,
    segments: &[&str],
) -> Result<Option<Vec<String>>, PromotionFsError> {
    imp::list_worktree_directory(root, segments)
}

/// Writes exactly `bytes` to `segments` below `root`: no-follow traversal,
/// missing directories created, same-directory temporary file, atomic rename.
pub fn write_worktree_file(
    root: &Path,
    segments: &[&str],
    bytes: &[u8],
) -> Result<(), PromotionFsError> {
    imp::write_worktree_file(root, segments, bytes)
}

/// Deletes one regular file below `root` using the same descriptor-relative,
/// no-follow traversal as reads/writes. Returns `Ok(false)` when the target is
/// already absent; symlink and non-regular targets fail closed.
pub fn delete_worktree_file(root: &Path, segments: &[&str]) -> Result<bool, PromotionFsError> {
    imp::delete_worktree_file(root, segments)
}

/// Replaces or removes a worktree file without clobbering a value that raced
/// with the caller's CAS check. The deterministic token binds recoverable,
/// same-directory artifacts to the already-persisted promotion intent.
pub fn conditional_replace_worktree_file(
    root: &Path,
    segments: &[&str],
    expected: ExpectedWorktreeValue<'_>,
    replacement: Option<&[u8]>,
    staging_token: &str,
) -> Result<ConditionalMutationOutcome, PromotionFsError> {
    imp::conditional_replace_worktree_file(
        root,
        segments,
        expected,
        replacement,
        staging_token,
        || {},
    )
}

/// Removes recoverable artifacts only after their bytes still match the
/// journal-bound old/new values.
pub fn cleanup_worktree_mutation_artifacts(
    root: &Path,
    segments: &[&str],
    expected: ExpectedWorktreeValue<'_>,
    replacement: Option<&[u8]>,
    staging_token: &str,
) -> Result<ConditionalMutationOutcome, PromotionFsError> {
    imp::cleanup_worktree_mutation_artifacts(root, segments, expected, replacement, staging_token)
}

#[cfg(unix)]
mod imp {
    use super::{ConditionalMutationOutcome, ExpectedWorktreeValue, PromotionFsError};
    use std::ffi::{CStr, CString};
    use std::fs::File;
    use std::io::{ErrorKind, Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::OpenOptionsExt;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};

    pub(super) static NEXT_TEMP_FILE: AtomicU64 = AtomicU64::new(0);

    fn io_error(error: std::io::Error) -> PromotionFsError {
        PromotionFsError::Io(error)
    }

    fn is_symlink_errno(error: &std::io::Error) -> bool {
        matches!(error.raw_os_error(), Some(libc::ELOOP) | Some(libc::EMLINK))
    }

    /// Classifies an already-refused `O_DIRECTORY | O_NOFOLLOW` open: on macOS
    /// a symlinked segment surfaces as `ENOTDIR` instead of `ELOOP`. The open
    /// itself is the fail-closed guarantee; this `fstatat` only decides
    /// whether the refusal voids the plan (symlink) or stays an I/O error.
    fn is_symlink_at(parent: &File, name: &CString) -> bool {
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        let outcome = unsafe {
            libc::fstatat(
                parent.as_raw_fd(),
                name.as_ptr(),
                &mut stat,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        outcome == 0 && (stat.st_mode & libc::S_IFMT) == libc::S_IFLNK
    }

    fn segment_cstring(segment: &str) -> Result<CString, PromotionFsError> {
        CString::new(segment).map_err(|_| {
            io_error(std::io::Error::new(
                ErrorKind::InvalidInput,
                "path segment contains NUL",
            ))
        })
    }

    fn openat(
        parent: &File,
        name: &CString,
        flags: libc::c_int,
        mode: libc::c_int,
    ) -> Result<File, std::io::Error> {
        let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags, mode) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    fn staging_names(token: &str) -> Result<(CString, CString), PromotionFsError> {
        if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(io_error(std::io::Error::new(
                ErrorKind::InvalidInput,
                "promotion staging token must be 64 hexadecimal characters",
            )));
        }
        Ok((
            segment_cstring(&format!(".threadshare-promotion-{token}.hold"))?,
            segment_cstring(&format!(".threadshare-promotion-{token}.new"))?,
        ))
    }

    fn read_regular_at(parent: &File, name: &CString) -> Result<Option<Vec<u8>>, PromotionFsError> {
        let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let mut file = match openat(parent, name, flags, 0) {
            Ok(file) => file,
            Err(error) if is_symlink_errno(&error) => return Err(PromotionFsError::Symlink),
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_error(error)),
        };
        if !file.metadata().map_err(io_error)?.is_file() {
            return Err(io_error(std::io::Error::new(
                ErrorKind::InvalidInput,
                "the promotion path exists but is not a regular file",
            )));
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(io_error)?;
        Ok(Some(bytes))
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    fn rename_noreplace(
        parent: &File,
        source: &CString,
        target: &CString,
    ) -> Result<(), std::io::Error> {
        // musl does not export renameat2, so call the Linux syscall directly.
        let outcome = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                parent.as_raw_fd(),
                source.as_ptr(),
                parent.as_raw_fd(),
                target.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if outcome == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    fn rename_noreplace(
        parent: &File,
        source: &CString,
        target: &CString,
    ) -> Result<(), std::io::Error> {
        let outcome = unsafe {
            libc::renameatx_np(
                parent.as_raw_fd(),
                source.as_ptr(),
                parent.as_raw_fd(),
                target.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        if outcome == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    #[cfg(not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    )))]
    fn rename_noreplace(
        _parent: &File,
        _source: &CString,
        _target: &CString,
    ) -> Result<(), std::io::Error> {
        Err(std::io::Error::new(
            ErrorKind::Unsupported,
            "atomic no-replace rename is unavailable on this platform",
        ))
    }

    fn create_replacement(
        parent: &File,
        name: &CString,
        bytes: &[u8],
    ) -> Result<(), PromotionFsError> {
        if let Some(existing) = read_regular_at(parent, name)? {
            return if existing == bytes {
                Ok(())
            } else {
                Err(io_error(std::io::Error::new(
                    ErrorKind::AlreadyExists,
                    "promotion replacement staging file contains unexpected bytes",
                )))
            };
        }
        let flags =
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let mut file = openat(parent, name, flags, 0o600).map_err(io_error)?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(io_error)
    }

    fn remove_known_artifact(
        parent: &File,
        name: &CString,
        expected: &[u8],
    ) -> Result<ConditionalMutationOutcome, PromotionFsError> {
        let Some(bytes) = read_regular_at(parent, name)? else {
            return Ok(ConditionalMutationOutcome::Applied);
        };
        if bytes != expected {
            return Ok(ConditionalMutationOutcome::RecoveryRequired {
                staging_name: name.to_string_lossy().into_owned(),
            });
        }
        if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            return Err(io_error(std::io::Error::last_os_error()));
        }
        parent.sync_all().map_err(io_error)?;
        Ok(ConditionalMutationOutcome::Applied)
    }

    fn open_root(root: &Path) -> Result<File, PromotionFsError> {
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(root)
            .map_err(|error| {
                let refused_symlink = is_symlink_errno(&error)
                    || (error.raw_os_error() == Some(libc::ENOTDIR)
                        && std::fs::symlink_metadata(root)
                            .is_ok_and(|metadata| metadata.file_type().is_symlink()));
                if refused_symlink {
                    PromotionFsError::Symlink
                } else {
                    io_error(error)
                }
            })
    }

    /// Opens one directory segment relative to `parent`, refusing symlinks.
    /// With `create`, a missing directory is created (`mkdirat`) and reopened.
    fn descend(
        parent: &File,
        segment: &str,
        create: bool,
    ) -> Result<Option<File>, PromotionFsError> {
        let name = segment_cstring(segment)?;
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        loop {
            match openat(parent, &name, flags, 0) {
                Ok(directory) => return Ok(Some(directory)),
                Err(error) if is_symlink_errno(&error) => return Err(PromotionFsError::Symlink),
                Err(error)
                    if error.raw_os_error() == Some(libc::ENOTDIR)
                        && is_symlink_at(parent, &name) =>
                {
                    return Err(PromotionFsError::Symlink);
                }
                Err(error) if error.kind() == ErrorKind::NotFound => {
                    if !create {
                        return Ok(None);
                    }
                    let created =
                        unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o755) };
                    if created != 0 {
                        let mkdir_error = std::io::Error::last_os_error();
                        if mkdir_error.kind() != ErrorKind::AlreadyExists {
                            return Err(io_error(mkdir_error));
                        }
                    }
                    // Retry the open; a symlink racing into place still fails
                    // closed through O_NOFOLLOW above.
                }
                Err(error) => return Err(io_error(error)),
            }
        }
    }

    fn open_parent(
        root: &Path,
        segments: &[&str],
        create: bool,
    ) -> Result<Option<File>, PromotionFsError> {
        let mut directory = open_root(root)?;
        for segment in &segments[..segments.len() - 1] {
            match descend(&directory, segment, create)? {
                Some(next) => directory = next,
                None => return Ok(None),
            }
        }
        Ok(Some(directory))
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    unsafe fn errno_location() -> *mut libc::c_int {
        unsafe { libc::__errno_location() }
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    unsafe fn errno_location() -> *mut libc::c_int {
        unsafe { libc::__error() }
    }

    #[cfg(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    ))]
    pub(super) fn list_worktree_directory(
        root: &Path,
        segments: &[&str],
    ) -> Result<Option<Vec<String>>, PromotionFsError> {
        let mut directory = open_root(root)?;
        for segment in segments {
            match descend(&directory, segment, false)? {
                Some(next) => directory = next,
                None => return Ok(None),
            }
        }
        let duplicate = unsafe { libc::fcntl(directory.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
        if duplicate < 0 {
            return Err(io_error(std::io::Error::last_os_error()));
        }
        let stream = unsafe { libc::fdopendir(duplicate) };
        if stream.is_null() {
            let error = std::io::Error::last_os_error();
            unsafe { libc::close(duplicate) };
            return Err(io_error(error));
        }

        let mut names = Vec::new();
        let mut read_error = None;
        loop {
            unsafe { *errno_location() = 0 };
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                let errno = unsafe { *errno_location() };
                if errno != 0 {
                    read_error = Some(std::io::Error::from_raw_os_error(errno));
                }
                break;
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if matches!(name, b"." | b"..") {
                continue;
            }
            let name = match std::str::from_utf8(name) {
                Ok(name) => name.to_owned(),
                Err(_) => {
                    read_error = Some(std::io::Error::new(
                        ErrorKind::InvalidData,
                        "directory entry is not valid UTF-8",
                    ));
                    break;
                }
            };
            names.push(name);
        }
        let close_error = if unsafe { libc::closedir(stream) } == 0 {
            None
        } else {
            Some(std::io::Error::last_os_error())
        };
        if let Some(error) = read_error.or(close_error) {
            return Err(io_error(error));
        }
        names.sort();
        Ok(Some(names))
    }

    #[cfg(not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    )))]
    pub(super) fn list_worktree_directory(
        _root: &Path,
        _segments: &[&str],
    ) -> Result<Option<Vec<String>>, PromotionFsError> {
        Err(io_error(std::io::Error::new(
            ErrorKind::Unsupported,
            "secure directory listing is unavailable on this Unix platform",
        )))
    }

    pub(super) fn read_worktree_file(
        root: &Path,
        segments: &[&str],
    ) -> Result<Option<Vec<u8>>, PromotionFsError> {
        assert!(!segments.is_empty(), "target path must have segments");
        let Some(parent) = open_parent(root, segments, false)? else {
            return Ok(None);
        };
        let name = segment_cstring(segments[segments.len() - 1])?;
        let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let mut file = match openat(&parent, &name, flags, 0) {
            Ok(file) => file,
            Err(error) if is_symlink_errno(&error) => return Err(PromotionFsError::Symlink),
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_error(error)),
        };
        let metadata = file.metadata().map_err(io_error)?;
        if !metadata.is_file() {
            return Err(io_error(std::io::Error::new(
                ErrorKind::InvalidInput,
                "the promotion target exists but is not a regular file",
            )));
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(io_error)?;
        Ok(Some(bytes))
    }

    pub(super) fn write_worktree_file(
        root: &Path,
        segments: &[&str],
        bytes: &[u8],
    ) -> Result<(), PromotionFsError> {
        assert!(!segments.is_empty(), "target path must have segments");
        let parent = open_parent(root, segments, true)?
            .expect("create mode always yields a parent directory");
        let final_name = segment_cstring(segments[segments.len() - 1])?;
        let temp_name = format!(
            ".threadshare-promotion-{}-{}.tmp",
            std::process::id(),
            NEXT_TEMP_FILE.fetch_add(1, Ordering::Relaxed)
        );
        let temp_cstring = segment_cstring(&temp_name)?;
        let flags =
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let mut temp_file = match openat(&parent, &temp_cstring, flags, 0o644) {
            Ok(file) => file,
            Err(error) if is_symlink_errno(&error) => return Err(PromotionFsError::Symlink),
            Err(error) => return Err(io_error(error)),
        };
        let written = temp_file
            .write_all(bytes)
            .and_then(|()| temp_file.sync_all());
        drop(temp_file);
        let renamed = written.and_then(|()| {
            let outcome = unsafe {
                libc::renameat(
                    parent.as_raw_fd(),
                    temp_cstring.as_ptr(),
                    parent.as_raw_fd(),
                    final_name.as_ptr(),
                )
            };
            if outcome != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
        if let Err(error) = renamed {
            unsafe { libc::unlinkat(parent.as_raw_fd(), temp_cstring.as_ptr(), 0) };
            return Err(io_error(error));
        }
        Ok(())
    }

    pub(super) fn delete_worktree_file(
        root: &Path,
        segments: &[&str],
    ) -> Result<bool, PromotionFsError> {
        assert!(!segments.is_empty(), "target path must have segments");
        let Some(parent) = open_parent(root, segments, false)? else {
            return Ok(false);
        };
        let name = segment_cstring(segments[segments.len() - 1])?;
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        let inspected = unsafe {
            libc::fstatat(
                parent.as_raw_fd(),
                name.as_ptr(),
                &mut stat,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if inspected != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == ErrorKind::NotFound {
                return Ok(false);
            }
            return Err(io_error(error));
        }
        match stat.st_mode & libc::S_IFMT {
            libc::S_IFLNK => return Err(PromotionFsError::Symlink),
            libc::S_IFREG => {}
            _ => {
                return Err(io_error(std::io::Error::new(
                    ErrorKind::InvalidInput,
                    "the promotion delete target is not a regular file",
                )));
            }
        }
        let deleted = unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) };
        if deleted != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == ErrorKind::NotFound {
                return Ok(false);
            }
            return Err(io_error(error));
        }
        parent.sync_all().map_err(io_error)?;
        Ok(true)
    }

    pub(super) fn conditional_replace_worktree_file<F>(
        root: &Path,
        segments: &[&str],
        expected: ExpectedWorktreeValue<'_>,
        replacement: Option<&[u8]>,
        staging_token: &str,
        before_displacement: F,
    ) -> Result<ConditionalMutationOutcome, PromotionFsError>
    where
        F: FnOnce(),
    {
        assert!(!segments.is_empty(), "target path must have segments");
        let parent = open_parent(root, segments, replacement.is_some())?.ok_or_else(|| {
            io_error(std::io::Error::new(
                ErrorKind::NotFound,
                "the promotion target parent does not exist",
            ))
        })?;
        let target_name = segment_cstring(segments[segments.len() - 1])?;
        let (hold_name, replacement_name) = staging_names(staging_token)?;
        let mut hold = read_regular_at(&parent, &hold_name)?;
        let target = read_regular_at(&parent, &target_name)?;

        if let Some(held) = hold.as_deref() {
            if !expected.matches(Some(held)) {
                return Ok(ConditionalMutationOutcome::RecoveryRequired {
                    staging_name: hold_name.to_string_lossy().into_owned(),
                });
            }
            if replacement.is_some_and(|bytes| target.as_deref() == Some(bytes))
                || (replacement.is_none() && target.is_none())
            {
                return Ok(ConditionalMutationOutcome::Applied);
            }
            if target.is_some() {
                return Ok(ConditionalMutationOutcome::RecoveryRequired {
                    staging_name: hold_name.to_string_lossy().into_owned(),
                });
            }
        } else {
            if !expected.matches(target.as_deref()) {
                return Ok(ConditionalMutationOutcome::Drift);
            }
            if target.is_some() {
                before_displacement();
                match rename_noreplace(&parent, &target_name, &hold_name) {
                    Ok(()) => {}
                    Err(error)
                        if error.kind() == ErrorKind::NotFound
                            || error.kind() == ErrorKind::AlreadyExists =>
                    {
                        return Ok(ConditionalMutationOutcome::Drift);
                    }
                    Err(error) => return Err(io_error(error)),
                }
                parent.sync_all().map_err(io_error)?;
                hold = read_regular_at(&parent, &hold_name)?;
                if !expected.matches(hold.as_deref()) {
                    return match rename_noreplace(&parent, &hold_name, &target_name) {
                        Ok(()) => {
                            parent.sync_all().map_err(io_error)?;
                            Ok(ConditionalMutationOutcome::Drift)
                        }
                        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                            Ok(ConditionalMutationOutcome::RecoveryRequired {
                                staging_name: hold_name.to_string_lossy().into_owned(),
                            })
                        }
                        Err(error) => Err(io_error(error)),
                    };
                }
            }
        }

        let Some(replacement) = replacement else {
            return Ok(ConditionalMutationOutcome::Applied);
        };
        create_replacement(&parent, &replacement_name, replacement)?;
        match rename_noreplace(&parent, &replacement_name, &target_name) {
            Ok(()) => {
                parent.sync_all().map_err(io_error)?;
                Ok(ConditionalMutationOutcome::Applied)
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                let current = read_regular_at(&parent, &target_name)?;
                if current.as_deref() == Some(replacement) {
                    Ok(ConditionalMutationOutcome::Applied)
                } else {
                    Ok(ConditionalMutationOutcome::RecoveryRequired {
                        staging_name: hold
                            .as_ref()
                            .map(|_| hold_name.to_string_lossy().into_owned())
                            .unwrap_or_else(|| replacement_name.to_string_lossy().into_owned()),
                    })
                }
            }
            Err(error) => Err(io_error(error)),
        }
    }

    pub(super) fn cleanup_worktree_mutation_artifacts(
        root: &Path,
        segments: &[&str],
        expected: ExpectedWorktreeValue<'_>,
        replacement: Option<&[u8]>,
        staging_token: &str,
    ) -> Result<ConditionalMutationOutcome, PromotionFsError> {
        assert!(!segments.is_empty(), "target path must have segments");
        let Some(parent) = open_parent(root, segments, false)? else {
            return Ok(ConditionalMutationOutcome::Applied);
        };
        let (hold_name, replacement_name) = staging_names(staging_token)?;
        if let Some(held) = read_regular_at(&parent, &hold_name)? {
            if !expected.matches(Some(&held)) {
                return Ok(ConditionalMutationOutcome::RecoveryRequired {
                    staging_name: hold_name.to_string_lossy().into_owned(),
                });
            }
            if let ConditionalMutationOutcome::RecoveryRequired { staging_name } =
                remove_known_artifact(&parent, &hold_name, &held)?
            {
                return Ok(ConditionalMutationOutcome::RecoveryRequired { staging_name });
            }
        }
        if let Some(staged) = read_regular_at(&parent, &replacement_name)? {
            let Some(replacement) = replacement else {
                return Ok(ConditionalMutationOutcome::RecoveryRequired {
                    staging_name: replacement_name.to_string_lossy().into_owned(),
                });
            };
            if staged != replacement {
                return Ok(ConditionalMutationOutcome::RecoveryRequired {
                    staging_name: replacement_name.to_string_lossy().into_owned(),
                });
            }
            if let ConditionalMutationOutcome::RecoveryRequired { staging_name } =
                remove_known_artifact(&parent, &replacement_name, &staged)?
            {
                return Ok(ConditionalMutationOutcome::RecoveryRequired { staging_name });
            }
        }
        Ok(ConditionalMutationOutcome::Applied)
    }
}

#[cfg(not(unix))]
mod imp {
    use super::{ConditionalMutationOutcome, ExpectedWorktreeValue, PromotionFsError};
    use std::path::Path;

    fn unsupported() -> PromotionFsError {
        PromotionFsError::Io(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "the promotion write path requires a Unix platform",
        ))
    }

    pub(super) fn read_worktree_file(
        _root: &Path,
        _segments: &[&str],
    ) -> Result<Option<Vec<u8>>, PromotionFsError> {
        Err(unsupported())
    }

    pub(super) fn list_worktree_directory(
        _root: &Path,
        _segments: &[&str],
    ) -> Result<Option<Vec<String>>, PromotionFsError> {
        Err(unsupported())
    }

    pub(super) fn write_worktree_file(
        _root: &Path,
        _segments: &[&str],
        _bytes: &[u8],
    ) -> Result<(), PromotionFsError> {
        Err(unsupported())
    }

    pub(super) fn delete_worktree_file(
        _root: &Path,
        _segments: &[&str],
    ) -> Result<bool, PromotionFsError> {
        Err(unsupported())
    }

    pub(super) fn conditional_replace_worktree_file<F>(
        _root: &Path,
        _segments: &[&str],
        _expected: ExpectedWorktreeValue<'_>,
        _replacement: Option<&[u8]>,
        _staging_token: &str,
        _before_displacement: F,
    ) -> Result<ConditionalMutationOutcome, PromotionFsError>
    where
        F: FnOnce(),
    {
        Err(unsupported())
    }

    pub(super) fn cleanup_worktree_mutation_artifacts(
        _root: &Path,
        _segments: &[&str],
        _expected: ExpectedWorktreeValue<'_>,
        _replacement: Option<&[u8]>,
        _staging_token: &str,
    ) -> Result<ConditionalMutationOutcome, PromotionFsError> {
        Err(unsupported())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ConditionalMutationOutcome, ExpectedWorktreeValue, cleanup_worktree_mutation_artifacts,
        decode_base64, git_blob_oid_hex,
    };

    #[cfg(unix)]
    fn mutation_root(label: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "threadshare-promotion-{label}-{}-{}",
            std::process::id(),
            super::imp::NEXT_TEMP_FILE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(root.join(".threadshare/memory/scenes")).unwrap();
        root
    }

    #[test]
    fn git_blob_oid_matches_git_hash_object() {
        // Well-known git vectors: empty blob and "hello\n".
        assert_eq!(
            git_blob_oid_hex(b""),
            "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
        );
        assert_eq!(
            git_blob_oid_hex(b"hello\n"),
            "ce013625030ba8dba906f756967f9e9ca394464a"
        );
    }

    #[test]
    fn base64_decoder_is_strict() {
        assert_eq!(decode_base64(""), Some(Vec::new()));
        assert_eq!(decode_base64("aGVsbG8K"), Some(b"hello\n".to_vec()));
        assert_eq!(decode_base64("aGk="), Some(b"hi".to_vec()));
        assert_eq!(decode_base64("aA=="), Some(b"h".to_vec()));
        for invalid in ["aGk", "a===", "=AAA", "aG k=", "aGk=aGk=x", "aGk=="] {
            assert_eq!(decode_base64(invalid), None, "{invalid}");
        }
        // Padding only in the final chunk.
        assert_eq!(decode_base64("aA==aGVsbG8K"), None);
    }

    #[cfg(unix)]
    #[test]
    fn conditional_write_preserves_a_value_racing_before_displacement() {
        let root = mutation_root("write-race");
        let target = root.join(".threadshare/memory/scenes/release.md");
        std::fs::write(&target, b"old").unwrap();
        let outcome = super::imp::conditional_replace_worktree_file(
            &root,
            &[".threadshare", "memory", "scenes", "release.md"],
            ExpectedWorktreeValue::Bytes(b"old"),
            Some(b"promoted"),
            &"a".repeat(64),
            || std::fs::write(&target, b"external edit").unwrap(),
        )
        .unwrap();
        assert_eq!(outcome, ConditionalMutationOutcome::Drift);
        assert_eq!(std::fs::read(&target).unwrap(), b"external edit");
        assert_eq!(
            std::fs::read_dir(target.parent().unwrap()).unwrap().count(),
            1
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn conditional_delete_preserves_a_value_racing_before_displacement() {
        let root = mutation_root("delete-race");
        let target = root.join(".threadshare/memory/scenes/release.md");
        std::fs::write(&target, b"old").unwrap();
        let outcome = super::imp::conditional_replace_worktree_file(
            &root,
            &[".threadshare", "memory", "scenes", "release.md"],
            ExpectedWorktreeValue::Bytes(b"old"),
            None,
            &"b".repeat(64),
            || std::fs::write(&target, b"external edit").unwrap(),
        )
        .unwrap();
        assert_eq!(outcome, ConditionalMutationOutcome::Drift);
        assert_eq!(std::fs::read(&target).unwrap(), b"external edit");
        assert_eq!(
            std::fs::read_dir(target.parent().unwrap()).unwrap().count(),
            1
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn conditional_write_recovers_a_persisted_displacement() {
        let root = mutation_root("resume");
        let directory = root.join(".threadshare/memory/scenes");
        let target = directory.join("release.md");
        let token = "c".repeat(64);
        let hold = directory.join(format!(".threadshare-promotion-{token}.hold"));
        std::fs::write(&target, b"old").unwrap();
        std::fs::rename(&target, &hold).unwrap();
        let outcome = super::imp::conditional_replace_worktree_file(
            &root,
            &[".threadshare", "memory", "scenes", "release.md"],
            ExpectedWorktreeValue::Bytes(b"old"),
            Some(b"promoted"),
            &token,
            || {},
        )
        .unwrap();
        assert_eq!(outcome, ConditionalMutationOutcome::Applied);
        assert_eq!(std::fs::read(&target).unwrap(), b"promoted");
        assert!(hold.exists());
        assert_eq!(
            cleanup_worktree_mutation_artifacts(
                &root,
                &[".threadshare", "memory", "scenes", "release.md"],
                ExpectedWorktreeValue::Bytes(b"old"),
                Some(b"promoted"),
                &token,
            )
            .unwrap(),
            ConditionalMutationOutcome::Applied
        );
        assert!(!hold.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
