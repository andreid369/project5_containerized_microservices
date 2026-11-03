#!/usr/bin/env python3
"""Build the Product Service architecture diagram (SVG) from the AWS icon package.

Usage: python3 make_diagram.py <icons-dir> <out.svg>
Icons are embedded as base64 data URIs, so the SVG is self-contained.
"""
import base64
import pathlib
import sys

ICONS = pathlib.Path(sys.argv[1])
OUT = pathlib.Path(sys.argv[2])

A = "Architecture-Service-Icons_07312026"
R = "Resource-Icons_07312026"
G = "Architecture-Group-Icons_07312026"
FILES = {
    "users": f"{R}/Res_General-Icons/Res_48_Light/Res_Users_48_Light.svg",
    "user": f"{R}/Res_General-Icons/Res_48_Light/Res_User_48_Light.svg",
    "git": f"{R}/Res_General-Icons/Res_48_Light/Res_Git-Repository_48_Light.svg",
    "igw": f"{R}/Res_Networking-Content-Delivery/Res_Amazon-VPC_Internet-Gateway_48.svg",
    "alb": f"{R}/Res_Networking-Content-Delivery/Res_Elastic-Load-Balancing_Application-Load-Balancer_48.svg",
    "nat": f"{R}/Res_Networking-Content-Delivery/Res_Amazon-VPC_NAT-Gateway_48.svg",
    "task": f"{R}/Res_Containers/Res_Amazon-Elastic-Container-Service_Task_48.svg",
    "bucket": f"{R}/Res_Storage/Res_Amazon-Simple-Storage-Service_Bucket_48.svg",
    "ecs": f"{A}/Arch_Containers/64/Arch_Amazon-Elastic-Container-Service_64.svg",
    "fargate": f"{A}/Arch_Containers/64/Arch_AWS-Fargate_64.svg",
    "ecr": f"{A}/Arch_Containers/64/Arch_Amazon-Elastic-Container-Registry_64.svg",
    "rds": f"{A}/Arch_Databases/64/Arch_Amazon-RDS_64.svg",
    "secrets": f"{A}/Arch_Security-Identity/64/Arch_AWS-Secrets-Manager_64.svg",
    "cloudwatch": f"{A}/Arch_Management-Tools/64/Arch_Amazon-CloudWatch_64.svg",
    "autoscaling": f"{A}/Arch_Management-Tools/64/Arch_AWS-Application-Auto-Scaling_64.svg",
    "lambda": f"{A}/Arch_Compute/64/Arch_AWS-Lambda_64.svg",
    "codepipeline": f"{A}/Arch_Developer-Tools/64/Arch_AWS-CodePipeline_64.svg",
    "codebuild": f"{A}/Arch_Developer-Tools/64/Arch_AWS-CodeBuild_64.svg",
    "codedeploy": f"{A}/Arch_Developer-Tools/64/Arch_AWS-CodeDeploy_64.svg",
    "g_cloud": f"{G}/AWS-Cloud-logo_32.svg",
    "g_region": f"{G}/Region_32.svg",
    "g_vpc": f"{G}/Virtual-private-cloud-VPC_32.svg",
    "g_public": f"{G}/Public-subnet_32.svg",
    "g_private": f"{G}/Private-subnet_32.svg",
}


def uri(key):
    data = (ICONS / FILES[key]).read_bytes()
    return "data:image/svg+xml;base64," + base64.b64encode(data).decode()


FONT = "Arial, 'Liberation Sans', Helvetica, sans-serif"
INK = "#232F3E"
MUTED = "#545B64"
out = []


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def text(x, y, s, size=13, weight="normal", anchor="middle", fill=INK):
    out.append(f'<text x="{x}" y="{y}" font-family="{FONT}" font-size="{size}" '
               f'font-weight="{weight}" text-anchor="{anchor}" fill="{fill}">{esc(s)}</text>')


def icon(key, cx, cy, size=56, label=None, sub=None, where="below"):
    out.append(f'<image href="{uri(key)}" x="{cx - size / 2}" y="{cy - size / 2}" width="{size}" height="{size}"/>')
    if not label:
        return
    lines = [label] + ([sub] if isinstance(sub, str) else (sub or []))
    if where == "below":
        y = cy + size / 2 + 17
        text(cx, y, lines[0], 13, "bold")
        for i, l in enumerate(lines[1:]):
            text(cx, y + 16 * (i + 1), l, 12, fill=MUTED)
    elif where == "above":
        y = cy - size / 2 - 10 - 16 * (len(lines) - 1)
        text(cx, y, lines[0], 13, "bold")
        for i, l in enumerate(lines[1:]):
            text(cx, y + 16 * (i + 1), l, 12, fill=MUTED)
    else:  # right
        x = cx + size / 2 + 10
        y = cy - 8 * (len(lines) - 1) + 4
        text(x, y, lines[0], 13, "bold", "start")
        for i, l in enumerate(lines[1:]):
            text(x, y + 16 * (i + 1), l, 12, "normal", "start", MUTED)


def group(x, y, w, h, label, stroke, fill="none", gicon=None, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}" stroke="{stroke}" stroke-width="1.5"{d}/>')
    tx = x + 10
    if gicon:
        out.append(f'<image href="{uri(gicon)}" x="{x}" y="{y}" width="30" height="30"/>')
        tx = x + 38
    text(tx, y + 20, label, 13, "bold", "start", stroke if stroke != INK else INK)


def arrow(points, label=None, at=None, dashed=False, color=INK):
    d = " ".join(f"{'M' if i == 0 else 'L'}{x},{y}" for i, (x, y) in enumerate(points))
    dash = ' stroke-dasharray="6 4"' if dashed else ""
    out.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="1.8"{dash} marker-end="url(#arrow)"/>')
    if label:
        lx, ly = at
        lines = label if isinstance(label, list) else [label]
        w = max(len(l) for l in lines) * 6.6 + 12
        h = 16 * len(lines) + 4
        out.append(f'<rect x="{lx - w / 2}" y="{ly - 13}" width="{w}" height="{h}" rx="3" fill="#FFFFFF" fill-opacity="0.92"/>')
        for i, l in enumerate(lines):
            text(lx, ly + 16 * i, l, 12, fill=INK)


W, H = 1720, 1100

# ---- groups -----------------------------------------------------------------
group(270, 20, 1430, 1060, "AWS Cloud", INK, gicon="g_cloud")
group(290, 64, 1390, 996, "Region", "#00A4A6", gicon="g_region", dash="6 4")
group(320, 110, 880, 620, "VPC 10.0.0.0/16 (2 availability zones)", "#8C4FFF", gicon="g_vpc")
group(380, 150, 790, 170, "Public subnets", "#7AA116", "#F2F6E8", "g_public")
group(380, 345, 790, 365, "Private subnets", "#00A4A6", "#E6F6F7", "g_private")
group(405, 385, 400, 300, "ECS cluster + service product-service", "#ED7100", "#FFFFFF", dash="5 4")
group(320, 790, 1350, 250, "CI/CD (deploys whatever is merged to main)", MUTED, dash="5 4")

# ---- outside AWS ------------------------------------------------------------
icon("users", 130, 232, 56, "Users", "HTTP clients")
icon("user", 130, 640, 56, "Developer")
icon("git", 130, 880, 56, "GitHub repository", ["Actions CI on every PR:", "tests, Docker smoke", "test, templates"])

# ---- public subnet ----------------------------------------------------------
icon("igw", 320, 232, 44)
icon("alb", 600, 232, 56, "Application Load Balancer", [":80 prod, :8080 test listener", "blue + green target groups"], where="right")
icon("nat", 960, 232, 52, "NAT gateway", None, where="above")

# ---- private subnet: cluster, database, rotation ----------------------------
icon("fargate", 790, 400, 30)
icon("task", 520, 500, 52, "Task on Fargate", ["base 1, on-demand"])
icon("task", 690, 500, 52, "Task on Fargate Spot", ["weight 3, cheaper"])
text(605, 618, "2 to 4 tasks, Node.js on :3000, read-only, non-root", 12, fill=MUTED)
text(605, 636, "task role: read only the database secret", 12, fill=MUTED)
icon("rds", 960, 450, 56, "RDS PostgreSQL 18", ["private, encrypted"], where="right")
icon("lambda", 960, 610, 52, "Rotation Lambda", ["every 30 days"], where="right")

# ---- regional services ------------------------------------------------------
icon("secrets", 1440, 170, 52, "Secrets Manager", ["product-service/database"])
icon("ecr", 1440, 320, 52, "Amazon ECR", ["product-service images"])
icon("cloudwatch", 1440, 470, 52, "CloudWatch", ["logs, dashboard, 5XX alarm"])
icon("autoscaling", 1440, 640, 52, "Application Auto Scaling", ["CPU 60%, memory 75%"])

# ---- CI/CD --------------------------------------------------------------------
icon("codepipeline", 560, 905, 56, "CodePipeline", ["Source, Build, Deploy"])
icon("codedeploy", 860, 905, 56, "CodeDeploy", ["blue/green, auto-rollback"])
icon("codebuild", 1160, 905, 56, "CodeBuild", ["test, build, push image"])
icon("bucket", 1440, 905, 50, "S3 artifact bucket")

# ---- arrows: request path (solid) ----------------------------------------------
arrow([(160, 232), (296, 232)], ":80", (228, 236))
arrow([(344, 232), (570, 232)])
arrow([(600, 262), (600, 392)], [":3000"], (635, 336))
arrow([(805, 450), (930, 450)], [":5432", "TLS"], (868, 438))

# ---- arrows: AWS API calls (dashed) --------------------------------------------
arrow([(760, 385), (760, 292), (960, 292), (960, 262)], None, dashed=True)
arrow([(990, 232), (1270, 232), (1270, 170), (1410, 170)], ["HTTPS to AWS APIs:", "secret, image pull, logs"], (1110, 202), dashed=True)
arrow([(1270, 232), (1270, 320), (1410, 320)], dashed=True)
arrow([(1270, 320), (1270, 470), (1410, 470)], dashed=True)
arrow([(960, 580), (960, 482)], None, dashed=True)
arrow([(1410, 640), (808, 640)], ["scales the service"], (1110, 644), dashed=True)

# ---- arrows: CI/CD ---------------------------------------------------------------
arrow([(130, 700), (130, 846)], ["pull request"], (130, 776))
arrow([(162, 880), (420, 880), (420, 905), (528, 905)], ["merge to main", "(CodeConnections)"], (420, 860))
arrow([(588, 905), (828, 905)], "deploy", (708, 909))
arrow([(560, 972), (560, 1018), (1160, 1018), (1160, 974)], "build", (860, 1022))
arrow([(1192, 905), (1412, 905)], "artifacts", (1302, 909), dashed=True)
arrow([(1160, 873), (1160, 760), (1620, 760), (1620, 320), (1470, 320)], "push image", (1400, 764))
arrow([(860, 873), (860, 750), (600, 750), (600, 690)], ["new task set + listener swap"], (730, 754))

# ---- legend --------------------------------------------------------------------
lx, ly = 30, 1040
out.append(f'<path d="M{lx},{ly} L{lx + 40},{ly}" stroke="{INK}" stroke-width="1.8" marker-end="url(#arrow)"/>')
text(lx + 50, ly + 4, "traffic and deployment", 12, anchor="start")
out.append(f'<path d="M{lx},{ly + 24} L{lx + 40},{ly + 24}" stroke="{INK}" stroke-width="1.8" stroke-dasharray="6 4" marker-end="url(#arrow)"/>')
text(lx + 50, ly + 28, "AWS API calls and control", 12, anchor="start")

svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<title>Product Service architecture on AWS</title>
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0,0 L10,5 L0,10 z" fill="{INK}"/></marker></defs>
<rect width="{W}" height="{H}" fill="#FFFFFF"/>
{chr(10).join(out)}
</svg>
"""
OUT.write_text(svg)
print(f"wrote {OUT} ({len(svg) // 1024} KB)")
