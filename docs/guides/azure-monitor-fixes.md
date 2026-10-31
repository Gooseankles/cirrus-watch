# Fixing Azure Monitor findings

What to do about each finding on the [Azure Monitor](../tools.md#azure-monitor) page.

The same steps are in the app: open **How to fix** under a finding's detail. Each one links to the Microsoft Learn
page it is based on. Replace the `<...>` parts of a command with your own names and resource IDs.

Most machine findings come down to the same thing: the machine needs the Azure Monitor Agent **and** a data
collection rule (DCR) linked to it. Adding a machine to a DCR in the portal does both, and turns on the managed
identity the agent needs.

The steps below are written by the code (`public/fixes.js`, `npm run docs`); change them there, not here.

## Fixes by finding

<!-- fixes:start -->
### No monitoring agent

Finding kind `monitor-no-agent`.

1. One VM in the portal: Monitor > Data Collection Rules, create a rule (or open one), then Resources > Add resources and pick the VM. This installs the agent and turns on a managed identity.
2. Or open the VM > Monitoring > Insights > Enable. VM insights installs the agent and a rule too.
3. Many machines: assign the built-in Azure Policy initiatives that deploy the Azure Monitor Agent and associate it with a data collection rule (one for Windows, one for Linux), with a remediation task for machines that already exist.
4. CLI: `az vm extension set --name AzureMonitorWindowsAgent --publisher Microsoft.Azure.Monitor --ids <vm-id> --enable-auto-upgrade true` (AzureMonitorLinuxAgent on Linux), then `az monitor data-collection rule association create --name <name> --rule-id <dcr-id> --resource <vm-id>`.
5. Arc servers take the same rule or policy; on the CLI use `az connectedmachine extension create`.
6. Before you start: the machine must be running, have a managed identity and reach the Azure Monitor endpoints on port 443.

Microsoft Learn: <https://learn.microsoft.com/en-us/azure/azure-monitor/agents/azure-monitor-agent-manage>

### Legacy agent only

Finding kind `monitor-legacy-agent`.

1. The legacy Log Analytics agent (MMA/OMS) is retired and can stop sending data at any time.
2. Install the Azure Monitor Agent and link a data collection rule that collects the same data. The DCR Config Generator can build the rule from the old workspace settings.
3. Check that the data arrives in the workspace, for example with a Heartbeat query.
4. Then remove the MicrosoftMonitoringAgent or OmsAgentForLinux extension, so nothing is collected twice.

Microsoft Learn: <https://learn.microsoft.com/en-us/azure/azure-monitor/agents/azure-monitor-agent-migration>

### Agent failed

Finding kind `monitor-agent-failed`.

1. Open the machine > Settings > Extensions + applications and read the error on the Azure Monitor Agent extension.
2. Check that the machine is running and has a managed identity turned on.
3. Check that it reaches the Azure Monitor endpoints on port 443 (firewall, proxy, private link).
4. If it still shows failed after 10 to 15 minutes, uninstall the extension and install it again.

Microsoft Learn: <https://learn.microsoft.com/en-us/azure/azure-monitor/agents/azure-monitor-agent-troubleshoot-windows-vm>

### No collection rule

Finding kind `monitor-no-dcr`.

1. The agent collects nothing until a data collection rule is linked to the machine.
2. In the portal: Monitor > Data Collection Rules, open or create a rule, then Resources > Add resources and pick the machine.
3. The rule needs a data source (performance counters, event logs or Syslog) and a Log Analytics destination. Create it in the workspace's region.
4. CLI: `az monitor data-collection rule association create --name <name> --rule-id <dcr-id> --resource <machine-id>`.

Microsoft Learn: <https://learn.microsoft.com/en-us/azure/azure-monitor/vm/data-collection>

### No heartbeat

Finding kind `monitor-no-heartbeat`.

1. Check that the machine is running and its Azure Monitor Agent extension shows Provisioning succeeded.
2. Check that a linked data collection rule sends to a Log Analytics workspace; the heartbeat goes there.
3. Check the network: outbound 443 to the Azure Monitor endpoints and no HTTPS inspection. With a private link scope, the rule needs a data collection endpoint in that scope.
4. In the workspace, `Heartbeat | where Category == "Azure Monitor Agent"` shows when the machine last reported.

Microsoft Learn: <https://learn.microsoft.com/en-us/azure/azure-monitor/agents/azure-monitor-agent-troubleshoot-windows-vm>

### Arc disconnected

Finding kind `monitor-arc-disconnected`.

1. Azure marks an Arc server Disconnected after 15 minutes without a heartbeat: it is off, offline, or its agent stopped.
2. On the server, `azcmagent show` gives the status and `azcmagent check` tests the Azure Arc endpoints.
3. Make sure the Azure Hybrid Instance Metadata Service (himds) is running and the proxy or firewall lets the endpoints through.
4. After 45 to 90 days offline its identity expires: run `azcmagent disconnect`, then `azcmagent connect` again.
5. A Resource Health alert on Arc servers tells you next time.

Microsoft Learn: <https://learn.microsoft.com/en-us/azure/azure-arc/servers/troubleshoot-connectivity>

### Rule sends nowhere

Finding kind `dcr-destination-missing`.

1. The rule sends to a Log Analytics workspace that was deleted, so what it collects is dropped.
2. Open the rule (Monitor > Data Collection Rules) > Data sources, and give each data source a workspace that exists as its destination.
3. The workspace must be in the rule's region; if it is not, create a new rule in the workspace's region and move the machines to it.
4. If nothing needs the rule any more, delete it.

Microsoft Learn: <https://learn.microsoft.com/en-us/azure/azure-monitor/vm/data-collection>

### Rule not linked

Finding kind `dcr-unused`.

1. The rule has data sources but no machine linked, so it collects nothing.
2. If machines should use it: open the rule > Resources > Add resources.
3. If a policy assignment is meant to link machines to it, run a remediation task for that assignment.
4. If it is left over, delete it so nobody thinks it is in use.

Microsoft Learn: <https://learn.microsoft.com/en-us/azure/azure-monitor/vm/data-collection>

### Alert rule off

Finding kind `alert-disabled`.

1. Monitor > Alerts > Alert rules, select the rule and Enable it if it is still needed.
2. If it was turned off because it was noisy, fix the condition or delete the rule.
3. CLI: `az monitor metrics alert update -g <rg> -n <rule> --enabled true` for metric rules, `az monitor scheduled-query update -g <rg> -n <rule> --disabled false` for log search rules.

Microsoft Learn: <https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/alerts-manage-alert-rules>

### Alert tells nobody

Finding kind `alert-no-action`.

1. Monitor > Alerts > Alert rules, select the rule > Edit > Actions.
2. Pick an action group, or create one with the people or channel who should hear about it.
3. Save, then Test the action group to check the message arrives.

Microsoft Learn: <https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/alerts-manage-alert-rules>

### Action group deleted

Finding kind `alert-action-group-missing`.

1. An action group the rule uses was deleted, so that part of the alert goes nowhere.
2. Monitor > Alerts > Alert rules, select the rule > Edit > Actions.
3. Remove the missing group, pick one that exists, and save.

Microsoft Learn: <https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/alerts-manage-alert-rules>

### Watches deleted resource

Finding kind `alert-scope-missing`.

1. The resource the rule watches was deleted, so the rule can never fire.
2. If the resource was replaced, edit the rule's Scope to the new one. Log search rules cannot change scope: create a new rule.
3. Otherwise delete the rule. Metric rules on deleted resources are hidden: in the resource group, tick Show hidden types and filter on microsoft.insights/metricalerts.

Microsoft Learn: <https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/alerts-manage-alert-rules>

### Action group off

Finding kind `action-group-disabled`.

1. A turned-off action group tells nobody about any alert that uses it.
2. Turn it on: `az monitor action-group update -n <group> -g <rg> --enabled true`.
3. Then select it in Monitor > Alerts > Action groups and use Test to check the message arrives.

Microsoft Learn: <https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/action-groups>

### Action group empty

Finding kind `action-group-empty`.

1. Monitor > Alerts > Action groups, select the group and edit it.
2. Under Notifications, add an email, SMS, app push or voice receiver. Under Actions, add a webhook, Logic App or function if you need one.
3. A new email address must confirm a one-time passcode within 30 minutes of saving.
4. Use Test to check the message arrives.

Microsoft Learn: <https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/action-groups>

### Email unsubscribed

Finding kind `action-group-email-off`.

1. These people unsubscribed from the alert emails, so they no longer get them.
2. Ask whether they still need the alerts. If not, remove them from the group.
3. If they do, turn the receiver back on: `az monitor action-group enable-receiver -n <receiver> --action-group <group> -g <rg>`.
4. A shared mailbox or a Teams channel address is safer than one person's mailbox.
5. Use Test on the action group to check the email arrives.

Microsoft Learn: <https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/action-groups>

### Daily cap reached

Finding kind `workspace-over-quota`.

1. The workspace takes no more billable logs until its daily reset hour, so alerts on those logs see nothing until then.
2. Find what grew: the workspace's Usage and estimated costs page, or a query on the Usage table.
3. If the growth is expected, raise the cap: Usage and estimated costs > Daily cap.
4. Cut noisy data at the source or with a transformation in the data collection rule.
5. Add a log search alert on `_LogOperation | where Category =~ "Ingestion" | where Detail contains "OverQuota"` to hear about it next time.

Microsoft Learn: <https://learn.microsoft.com/en-us/azure/azure-monitor/logs/daily-cap>

### Near daily cap

Finding kind `workspace-near-quota`.

1. Logs stop when the cap is reached, until the workspace's daily reset hour.
2. Check what is growing on the workspace's Usage and estimated costs page.
3. Raise the cap (Usage and estimated costs > Daily cap), or cut noisy data with a transformation in the data collection rule.
4. The cap is a safety net against surprise costs; Microsoft advises not to hit it regularly.

Microsoft Learn: <https://learn.microsoft.com/en-us/azure/azure-monitor/logs/daily-cap>
<!-- fixes:end -->
