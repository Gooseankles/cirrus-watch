# 0001. Scans only read

- Status: accepted
- Date: 2026-10-20

## Context

The dashboard is meant to be pointed at production tenants, including other organizations' tenants. A tool that
can change resources can also break them, and an identity with write rights is a bigger prize for an attacker.

## Decision

Every scan uses read-only access: Reader and Cost Management Reader on Azure, and read-only Graph application
permissions. No scan deletes, changes or creates anything in a scanned tenant. The only writes go to the dashboard's
own storage account and key vault. Fixing a finding is left to people; the finding says what to change.

## Consequences

- Customers can grant access without worrying about changes.
- Some findings could be fixed with one click but are not.
- Permission lists stay short ([permissions.md](../permissions.md)).
- Email notifications need a send right, given in Exchange and scoped to one mailbox, not in Graph.
