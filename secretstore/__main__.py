"""Command line for the Iobeam secrets file.

    python3 -m secretstore init                      set up the file: generate tokens, ask for
                                                     every value that is still missing
    python3 -m secretstore init --from FILE          take values from a prepared KEY=VALUE file
    python3 -m secretstore path                      print the secrets file location
    python3 -m secretstore list                      variable names (values masked)
    python3 -m secretstore set NAME [NAME ...]       hidden prompt for each value
    python3 -m secretstore set NAME --generate hex32 store a random value
    python3 -m secretstore check [FILE ...]          report missing values / unresolved ${VARS}
    python3 -m secretstore harvest --root DIR        copy literal credentials out of an older
                                                     installation's Development directory
    python3 -m secretstore scan DIR                  fail if DIR contains literal credentials

Run from a Development checkout, or from DistributionDeploy/vendor in a
DeployWorkspace handoff archive.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys

import secretstore

DEVELOPMENT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(secretstore.__file__)))
DEFAULT_CHECK_FILES = (
    "GlasgowDataIO/Json/streamData.json",
    "IobeamAdmin/Json/IobeamAdmin.json",
    "IobeamAdmin/Json/IobeamAdminDb.json",
    "OperationData/Json/OperationDataDb.json",
    "DeployWorkSpace/Development/DistributionDeploy/Json/DistributionDeploy.json",
)


def _mask(value: str) -> str:
    return "(empty)" if not value else "*" * min(len(value), 8)


def cmd_path(args) -> int:
    print(args.file)
    return 0


def cmd_list(args) -> int:
    values = secretstore.read_file(args.file)
    for name in sorted(values):
        print("{}={}".format(name, _mask(values[name])))
    return 0


def cmd_set(args) -> int:
    updates = {}
    for name in args.names:
        if args.generate:
            updates[name] = secretstore.generate(args.generate)
        elif args.stdin:
            updates[name] = sys.stdin.readline().rstrip("\r\n")
        else:
            first = getpass.getpass("{}: ".format(name))
            if first and getpass.getpass("Repeat {}: ".format(name)) != first:
                print("Values did not match; nothing written.", file=sys.stderr)
                return 1
            updates[name] = first
    written = secretstore.write(updates, args.file)
    print("Updated {} in {}".format(", ".join(written) or "nothing", args.file))
    return 0


def cmd_init(args) -> int:
    seed = secretstore.read_seed(args.seed) if args.seed else None
    interactive = not args.no_prompt and sys.stdin.isatty()
    try:
        result = secretstore.provision(args.file, seed=seed,
                                       ask=secretstore.prompt if interactive else None)
    except (EOFError, KeyboardInterrupt):
        print("\nStopped; values entered so far are kept in {}.".format(args.file), file=sys.stderr)
        return 1
    for name in sorted(result.sources):
        print("{} <- {}".format(name, result.sources[name]))
    if result.missing:
        print("Still missing (required): {}. Set them with: python3 -m secretstore set {}"
              .format(", ".join(result.missing), " ".join(result.missing)), file=sys.stderr)
        return 1
    print("Secrets file ready: {} (mode 600)".format(result.path))
    if args.seed:
        print("You can now delete {}.".format(args.seed))
    return 0


def cmd_check(args) -> int:
    status = 0
    for variable in secretstore.unresolved_variables(path=args.file):
        if variable.get("required"):
            status = 1
            print("missing required {}".format(variable["name"]))
        else:
            print("not set (optional) {}".format(variable["name"]))
    files = args.files or [os.path.join(DEVELOPMENT_ROOT, f) for f in DEFAULT_CHECK_FILES]
    for path in files:
        if not os.path.isfile(path):
            continue
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        missing = secretstore.missing(data, args.file)
        if missing:
            status = 1
            print("{}: missing {}".format(os.path.relpath(path, DEVELOPMENT_ROOT), ", ".join(missing)))
    if status == 0:
        print("All referenced secrets resolve ({}).".format(args.file))
    return status


def cmd_harvest(args) -> int:
    root = os.path.abspath(os.path.expanduser(args.root))
    if not os.path.isdir(root):
        print("No such directory: {}".format(root), file=sys.stderr)
        return 1
    found = secretstore.harvest(root)
    if not found:
        print("No literal credentials found.")
        return 0
    for name in sorted(found):
        print("found {}={}".format(name, _mask(found[name])))
    if args.dry_run:
        return 0
    written = secretstore.write(found, args.file, overwrite=args.overwrite)
    skipped = sorted(set(found) - set(written))
    print("Wrote {} to {}".format(", ".join(written) or "nothing", args.file))
    if skipped:
        print("Kept existing values for {} (use --overwrite to replace)".format(", ".join(skipped)))
    return 0


def cmd_scan(args) -> int:
    problems = secretstore.scan_tree(args.directory)
    for problem in problems:
        print(problem)
    if problems:
        print("{} literal credential(s) found.".format(len(problems)), file=sys.stderr)
        return 1
    print("No literal credentials found under {}.".format(args.directory))
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m secretstore", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--file", default=None, help="secrets file (default: %(default)s)")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("init")
    p.add_argument("--from", dest="seed", metavar="FILE", help="prepared KEY=VALUE file")
    p.add_argument("--no-prompt", action="store_true", help="never ask; fail if a value is missing")
    p.set_defaults(func=cmd_init)
    sub.add_parser("path").set_defaults(func=cmd_path)
    sub.add_parser("list").set_defaults(func=cmd_list)
    p = sub.add_parser("set")
    p.add_argument("names", nargs="+")
    p.add_argument("--generate", choices=("hex32", "urlsafe"))
    p.add_argument("--stdin", action="store_true", help="read one value per name from stdin")
    p.set_defaults(func=cmd_set)
    p = sub.add_parser("check")
    p.add_argument("files", nargs="*")
    p.set_defaults(func=cmd_check)
    p = sub.add_parser("harvest")
    p.add_argument("--root", required=True,
                   help="Development directory of an older installation, e.g. ~/IobeamPlatform/Development")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--overwrite", action="store_true")
    p.set_defaults(func=cmd_harvest)
    p = sub.add_parser("scan")
    p.add_argument("directory")
    p.set_defaults(func=cmd_scan)
    args = parser.parse_args(argv)
    args.file = os.path.abspath(os.path.expanduser(args.file)) if args.file \
        else secretstore.default_secrets_path()
    try:
        return args.func(args)
    except secretstore.SecretError as error:
        print("error: {}".format(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
