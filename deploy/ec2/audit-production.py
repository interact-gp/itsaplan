#!/usr/bin/env python3
import json
import subprocess


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=60, **kwargs).stdout.strip()


ids = run(['docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project=itsaplan']).splitlines()
if not ids or len(ids) > 10:
    raise SystemExit('Expected one bounded Itsaplan Compose installation')
services = {}
for container in ids:
    labels = json.loads(run(['docker', 'inspect', '--format', '{{json .Config.Labels}}', container]))
    if labels.get('com.docker.compose.project.working_dir') != '/opt/itsaplan':
        raise SystemExit('Unexpected Compose working directory')
    service = labels['com.docker.compose.service']
    if service in services:
        raise SystemExit('Unexpected duplicate service')
    services[service] = container
    facts = run(['docker', 'inspect', '--format', '{{.Config.Image}}|{{.Image}}|{{.State.Status}}|{{.State.StartedAt}}', container]).split('|')
    print(json.dumps({'service': service, 'image': facts[0], 'imageId': facts[1], 'state': facts[2], 'startedAt': facts[3]}))
    mounts = json.loads(run(['docker', 'inspect', '--format', '{{json .Mounts}}', container]))
    print(json.dumps({'service':service,'mounts':[{'type':m['Type'],'name':m.get('Name'),'destination':m['Destination']} for m in mounts]}))
if 'api' not in services or 'postgres' not in services:
    raise SystemExit('API/Postgres not found')
print(run(['docker', 'exec', services['api'], 'bun', '-e', '''const pkg=await Bun.file('/app/package.json').json();console.log(JSON.stringify({version:pkg.version,managedAccess:process.env.ITSAPLAN_MANAGED_ACCESS==='true',keycloakIssuer:process.env.ITSAPLAN_KEYCLOAK_ISSUER??null,provisionerClientConfigured:Boolean(process.env.ITSAPLAN_KEYCLOAK_CLIENT_ID),provisionerSecretConfigured:Boolean(process.env.ITSAPLAN_KEYCLOAK_CLIENT_SECRET),jevKeyConfigured:Boolean(process.env.OPENROUTER_API_KEY)}));''']))
sql = r'''
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SELECT json_build_object('database',current_database(),'recovery',pg_is_in_recovery(),'readOnly',current_setting('transaction_read_only'),'application',current_setting('application_name'),'serverVersion',current_setting('server_version'));
SELECT json_build_object('table',table_name,'column',column_name) FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('user','issue_activity','project_document','note_board') AND column_name IN ('role','active','created_at','actor_user_id','actor_name','action','created_by_user_id') ORDER BY table_name,column_name;
SELECT format('SELECT json_build_object(''table'',%L,''count'',count(*),''oldest'',min(created_at),''newest'',max(created_at)) FROM public.%I',table_name,table_name) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('user','team','project','issue','initiative','project_document','note_board','issue_activity') ORDER BY table_name
\gexec
SELECT row_to_json(x) FROM (SELECT id,name,email,role,created_at FROM public."user" ORDER BY created_at LIMIT 100) x;
SELECT row_to_json(x) FROM (SELECT p.id,p.key,p.name,p.created_at,(SELECT json_agg(json_build_object('userId',m.user_id,'role',m.role)) FROM project_member m WHERE m.project_id=p.id) memberships FROM project p ORDER BY p.created_at DESC LIMIT 100) x;
SELECT row_to_json(x) FROM (SELECT actor_user_id,actor_name,action,count(*) events,min(created_at) first_at,max(created_at) last_at FROM issue_activity GROUP BY actor_user_id,actor_name,action ORDER BY events DESC LIMIT 100) x;
SELECT row_to_json(x) FROM (SELECT id,issue_id,initiative_id,actor_user_id,actor_name,action,created_at FROM issue_activity WHERE action='created' ORDER BY created_at DESC LIMIT 100) x;
SELECT format('SELECT row_to_json(x) FROM (SELECT to_jsonb(t)->>''created_by_user_id'' AS creator,count(*) AS count,min(created_at) AS first_at,max(created_at) AS last_at FROM public.%I t GROUP BY to_jsonb(t)->>''created_by_user_id'' LIMIT 100) x',table_name) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('project_document','note_board') ORDER BY table_name
\gexec
SELECT json_build_object('configuredSecretKey',key) FROM app_secret WHERE key IN ('auth.oidc','auth.google','auth.scim') ORDER BY key;
SELECT json_build_object('otherDiagnosticConnections',count(*)) FROM pg_stat_activity WHERE application_name='itsaplan-release-audit' AND pid<>pg_backend_pid();
SELECT json_build_object('registration',value->>'registrationMode') FROM app_setting WHERE key='auth';
ROLLBACK;
'''
result = subprocess.run(['docker','exec','-i',services['postgres'],'sh','-c','PGAPPNAME=itsaplan-release-audit psql -X -h /var/run/postgresql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'], input=sql, capture_output=True, text=True, timeout=60)
print(result.stdout)
if result.returncode:
    print(json.dumps({'databaseAuditFailed': True, 'exitCode': result.returncode}))
    raise SystemExit(result.returncode)
