#!/usr/bin/env python3
"""Render ecs/taskdef.json and ecs/appspec.yaml for the CodeDeployToECS action.

Replaces ${VAR} placeholders with environment variables (set on the CodeBuild
project by CloudFormation). Placeholders in angle brackets (<IMAGE1_NAME>,
<TASK_DEFINITION>) are left for CodePipeline. Fails, rather than producing a
half-rendered file, when:
  - a ${VAR} has no value,
  - a variable whose name ends in _JSON isn't valid JSON,
  - a .json output isn't valid JSON,
  - a --require'd placeholder is missing from the output.

Usage:
  python3 scripts/render-template.py ecs/taskdef.json taskdef.json --require "<IMAGE1_NAME>"
  python3 scripts/render-template.py ecs/appspec.yaml appspec.yaml --require "<TASK_DEFINITION>"
"""
import argparse
import json
import os
import re
import sys

PLACEHOLDER = re.compile(r"\$\{([A-Z0-9_]+)\}")


def fail(msg):
    sys.exit(f"render-template: {msg}")


def render(text, env):
    names = sorted(set(PLACEHOLDER.findall(text)))
    missing = [n for n in names if not env.get(n)]
    if missing:
        fail(f"missing environment variables: {', '.join(missing)}")
    for name in names:
        if name.endswith("_JSON"):
            try:
                json.loads(env[name])
            except json.JSONDecodeError as e:
                fail(f"{name} is not valid JSON: {e}")
    return PLACEHOLDER.sub(lambda m: env[m.group(1)], text)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("src")
    p.add_argument("dst")
    p.add_argument("--require", action="append", default=[], help="text that must be present in the output")
    args = p.parse_args()

    with open(args.src, encoding="utf-8") as f:
        out = render(f.read(), os.environ)
    if args.dst.endswith(".json"):
        try:
            out = json.dumps(json.loads(out), indent=2) + "\n"
        except json.JSONDecodeError as e:
            fail(f"{args.dst} is not valid JSON after rendering: {e}")
    for needle in args.require:
        if needle not in out:
            fail(f"{needle} not found in {args.dst}")
    with open(args.dst, "w", encoding="utf-8") as f:
        f.write(out)
    print(f"render-template: wrote {args.dst}")


if __name__ == "__main__":
    main()
