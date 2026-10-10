# Itsaplan and Shastra V1 production release preparation

Host preflight verified 2026-10-03 09:02 UTC / 14:32 IST. This is preparation, not a deployment approval or completed rollout.

## Current production observations

AWS identity: account `582524322671`, region `ap-south-1`, role/session `shastra-aws-platform/jayjain`, through the configured short-lived `shastra-platform` credential process.

| Component | Current evidence |
| --- | --- |
| Itsaplan EC2 | `i-0a7cc7b624234c60e`, name `itsaplan-pilot`, private IP `172.31.253.131`, t3.large, Ubuntu 24.04, no public IP. Running, EC2 system/instance checks OK, SSM Online. |
| Web | `https://prd.frnd.app/login` returns 200. Shared public ALB rule 600 forwards to the healthy web target on port 3001. |
| API | `https://prd-api.frnd.app/` returns 200 with status OK. Shared ALB rule 610 forwards to the healthy API target on port 3000. |
| Ingress | Both rules have only hostname conditions; no source-CIDR restriction. The initial deployment documents describing closed/setup ingress are stale. |
| Native OAuth | The production API advertises authorization-code/refresh-token OAuth, public-client registration and S256 at `/api/auth/.well-known/oauth-authorization-server`. This is metadata evidence, not authenticated acceptance. |
| Shastra EC2 | `i-0bf2cffe7dc6f9583`, t3.small, running, EC2 checks OK, SSM Online. Unauthenticated `https://shastra.frnd.app/mcp` returns 401. |
| Running version | Installed API reports 1.0.0. All four application services run pinned 1.0.0 images; exact image IDs and persistent volume names are recorded in ignored `.local/production-release/preflight-result.json`. |
| Candidate capacity | x86_64, two CPUs, approximately 6.3 GiB available memory and 31 GiB free disk. Ports 14000/14001 are free. CPU credits and sustained build capacity remain unverified. |
| Existing usage | Three issues have creation history attributed to Jay. Eleven teams and three projects have unavailable creator attribution. The bounded check found no other-member issue creators; comments, worklogs and attachments were not attributed. Preserve all records and volumes. |

## Deployment and testing plan

This plan separates candidate acceptance, the live Itsaplan code update, and live
identity/MCP activation. Fixture acceptance uses local Keycloak through a tunnel.
Permanent access uses the production identity provider after its groups and clients
are ready. Neither production application may trust the local fixture issuer.

| Phase | Executor work | Reviewer gate | Exit evidence |
| --- | --- | --- | --- |
| 1. Preflight | Run the prepared bounded host/capacity/creator check; inspect actual pending migrations and backup locations | Correct account/host, preserved data, sufficient resources | Live version/images, attribution limits, capacity and recovery facts recorded |
| 2. Freeze and build | Freeze Itsaplan and Shastra source, verify secret exclusions, build native amd64 images and run relevant release checks | Reviewed final source/config, immutable artifact identity | Source SHA256, base and application image digests, gate results |
| 3. Candidate setup | Start isolated EC2 candidate, isolated local Keycloak HTTPS tunnel, local Shastra test gateway and browser helper | Separate DB/attachments/keys/grants, exact origins/issuer/scoped clients | Working fresh login and protected page using actual built images |
| 4. Candidate acceptance | Run the UI/MCP matrix below sequentially in fresh Playwright contexts | Review failures, fix material defects, retest affected cases | Scenario evidence tied to the exact artifact and configuration |
| 5. Itsaplan live update | Verify recovery, deploy the candidate-tested images into the installed Compose stack | Exact live update action, migration compatibility, identity recovery | Health, existing records/accounts/ownership intact, privacy settings verified |
| 6. Identity and Shastra activation | User configures real Keycloak groups; verify real clients, publish authorized Shastra source and apply reviewed delivery plan | Live IdP ready, explicit activation action, State Manager/restart impact covered | Real existing/new-user UI and per-user MCP acceptance |
| 7. Cleanup and handoff | Remove temporary candidate, forward/transfer processes and issuer trust; retire legacy resources after replacement passes | Exact cleanup scope, preserved live volumes/grants | No temporary listeners/trust, live operation evidence and recovery instructions |

The orchestrator coordinates targets, dependencies and evidence. The Astra-medium
executor prepares and runs authorized actions. The independent reviewer checks final
artifacts and configuration. A failed gate returns to the executor; a changed
artifact repeats relevant acceptance before promotion. Planning does not execute a
deployment, publish source, or mutate production Keycloak.

### Candidate topology

Use `i-0a7cc7b624234c60e` only if preflight confirms capacity and the live stack stays
healthy. Build and start one service at a time; monitor memory, disk, CPU credits
and both live ALB target groups. Stop candidate work if live health degrades. A
capacity failure requires a separately reviewed builder/test target.

| Component | Candidate configuration |
| --- | --- |
| Compose identity | Separate candidate project and directory; no installed stack lifecycle commands |
| All services | Own bridge network, DB/attachment/backup volumes and generated keys; internal service DNS stays intact |
| API entry | Container port 3000 published only to host `127.0.0.1:14000` |
| Web | Container port 3001 published only to host `127.0.0.1:14001`; browser `API_URL=http://localhost:14000`, server media `SERVICE_URL_API=http://api:3000` |
| Browser access | SSM forwards local 14000/14001 to the same host ports; web origin `http://localhost:14001`, API origin `http://localhost:14000` |
| Cookies | Fresh candidate-only browser contexts, unset cookie domain, production image/mode; verify secure localhost cookies and callback state rather than relaxing them |
| Keycloak | Separate local fixture container/realm behind HTTPS tunnel; canonical HTTPS issuer, exact redirects, scoped provisioner |
| MCP client | Separate local Shastra gateway/helper and grant namespace; matching local-fixture subject and downstream account |

Verify page rendering, authenticated API calls, attachment upload/download and
protected-media authorization with these separate browser/server origins. Verify
actual loopback bindings and container isolation; do not publish candidate database
or object-store ports. No ALB or DNS changes are planned. If this topology cannot
pass fresh login or server rendering, stop and review the needed change; do not
weaken cookies or use a development-mode image as acceptance.

Source transfer uses a temporary SSM-forwarded loopback upload receiver restricted
to one expected archive, size and hash in the candidate directory. Its exact launch,
forward, upload and cleanup commands require preparation/review before execution.
Do not embed multi-megabyte source in SSM commands, assume new S3 permissions, copy
production credentials, or print transfer credentials. Verify the received archive
against the local manifest before building, and confirm the receiver exits and its
port closes. Preserve a copy of the exact tested images for live promotion.

### Browser and MCP acceptance matrix

| Scenario | UI expectation | MCP expectation |
| --- | --- | --- |
| Existing entitled user | Fresh IdP login reaches the same account and protected operation; no duplicate or lost ownership | Independent gateway login and same-account consent connect the expected user |
| New supported onboarding | Closed self-registration denied; supported provisioning creates one subject-linked, least-privilege account | Connect works after provisioning; no inherited unrelated grants |
| Entitled, unassigned member | Empty workspace, no automatic personal team or project | No usable unassigned resource access; guessed IDs are denied |
| Organization admins | Five fixture admins can create/manage teams and application access within the documented organization model | Corresponding permitted catalogue and successful protected operation |
| Team owner/manager | Team projects/member management obey rank and last-owner rules | Same permitted actions and denials as UI |
| Custom roles | Create a team/project role with selected permissions; assign it; permitted action succeeds and forbidden action fails | Catalogue/discovery reflect capabilities; execution enforces target permissions |
| Project-only assignment | Assigned project usable; sibling projects and broader team administration unavailable | Direct assigned read/write as permitted; sibling, forged scope and admin calls denied |
| Role/access removal | Old sessions lose access at the verified boundary; membership preservation and restoration behave as documented | Existing grant cannot bypass removal; cached or guessed tool calls denied |
| Unauthorized identity | Missing group, external/unverified identity and legacy-email collision fail closed | Missing entitlement or mismatched downstream consent produces no unauthorized grant |
| Session lifecycle | Logout, expired-session redirect and fresh login behave correctly; IdP SSO lifetime recorded separately | Real downstream refresh, disconnected grant and revoked access behavior verified |
| Consent failure | Cancellation returns usable app/login state | Cancel, state replay and account mismatch do not store a usable grant |
| Discovery and write | Written test project/item appears in the protected UI | JEV recommends only permitted tools; execution/readback works; failure falls back locally without dispatching a write |
| Protocol and ambiguity | No false success after a failed operation | Real SDK validates schemas/structuredContent; ambiguous writes are not retried automatically |
| Privacy | No browser analytics beacon on tested workflow; request origins recorded | Runtime telemetry/update/catalogue flags off; JEV's intentional OpenRouter payload scope verified |
| Attachments and documents | Upload/download and protected document assets work through internal media proxy; denied users cannot fetch them | Permitted content tools work without exposing protected media to siblings |
| Release-note interaction | Post-login notes can be dismissed and the workspace remains usable | Protected reads still work after dismissal |

Record browser screenshots, API/MCP status, account/role scenario, timestamps and
artifact/configuration identity without credentials. Use namespaced disposable
fixtures; do not delete unknown or other-member records. Induced expiry checks must
be labelled; natural-expiry coverage remains pending unless actually observed.

### Live acceptance and recovery

Before replacement, enumerate every pending migration in the installed journal,
verify a fresh database backup and isolated restore, and identify attachment and
encryption-key recovery. An image downgrade is sufficient only if its schema is
compatible. Otherwise recovery needs the matching database, attachments and key;
prepare that exact restore action before the live update.

Keep live identity settings usable during a code-only update. Managed access and
Shastra activation require real group claims, exact live redirect registrations,
scoped provisioner permissions, and a recoverable owner. Jay configures the real
Keycloak groups; real authentication/consent remains user takeover. Remote candidate
results cannot establish permanent production sign-in success.

Validate both live existing-user login and supported new-user onboarding, assignment,
custom-role boundaries, revocation, OAuth/refresh and actual MCP read/write/readback.
Verify runtime privacy settings in the deployed services. Reconnect MCP clients to
reload tool catalogues. Keep access expansion limited until these gates pass.

Shastra delivery uses the canonical sibling checkout. Its repository requires
user-authorized commit/push before delivery, or an explicit current-task waiver;
the private Itsaplan source archive does not waive that rule. Review the complete
Terraform plan and recorded source identity. An apply updating the install document
can trigger State Manager immediately (`apply_only_at_cron_interval=false`), so its
approval must cover operational convergence and the shared gateway restart, not
just file delivery. Read terminal convergence output, verify deployed definitions,
and test unaffected gateway integrations with bounded permitted calls.

Rollback targets are the recorded previous Itsaplan images/config and previous
Shastra source/delivery artifact. Reverting Shastra's container alone is insufficient
while State Manager still targets new source. Preserve per-user grants and do not
remove legacy clients/credentials until replacement acceptance passes. Cleanup must
stop the candidate/remove tunnel issuer trust before tunnel shutdown, then close
forwards and verify temporary listeners/processes are gone. Never remove live volumes.

Email notifications can use existing SMTP/Resend configuration as an optional
release configuration task. A full inbox client or native Slack app is separate
feature work. Slack member exports are a review input, not identity verification or
authorization; do not automatically provision roles from channel membership.

## Narrow update preflight

Source: `deploy/ec2/preflight-update.py`. Owner account: `jay@frnd.app`.
Target: only `i-0a7cc7b624234c60e`, `/opt/itsaplan`, Compose project `itsaplan`.

Completed read-only submission command:

```sh
python3 /Users/jayjain/itsaplan/.local/production-release/submit-preflight.py
```

The wrapper verifies the request hash and exact short-lived AWS identity before one
SSM command, without retries. Source SHA256:
`aa86f7eecc11558b20d943c35d88e884dc7599731dd45d5531695088b490a4c4`.
Request SHA256:
`060f172dacb3cc24c09df74615542ba7bd30b6035798b1d5b4b506bd5d88c580`.

Impact: bounded host/Compose image, mount, port and capacity reads, followed by a
dedicated PostgreSQL Unix-socket connection using `BEGIN READ ONLY`, five-second
statement and one-second lock limits, and `ROLLBACK`. It reports only aggregate
creator attribution for issues, initiatives, documents and note boards. It does
not print other users' emails, record content, secrets or the host environment.
Team/project authorship is unavailable; comments, worklogs and attachments are
not attributed. Missing, deleted or inconsistent actor history remains unknown.
Zero other-member counts cannot establish that all records belong to Jay.

Validation: terminal SSM success, `completed=true`, expected instance/project,
read-only transaction and exactly one owner match. A mismatch or failed query
stops the command. No service restart, build, migration or record change occurs.
No application rollback is required. The dedicated client exits, ending its
connection; no remote files, ports or cloud resources are created. The SSM record
remains. The current production command matrix permits bounded diagnostics on
a verified dedicated connection. SSM command `11d5d7c8-70e8-4421-b4d2-c90179000ce5`
completed successfully on the exact target with `completed=true`, `mutations=false`,
one owner match, a read-only transaction and zero other preflight connections.
The dedicated client exited after rollback. Production mutations retain their
exact-action approval requirements.

## Privacy controls in the release source

Automatic usage reporting is disabled. The worker requires explicit opt-in;
Better Auth, Mastra and Next.js telemetry are disabled. Automatic GitHub release
checks and models.dev suggestions require explicit opt-in. All three deploy
composes, the API/worker image defaults and the generated update override deliver
the controls. The update override forces them off independently of the host env.
Docker contexts and source packages exclude local fixture credentials/env files.

Focused verification: 42 tests passed, including no usage-counter/id writes or
outbound requests when reporting is disabled, no GitHub fetch on a forced update
check, and no model-catalogue fetch. Root typecheck, affected API/auth/worker lint,
changed-file formatting and diff checks passed. The existing local member's
protected BROWSER03 board was checked in Playwright; its observed request origins
were only localhost web/API. This browser observation is limited to that screen,
not a network-egress guarantee. Independent review found no material privacy or
packaging issue.

JEV intentionally sends discovery request text and permitted candidate tool
names/descriptions to OpenRouter when its key is configured. It does not load
stored project content or forward OAuth credentials for discovery. Provider
retention is not enforced by the application. Configured integrations, user
external media/link previews and the Scalar documentation CDN can contact their
hosts. See `TELEMETRY.md` for the exact scope; do not claim all outbound traffic
is disabled. Production privacy remains unverified until the new images run.

## Build and candidate acceptance

Package the reviewed working tree with `deploy/ec2/prepare-update.py` into an
ignored immutable source snapshot. Preserve all existing dirty work. The private Itsaplan source archive can be prepared without a commit, push or
public image publication. Shastra has its own source-publication gate above.
The archive includes a per-file SHA256 manifest and image/config update override.

The local ARM Colima builder failed while installing Bun dependencies under x86
emulation: the x86 Bun binary needs instructions unavailable in that emulator.
No deployable amd64 images were produced. Prepare a bounded native x86 build on
the named EC2 host after capacity is verified and exact action is approved.

Test the resulting artifact in an isolated candidate Compose project with its
own database, attachments and credentials. Preserve the installed Compose plus
`compose.alb.yml`, existing environment, secrets and volumes. Do not rerun the
initial installer. The candidate must not point at the live application database.

Use an isolated local Keycloak fixture behind an HTTPS tunnel. Keep its canonical
issuer, discovery metadata, JWKS, userinfo and token `iss` identical. Register exact
candidate/browser redirects and scoped provisioner permissions. The local Shastra
test gateway must use its own realm, origins and grant storage; never reconfigure
the live Shastra issuer to accept fixture tokens. No production Keycloak actions
are authorized in this acceptance phase.

Before shutting down the tunnel, stop the candidate or remove its trust in that
issuer. A laptop tunnel cannot supply permanent production authentication.
The tunnel/container/test origins are not provisioned yet.

Repeat existing/new-user browser login, supported provisioning, no-access empty
workspace, assignments, custom-role boundaries, logout, expiry, revocation and
MCP consent/refresh/denial through the candidate. Record artifact hash and actual
results. Local fixtures already passed the earlier matrix in
`docs/local-v1-keycloak.md`; that is not evidence for a new remote artifact.

## Live update and Shastra changes

After candidate acceptance, prepare the exact in-place update command and its
backup/restore validation. Keep database, attachment, encryption and identity
configuration stable. API startup applies migrations and takes a pre-migration
backup; verify the live backup mount and migration compatibility. Migration 0128
adds nullable team-member custom-role linkage. Unknown historical attribution
and other members' records must be preserved; no blanket reset is planned.

The live application must retain usable production authentication. The user will
configure the real Keycloak groups. Activating managed access requires verified
real settings and a recoverable owner; local fixture credentials/tunnel origins
must never become the live issuer. A code update does not establish production
sign-in acceptance. Production authentication/consent remains user takeover.

Shastra source replaces legacy Itsaplan Keycloak/SCIM provisioning with per-user
native OAuth/PKCE and consent, refresh, permission-filtered tool discovery and
repeated access checks before forwarding. The reviewed registry contains 121
operations plus discovery and the two connection tools; agent/integration
credential operations are excluded. JEV is handled by Itsaplan. Custom roles
require no per-role Shastra code.

Prepare the complete `terraform/mcp` delivery plan and convergence action for
`i-0bf2cffe7dc6f9583` separately. State Manager may auto-converge after a delivery
change, and convergence can restart the shared gateway, briefly affecting other
integrations. Keep legacy credentials/resources until the replacement has passed;
cleanup needs its own exact target/action. Preserve existing downstream grants.

## Recovery and remaining gates

Record the current image/configuration and verify recoverable database/attachments
before replacement. A compatible old image/config can be restored after a failed
update; reverting images does not reverse migrations or Keycloak changes. Database
restoration or shared-gateway changes need their own reviewed action. Stop expanding
access on a failed acceptance check.

Pending: verified recovery backup/restore, native x86 build, isolated remote
candidate setup and browser acceptance, final exact live update, real production
identity activation/acceptance, and Shastra delivery/acceptance. The bounded
production read-only preflight completed. No deployment, production data/configuration
mutation, commit or push has occurred.
