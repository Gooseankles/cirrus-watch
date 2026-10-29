# Cirrus Watch documentation

Pick the part for what you are doing. The [README](../README.md) has the tool list and the quick start.

## Using the dashboard

- [Using the dashboard](guides/using-the-dashboard.md): scan pages, accepting findings, monthly report, trends,
  compliance pages.
- [Tools](tools.md): what every scan checks.

## Setting it up

- [Sign-in and roles](guides/sign-in-and-roles.md): local admin, SSO, roles, areas.
- [Permissions](permissions.md): what each identity needs.
- [Customer tenants](guides/customer-tenants.md): scanning other organizations' tenants.
- [Notifications](guides/notifications.md): Teams, Slack, webhook or email.
- [Terraform module](https://github.com/Gooseankles/terraform-azurerm-ops-dashboard#readme): every input.

## Running it

- [Operations](operations.md): upgrade, roll back, back up, rotate secrets, audit log, server load.
- [Troubleshooting](troubleshooting.md): common problems by symptom.
- [Where data is kept](data.md).
- [Changelog](../CHANGELOG.md), with the **Upgrading** steps.

## How it is built

- [High-level design](hld.md): purpose, scope, building blocks, main choices, on one page.
- [Setup low-level design](lld-setup.md): what the Terraform module creates and how start-up, sign-in and a scan
  run step by step.
- [Architecture](architecture.md): every part, with diagrams.
- [Decision records](adr/README.md): why it is built this way.
- [Contributing](../CONTRIBUTING.md): run locally, add a tool, what a change brings with it.
- [Security](../SECURITY.md): reporting a problem, running it safely.
