# 0006. One process, one instance, no database

- Status: accepted
- Date: 2026-10-20

## Context

The dashboard is a small tool for a few people. A database server, a queue and workers would cost more to run
and to keep up to date than the app itself.

## Decision

One Node.js process serves the pages and the API, runs the schedules (node-cron), sends notifications and samples
its own load. Results and history are JSON in blob storage (or on disk); settings, sessions and logs are files under
`DATA_DIR`. Run exactly one instance.

## Consequences

- Cheap and simple: a B1 App Service plan, one storage account, one key vault.
- No scale-out: two instances would run every scan twice and write the same files. Scale up instead.
- A restart during a scan loses that run; the next schedule or Run now repeats it.
- Reports and trends read the stored history; they never start scans.
