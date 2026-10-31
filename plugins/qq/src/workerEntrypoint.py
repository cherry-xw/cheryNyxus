"""Check the mounted source before entering a workspace or running its command."""
import json
import os
import stat
import sys


DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK


def enter_workspace(expected, cwd):
    parts = [part for part in cwd.split('/') if part and part != '.']
    if (not cwd or cwd.startswith('/') or '\\' in cwd or '\x00' in cwd
            or '..' in parts):
        raise ValueError('invalid working directory')

    source = os.open('/workspace/files/incoming-zips', DIR_FLAGS)
    current = None
    try:
        if expected is not None:
            actual = os.fstat(source)
            if (not stat.S_ISDIR(actual.st_mode)
                    or str(actual.st_dev) != expected['device']
                    or str(actual.st_ino) != expected['inode']):
                raise ValueError('source mount differs')
        if parts and parts[0] == 'incoming-zips':
            if expected is None:
                raise ValueError('source permission required')
            current = os.dup(source)
            parts = parts[1:]
        else:
            current = os.open('/workspace/files', DIR_FLAGS)
        for part in parts:
            following = os.open(part, DIR_FLAGS, dir_fd=current)
            os.close(current)
            current = following
        os.fchdir(current)
    finally:
        if current is not None:
            os.close(current)
        os.close(source)


def main():
    try:
        if len(sys.argv) != 4:
            raise ValueError('invalid invocation')
        expected = json.loads(sys.argv[1])
        if expected is not None and (
                not isinstance(expected, dict) or set(expected) != {'device', 'inode'}
                or any(not isinstance(value, str) or not value.isascii() or not value.isdecimal()
                       for value in expected.values())):
            raise ValueError('invalid source identity')
        enter_workspace(expected, sys.argv[2])
    except (OSError, ValueError, KeyError, TypeError):
        print('QQ_WORKER_MOUNT_REJECTED: directory check failed; command was not started', file=sys.stderr)
        return 126
    os.execv('/usr/bin/bash', ['/usr/bin/bash', '-c', sys.argv[3]])


if __name__ == '__main__':
    sys.exit(main())
