# Notifications

A daily message per tenant with what is new: to Teams, Slack, another webhook or email addresses.

Each tenant can have one notification link (Settings → Notifications, on that tenant's tab; Admin only). Once a
day at `NOTIFY_TIME` (server time, default 08:30, after the nightly scans) the tenant gets one message with what
turned up since the last one: new findings, grouped by tool (up to 25 listed, the rest counted), and scans that
failed. Accepted and snoozed findings and the change log are left out, a tool's first run in a tenant does not count
everything as new, and a day with nothing new sends nothing. A tenant only gets its own findings.

The link can be:

- **Teams**: in the channel, Workflows → "Post to a channel when a webhook request is received", and copy the link.
  The message is an Adaptive Card with a button to the dashboard (taken from `DASHBOARD_REDIRECT_URI`).
- **Slack**: an incoming webhook (`hooks.slack.com`); it gets plain text.
- **Any other https endpoint** (Power Automate, Logic Apps, n8n): it gets the Teams body plus `text` and a
  `summary` object with the tenant, counts and items.
- **Email addresses** (comma-separated, up to 20), for when the organization blocks webhooks. A Teams channel's
  email address (channel ⋯ → Get email address) works too, if the organization allows mail to channels. The mail
  goes out through Microsoft Graph from the mailbox in **Send email from** (Settings → Notifications on the Home
  tab, `NOTIFY_MAIL_FROM`): a mailbox in the home tenant (a shared mailbox is fine), whichever tenant the message is
  about. The dashboard's identity (app or managed identity) needs the right to send as that mailbox, best given in
  Exchange Online with **RBAC for Applications**, limited to that mailbox, and *not* as Graph `Mail.Send` in Entra
  (an Entra grant works for every mailbox and overrides the Exchange limit):

  ```powershell
  Connect-ExchangeOnline
  New-DistributionGroup -Name "Dashboard Mailer Scope" -Type Security -Members alerts@contoso.com
  New-ServicePrincipal -AppId <app id> -ObjectId <enterprise app object id> -DisplayName "Cirrus Watch mailer"
  $dn = (Get-DistributionGroup "Dashboard Mailer Scope").DistinguishedName
  New-ManagementScope -Name "Dashboard Mailer Mailboxes" -RecipientRestrictionFilter "MemberOfGroup -eq '$dn'"
  New-ManagementRoleAssignment -App <app id> -Role "Application Mail.Send" -CustomResourceScope "Dashboard Mailer Mailboxes"
  Test-ServicePrincipalAuthorization -Identity <app id> -Resource alerts@contoso.com   # InScope = True
  ```

  The role can take up to two hours to apply.

The link carries its own signature, so it is kept like a client secret (the key vault when `SECRET_VAULT_URL` is
set, else `notify.json` under `DATA_DIR`) and never shown again. What is waiting is kept in `notify-queue.json`. A
failed send is logged in Recent activity and tried again every hour. Send test posts a test message at once.

Related: [Using the dashboard](using-the-dashboard.md), [Troubleshooting](../troubleshooting.md#notifications).
