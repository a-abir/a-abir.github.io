#!/usr/bin/env python3
"""
vault.py — encrypt a directory into a single authenticated archive.

    python vault.py encrypt -s ./secrets -o secrets.vault
    python vault.py decrypt -s secrets.vault -o ./restored
    python vault.py inspect -s secrets.vault

Format (v2). Everything before the chunk stream is a fixed 50-byte header
that is fed to every chunk as additional authenticated data, so the KDF
parameters cannot be downgraded without the tag failing.

    offset  size  field
    0       8     magic  b"PYVAULT2"
    8       1     format version
    9       1     kdf id (1 = scrypt, 2 = pbkdf2-hmac-sha256)
    10      4     kdf param 1   (scrypt n   | pbkdf2 iterations)
    14      4     kdf param 2   (scrypt r   | 0)
    18      4     kdf param 3   (scrypt p   | 0)
    22      16    salt
    38      8     nonce prefix
    46      4     plaintext chunk size
    50      ..    chunk stream

Each chunk is framed as:

    1 byte   final flag (0 = more follow, 1 = last)
    4 bytes  ciphertext length, big endian
    n bytes  ciphertext + 16-byte GCM tag

Chunk nonce = nonce_prefix || counter, so it is unique per chunk under a
given key. AAD = header || counter || final flag, which binds each chunk to
its position and to the header. Reordering, splicing between archives, and
truncation all fail authentication rather than silently returning short data.
"""

from __future__ import annotations

import argparse
import getpass
import io
import os
import secrets
import stat
import struct
import sys
import tarfile
from pathlib import Path
from typing import BinaryIO

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

MAGIC = b"PYVAULT2"
VERSION = 2

KDF_SCRYPT = 1
KDF_PBKDF2 = 2

SALT_SIZE = 16
NONCE_PREFIX_SIZE = 8
COUNTER_SIZE = 4           # prefix + counter = 12-byte GCM nonce
KEY_SIZE = 32
TAG_SIZE = 16

HEADER_FMT = ">8sBBIII16s8sI"
HEADER_SIZE = struct.calcsize(HEADER_FMT)   # 50

CHUNK_SIZE = 4 * 1024 * 1024                # 4 MiB of plaintext per chunk
MAX_CHUNK_SIZE = 256 * 1024 * 1024          # refuse absurd sizes from a header

# scrypt at n=2**16, r=8, p=1 costs ~64 MiB and is far harder to attack with
# GPUs than PBKDF2. PBKDF2 stays available for environments that need it.
SCRYPT_N, SCRYPT_R, SCRYPT_P = 1 << 16, 8, 1
PBKDF2_ITERATIONS = 600_000

EXIT_OK, EXIT_USAGE, EXIT_AUTH, EXIT_IO = 0, 2, 3, 4


class VaultError(Exception):
    """Anything that should end the run with a clean message, not a traceback."""


# --------------------------------------------------------------------------- keys
def derive_key(password: str, salt: bytes, kdf_id: int, p1: int, p2: int, p3: int) -> bytes:
    pw = password.encode("utf-8")
    if kdf_id == KDF_SCRYPT:
        return Scrypt(salt=salt, length=KEY_SIZE, n=p1, r=p2, p=p3).derive(pw)
    if kdf_id == KDF_PBKDF2:
        return PBKDF2HMAC(algorithm=SHA256(), length=KEY_SIZE,
                          salt=salt, iterations=p1).derive(pw)
    raise VaultError(f"unknown KDF id {kdf_id} — archive written by a newer version?")


def pack_header(kdf_id: int, p1: int, p2: int, p3: int,
                salt: bytes, nonce_prefix: bytes, chunk_size: int) -> bytes:
    return struct.pack(HEADER_FMT, MAGIC, VERSION, kdf_id, p1, p2, p3,
                       salt, nonce_prefix, chunk_size)


def unpack_header(raw: bytes) -> dict:
    if len(raw) != HEADER_SIZE:
        raise VaultError("file is too short to be a vault")
    magic, version, kdf_id, p1, p2, p3, salt, prefix, chunk = struct.unpack(HEADER_FMT, raw)

    if magic != MAGIC:
        raise VaultError("not a vault file (bad magic)")
    if version != VERSION:
        raise VaultError(f"unsupported format version {version}; this build reads v{VERSION}")
    if not 0 < chunk <= MAX_CHUNK_SIZE:
        raise VaultError(f"implausible chunk size in header ({chunk})")

    return {"kdf_id": kdf_id, "p1": p1, "p2": p2, "p3": p3,
            "salt": salt, "nonce_prefix": prefix, "chunk_size": chunk}


def _nonce(prefix: bytes, counter: int) -> bytes:
    return prefix + counter.to_bytes(COUNTER_SIZE, "big")


def _aad(header: bytes, counter: int, final: bool) -> bytes:
    return header + struct.pack(">IB", counter, int(final))


# --------------------------------------------------------------------------- streams
class ChunkedEncryptWriter(io.RawIOBase):
    """
    File-like sink. Buffers plaintext, emits authenticated chunks.

    tarfile writes into this directly in stream mode, so the plaintext tar
    never exists as a file — the original wrote a full unencrypted .tmp
    beside the output and only encrypted it afterwards.
    """

    def __init__(self, fh: BinaryIO, aesgcm: AESGCM, nonce_prefix: bytes,
                 header: bytes, chunk_size: int, progress=None):
        self._fh = fh
        self._aes = aesgcm
        self._prefix = nonce_prefix
        self._header = header
        self._chunk = chunk_size
        self._buf = bytearray()
        self._counter = 0
        self._progress = progress
        self._plain_bytes = 0
        self._closed_cleanly = False

    def writable(self) -> bool:
        return True

    def write(self, data) -> int:
        chunk = bytes(data)
        self._buf += chunk
        self._plain_bytes += len(chunk)
        # Hold at least one byte back so the trailing chunk can be flagged final.
        while len(self._buf) > self._chunk:
            self._emit(bytes(self._buf[:self._chunk]), final=False)
            del self._buf[:self._chunk]
        if self._progress:
            self._progress(self._plain_bytes)
        return len(chunk)

    def _emit(self, plaintext: bytes, final: bool) -> None:
        if self._counter >= 2 ** (COUNTER_SIZE * 8) - 1:
            raise VaultError("chunk counter exhausted; raise the chunk size")
        ct = self._aes.encrypt(_nonce(self._prefix, self._counter), plaintext,
                               _aad(self._header, self._counter, final))
        self._fh.write(struct.pack(">BI", int(final), len(ct)))
        self._fh.write(ct)
        self._counter += 1

    def finish(self) -> None:
        """Flush the remainder as the final chunk. Must be called explicitly."""
        if self._closed_cleanly:
            return
        self._emit(bytes(self._buf), final=True)
        self._buf.clear()
        self._closed_cleanly = True


class ChunkedDecryptReader(io.RawIOBase):
    """File-like source. Verifies and decrypts chunks on demand."""

    def __init__(self, fh: BinaryIO, aesgcm: AESGCM, nonce_prefix: bytes,
                 header: bytes, progress=None):
        self._fh = fh
        self._aes = aesgcm
        self._prefix = nonce_prefix
        self._header = header
        self._buf = bytearray()
        self._counter = 0
        self._eof = False
        self._progress = progress
        self._plain_bytes = 0

    def readable(self) -> bool:
        return True

    def _read_exact(self, n: int) -> bytes:
        out = bytearray()
        while len(out) < n:
            part = self._fh.read(n - len(out))
            if not part:
                raise VaultError("archive ends mid-chunk (truncated or corrupt)")
            out += part
        return bytes(out)

    def _next_chunk(self) -> None:
        head = self._fh.read(5)
        if not head:
            # Ran out of frames without ever seeing final=1.
            raise VaultError("archive is truncated — final chunk missing")
        if len(head) < 5:
            raise VaultError("archive ends mid-frame (truncated or corrupt)")

        final_flag, length = struct.unpack(">BI", head)
        if final_flag not in (0, 1):
            raise VaultError("corrupt chunk frame")
        if length < TAG_SIZE or length > MAX_CHUNK_SIZE + TAG_SIZE:
            raise VaultError("corrupt chunk length")

        ct = self._read_exact(length)
        final = bool(final_flag)
        # Wrong password, tampered bytes, reordered chunks, and a spliced
        # header all surface here as InvalidTag.
        plain = self._aes.decrypt(_nonce(self._prefix, self._counter), ct,
                                  _aad(self._header, self._counter, final))

        self._buf += plain
        self._counter += 1
        self._plain_bytes += len(plain)
        if self._progress:
            self._progress(self._plain_bytes)
        if final:
            self._eof = True
            if self._fh.read(1):
                raise VaultError("trailing data after final chunk")

    def readinto(self, b) -> int:
        while not self._buf and not self._eof:
            self._next_chunk()
        n = min(len(b), len(self._buf))
        b[:n] = self._buf[:n]
        del self._buf[:n]
        return n


# --------------------------------------------------------------------------- helpers
def human(n: float) -> str:
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if n < 1024 or unit == "TiB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TiB"


def make_progress(label: str, enabled: bool):
    if not enabled or not sys.stderr.isatty():
        return None
    state = {"last": 0}

    def report(done: int) -> None:
        if done - state["last"] < 8 << 20:      # redraw every 8 MiB
            return
        state["last"] = done
        print(f"\r  {label} {human(done)}…", end="", file=sys.stderr, flush=True)

    return report


def clear_progress(enabled: bool) -> None:
    if enabled and sys.stderr.isatty():
        print("\r\033[K", end="", file=sys.stderr, flush=True)


def read_password(args, *, confirm: bool) -> str:
    """
    Password sources, in order. Deliberately no --password flag: anything on
    argv is visible in `ps` output and lands in shell history.
    """
    if args.password_file:
        pw = Path(args.password_file).read_text(encoding="utf-8").splitlines()
        if not pw or not pw[0]:
            raise VaultError("password file is empty")
        return pw[0]

    env = os.environ.get("VAULT_PASSWORD")
    if env:
        return env

    if not sys.stdin.isatty():
        line = sys.stdin.readline().rstrip("\n")
        if not line:
            raise VaultError("no password on stdin")
        return line

    pw = getpass.getpass("Password: ")
    if not pw:
        raise VaultError("password cannot be empty")
    if confirm and pw != getpass.getpass("Confirm password: "):
        raise VaultError("passwords do not match")
    if confirm and len(pw) < 12:
        print("  note: short passwords are the weak link here, not the cipher.",
              file=sys.stderr)
    return pw


def resolve_output(path_str: str, force: bool) -> Path:
    path = Path(path_str)
    if path.exists() and not force:
        raise VaultError(f"'{path}' already exists (pass --force to overwrite)")
    if path.parent and not path.parent.exists():
        raise VaultError(f"output directory '{path.parent}' does not exist")
    return path


def tar_filter(tarinfo: tarfile.TarInfo):
    """
    Skip things that should never be inside a portable archive, and strip
    identity metadata. Note this is tar.add()'s filter, which takes a single
    TarInfo — not the two-argument extraction filter.
    """
    if tarinfo.issym() or tarinfo.islnk():
        return tarinfo                      # links are preserved but validated on extract
    if tarinfo.ischr() or tarinfo.isblk() or tarinfo.isfifo():
        print(f"  skipping device/fifo: {tarinfo.name}", file=sys.stderr)
        return None
    tarinfo.mode &= ~(stat.S_ISUID | stat.S_ISGID)
    tarinfo.uid = tarinfo.gid = 0
    tarinfo.uname = tarinfo.gname = ""
    return tarinfo


# --------------------------------------------------------------------------- commands
def cmd_encrypt(args) -> int:
    source = Path(args.source).resolve()
    if not source.is_dir():
        raise VaultError(f"source directory '{args.source}' does not exist")

    out_path = resolve_output(args.output, args.force)
    password = read_password(args, confirm=True)

    if args.kdf == "scrypt":
        kdf_id, p1, p2, p3 = KDF_SCRYPT, args.scrypt_n, SCRYPT_R, SCRYPT_P
    else:
        kdf_id, p1, p2, p3 = KDF_PBKDF2, args.iterations, 0, 0

    salt = secrets.token_bytes(SALT_SIZE)
    nonce_prefix = secrets.token_bytes(NONCE_PREFIX_SIZE)
    header = pack_header(kdf_id, p1, p2, p3, salt, nonce_prefix, CHUNK_SIZE)

    print("  deriving key…", file=sys.stderr)
    aesgcm = AESGCM(derive_key(password, salt, kdf_id, p1, p2, p3))
    del password

    progress = make_progress("packing", not args.quiet)

    # Write to a temp file and rename at the end, so an interrupted run never
    # leaves a half-written archive that looks complete.
    tmp = out_path.with_name(out_path.name + ".partial")
    try:
        with tmp.open("wb") as fh:
            os.chmod(tmp, 0o600)
            fh.write(header)
            writer = ChunkedEncryptWriter(fh, aesgcm, nonce_prefix, header,
                                          CHUNK_SIZE, progress)
            # "w|gz" is the streaming mode — no seeking, so it works on a pipe.
            with tarfile.open(fileobj=writer, mode="w|gz",
                              format=tarfile.PAX_FORMAT) as tar:
                tar.add(source, arcname=".", filter=tar_filter)
            writer.finish()
            fh.flush()
            os.fsync(fh.fileno())

        tmp.replace(out_path)
        clear_progress(not args.quiet)

        size = out_path.stat().st_size
        print(f"Encrypted '{source}' -> '{out_path}' ({human(size)}, "
              f"{'scrypt' if kdf_id == KDF_SCRYPT else 'pbkdf2'}).")
        return EXIT_OK

    except BaseException:
        clear_progress(not args.quiet)
        tmp.unlink(missing_ok=True)
        raise


def cmd_decrypt(args) -> int:
    vault = Path(args.source)
    if not vault.is_file():
        raise VaultError(f"vault file '{args.source}' does not exist")

    dest = Path(args.output).resolve()
    if dest.exists() and any(dest.iterdir()) and not args.force:
        raise VaultError(f"'{dest}' is not empty (pass --force to extract into it)")

    with vault.open("rb") as fh:
        header_raw = fh.read(HEADER_SIZE)
        meta = unpack_header(header_raw)

        password = read_password(args, confirm=False)
        print("  deriving key…", file=sys.stderr)
        key = derive_key(password, meta["salt"], meta["kdf_id"],
                         meta["p1"], meta["p2"], meta["p3"])
        del password

        aesgcm = AESGCM(key)
        progress = make_progress("extracting", not args.quiet)
        reader = ChunkedDecryptReader(fh, aesgcm, meta["nonce_prefix"],
                                      header_raw, progress)

        dest.mkdir(parents=True, exist_ok=True)
        try:
            with tarfile.open(fileobj=reader, mode="r|gz") as tar:
                # The "data" filter is the supported way to block absolute
                # paths, "..", links escaping the destination, device nodes,
                # and setuid bits. The hand-rolled commonpath check it
                # replaces missed link targets entirely.
                if sys.version_info >= (3, 12):
                    tar.extractall(path=dest, filter="data")
                else:
                    _safe_extract_legacy(tar, dest)
        except InvalidTag:
            raise
        except tarfile.TarError as exc:
            raise VaultError(f"archive decrypted but the tar stream is damaged: {exc}")

    clear_progress(not args.quiet)
    print(f"Decrypted '{vault}' -> '{dest}'.")
    return EXIT_OK


def _safe_extract_legacy(tar: tarfile.TarFile, dest: Path) -> None:
    """Fallback for Python < 3.12, which has no extraction filters."""
    dest = dest.resolve()

    def escapes(name: str) -> bool:
        target = (dest / name).resolve()
        return target != dest and dest not in target.parents

    for member in tar:                       # streaming mode: iterate, don't getmembers()
        if member.name.startswith("/") or escapes(member.name):
            raise VaultError(f"blocked path traversal in archive: {member.name}")
        if member.issym() or member.islnk():
            if member.linkname.startswith("/") or escapes(member.linkname):
                raise VaultError(f"blocked link escaping destination: {member.name}")
        if member.ischr() or member.isblk() or member.isfifo():
            raise VaultError(f"blocked device entry in archive: {member.name}")
        member.mode &= ~(stat.S_ISUID | stat.S_ISGID)
        tar.extract(member, path=dest, set_attrs=False)


def cmd_inspect(args) -> int:
    """Read the header without needing the password."""
    vault = Path(args.source)
    if not vault.is_file():
        raise VaultError(f"vault file '{args.source}' does not exist")

    meta = unpack_header(vault.open("rb").read(HEADER_SIZE))
    kdf = "scrypt" if meta["kdf_id"] == KDF_SCRYPT else "pbkdf2-hmac-sha256"
    params = (f"n={meta['p1']}, r={meta['p2']}, p={meta['p3']}"
              if meta["kdf_id"] == KDF_SCRYPT else f"iterations={meta['p1']}")

    print(f"  file         {vault}")
    print(f"  size         {human(vault.stat().st_size)}")
    print(f"  format       PYVAULT v{VERSION}")
    print(f"  cipher       AES-256-GCM, {human(meta['chunk_size'])} chunks")
    print(f"  kdf          {kdf} ({params})")
    print(f"  salt         {meta['salt'].hex()}")
    return EXIT_OK


# --------------------------------------------------------------------------- cli
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Encrypt a directory into a single authenticated archive.",
        epilog="Password is read from --password-file, then $VAULT_PASSWORD, "
               "then stdin, then an interactive prompt.")
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p):
        p.add_argument("-s", "--source", required=True)
        p.add_argument("-o", "--output", required=True)
        p.add_argument("-f", "--force", action="store_true",
                       help="overwrite an existing output")
        p.add_argument("-q", "--quiet", action="store_true")
        p.add_argument("--password-file", metavar="PATH",
                       help="read the password from the first line of a file")

    enc = sub.add_parser("encrypt", help="encrypt a folder")
    common(enc)
    enc.add_argument("--kdf", choices=("scrypt", "pbkdf2"), default="scrypt")
    enc.add_argument("--scrypt-n", type=int, default=SCRYPT_N,
                     help=f"scrypt cost, must be a power of two (default {SCRYPT_N})")
    enc.add_argument("--iterations", type=int, default=PBKDF2_ITERATIONS,
                     help=f"pbkdf2 iterations (default {PBKDF2_ITERATIONS})")
    enc.set_defaults(func=cmd_encrypt)

    dec = sub.add_parser("decrypt", help="decrypt an archive")
    common(dec)
    dec.set_defaults(func=cmd_decrypt)

    ins = sub.add_parser("inspect", help="show header details, no password needed")
    ins.add_argument("-s", "--source", required=True)
    ins.set_defaults(func=cmd_inspect)

    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        return args.func(args)
    except InvalidTag:
        # One message for every authentication failure. Saying which part
        # failed would tell an attacker whether the password was close.
        print("Failed: wrong password, or the archive has been modified.",
              file=sys.stderr)
        return EXIT_AUTH
    except VaultError as exc:
        print(f"Failed: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except (OSError, tarfile.TarError) as exc:
        print(f"Failed: {exc}", file=sys.stderr)
        return EXIT_IO
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
