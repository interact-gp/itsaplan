# Local Keycloak and Shastra V1

Keycloak grants application access through `/access/frnd-prd/member` and organization administration through `/access/frnd-prd/admin`. Active human organization admins with fresh synchronized access have full instance, team and project access in the UI, API and MCP, including private project documents and note boards. They can create teams and projects, manage memberships and custom roles, and grant application access to existing, enabled, verified company identities. Global access does not create stored memberships. Removing admin access removes the global override on subsequent authorization checks after synchronization. MCP enablement, project feature settings and data integrity checks remain enforced.

Ordinary members use scoped permissions. Team owners grant team administrative ranks. Team owners and managers manage ordinary memberships and projects. Team custom roles can grant `projects.create`; ordinary members require project membership and its permission matrix to access project content. Agents never inherit organization-admin access.

An authorized user with no assignments has an empty workspace. Managed provisioning creates no personal team. UI and MCP call the same guarded API routes. Managed MCP operations require an explicit team ID and honor team/project MCP switches. Shastra's reviewed V1 registry excludes autonomous agents and integration credential tools.

Managed provisioning never adopts an unverified existing local account. A matching unverified address stays unlinked and unauthorized and requires administrator resolution; other eligible identities continue synchronizing. Verified local accounts can link to the provider's stable subject. Existing unverified accounts previously linked to a managed subject lose their application entitlement during reconciliation.

The API polls Keycloak every 15 seconds. Direct membership changes become effective after reconciliation. Access fails closed if the last successful synchronization is older than 120 seconds. A mutation through the application invalidates its access snapshot before changing Keycloak, then reconciles it. Resource memberships survive application revocation and restoration. A Keycloak subject remains the account identity when its verified company email changes.

## Reproduce locally

Run from this repository. Bun and a working Docker engine are required. This machine uses the isolated Docker context `colima-itsaplan-v1`; substitute your local context elsewhere.

```sh
bun install
bun scripts/local-v1/init.ts
docker --context colima-itsaplan-v1 compose --env-file .local/v1/compose.env -f deploy/local-v1.compose.yml up -d
bun --env-file=.env packages/db/src/migrate.ts
bun --env-file=.env scripts/local-v1/keycloak.ts
bun --env-file=.env scripts/local-v1/seed.ts
bun run dev --filter=api --filter=web
```

`init.ts` refuses to overwrite existing configuration. PostgreSQL uses port 55432, the API 13000, the web app 3001, Keycloak 18080, and DynamoDB Local 18000. Keycloak 26.3.5 uses fine-grained admin authorization v2. Its provisioner can view users and manage membership only in the two application groups; it cannot edit identities, grant realm administration, or manage unrelated groups. Both the client policy and service-account user policy are required for permission evaluation and filtered query results.

Start the sibling gateway and browser test helper in separate terminals:

```sh
cd ../shastra-mcp
python3 tools/itsaplan-local/start.py
```

```sh
bun scripts/local-v1/mcp-browser.ts
```

Open `http://localhost:3001/login` for app sign-in and `http://localhost:18082` for browser-authenticated Shastra testing. The helper uses PKCE and single-use state. After Keycloak sign-in, connect the same Itsaplan account and complete consent. Tool calls then use that user's downstream grant. The helper is a single-user local test utility.

Passwords are in ignored `.local/v1/accounts.json`; service configuration and secrets are in ignored `.local/v1/`. Never commit these files. The local fixtures are `admin`, `member`, `newmember`, `onboarding`, `denied`, and `external`. Registration is closed; new identities are provisioned through Keycloak application access. The test realm issues 60-second access tokens; application sessions have a separate lifetime.

The runtime check creates disposable teams and projects, changes fixture memberships, and restores access in `finally` blocks:

```sh
bun --env-file=.env scripts/local-v1/check-runtime.ts
```

Stop only this compose project with the same context, file, and env-file arguments plus `down`. Its volumes preserve local data. Removing those volumes destroys the fixture data and requires an explicit reset. DynamoDB is in-memory; restarting it removes local Shastra grants and requires reconnecting.

## Local acceptance — 2026-10-02 UTC / 2026-10-03 IST

The tested source bases are Itsaplan `c2ba007`, Shastra `cec9e71`, and Terraform `577ca9d`, with uncommitted local changes. The local environment uses Keycloak 26.3.5, PostgreSQL 17, Next.js 16.3.4, DynamoDB Local, Python Playwright 1.60.0 and Chrome 154.0.8037.95. Execution used Astra at medium effort, independent review used GPT-6.1 Sol at high effort, and the root agent verified browser outcomes. The user explicitly authorized Playwright and automated local fixture authentication/consent.

Computer Use could not connect to a browser. Acceptance used a separate headed Chrome browser controlled through Playwright against the real local identity provider and application. Browser checks ran approximately 18:32–18:57 UTC. Credentials, screenshots, helper tokens and diagnostic scripts remain under ignored `.local/v1/`; no credential values belong in this report. The helper is a single-user test utility; user contexts were isolated and exercised sequentially.

| Acceptance case | Verified outcome |
| --- | --- |
| Existing admin | Fresh Keycloak login, downstream same-account consent and usable protected project board passed. Existing admin ownership was retained. Earlier UI checks created team 5, project MAILUI and a custom team role granting only project creation. |
| Supported new-user onboarding | A fresh enabled/verified company identity with no group and no Itsaplan row received member access through admin UI. Provisioning created exactly one ordinary user. Fresh browser SSO linked exactly one matching OIDC account, created no personal team, and showed an empty workspace. Second login preserved the identity/link. |
| Release-notes dismissal | The fresh member clicked Got it and reached a clean empty workspace without the reported error. |
| Team/project assignment | Admin UI added onboarding to team 5 and project BROWSER03 as Member. Its protected board and API became usable. MAILUI remained forbidden. Organization access and team creation were denied to the member. |
| Closed registration and denied users | Browser registration states that registration is closed. Fresh Keycloak logins for the no-entitlement and external-company fixtures were denied; protected API returned 401. Anonymous protected navigation redirected to login. |
| Per-user MCP grants | Admin and onboarding each completed their own helper login and explicit downstream consent. Before connection each saw only Connect/Disconnect. Connected admin had 124 tools; onboarding had 80, excluding team creation, application-access mutation and team-project creation. These counts are fixture-specific. |
| Discovery and execution | Real OpenRouter Jev recommended the authorized team-project tool for admin. Browser MCP execution created BROWSER03, id 7, in team 5, and API/MCP readback plus the UI board confirmed it. Member discovery recommended get_project and the assigned project read succeeded. Sibling reads were denied without data. |
| MCP wire compatibility | The gateway preserves sanitized structuredContent at the outer CallToolResult. A real schema-aware MCP SDK client completed initialize/listTools/get_project/discover_tools without schema errors. |
| OAuth failure handling | Cancelling consent saved no grant. Replaying a completed browser callback returned 400. A connection initiated by onboarding but authorized as admin was rejected and saved no grant. Fresh same-account consent restored onboarding's connection. Disconnect removed its stored connection. |
| Logout and session expiry | Member UI logout redirected to login and protected API returned 401. Conditionally expiring its exact fresh app session caused API 401 and protected-board redirect; real SSO reauthentication restored access. |
| Downstream refresh | Conditionally expiring the exact browser-created admin downstream grant triggered real refresh through gateway tools/list: token fingerprint changed, grant version increased from 1 to 2, same client remained and expiry was renewed. |
| Application revocation and restoration | Admin UI removed onboarding access. Its existing app cookie returned 401 and board redirected to login. Its existing gateway credential exposed only Connect/Disconnect; protected call was not dispatched. Restoring member access preserved resource memberships and the downstream grant; MCP read succeeded again. The old app cookie remained invalid and fresh app login restored its board. |

Expiry checks used conditional metadata updates on the exact local fixture session/grant. They establish induced-expiry handling, not a naturally elapsed one-hour access-token observation. Keycloak token, application session and downstream token lifetimes are separate. Application logout ends the application session; the Keycloak SSO session remains available for subsequent login.

## Review and regression evidence

The detailed authentication/configuration review covered 56 source/configuration files and installed better-auth OIDC/MCP paths: issuer/audience/signature/expiry validation, PKCE/state, exact redirects, cookies, consent, account linking, synchronization, least privilege, refresh, forwarding and delivery configuration. Live client readbacks verified exact origins/callbacks and enforced S256. Direct grants and registration are disabled; scoped provisioner permissions do not grant realm administration. All three deployment API environment allowlists deliver managed-access settings. Managed mode and the gateway integration remain disabled by default for production.

Three material findings were fixed and retested:

- Unverified legacy email collisions cannot acquire a managed identity or application entitlement. Previously linked unverified identities lose entitlement; verified legacy linking remains supported. The focused managed/SCIM suite passed 41 tests, including old cookie/API-key denial.
- Proxied tool output schemas require outer structuredContent. Sanitized structured results are forwarded at the correct MCP level, verified with the real SDK and browser readback.
- Read-only native 401/403/404 failures return the same generic unavailable denial. They do not claim an unknown write outcome. Writes, malformed/transport responses and server failures retain conservative outcome handling; dispatched writes are not retried. Focused Shastra OAuth/proxy checks passed 63 tests after these regressions.

API lint/typecheck, web/script typechecks, changed-file formatting/diff checks and the frontend production build passed. Tests and configuration checks supplement the real browser evidence above.

## Jev configuration and limits

`discover_tools(request, teamId?, projectId?)` uses OpenRouter's decisions API with `~typesafe/jev-latest`; the observed model was `typesafe/jev-1.13-20260917`. The API reads optional `OPENROUTER_API_KEY` from its server environment. Only the task request and descriptions of scope/permission/feature-filtered candidates are submitted. OAuth credentials and stored project content are excluded; avoid secrets or sensitive project text in the request itself.

The gateway admits 122 native tools (121 operations plus discovery), plus Connect/Disconnect. Recommendations intersect its current per-user catalogue and use prefixed names and sanitized schemas. A recommendation does not grant permission: execution repeats discovery and target authorization. The five-second timeout and provider failure use a labelled lexical fallback over the same authorized candidates. Live native verification covered delegated project/issue creation, unassigned-user no-match and inaccessible scope; focused checks exercised HTTP 503 and stalled-provider fallback. The 0.6 confidence threshold is provisional, not an accuracy guarantee.

## Production boundary

This evidence establishes local V1 acceptance. It does not establish production readiness or production sign-in success. Production topology, domains, client redirects, TLS/cookies, secret delivery, managed-group provisioning, activation, rollback and cleanup require an exact deployment proposal and approval. Production must repeat both existing-user and supported new-user browser onboarding plus access revocation after deployment. No commits, pushes, production mutations, production credential cleanup or deployment were performed.
