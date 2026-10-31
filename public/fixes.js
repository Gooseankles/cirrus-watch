// How to fix a finding: short steps and one Microsoft Learn page per finding kind.
// Shared data: the browser gets the global Fixes (loaded before app.js), Node gets
// module.exports (scripts/gen-docs.mjs writes docs/guides/azure-monitor-fixes.md
// from it, test/fixes.test.js checks it). Text between `backticks` is shown as code.
// Any tool can add its kinds here; a kind without an entry simply shows no "How to fix".
const Fixes = {
  KINDS: {
    // --- Azure Monitor: machines ---
    "monitor-no-agent": {
      steps: [
        "One VM in the portal: Monitor > Data Collection Rules, create a rule (or open one), then Resources > Add resources and pick the VM. This installs the agent and turns on a managed identity.",
        "Or open the VM > Monitoring > Insights > Enable. VM insights installs the agent and a rule too.",
        "Many machines: assign the built-in Azure Policy initiatives that deploy the Azure Monitor Agent and associate it with a data collection rule (one for Windows, one for Linux), with a remediation task for machines that already exist.",
        "CLI: `az vm extension set --name AzureMonitorWindowsAgent --publisher Microsoft.Azure.Monitor --ids <vm-id> --enable-auto-upgrade true` (AzureMonitorLinuxAgent on Linux), then `az monitor data-collection rule association create --name <name> --rule-id <dcr-id> --resource <vm-id>`.",
        "Arc servers take the same rule or policy; on the CLI use `az connectedmachine extension create`.",
        "Before you start: the machine must be running, have a managed identity and reach the Azure Monitor endpoints on port 443.",
      ],
      url: "https://learn.microsoft.com/en-us/azure/azure-monitor/agents/azure-monitor-agent-manage",
    },
    "monitor-legacy-agent": {
      steps: [
        "The legacy Log Analytics agent (MMA/OMS) is retired and can stop sending data at any time.",
        "Install the Azure Monitor Agent and link a data collection rule that collects the same data. The DCR Config Generator can build the rule from the old workspace settings.",
        "Check that the data arrives in the workspace, for example with a Heartbeat query.",
        "Then remove the MicrosoftMonitoringAgent or OmsAgentForLinux extension, so nothing is collected twice.",
      ],
      url: "https://learn.microsoft.com/en-us/azure/azure-monitor/agents/azure-monitor-agent-migration",
    },
    "monitor-agent-failed": {
      steps: [
        "Open the machine > Settings > Extensions + applications and read the error on the Azure Monitor Agent extension.",
        "Check that the machine is running and has a managed identity turned on.",
        "Check that it reaches the Azure Monitor endpoints on port 443 (firewall, proxy, private link).",
        "If it still shows failed after 10 to 15 minutes, uninstall the extension and install it again.",
      ],
      url: "https://learn.microsoft.com/en-us/azure/azure-monitor/agents/azure-monitor-agent-troubleshoot-windows-vm",
    },
    "monitor-no-dcr": {
      steps: [
        "The agent collects nothing until a data collection rule is linked to the machine.",
        "In the portal: Monitor > Data Collection Rules, open or create a rule, then Resources > Add resources and pick the machine.",
        "The rule needs a data source (performance counters, event logs or Syslog) and a Log Analytics destination. Create it in the workspace's region.",
        "CLI: `az monitor data-collection rule association create --name <name> --rule-id <dcr-id> --resource <machine-id>`.",
      ],
      url: "https://learn.microsoft.com/en-us/azure/azure-monitor/vm/data-collection",
    },
    "monitor-no-heartbeat": {
      steps: [
        "Check that the machine is running and its Azure Monitor Agent extension shows Provisioning succeeded.",
        "Check that a linked data collection rule sends to a Log Analytics workspace; the heartbeat goes there.",
        "Check the network: outbound 443 to the Azure Monitor endpoints and no HTTPS inspection. With a private link scope, the rule needs a data collection endpoint in that scope.",
        "In the workspace, `Heartbeat | where Category == \"Azure Monitor Agent\"` shows when the machine last reported.",
      ],
      url: "https://learn.microsoft.com/en-us/azure/azure-monitor/agents/azure-monitor-agent-troubleshoot-windows-vm",
    },
    "monitor-arc-disconnected": {
      steps: [
        "Azure marks an Arc server Disconnected after 15 minutes without a heartbeat: it is off, offline, or its agent stopped.",
        "On the server, `azcmagent show` gives the status and `azcmagent check` tests the Azure Arc endpoints.",
        "Make sure the Azure Hybrid Instance Metadata Service (himds) is running and the proxy or firewall lets the endpoints through.",
        "After 45 to 90 days offline its identity expires: run `azcmagent disconnect`, then `azcmagent connect` again.",
        "A Resource Health alert on Arc servers tells you next time.",
      ],
      url: "https://learn.microsoft.com/en-us/azure/azure-arc/servers/troubleshoot-connectivity",
    },
    // --- Azure Monitor: data collection rules ---
    "dcr-destination-missing": {
      steps: [
        "The rule sends to a Log Analytics workspace that was deleted, so what it collects is dropped.",
        "Open the rule (Monitor > Data Collection Rules) > Data sources, and give each data source a workspace that exists as its destination.",
        "The workspace must be in the rule's region; if it is not, create a new rule in the workspace's region and move the machines to it.",
        "If nothing needs the rule any more, delete it.",
      ],
      url: "https://learn.microsoft.com/en-us/azure/azure-monitor/vm/data-collection",
    },
    "dcr-unused": {
      steps: [
        "The rule has data sources but no machine linked, so it collects nothing.",
        "If machines should use it: open the rule > Resources > Add resources.",
        "If a policy assignment is meant to link machines to it, run a remediation task for that assignment.",
        "If it is left over, delete it so nobody thinks it is in use.",
      ],
      url: "https://learn.microsoft.com/en-us/azure/azure-monitor/vm/data-collection",
    },
    // --- Azure Monitor: alert rules ---
    "alert-disabled": {
      steps: [
        "Monitor > Alerts > Alert rules, select the rule and Enable it if it is still needed.",
        "If it was turned off because it was noisy, fix the condition or delete the rule.",
        "CLI: `az monitor metrics alert update -g <rg> -n <rule> --enabled true` for metric rules, `az monitor scheduled-query update -g <rg> -n <rule> --disabled false` for log search rules.",
      ],
      url: "https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/alerts-manage-alert-rules",
    },
    "alert-no-action": {
      steps: [
        "Monitor > Alerts > Alert rules, select the rule > Edit > Actions.",
        "Pick an action group, or create one with the people or channel who should hear about it.",
        "Save, then Test the action group to check the message arrives.",
      ],
      url: "https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/alerts-manage-alert-rules",
    },
    "alert-action-group-missing": {
      steps: [
        "An action group the rule uses was deleted, so that part of the alert goes nowhere.",
        "Monitor > Alerts > Alert rules, select the rule > Edit > Actions.",
        "Remove the missing group, pick one that exists, and save.",
      ],
      url: "https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/alerts-manage-alert-rules",
    },
    "alert-scope-missing": {
      steps: [
        "The resource the rule watches was deleted, so the rule can never fire.",
        "If the resource was replaced, edit the rule's Scope to the new one. Log search rules cannot change scope: create a new rule.",
        "Otherwise delete the rule. Metric rules on deleted resources are hidden: in the resource group, tick Show hidden types and filter on microsoft.insights/metricalerts.",
      ],
      url: "https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/alerts-manage-alert-rules",
    },
    // --- Azure Monitor: action groups ---
    "action-group-disabled": {
      steps: [
        "A turned-off action group tells nobody about any alert that uses it.",
        "Turn it on: `az monitor action-group update -n <group> -g <rg> --enabled true`.",
        "Then select it in Monitor > Alerts > Action groups and use Test to check the message arrives.",
      ],
      url: "https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/action-groups",
    },
    "action-group-empty": {
      steps: [
        "Monitor > Alerts > Action groups, select the group and edit it.",
        "Under Notifications, add an email, SMS, app push or voice receiver. Under Actions, add a webhook, Logic App or function if you need one.",
        "A new email address must confirm a one-time passcode within 30 minutes of saving.",
        "Use Test to check the message arrives.",
      ],
      url: "https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/action-groups",
    },
    "action-group-email-off": {
      steps: [
        "These people unsubscribed from the alert emails, so they no longer get them.",
        "Ask whether they still need the alerts. If not, remove them from the group.",
        "If they do, turn the receiver back on: `az monitor action-group enable-receiver -n <receiver> --action-group <group> -g <rg>`.",
        "A shared mailbox or a Teams channel address is safer than one person's mailbox.",
        "Use Test on the action group to check the email arrives.",
      ],
      url: "https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/action-groups",
    },
    // --- Azure Monitor: workspaces ---
    "workspace-over-quota": {
      steps: [
        "The workspace takes no more billable logs until its daily reset hour, so alerts on those logs see nothing until then.",
        "Find what grew: the workspace's Usage and estimated costs page, or a query on the Usage table.",
        "If the growth is expected, raise the cap: Usage and estimated costs > Daily cap.",
        "Cut noisy data at the source or with a transformation in the data collection rule.",
        "Add a log search alert on `_LogOperation | where Category =~ \"Ingestion\" | where Detail contains \"OverQuota\"` to hear about it next time.",
      ],
      url: "https://learn.microsoft.com/en-us/azure/azure-monitor/logs/daily-cap",
    },
    "workspace-near-quota": {
      steps: [
        "Logs stop when the cap is reached, until the workspace's daily reset hour.",
        "Check what is growing on the workspace's Usage and estimated costs page.",
        "Raise the cap (Usage and estimated costs > Daily cap), or cut noisy data with a transformation in the data collection rule.",
        "The cap is a safety net against surprise costs; Microsoft advises not to hit it regularly.",
      ],
      url: "https://learn.microsoft.com/en-us/azure/azure-monitor/logs/daily-cap",
    },
  },
  of(kind) {
    return Object.prototype.hasOwnProperty.call(Fixes.KINDS, kind) ? Fixes.KINDS[kind] : null;
  },
};
if (typeof module !== "undefined") module.exports = Fixes;
