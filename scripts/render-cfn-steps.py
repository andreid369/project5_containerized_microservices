#!/usr/bin/env python3
"""Generate the per-step and migration CloudFormation templates from one source.

cloudformation/product-service.yaml is the single source. Lines between
"#@in TOKENS" and "#@end" are kept only for the targets the tokens match.
Blocks can be nested; a line is kept when every enclosing block matches.

Tokens:
  N+      main-track steps N and later      (3+)
  N-M     main-track steps N through M       (3-7)
  N       main-track step N only             (6)
  ec2     migration: EC2 baseline            (cloudformation/migration/1-ec2-baseline.yaml)
  migrate migration: EC2 + Fargate parallel run (cloudformation/migration/2-parallel-run.yaml)
  drain   migration: EC2 service removed      (cloudformation/migration/3-remove-ec2-service.yaml)

Unmarked lines are in every target. The source itself is the latest main step.

Usage: python3 scripts/render-cfn-steps.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "cloudformation" / "product-service.yaml"

TARGETS = {
    2: ("steps/02-ecr.yaml", "Product Service - Step 2: ECR repository"),
    3: ("steps/03-ecs-task.yaml", "Product Service - Step 3: + VPC, RDS PostgreSQL, ECS cluster, IAM roles and task definition"),
    4: ("steps/04-ecs-service-alb-autoscaling.yaml", "Product Service - Step 4: + ECS service on Fargate, Application Load Balancer and Auto Scaling"),
    5: ("steps/05-dashboard.yaml", "Product Service - Step 5: + CloudWatch dashboard"),
    6: ("steps/06-cicd.yaml", "Product Service - Step 6: + CI/CD with CodePipeline, CodeBuild and CodeDeploy blue/green"),
    7: ("steps/07-capacity-providers.yaml", "Product Service - Step 7: + Fargate and Fargate Spot capacity provider strategy"),
    8: ("steps/08-secrets-manager.yaml", "Product Service - Step 8: + template-owned Secrets Manager database secret with rotation"),
    "ec2": ("migration/1-ec2-baseline.yaml", "Product Service - Migration 1: EC2 launch type baseline (bridge networking, Auto Scaling group capacity provider)"),
    "migrate": ("migration/2-parallel-run.yaml", "Product Service - Migration 2: EC2 and Fargate services in parallel, weighted traffic shift"),
    "drain": ("migration/3-remove-ec2-service.yaml", "Product Service - Migration 3: all traffic on Fargate, EC2 service removed (EC2 capacity is removed by step 4)"),
}

START = re.compile(r"^\s*#@in\s+(.+?)\s*$")
END = re.compile(r"^\s*#@end\s*$")


def matcher(tokens, lineno):
    checks = []
    for tok in tokens.split():
        if m := re.fullmatch(r"(\d+)\+", tok):
            n = int(m.group(1))
            checks.append(lambda t, n=n: isinstance(t, int) and t >= n)
        elif m := re.fullmatch(r"(\d+)-(\d+)", tok):
            a, b = int(m.group(1)), int(m.group(2))
            checks.append(lambda t, a=a, b=b: isinstance(t, int) and a <= t <= b)
        elif re.fullmatch(r"\d+", tok):
            checks.append(lambda t, n=int(tok): t == n)
        elif tok in ("ec2", "migrate", "drain"):
            checks.append(lambda t, name=tok: t == name)
        else:
            sys.exit(f"line {lineno}: unknown token {tok!r}")
    return lambda target: any(c(target) for c in checks)


def render(lines, target):
    out, stack = [], []
    for lineno, line in enumerate(lines, 1):
        if m := START.match(line):
            stack.append(matcher(m.group(1), lineno)(target))
            continue
        if END.match(line):
            if not stack:
                sys.exit(f"line {lineno}: #@end without #@in")
            stack.pop()
            continue
        if all(stack):
            out.append(line)
    if stack:
        sys.exit("unterminated #@in block")
    return out


def main():
    lines = SOURCE.read_text().splitlines(keepends=True)
    for target, (rel, description) in TARGETS.items():
        text = "".join(render(lines, target))
        text = re.sub(r"^Description: .*$", f'Description: "{description}"', text, count=1, flags=re.M)
        text = re.sub(
            r"\n# =+\n# This is the single source.*?\n# =+\n",
            "\n# Generated from cloudformation/product-service.yaml by scripts/render-cfn-steps.py.\n"
            "# Do not edit by hand.\n",
            text, count=1, flags=re.S,
        )
        dst = ROOT / "cloudformation" / rel
        dst.parent.mkdir(exist_ok=True)
        dst.write_text(text)
        print(f"wrote cloudformation/{rel}")


if __name__ == "__main__":
    main()
