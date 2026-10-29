# Troubleshooting

Common problems by symptom, with the cause and the fix. Messages in quotes are what the dashboard shows. Recent
activity, the scan page's error box and App Service → Log stream usually say which one it is.

## Sign-in

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Your account has no role on this dashboard." | The account (or a group it is in) has no app role on the sign-in app | Add the person to a role group, or assign a role in Enterprise applications → the app → Users and groups. Roles apply at the next sign-in |
| "Sign-in was refused: AADSTS50011 …" (redirect URI mismatch) | The app registration's redirect URI differs from `DASHBOARD_REDIRECT_URI` | Make them the same, including `https://` and `/auth/callback`. The module sets both from `name`; a custom domain needs both changed |
| "Sign-in was refused: AADSTS50105 …" | Assignment is required and the person is not assigned | As for "no role" above |
| "Need admin approval" | The tenant blocks user consent and `openid profile` were not consented | Set `grant_sso_consent = true`, or have an admin grant consent on the app |
| "Sign-in failed: the user-assigned managed identity with client ID … gave no token" | The identity in `DASHBOARD_FEDERATED_MI_CLIENT_ID` is not attached to the web app, or the value is its object ID | Attach it (web app → Identity → User assigned) and use its **Client ID** |
| "Sign-in failed: … AADSTS700213 / AADSTS70021 …" (no matching federated credential) | The federated credential's issuer or subject does not match the identity | The subject must be the user-assigned identity's object ID, the issuer `https://login.microsoftonline.com/<tenant>/v2.0`, the audience `api://AzureADTokenExchange` |
| "SSO is not configured (DASHBOARD_AZURE_* missing in .env)." | Tenant ID, client ID, or both of client secret and federated identity are missing | Set them ([sign-in and roles](guides/sign-in-and-roles.md#sso-with-an-entra-id-app-registration)) |
| "too many wrong passwords; try again in N minute(s)" | Ten wrong local admin passwords from one address | Wait 15 minutes |
| "local admin account is not configured" | `DASHBOARD_ADMIN_PASSWORD` is empty | Set it, or sign in with SSO |
| Signed out after every update | `DATA_DIR` is not on a volume, so sessions and the sign-in key are lost | Map `DATA_DIR` to a volume (Docker), or set `SESSION_SECRET` to a fixed value of 32 characters or more |
| "request refused: it did not come from this dashboard's own pages" | A script or proxy sent a changing request with another `Origin` header | Send the dashboard's own address as `Origin`, or none. Behind a proxy, `DASHBOARD_REDIRECT_URI` must use the address people open |

## Scans

| Symptom | Cause | Fix |
| --- | --- | --- |
| A scan fails with 403, "Authorization_RequestDenied" or "AuthorizationFailed" | The identity lacks a Graph permission or an Azure role | The error box lists what the scan needs. Grant it ([permissions.md](permissions.md)), then use **Test** in Settings to check |
| A Graph permission was granted, but the scan still fails | A managed identity's token is cached for up to 24 hours | Wait; the token renews within 24 hours. **Test** in Settings lists such permissions apart from the missing ones, with the token's age |
| A scan shows no subscriptions or too few | Reader is missing on those subscriptions, or `AZURE_SUBSCRIPTION_IDS` limits the list | Give Reader at a management group; check `scan_subscription_ids` |
| Stale accounts or MFA coverage fail in one tenant | Sign-in activity and the authentication methods report need Entra ID P1 or P2 | Needs that licence in the tenant; otherwise turn the scan off there (Settings → Scans) |
| Key Vault item check shows errors per vault | The vault's firewall blocks the dashboard, or Key Vault Reader is missing | Allow the dashboard's outbound addresses or subnet; grant Key Vault Reader, or leave `KEYVAULT_ITEM_CHECK` off |
| A customer tenant fails every scan with AADSTS7000222 or AADSTS7000215 | Its client secret has expired or is wrong | New secret from the customer, paste in Settings → Customer tenants → Edit, **Test** ([operations](operations.md#rotate-secrets)) |
| "… already running for …; not started again" | That scan is still running in that tenant | Wait for it; Recent activity says when it ends |
| A scan takes very long or the page is slow | A large tenant; several scans at once | See Admin → Server load for the scan that pushed the load; move schedules apart or use a bigger plan |

## Storage and secrets

| Symptom | Cause | Fix |
| --- | --- | --- |
| "the key vault is not reachable, so the secret was not saved: …" | The vault is blocked by its firewall or private endpoint, or the role is missing | Check the vault's network rules and private DNS; the web app's identity needs Key Vault Secrets Officer. The app retries every minute |
| A scan says the key vault holding the secrets is not reachable | Same as above | Same as above; scans that need no secret keep running |
| "SECRET_VAULT_URL must be the vault's https://<name>.vault.azure.net address" | A wrong value in Settings or the app setting | Use the vault URI from the portal |
| "history storage: STORAGE_ACCOUNT_URL must look like https://<account>.blob.core.windows.net" | A wrong value | Use the account's blob endpoint |
| History errors with 403 | Storage Blob Data Contributor missing, or the network blocks the account | Grant the role to the web app's identity; with `private_network`, check the private endpoint and DNS zone link |
| "Sign-ins kept in memory only (lost on restart)" in the log | `DATA_DIR/sessions` is not writable | Fix the folder's permissions or the volume |

## Notifications

| Symptom | Cause | Fix |
| --- | --- | --- |
| "the link answered 4xx/5xx …" | The webhook was deleted, or the flow is off | Make a new link and paste it in Settings → Notifications; **Send test** |
| "the dashboard may not send mail as …" | The identity lacks the Exchange role Application Mail.Send for that mailbox | Follow the PowerShell steps in [notifications](guides/notifications.md); the role can take two hours to apply |
| "no mailbox … in the home tenant" | `NOTIFY_MAIL_FROM` names a mailbox that does not exist there | Use a mailbox (a shared one is fine) in the home tenant |
| "set Send email from (Settings, Home tab, Notifications) to send email" | Email addresses are set but no sender | Set **Send email from** on the Home tab |
| Nothing arrives | Nothing new since the last message, or it is not yet `NOTIFY_TIME` | A day with nothing new sends nothing; check Recent activity for "sent to …" |

## Still stuck

Search the [issues](https://github.com/Gooseankles/cirrus-watch/issues), or open one with the version
(bottom left), what you did and the message. Security problems go through [SECURITY.md](../SECURITY.md), not an
issue.
