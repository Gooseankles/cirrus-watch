# 0005. Each customer tenant has its own app registration

- Status: accepted
- Date: 2026-10-21

## Context

One installation should scan several organizations' tenants. The home identity is a managed identity, and Entra
does not let an app registration in another tenant trust a managed identity of this tenant (AADSTS700236). Azure
Lighthouse delegation covers Azure resources but not Entra (Graph) data.

## Decision

Each customer makes an app registration in their own tenant, with a client secret, the Graph application
permissions and Reader roles. The dashboard stores the secret in Key Vault
([0003](0003-secrets-in-key-vault-not-terraform.md)) and runs that customer's scans as that app. Each customer gets
its own storage container and its own roles. A tenant delegated with Lighthouse can instead be scanned by the home
identity like any other subscription.

## Consequences

- One secret per customer to watch: when it expires, that customer's scans fail.
- Customers keep control: they can see and revoke the app at any time.
- Terraform never touches a customer tenant; `terraform output customer_onboarding` prints the steps for them.
- The first version used federated sign-in for customers; it was replaced the same day because of the limit above.
