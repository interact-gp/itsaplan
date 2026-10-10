# Telemetry and external requests

Usage telemetry is disabled by default. With telemetry disabled, the worker does
not read usage counters, create a telemetry instance id, or contact the collector.
Better Auth and Mastra usage telemetry are disabled. Next.js telemetry is disabled
in the web image. No browser analytics or external error-reporting service is configured.

Automatic GitHub release checks and models.dev model suggestions are disabled by
default. Set `UPDATE_CHECKS_ENABLED=1` or `MODEL_CATALOG_ENABLED=1` to enable them.
Release notes remain available from the bundled changelog; model ids can be entered
manually. These metadata requests disclose server IP and request timing.

Configured integrations send data when used: identity-provider authentication, mail,
Telegram, webhooks, repository operations and AI providers. JEV tool discovery uses
OpenRouter when `OPENROUTER_API_KEY` is configured. It sends the discovery request
and candidate tool names/descriptions permitted for that user, without loading
stored project contents or forwarding authentication credentials. Request text can
include sensitive information supplied by the caller. Without that key, discovery
uses local lexical matching. OpenRouter retention is governed by its service terms;
this application does not enforce provider zero-retention controls.

External markdown images and media can contact their hosts from the browser. Link
previews contact the requested hosts from the server. Interactive API documentation
at `/docs` and `/api/auth/reference` loads Scalar JavaScript from jsDelivr. These
functional requests are separate from usage telemetry.

## When opt-in telemetry is sent

The first snapshot goes out when the worker starts, so an instance that is set up and
removed the same hour is still counted once. After that each instance picks one minute
of the day at random and keeps it, then reports once a day from that minute on. That
spreads the traffic instead of every instance reporting at midnight UTC.

A send that fails is retried with a growing delay for five attempts, then once an hour.
The worker logs each failure and carries on with its other work.

## Enabling usage telemetry

To enable reporting with deployment defaults, set both:

```bash
TELEMETRY_DISABLED=0
DO_NOT_TRACK=0
```

An unset or empty `TELEMETRY_DISABLED` keeps telemetry off. Any nonempty
`DO_NOT_TRACK` value except `0` prevents reporting. Deployment defaults set both
variables to `1`. The sections below describe reporting only when enabled.

## Seeing what is sent

```bash
TELEMETRY_DEBUG=1
```

The worker logs the exact body before each send.

## What is sent

- A random id, generated once for this instance.
- The day the instance was installed, taken from the timestamp of its first database
  migration.
- The running version.
- The runtime: Bun version, OS and architecture, Postgres major version, whether it
  runs in Docker.
- How many users, projects and issues there are, plus how many users signed in and how
  many issues were created in the last 30 days, and how much space attachments take.
  All of it as size ranges (`6-20`, `101-1000`), never exact numbers.
- Which features are used, as yes/no, twice over: ever, and in the last 30 days.
  Initiatives, note boards, dashboards, saved views, custom fields, label groups,
  project actions, attachments, cycles, checklists, sub-issues, issue links, watchers,
  shared issues, shared views, agent chats, agent skills.
- Which optional sections a project switched off in Settings -> Features, as yes/no.
- Which integrations are set up and switched on, as yes/no: email, Google sign-in,
  Telegram bot, webhooks, API keys, MCP, repository hosting, per-project integration
  credentials.
- Which integrations hold a credential, by their catalogue key (`openai`, `jina`), and
  which repository hosts have delivered (`github`, `gitlab`, `gitea`, `forgejo`,
  `bitbucket`). The keys only, never a credential or a repository name.
- The sign-up policy: whether registration is open, invite-only or closed, whether
  email has to be confirmed, whether magic links are on.
- The interface languages users picked, as language codes.
- AI agents: how many, how many are internal and how many external, how many runs in
  the last 30 days (as ranges), how many skills, how many chats, whether schedules are
  used, whether an external agent's runner polled in the last 30 days, and which
  triggers started a run (mention, delegation, schedule, manual).
- The share of webhook deliveries and of agent runs that failed in the last 30 days.

## What is never sent

Names of anything. Project keys, issue titles, descriptions, comments. Email
addresses, user names. Webhook URLs, agent prompts, credentials, environment
variables, file contents, logs, error messages. Exact counts.

The instance id is a random uuid stored in the database. It is not derived from your
domain, your keys, or anything else in the instance.

## Where it goes

`https://telemetry.itsaplan.dev`, operated by the project. No third-party analytics
service is involved. The address is fixed in the worker; there is no setting that
points it somewhere else.
