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

/// Writes exactly `bytes` to `segments` below `root`: no-follow traversal,
/// missing directories created, same-directory temporary file, atomic rename.
pub fn write_worktree_file(
    root: &Path,
    segments: &[&str],
    bytes: &[u8],
) -> Result<(), PromotionFsError> {
    imp::write_worktree_file(root, segments, bytes)
}

#[cfg(unix)]
mod imp {
    use super::PromotionFsError;
    use std::ffi::CString;
    use std::fs::File;
    use std::io::{ErrorKind, Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::OpenOptionsExt;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP_FILE: AtomicU64 = AtomicU64::new(0);

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
}

#[cfg(not(unix))]
mod imp {
    use super::PromotionFsError;
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

    pub(super) fn write_worktree_file(
        _root: &Path,
        _segments: &[&str],
        _bytes: &[u8],
    ) -> Result<(), PromotionFsError> {
        Err(unsupported())
    }
}

#[cfg(test)]
mod tests {
    use super::{decode_base64, git_blob_oid_hex};

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
}
