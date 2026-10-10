#!/usr/bin/env python3
"""Read-only, approval-gated preflight for the existing Itsaplan EC2 host."""

import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import urllib.request

INSTANCE = "i-0a7cc7b624234c60e"
DIRECTORY = Path("/opt/itsaplan")
PROJECT = "itsaplan"


def run(args, **kwargs):
    result = subprocess.run(
        args, check=True, capture_output=True, text=True, timeout=60, **kwargs
    )
    return result.stdout.strip()


def report(**fields):
    print(json.dumps(fields), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner-email", required=True)
    args = parser.parse_args()
    if "@" not in args.owner_email or "\n" in args.owner_email:
        raise SystemExit("An exact owner email is required for attribution")
    if platform.machine() != "x86_64" or not DIRECTORY.is_dir():
        raise SystemExit("Unexpected architecture or application directory")
    token_request = urllib.request.Request(
        "http://169.254.169.254/latest/api/token",
        method="PUT",
        headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"},
    )
    with urllib.request.urlopen(token_request, timeout=3) as response:
        token = response.read().decode()
    identity_request = urllib.request.Request(
        "http://169.254.169.254/latest/meta-data/instance-id",
        headers={"X-aws-ec2-metadata-token": token},
    )
    with urllib.request.urlopen(identity_request, timeout=3) as response:
        instance = response.read().decode()
    if instance != INSTANCE or DIRECTORY.resolve() != DIRECTORY:
        raise SystemExit("Unexpected target identity or directory")
    report(instance=instance, architecture=platform.machine(), project=PROJECT)
    report(composeVersion=run(["docker", "compose", "version", "--short"]))
    docker_root = run(["docker", "info", "--format", "{{.DockerRootDir}}"])
    for directory in (str(DIRECTORY), docker_root):
        usage = shutil.disk_usage(directory)
        report(path=directory, totalBytes=usage.total, freeBytes=usage.free)
    report(cpuCount=os.cpu_count())
    memory = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
    report(memoryTotal=memory["MemTotal"].strip(), memoryAvailable=memory["MemAvailable"].strip())
    ids = run([
        "docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={PROJECT}"
    ]).splitlines()
    if not ids or len(ids) > 10:
        raise SystemExit("Expected one bounded Compose installation")
    services = {}
    for container in ids:
        labels = json.loads(run([
            "docker", "inspect", "--format", "{{json .Config.Labels}}", container
        ]))
        if labels.get("com.docker.compose.project.working_dir") != str(DIRECTORY):
            raise SystemExit("Unexpected Compose working directory")
        service = labels.get("com.docker.compose.service")
        if service not in {"api", "web", "worker", "bot", "postgres", "minio", "minio-init"} or service in services:
            raise SystemExit("Unexpected or duplicate Compose service")
        services[service] = container
        facts = run([
            "docker", "inspect", "--format",
            "{{.Config.Image}}|{{.Image}}|{{.State.Status}}", container
        ]).split("|")
        mounts = json.loads(run(["docker", "inspect", "--format", "{{json .Mounts}}", container]))
        ports = json.loads(run(["docker", "inspect", "--format", "{{json .NetworkSettings.Ports}}", container]))
        report(service=service, image=facts[0], imageId=facts[1], state=facts[2], ports=ports,
               mounts=[{"type": m["Type"], "name": m.get("Name"), "destination": m["Destination"]} for m in mounts])
    if not {"api", "web", "postgres", "minio"}.issubset(services):
        raise SystemExit("Required services are missing")
    report(applicationVersion=run([
        "docker", "exec", services["api"], "bun", "-e",
        "console.log((await Bun.file('/app/package.json').json()).version)"
    ]))
    listeners = run(["ss", "-H", "-lnt"]).splitlines()
    for port in (3000, 3001, 14000, 14001):
        addresses = [line.split()[3] for line in listeners if line.split()[3].endswith(f":{port}")]
        report(port=port, listeningAddresses=addresses)

    sql = """
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SELECT json_build_object('database',current_database(),'recovery',pg_is_in_recovery(),
'readOnly',current_setting('transaction_read_only'),'application',current_setting('application_name'));
SELECT json_build_object('ownerMatchCount',count(*)) FROM public."user" WHERE lower(email)=lower(:'owner_email');
"""
    owner = "SELECT id FROM public.\"user\" WHERE lower(email)=lower(:'owner_email')"
    for table, foreign_key in (("issue", "issue_id"), ("initiative", "initiative_id")):
        sql += f"""
WITH owner AS ({owner}), creations AS (
 SELECT {foreign_key} id, min(actor_user_id) creator, count(DISTINCT actor_user_id) actors, bool_and(actor_user_id IS NOT NULL) complete
 FROM issue_activity WHERE action='created' AND {foreign_key} IS NOT NULL GROUP BY {foreign_key}
), classified AS (
 SELECT CASE WHEN (SELECT count(*) FROM owner)<>1 OR c.actors IS DISTINCT FROM 1 OR c.complete IS DISTINCT FROM true OR u.id IS NULL THEN 'unknown'
 WHEN u.id IN (SELECT id FROM owner) THEN 'owner' ELSE 'other_member' END attribution
 FROM {table} t LEFT JOIN creations c ON c.id=t.id LEFT JOIN public."user" u ON u.id=c.creator
)
SELECT json_build_object('recordType','{table}','attribution',attribution,'count',count(*))
FROM classified GROUP BY attribution;
"""
    for table in ("project_document", "note_board"):
        sql += f"""
WITH owner AS ({owner}), classified AS (
 SELECT CASE WHEN (SELECT count(*) FROM owner)<>1 OR u.id IS NULL THEN 'unknown'
 WHEN u.id IN (SELECT id FROM owner) THEN 'owner' ELSE 'other_member' END attribution
 FROM {table} t LEFT JOIN public."user" u ON u.id=t.created_by_user_id
)
SELECT json_build_object('recordType','{table}','attribution',attribution,'count',count(*))
FROM classified GROUP BY attribution;
"""
    for table in ("team", "project"):
        sql += f"SELECT json_build_object('recordType','{table}','attribution','unavailable','count',count(*)) FROM {table};\n"
    sql += """
SELECT json_build_object('otherPreflightConnections',count(*)) FROM pg_stat_activity
WHERE application_name='itsaplan-update-preflight' AND pid<>pg_backend_pid();
ROLLBACK;
"""
    command = [
        "docker", "exec", "-i", services["postgres"], "sh", "-c",
        'PGAPPNAME=itsaplan-update-preflight psql -X -h /var/run/postgresql -v ON_ERROR_STOP=1 '
        '-v "owner_email=$1" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At',
        "preflight", args.owner_email,
    ]
    output = run(command, input=sql)
    for line in output.splitlines():
        if line.startswith("{"):
            print(line)
    report(completed=True, mutations=False, creatorLimit="Counts only; missing or deleted creator history remains unknown. Comments, worklogs, attachments, and team/project authorship are not attributed. Zero other-member counts do not justify resetting data.")


if __name__ == "__main__":
    try:
        main()
    except (subprocess.SubprocessError, OSError, ValueError) as error:
        report(completed=False, errorType=type(error).__name__)
        raise SystemExit(1)
