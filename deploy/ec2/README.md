# EC2 deployment

Status: Itsaplan 1.0.0 is installed on `i-0a7cc7b624234c60e` with private API/web health checks passing. GoDaddy DNS and public HTTPS are verified. The actual deployment uses the shared ALB, 40 GiB storage, and [the Ansible package](https://github.com/interact-gp/terraform/tree/main/itsaplan/ansible). See [deployment results](https://github.com/interact-gp/terraform/blob/main/itsaplan/ansible/DEPLOYMENT_RESULT.md) for verification. Both `prd.frnd.app` and `prd-api.frnd.app` remain closed with setup-pending responses. Google authentication and off-host backups are pending. The standalone Caddy configuration below is a preparation reference and is not deployed.

Fork: https://github.com/interact-gp/itsaplan

Reviewed source: `ae861822d4dc3632fa5a92beb1d31fb356a70fbc`, version 1.0.0 (2026-09-15).

## Initial server

Use a dedicated Ubuntu 24.04 LTS x86_64 EC2 instance, `t3.large` (2 vCPU, 8 GiB RAM), with 40 GiB encrypted gp3 storage. This is an initial sizing recommendation for a small-team pilot, not an upstream minimum or a measured capacity guarantee. Monitor memory, disk, CPU credits and request latency. Use 4 vCPU / 16 GiB if sustained activity requires it. No GPU is needed when model inference uses a remote provider.

Run Docker Engine and Compose v2.24 or newer. Configure Docker log rotation before starting the stack. Keep coding CLI runners and Android builds on a separate machine with their own limited credentials.

## Shastra provisioning request

Resolve the authorized AWS principal and target before provisioning. Expected FRND account is `582524322671`, region `ap-south-1`; stop on mismatch. Use the per-user `shastra-platform` credential process for AWS CLI and Terraform; verify the expected role/session before any action. Do not fall back to legacy static credentials.

Allocated isolated resource: `itsaplan-pilot`, `t3.large`, Ubuntu 24.04 LTS x86_64, encrypted 40 GiB gp3, IMDSv2 required, administration through SSM, no public SSH. The existing internet-facing `frnd-wildcard-alb` terminates HTTPS and routes to the private host; both routes return setup pending until access controls are verified. Do not attach production application/database credentials or broad IAM permissions. The reviewed Terraform allocation is recorded in the infrastructure repository at `itsaplan/ALLOCATION.md`.

The bundled Caddy option assumes two DNS names reach this host and certificate validation can succeed on ports 80/443. If existing internal ingress terminates TLS, adapt routing to that ingress instead of deploying this proxy. Do not expose an unclaimed installation: the first registered account becomes administrator. Restrict application access to Jay during setup and establish the access policy below before opening normal ingress. User takeover is required for authentication setup.

## Google sign-in and access policy

Enable Google sign-in. Initially, Jay is the only application user and administrator. Confirm the exact Google account with Jay during setup; do not infer it from an unrelated browser or connector account. Do not automatically grant access to everyone in the company domain or to everyone with a Google account.

Create a Google OAuth web client for the deployed origins. Register the exact redirect URI shown in the Itsaplan administration UI: `<API_URL>/api/auth/callback/google`. Configure the client ID and secret through Itsaplan's Google authentication settings; this version stores them encrypted in its database. Keep credentials out of this document, Git, chat and logs.

Bootstrap the first administrator while access is restricted to Jay. Verify Google sign-in resolves to that same administrator account, then set registration to **closed**. Confirm Jay can sign out and back in using Google, and that a different, uninvited Google account cannot create an account or access application data. Check for unintended existing accounts and pending invitations. Google OAuth consent settings alone do not enforce the application access policy.

When Jay is ready to add people, change registration to **invite only** and send individual invitations only to the email addresses Jay selects. Give each person access only to the required projects and an appropriate non-administrator role. Verify an invited account can join while an uninvited account is rejected. Do not enable open registration or automatic domain-wide admission.

Source verification for version 1.0.0: `packages/auth/src/index.ts` defines the Google callback and applies the closed/invitation registration gate to both password and social sign-up. Google sign-in is supported but has not been configured or tested on a running deployment yet.

## Standalone Caddy reference

The deployed ALB configuration and pinned dependency images are maintained in
[the Terraform Ansible package](https://github.com/interact-gp/terraform/tree/main/itsaplan/ansible).
The files in this directory describe a standalone Caddy alternative; do not apply
them over the installed ALB deployment.

Run from the repository root. Copy `deploy/ec2/env.example` to `.env` on the server with mode 0600. The deployed origins are `APP_URL=https://prd.frnd.app` and `API_URL=https://prd-api.frnd.app`. Generate independent secrets on the host; use a URL-safe hexadecimal PostgreSQL password because Compose interpolates it into a database URL. Keep `APP_ENCRYPTION_KEY` stable and include it in the secure recovery process. No secret values belong in Git or this document.

The application images are upstream version `1.0.0`, pinned by digest in the override. All four registry manifests were verified on 2026-09-15 and include linux/amd64 and linux/arm64. Changing `VERSION` alone does not change these pins. Forking does not automatically publish images under the organization. Before starting, pin dependency images (PostgreSQL, MinIO, mc, Caddy) to approved digests. If custom application code is added, build and publish images from the reviewed fork revision and update the image references.

```sh
docker compose -f docker-compose.yml -f deploy/ec2/compose.yml config --quiet
docker compose -f docker-compose.yml -f deploy/ec2/compose.yml pull
docker compose -f docker-compose.yml -f deploy/ec2/compose.yml up -d --no-build
docker compose -f docker-compose.yml -f deploy/ec2/compose.yml ps
```

Only the proxy publishes host ports. PostgreSQL, MinIO, API and web remain on the Compose network. Caddy forwards WebSockets and streaming responses. The one-shot `minio-init` service must exit successfully. The API performs database migrations during startup.

## Validation and recovery

Before normal access, verify both TLS origins, Jay's Google administrator login, closed registration, rejection of an uninvited account, an issue and document, attachment upload/download, and one controlled agent interaction. Before adding colleagues, verify invitation-only registration and project access as described above. Configure mail and the selected model provider through the application. Check that provider credentials are not written to logs. Record the instance identity and health results.

Provision daily database dumps and attachment backups to approved encrypted off-host storage. Keep at least seven daily recovery points for the pilot and test a restore before storing important data. Automatic pre-migration dumps are local to the EC2 host and are insufficient for host loss. Back up secrets and TLS state through approved encrypted storage. Target a 24-hour recovery point and a four-hour recovery time, subject to a successful restore test.

Before upgrades, retain the current image digests, database dump and attachment snapshot. Migrations can prevent an image-only downgrade; restore a matching database, attachment backup and encryption key into an isolated replacement host if necessary. Do not remove persistent volumes during rollback.

For a failed initial deployment, restrict ingress and stop only this new stack while preserving its volumes for diagnosis. Resource termination, volume deletion and DNS cleanup require a separately reviewed action. No shared production service should be changed.

## Remaining gates

- Apply the [reviewed setup-access plan](https://github.com/interact-gp/terraform/blob/main/itsaplan/SETUP_REVIEW.md) for `106.192.231.31/32` after exact-action approval; reverify the IP before applying. Confirm Jay's Google account during administrator setup.
- Configure Google sign-in and verify Jay-only access with registration closed.
- Complete off-host backups and the smoke/restore checks.
