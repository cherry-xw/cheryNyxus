#!/usr/bin/env python3
"""List or extract a ZIP without running any member. Paths are relative to cwd."""
import argparse
import fcntl
import hashlib
import json
import os
import re
import stat
import sys
import zipfile
from contextlib import ExitStack
from uuid import uuid4
from pathlib import PurePosixPath

MAX_ENTRIES = 2000
MAX_FILE = 64 * 1024 * 1024
MAX_TOTAL = 256 * 1024 * 1024
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def member_path(info):
    name = info.filename
    if not info.flag_bits & 0x800:
        raw = name.encode('cp437')
        for encoding in ('utf-8', 'gbk'):
            try:
                name = raw.decode(encoding)
                break
            except UnicodeError:
                pass
    if (not name or len(name) > 512 or '\\' in name or '\x00' in name
            or any(ord(c) < 32 for c in name) or name.startswith('/')
            or re.match(r'^[a-zA-Z]:', name)):
        raise ValueError('unsafe member name')
    segments = name.rstrip('/').split('/')
    if any(p in ('', '.', '..') for p in segments):
        raise ValueError('unsafe member path')
    mode = info.external_attr >> 16
    kind = stat.S_IFMT(mode)
    if kind not in (0, stat.S_IFDIR, stat.S_IFREG):
        raise ValueError('special ZIP member is not allowed')
    if kind == stat.S_IFDIR and not info.is_dir() or kind == stat.S_IFREG and info.is_dir():
        raise ValueError('inconsistent ZIP member')
    if info.flag_bits & 1:
        raise ValueError('encrypted ZIP is not supported')
    if info.file_size < 0 or info.file_size > MAX_FILE:
        raise ValueError('member exceeds 64 MiB')
    return '/'.join(segments)


def plan(archive):
    entries = archive.infolist()
    if len(entries) > MAX_ENTRIES:
        raise ValueError('archive exceeds 2000 entries')
    total, names, result = 0, set(), []
    files = set()
    for info in entries:
        name = member_path(info)
        if name in names:
            raise ValueError('duplicate member path')
        names.add(name)
        if not info.is_dir():
            files.add(name)
        total += info.file_size
        if total > MAX_TOTAL:
            raise ValueError('archive exceeds 256 MiB')
        result.append((info, name))
    for _, name in result:
        if any(str(parent) in files for parent in PurePosixPath(name).parents if str(parent) != '.'):
            raise ValueError('file blocks a member directory')
    return result, total


def directory_at(parent, segments):
    current = os.dup(parent)
    try:
        for name in segments:
            try:
                os.mkdir(name, 0o700, dir_fd=current)
            except FileExistsError:
                pass
            following = os.open(name, DIR_FLAGS, dir_fd=current)
            os.close(current)
            current = following
        return current
    except BaseException:
        os.close(current)
        raise


def version(file_stat):
    return (file_stat.st_dev, file_stat.st_ino, file_stat.st_size,
            file_stat.st_mtime_ns, file_stat.st_ctime_ns, file_stat.st_nlink)


def existing_matches(parent, name, size, checksum, staging):
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    with os.fdopen(descriptor, 'rb') as saved:
        before = os.fstat(saved.fileno())
        if stat.S_ISREG(before.st_mode) and before.st_nlink == 2:
            # A killed publisher may have linked a complete member before unlinking
            # its temporary. Only that exact inode in our reserved staging is removed.
            matches = []
            for entry in os.listdir(staging):
                if not re.fullmatch(r'member-[a-f0-9-]{36}', entry):
                    continue
                candidate = os.stat(entry, dir_fd=staging, follow_symlinks=False)
                if stat.S_ISREG(candidate.st_mode) and (candidate.st_dev, candidate.st_ino) == (before.st_dev, before.st_ino):
                    matches.append(entry)
            if len(matches) == 1:
                os.unlink(matches[0], dir_fd=staging)
                os.fsync(staging)
                before = os.fstat(saved.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != size:
            raise ValueError('unsafe or incomplete existing extraction')
        actual = hashlib.sha256()
        for block in iter(lambda: saved.read(65536), b''):
            actual.update(block)
        if (actual.digest() != checksum or version(before) != version(os.fstat(saved.fileno()))
                or version(before) != version(os.stat(name, dir_fd=parent, follow_symlinks=False))):
            raise ValueError('existing extraction differs; no file was overwritten')


def extract(archive, entries, root, staging):
    actual_total = 0
    for info, name in entries:
        segments = name.split('/')
        parent = directory_at(root, segments if info.is_dir() else segments[:-1])
        temporary = None
        try:
            if info.is_dir():
                continue
            # An interrupted write never appears as a completed extracted member.
            temporary = 'member-' + str(uuid4())
            target = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=staging)
            with os.fdopen(target, 'wb') as output:
                before = os.fstat(output.fileno())
                if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                    raise ValueError('unsafe output file')
                count, checksum = 0, hashlib.sha256()
                with archive.open(info, 'r') as source:
                    while True:
                        block = source.read(65536)
                        if not block:
                            break
                        count += len(block)
                        actual_total += len(block)
                        if count > MAX_FILE or count > info.file_size or actual_total > MAX_TOTAL:
                            raise ValueError('extraction exceeds declared limits')
                        checksum.update(block)
                        output.write(block)
                if count != info.file_size:
                    raise ValueError('member size mismatch')
                output.flush()
                os.fsync(output.fileno())
            try:
                os.link(temporary, segments[-1], src_dir_fd=staging, dst_dir_fd=parent, follow_symlinks=False)
            except FileExistsError:
                existing_matches(parent, segments[-1], count, checksum.digest(), staging)
            os.unlink(temporary, dir_fd=staging)
            temporary = None
            os.fsync(parent)
        finally:
            if temporary is not None:
                os.unlink(temporary, dir_fd=staging)
            os.close(parent)
    os.fsync(root)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('list', 'extract'))
    args = parser.parse_args()
    cwd = os.open('.', DIR_FLAGS)
    try:
        descriptor = os.open('archive.zip', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=cwd)
        with os.fdopen(descriptor, 'rb') as source:
            before = os.fstat(source.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 100 * 1024 * 1024:
                raise ValueError('unsafe archive')
            with zipfile.ZipFile(source) as archive:
                entries, total = plan(archive)
                if args.operation == 'extract':
                    with ExitStack() as resources:
                        lock = os.open('.archive-inspect.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=cwd)
                        resources.callback(os.close, lock)
                        lock_stat = os.fstat(lock)
                        if not stat.S_ISREG(lock_stat.st_mode) or lock_stat.st_nlink != 1:
                            raise ValueError('unsafe extraction lock')
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        root = directory_at(cwd, ['extracted'])
                        resources.callback(os.close, root)
                        staging = directory_at(cwd, ['.archive-inspect-staging'])
                        resources.callback(os.close, staging)
                        extract(archive, entries, root, staging)
                if version(before) != version(os.fstat(source.fileno())):
                    raise ValueError('archive changed during inspection')
                print(json.dumps({'operation': args.operation, 'entryCount': len(entries), 'uncompressedBytes': total,
                                  'entries': [{'path': name, 'directory': info.is_dir(), 'sizeBytes': info.file_size}
                                              for info, name in entries]}, ensure_ascii=False))
    finally:
        os.close(cwd)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, RuntimeError, UnicodeError, zipfile.BadZipFile, NotImplementedError):
        print(json.dumps({'error': 'ZIP inspection or extraction failed; no member was executed'}), file=sys.stderr)
        sys.exit(1)
