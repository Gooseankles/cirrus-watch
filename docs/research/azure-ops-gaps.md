# Azure and Entra ID operations gaps: what admins want, and what this dashboard could add

Research date: 2026-10-20. Scope: what Azure admins, platform/cloud engineers, FinOps people and security/identity
teams say is missing or painful in Azure and Entra ID, which tools they use to fill the gaps, and which of those gaps fit
this dashboard (Node/Express, managed identity, Resource Graph + ARM + Microsoft Graph, ServiceNow webhooks).

## How to read this report

- **Sources actually read.** Every claim links to a source. Sources marked *(full)* in section 6 were opened and read;
  the ones marked *(excerpt)* were read only as search-engine excerpts or summaries of the page. Vendor blogs are labelled
  as vendor material, because most of them sell a fix for the pain they describe.
- **Reddit could not be read.** reddit.com blocks the fetch tool, and searches limited to reddit.com returned no Reddit
  pages. No Reddit thread is quoted here. The practitioner voice comes from Hacker News comments (read through the
  Algolia API), Microsoft Q&A, Microsoft Tech Community, GitHub issues and practitioner blogs instead. Someone with a
  browser should spot-check r/AZURE and r/FinOps before a final decision.
- **"How often / how strongly"** in the summary is my judgment from how many separate sources raised the point and how
  pointed they were. It is not a measured count.
- **Guesses are marked** *(guess)* or *(to verify)*. That applies mostly to exact API table names I could not confirm
  in this session.

---

## 1. Summary: the top 10 pain points

| # | Pain point | How often / how strongly (judgment) |
|---|---|---|
| 1 | **Cloud spend is hard to control.** Spend management is the top cloud challenge, waste is rising again, and pay-as-you-go has no hard spending cap. | Very common, strong. 84% (2025) and 85% (2026) in Flexera's survey; waste up to 29% in 2026; several HN complaints about no spending limit. |
| 2 | **No built-in alert for expiring app secrets and certificates.** People fall back on scripts, Logic Apps or paid tools. | Very common. Many Microsoft Q&A threads 2023-2025 say "no built-in alert"; a whole ecosystem of scripts and modules exists. Entra "recommendations" partly cover it (preview, licensed). |
| 3 | **Who owns this resource / app / group?** The Activity Log keeps 90 days, so creators are lost; apps and groups end up with no owner. | Common, strong for ops teams. Many Q&A threads; Practical365; Microsoft says there is no native enforcement of app owners. |
| 4 | **Tag governance breaks cost allocation.** Policy checks that a tag exists, not that its value is valid. Teams type "TODO" or "PRD". | Common. A December 2025 practitioner blog gives a worked example (USD 12,000 a month unallocated); the FinOps Foundation ranks allocation as the #2 priority. |
| 5 | **Hard to see effective privilege in Entra and Azure RBAC.** No consolidated view of transitive, PIM-activated or app permissions; risky Graph app roles are hard to find. | Common with security and identity teams. Quarkslab (April 2026), Practical365, AzGovViz and Maester all exist partly for this. |
| 6 | **Governance at scale is the next FinOps priority,** and native anomaly detection is subscription-scoped and runs 1-2 days late. | Strong in surveys. State of FinOps 2025: "governance and policy at scale" becomes the #1 future priority. |
| 7 | **Cleaning up waste needs many more resource types** than disks, IPs and NICs: snapshots, empty plans, unused firewall policies, Data Collection Rules, App Insights, alert rules whose target is gone. | Common. A cluster of feature requests on the Azure Orphan Resources workbook (2025); a staple of FinOps vendor content. |
| 8 | **Keeping up with service retirements.** Microsoft's retirement workbook and Resource Graph queries say themselves that they are not complete. | Moderate but recurring (for example, the Basic public IP retirement on 2025-09-30). |
| 9 | **Too many findings, no lifecycle.** Defender "produces recommendations faster than any team can act on them"; tools lack accepted-deviation and suppression-with-expiry. | Moderate, rising. Maester issue #1798 (2026); the RuleBeat author's question (2026); conference talk "Your secure score is lying to you". |
| 10 | **Hygiene limits and coverage gaps nobody watches:** the fixed limit of 4,000 role assignments per subscription, assignments left behind by deleted identities, quota headroom, backup coverage, diagnostic settings (not in Resource Graph). | Moderate. Each has its own Q&A threads, scripts and at least one real outage (ToDesktop hit the 4,000 limit). |

The newer theme that runs through 2026 sources is **AI spend**: 98% of FinOps teams now manage AI spend (State of FinOps
2026, via Finout), and Flexera ties the first rise in wasted spend in five years to AI workloads.

---

## 2. Pain points by area

### 2.1 Cost / FinOps

- **Spend control is the top challenge, and waste went back up.** Flexera 2025 (released 2025-03-19): "84% of
  respondents believe that managing cloud spend is the top cloud challenge"; budgets were exceeded by 17%. Flexera 2026
  (2026-03-18): 85% still name spend management as a top challenge, and wasted spend rose to 29%, "the first increase in
  five years", tied to AI workloads.
  [Flexera 2025](https://www.flexera.com/about-us/press-center/new-flexera-report-finds-84-percent-of-organizations-struggle-to-manage-cloud-spend),
  [Flexera 2026 press release](https://www.globenewswire.com/de/news-release/2026/03/18/3258065/0/en/flexera-finds-cloud-value-is-rising-while-ai-waste-grows.html),
  [vmblog on 2026](https://vmblog.com/news/flexera-finds-cloud-value-is-rising-while-ai-waste-grows/)
- **FinOps priorities move to governance and allocation.** State of FinOps 2025: workload optimization and waste
  reduction is #1 now (50%), then full allocation and forecasting; over the next 12 months "implementing governance and
  policy at scale" becomes #1. 2026: large obvious waste is already gone and what is left is "smaller, harder-to-capture
  savings"; FinOps for AI is the top future priority; "shift left" (cost before deployment) is the most wanted new tool
  capability.
  [State of FinOps 2025](https://data.finops.org/2025-report/), [Finout summary of State of FinOps 2026 (vendor)](https://finout.io/blog/state-of-finops-2026-report-key-trends-insights-and-what-comes-next)
- **No hard spending cap on pay-as-you-go.** Microsoft: "The spending limit isn't available for subscriptions with
  commitment plans or with pay-as-you-go pricing." HN commenters return to this often: "Azure still doesn't allow you to
  set spending limits on Pay-as-you-go subscriptions" (2024-09-22), "if you have a standard account you're not allowed to
  set a spending limit for, uh... reasons" (2024-05-01). A January 2026 Q&A answer says Azure OpenAI also has no hard cap
  outside budgets, which only alert. A community project deletes resources from a budget-alert action group as a "last
  resort".
  [Spending limit doc](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/spending-limit),
  [HN 41616736](https://news.ycombinator.com/item?id=41616736), [HN 40229452](https://news.ycombinator.com/item?id=40229452),
  [HN 42135796](https://news.ycombinator.com/item?id=42135796),
  [Q&A Azure OpenAI cap](https://learn.microsoft.com/en-us/answers/questions/5725505/can-azure-openai-enforce-a-hard-spending-limit-or),
  [flavienbwk/azure-spending-limits](https://github.com/flavienbwk/azure-spending-limits)
- **Native anomaly detection is subscription-scoped and late.** Microsoft: anomaly detection "is available in Cost
  Analysis smart views when you select a subscription scope." Vendor blogs (Turbo360, ZopNight) add that there is no
  management-group-level detection and that detection lags 1-2 days; that part is vendor material.
  [Analyze unexpected charges](https://learn.microsoft.com/azure/cost-management-billing/understand/analyze-unexpected-charges),
  [ZopNight on dev.to (vendor)](https://dev.to/zop_8abedcc7e12/azure-cost-anomalies-hide-above-and-below-the-subscription-line-so-zopnight-now-watches-all-three-2398)
- **Cost data lags and is not final at once.** Exports "can take up to 24 hours"; a Q&A user reports using the export
  from two days ago for yesterday's cost.
  [Export tutorial](https://learn.microsoft.com/azure/cost-management-billing/costs/tutorial-export-acm-data),
  [Q&A 4379202](https://learn.microsoft.com/en-us/answers/questions/4379202/azure-cost-management-export)
- **Commitment tracking.** Reservation low-utilization email alerts exist (since 2023). I found no native alert for a
  reservation or savings plan that is about to *expire*: a CloudHealth KB says there is no savings-plan expiry alerting,
  and Turbo360 sells it.
  [Reservation utilization alerts](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/reservation-utilization-alerts),
  [Broadcom/CloudHealth KB](https://knowledge.broadcom.com/external/article/436049/option-is-not-available-to-create-and-se.html)
- **Azure Hybrid Benefit coverage** is checked by hand or with community workbooks; Liongard defines "Windows VMs with
  null licenseType" as a metric.
  [AHB workbook](https://github.com/rlowellfl/azure_hybrid_benefit_workbook),
  [Liongard metric](https://share.liongard.com/metrics-library/p/azure-windows-servers-missing-hybrid-benefits)
- **Shared and AKS cost allocation.** The most-upvoted open feature requests in the FinOps toolkit are a Terraform module
  (33 reactions) and an "AKS cost breakdown by namespace" (#1441, 15 reactions, 2025-03-26).
  [finops-toolkit #1441](https://github.com/microsoft/finops-toolkit/issues/1441)
- **AI spend attribution.** Azure OpenAI cost is hard to map to teams or deployments. Shared endpoints "obscure
  ownership"; Microsoft points to tag-based allocation (preview for Azure OpenAI) and API Management AI Gateway token
  metrics. These sources are mostly vendors.
  [PointFive (vendor)](https://www.pointfive.co/research/finops-for-ai-managing-llm-costs-in-azure-openai),
  [Finout on Azure OpenAI (vendor)](https://www.finout.io/blog/azure-openai-pricing)
- **Budgets per subscription.** There is no direct way to list subscriptions with no budget. A partner user complained
  that the "no budget" column was removed from a partner portal. Management-group budgets need a single billing
  currency.
  [Q&A budget vs actual](https://learn.microsoft.com/en-us/answers/questions/754722/azure-report-for-budget-vs-actual),
  [Partner forum thread](https://gxcuf89792.i.lithium.com/t5/azure-partners/azure-spending-nce-tab-does-not-show-all-clients-with-azure/m-p/4038829)

### 2.2 Governance, policy and tagging

- **Tag values are not validated.** "Tag exists but value is garbage": "Prod", "PRD", "P" and "PRODUCTION" for one
  environment; a team set `Environment: "TODO"` to pass the check; "$12,000/month unaccounted for in reports"
  (azure-noob, 2025-12-12). A Q&A thread reports that a custom tag policy did not flag tags changed by hand.
  [dev.to azure-noob](https://dev.to/azurenoob/azure-tag-governance-reality-why-247-variations-of-environment-collapse-your-cost-reports-3408),
  [Q&A 1041339](https://learn.microsoft.com/en-gb/answers/questions/1041339/azure-policy-not-enforcing-the-specified-tags)
- **Tag inheritance only applies to cost records,** not to the resources themselves ("Inherited tags are applied to
  child resource usage records and not the resources themselves"), and it is not retroactive.
  [Tag inheritance doc](https://docs.azure.cn/en-us/cost-management-billing/costs/enable-tag-inheritance)
- **Organization-specific checks and findings with a lifecycle.** A Microsoft Certified Trainer built RuleBeat
  (2026-08-30) because no built-in standard covers organization-specific checks, and because findings need owners,
  states (new/active/fixed/reopened) and suppressions with a reason and an expiry. Azure Policy is better for enforcing,
  and Defender for its own scope. Maester users ask for "configurable accepted deviations" (#1798, 2026-05-23).
  [RuleBeat post](https://techcommunity.microsoft.com/discussions/azuregovernance/i-built-an-open-source-tool-for-running-arg-governance-checks-on-a-schedule-and-/4551629),
  [Maester #1798](https://github.com/maester365/maester/issues/1798)
- **Azure Policy itself:** the most-upvoted open issue in Azure/azure-policy is about built-in private DNS policies
  needing an evaluation delay (#1050, 24 reactions); others ask for Key Vault data-plane modes in custom policies and
  for policy rules on management groups.
  [azure-policy #1050](https://github.com/Azure/azure-policy/issues/1050),
  [#1304](https://github.com/Azure/azure-policy/issues/1304), [#1331](https://github.com/Azure/azure-policy/issues/1331)
- **General portal distrust (HN).** "The Azure Portal is not to be trusted, it can just lie to you at times"; "even the
  good ideas are implemented poorly" (about resource groups and governance) (2025-03-01, thread "400 reasons to not use
  Microsoft Azure"). A former Azure Core engineer's essay drew "The stagnation in Azure is apparent everywhere you look"
  (2026-04-03).
  [HN 43215549](https://news.ycombinator.com/item?id=43215549), [HN 43215780](https://news.ycombinator.com/item?id=43215780),
  [HN 47627451](https://news.ycombinator.com/item?id=47627451)

### 2.3 Identity and access, PIM, Entra

- **No consolidated view of effective permissions.** Quarkslab (2026-04-30): "the portal does not show transitive role
  assignments"; PIM-activated roles "are not visible in the portal at all"; for app roles and delegated grants "there is
  no built-in consolidated view in the portal"; service principal credentials can be added only through Graph and "can
  go unnoticed"; federated identity credentials are "not included in the returned JSON object"; escalation chains
  (owner -> group -> app -> role) are not traced.
  [Quarkslab QAZPT](https://blog.quarkslab.com/auditing-application-permissions-in-microsoft-entra-id-hidden-risks-pitfalls-and-quarkslabs-qazpt-tool.html)
- **Risky app permissions.** The Entra admin center has no filter for applications with dangerous permissions; people
  compare app roles against their own list (Practical365, from a search excerpt). Sentinel rules flag grants of
  `Application.ReadWrite.All`, `RoleManagement.ReadWrite.Directory` and `AppRoleAssignment.ReadWrite.All`.
  [Practical365 (excerpt)](https://practical365.com/identifying-privileged-applications-and-their-secret-passwords/),
  [LeastPrivilegedMSGraph session](https://sessionize.com/s/morten-mynster/your-graph-apps-are-over-privileged-lets-fix-that-/170418)
- **Secret and certificate expiry has no built-in alert.** Accepted Q&A answer, 2024-04-03: "there isn't a direct way
  within the Portal to set up notifications or alerts for expiring secrets within an App Registration"; a 2025-04-15
  answer still proposes an Automation runbook. Other threads: "no default alert being sent, only a message displayed in
  the UI" (2023); "a common ask" (2024-2025). Workarounds include the EntraCredentialExpiry module, Coreview, Logic
  Apps / Power Automate, and a Docker project. Entra now has the recommendations "Renew expiring application credentials",
  "Remove unused credentials" and "Remove unused applications" (preview; Microsoft's docs tie them to Workload ID
  Premium, while a third-party table says P2, so the licence is unclear).
  [Q&A 1642018](https://learn.microsoft.com/en-us/answers/questions/1642018/is-there-a-way-to-enable-alerts-on-client-secret-k),
  [Q&A 1342766](https://learn.microsoft.com/en-gb/answers/questions/1342766/alerts-for-app-registration-client-secret),
  [Q&A 2141367](https://learn.microsoft.com/en-us/answers/questions/2141367/how-to-create-email-notifications-for-client-secre),
  [Entra recommendation doc](https://learn.microsoft.com/hr-hr/entra/identity/monitoring-health/recommendation-renew-expiring-application-credential),
  [Petri on app health recommendations](https://petri.com/microsoft-entra-workload-app-health-recommendations/),
  [EntraCredentialExpiry](https://www.powershellgallery.com/packages/EntraCredentialExpiry)
- **Ownerless apps and groups.** Assigned owners leave and the app "eventually becomes ownerless"; Microsoft recommends
  at least two owners; a Q&A answer says there is "no native enforcement at the moment" that blocks creating an app
  without an owner. Admin centers cannot list all ownerless security groups.
  [Practical365 ownerless apps](https://practical365.com/ownerless-apps/),
  [Q&A 5509511](https://learn.microsoft.com/en-us/answers/questions/5509511/enforce-the-creation-of-app-registrations-and-ente)
- **Stale role assignments and the 4,000 limit.** The limit is 4,000 role assignments per subscription, fixed, and
  "cannot be increased" (eligible PIM assignments do not count). Assignments to deleted identities linger ("Identity not
  found"); Resource Graph does not update the principal type when a principal is deleted, so finding them needs a
  directory lookup. ToDesktop's builds failed when a subscription hit the limit because its cleanup job was stuck in
  dry-run mode.
  [RBAC limits doc](https://learn.microsoft.com/en-my/azure/role-based-access-control/troubleshoot-limits),
  [Q&A 1347918](https://learn.microsoft.com/en-us/answers/questions/1347918/removing-iam-assignments-unable-to-find-identity),
  [ToDesktop incident](https://status.todesktop.com//incidents/01KBKV2SYPHY1CVB45VJRF6Y0X)
- **PIM coverage across many subscriptions.** I found no portal report of standing versus eligible privileged
  assignments across subscriptions; people loop `Get-AzRoleEligibilitySchedule` or use AzurePIMStuff or AzGovViz.
  `az` CLI PIM support was a long-standing request (#13064, 74 reactions).
  [PIM integration doc](https://learn.microsoft.com/en-my/azure/role-based-access-control/pim-integration),
  [AzurePIMStuff](https://www.powershellgallery.com/packages/AzurePIMStuff/),
  [azure-cli #13064](https://github.com/Azure/azure-cli/issues/13064)
- **Inactive users and guests.** Reading `signInActivity` needs Entra ID P1/P2; without it every user looks "never
  signed in". `lastSuccessfulSignInDateTime` exists only from 2023-12-01 and was not backfilled.
  [Inactive users doc](https://learn.microsoft.com/en-us/entra/identity/monitoring-health/howto-manage-inactive-user-accounts),
  [signInActivity](https://learn.microsoft.com/en-us/graph/api/resources/signInActivity)
- **The ID Governance licence is a barrier.** CIAOPS (2025-09-27): P2 access reviews cost an extra AU$13.50 per user
  per month for SMBs, and reviewers need P2 too; Gartner Peer Insights reviewers cite licence cost.
  [CIAOPS](https://blog.ciaops.com/2025/09/27/microsoft-entra-id-p2-access-reviews-a-critical-evaluation-for-smb-customers-in-australia/),
  [Gartner Peer Insights](https://www.gartner.com/reviews/product/microsoft-entra-id-governance)
- **Group sprawl.** "So you have all those Entra groups and you need IT Operations to maintain them" (HN, 2026-09-01).
  [HN 49519776](https://news.ycombinator.com/item?id=49519776)
- **Break-glass drift.** "A single policy update could inadvertently subject a break glass account to MFA requirements,
  IP restrictions, or other controls" (Substack, from a search excerpt).
  [Monitor your break glass account](https://thetolkienblackguy.substack.com/p/monitor-your-break-glass-account)

### 2.4 Security posture

- **Defender for Cloud: noise, cost, score lag.** A conference abstract says Defender "produces recommendations faster
  than any team can act on them" and charges per plan and per resource type. The G2 summary says it "can be expensive for
  small to medium businesses". A forum thread describes the secure score swinging from 72% to 50% (anecdotal).
  [Sessionize "Your secure score is lying to you"](https://sessionize.com/s/barbara-forbes/your-secure-score-is-lying-to-you/188284),
  [G2 Defender for Cloud](https://www.g2.com/products/microsoft-defender-for-cloud),
  [yomotherboard thread](https://yomotherboard.com/question/does-anyone-else-experience-fluctuations-in-defender-for-cloud-scores/)
- **Exposed management ports.** Simple Resource Graph samples only match source `*`; CIS-style checks also need
  `Internet`, `0.0.0.0/0`, port ranges and rule priority. InSpec warns that its checks "do not take the priorities of
  security rules into account".
  [Powerpipe CIS 7.1](https://hub.powerpipe.io/mods/turbot/steampipe-mod-azure-compliance/controls/control.cis_v500_7_1),
  [InSpec azure_network_security_group](https://docs.chef.io/inspec/resource_packs/azure/azure_network_security_group/)
- **Entra tenant-level design risk** comes up on HN ("Entra ID is full of design-level bugs that allow full tenant
  takeover", 2026-09-18); this is sentiment, not a tool need.
  [HN 49760060](https://news.ycombinator.com/item?id=49760060)

### 2.5 Inventory and hygiene

- **Orphan detection needs more types and scope exclusions.** Feature requests on the Azure Orphan Resources workbook
  (2025): old disk snapshots (#74), unused firewall policies (#73), unused Data Collection Rules (#75), alert rules whose
  target is gone (#76), unused Application Insights (#77), unused SQL DBs and VMs (#78), unused vWAN circuits (#80),
  "ability to exclude various scopes" (#84), and a false-positive bug where subnets ignore VM scale sets (#83).
  [Orphan workbook issues](https://github.com/dolevshor/azure-orphan-resources/issues)
- **"Who created this?"** The Activity Log keeps 90 days; "if the VM is created before the last 90 days there is no
  chance to get the detail of the creator". Auto-tagging at creation is the usual workaround. Resource Graph's
  `resourcechanges` table now records `changedBy`, `clientType` and `operation`, and change records "should be available
  in less than five minutes"; its retention is short (about 14 days *(to verify; the page I read does not state it)*).
  [Q&A 1341059](https://learn.microsoft.com/en-us/answers/questions/1341059/how-to-find-creator-of-virtual-machine),
  [Get resource changes](https://learn.microsoft.com/en-us/azure/governance/resource-graph/how-to/get-resource-changes)
- **Stopped is not deallocated.** "Stopped (allocated)" VMs still pay for cores, and deallocated VMs still pay for disks.
  [Q&A 1366432](https://learn.microsoft.com/en-us/answers/questions/1366432/how-to-get-the-stopped-virtual-machines-pricing-fo)
- **Service retirements.** The Advisor Service Retirement workbook "contains information about a subset of services";
  the Resource Graph retirement queries say impacted-resource data "isn't comprehensive". The Basic public IP SKU was
  retired on 2025-09-30.
  [Retirement workbook](https://learn.microsoft.com/en-us/azure/advisor/advisor-how-to-plan-migration-workloads-service-retirement),
  [Resource Graph retirement queries](https://docs.azure.cn/en-us/service-health/service-retirement-unified-impact-queries),
  [Basic public IP retirement](https://azure.microsoft.com/updates/upgrade-to-standard-sku-public-ip-addresses-in-azure-by-30-september-2025-basic-sku-will-be-retired)

### 2.6 Networking

- **IP address management.** Virtual Network Manager IPAM pools plus Policy can stop overlapping address spaces, but
  Virtual Network Manager "doesn't automatically prevent overlapping address spaces" on its own, and removing
  IPAM-managed space is not supported. The open-source Azure/ipam tool (still updated in October 2026) gives discovery
  and utilization. `SubnetIsFull` errors usually mean disrupting workloads to fix.
  [Virtual Network Manager IPAM doc](https://learn.microsoft.com/en-us/azure/virtual-network-manager/Prevent-overlapping-ip-address-space-policy-ipam),
  [Q&A 1465965](https://learn.microsoft.com/en-us/answers/questions/1465965/ipam-solution-for-azure-tenant-to-monitor-and-prev),
  [Azure/ipam](https://github.com/Azure/ipam)
- **Resource maps across resource groups.** In a January 2024 r/AZURE thread (seen only as a search excerpt from a
  mirror; the page itself 404'd), people wanted a visual map of how resources connect, because Resource Visualizer works
  only within one resource group.
- **Private DNS zone policies** are the top Azure Policy issue (see 2.2).

### 2.7 Operations and monitoring

- **Diagnostic settings are not in Resource Graph.** Tech Community users asked when they would be; audits loop
  `Get-AzDiagnosticSetting` per resource (Charbel Nemnom's script). AzGovViz reports diagnostic settings only at
  management-group and subscription level, and has an open false-positive issue there (#290).
  [Charbel Nemnom](https://charbelnemnom.com/finding-azure-resources-with-diagnostic-settings-enabled-with-powershell/),
  [Tech Community tag](https://techcommunity.microsoft.com/tag/azure%20diagnostics),
  [AzGovViz #290](https://github.com/JulianHayward/Azure-MG-Sub-Governance-Reporting/issues/290)
- **Alert coverage.** Azure Monitor Baseline Alerts (AMBA) deploys alert rules by policy (DeployIfNotExists); for gaps
  "the solution provides a framework for you to develop your own policies".
  [AMBA](https://azure.github.io/azure-monitor-baseline-alerts/welcome/index.html)
- **Quotas.** Quota alerts exist per subscription; I found nothing that rolls them up across subscriptions, and quotas
  are per region and per VM family.
  [Quota monitoring and alerting](https://learn.microsoft.com/uk-ua/azure/quotas/monitoring-alerting)
- **Backup coverage.** Resiliency "protectable resources" and Resource Graph `RecoveryServicesResources` can show
  unprotected resources; backup jobs older than 14 days are not in Resource Graph.
  [Query backups with Resource Graph](https://learn.microsoft.com/en-my/azure/backup/query-backups-using-azure-resource-graph),
  [Protectable resources](https://learn.microsoft.com/en-ca/Azure/resiliency/tutorial-view-protectable-resources)
- **Portal quality.** "horrible ux, really convoluted" (HN 2025-03-01); "Azure portal is notorious for leaking memory"
  (HN 2026-03-03).
  [HN 43219847](https://news.ycombinator.com/item?id=43219847), [HN 47240223](https://news.ycombinator.com/item?id=47240223)

### 2.8 Subscriptions and landing zones

- **Subscription vending** must collect request data, start automation after approval, create the subscription with
  infrastructure-as-code, handle quotas ("easier if you automate this process by using the available APIs") and place
  the subscription in the right management group with budgets and baseline policy. Ownership after the requester leaves
  and offboarding are poorly covered ("Ownership Unclear once the original requester leaves the project"; a
  "Decommissioned" management group for retiring subscriptions).
  [CAF subscription vending](https://learn.microsoft.com/en-ie/azure/cloud-adoption-framework/ready/landing-zone/design-area/subscription-vending),
  [Insight APAC subscription vending](https://blog.insight-services-apac.dev/2024/12/12/pe-subvending-part1)
- **AzGovViz in large tenants:** "Memory usage is too high for large tenant" (#292, 2026-01); it broke when classic
  administrators were retired in May 2026 (#294) and needed changes for the retirement of the PIM iteration 2 API (#291).
  This shows the upkeep cost of scraping governance data.
  [AzGovViz #292](https://github.com/JulianHayward/Azure-MG-Sub-Governance-Reporting/issues/292),
  [#294](https://github.com/JulianHayward/Azure-MG-Sub-Governance-Reporting/issues/294),
  [#291](https://github.com/JulianHayward/Azure-MG-Sub-Governance-Reporting/issues/291)

### 2.9 Automation and ITSM

- **ServiceNow CMDB sync.** Service Graph Connector users struggle to exclude subscriptions (a deny rule on the Azure
  side was "not viable" for one user; identification rules are the fallback). CIs not found in the last run are marked
  non-operational.
  [ServiceNow community thread](https://www.servicenow.com/community/service-graph-connectors-forum/exclude-a-subscriptions-from-service-graph-azure-in-servicenow/m-p/3363365)
- **Findings need a workflow:** an owner, a ticket, a suppression with a reason and an expiry (RuleBeat author; Maester
  #1798; the Defender talk). This dashboard already writes ServiceNow work notes, so it is well placed here.

---

## 3. Existing tools: what they do well and what they miss

| Tool | Kind | Does well | Misses / complaints (sourced) |
|---|---|---|---|
| **Azure Advisor** | Built-in | Free cost, reliability and security recommendations; the retirement workbook | Quality "inconsistent across services"; hard to interpret what to do (G2); limited visibility into idle resources across subscriptions (G2 summary). [G2](https://g2.com/products/azure-advisor/reviews?page=2) |
| **Microsoft Cost Management** | Built-in | Cost analysis, budgets, exports (FOCUS), allocation rules, reservation utilization alerts | Anomaly detection subscription-scope only; export latency up to 24 h; budgets only alert; no hard cap on pay-as-you-go; tag inheritance only on usage records. |
| **Azure Policy** | Built-in | Enforcement (deny/modify/deployIfNotExists), compliance | Checks tag presence, not value quality; built-in DNS policy timing (#1050); no workflow for findings. |
| **Defender for Cloud** | Built-in, paid plans | Secure score, CSPM, workload protection | Noise, per-plan cost, score lag (sources in 2.4). |
| **Entra ID Governance / PIM / access reviews** | Built-in, P2 / ID Governance licence | Just-in-time roles, access reviews, entitlement management | Licence cost (CIAOPS, Gartner); no cross-subscription standing-access report; Entra app recommendations are preview and licensed. |
| **AzGovViz** | Open source (PowerShell) | Very broad: management-group hierarchy, policy, RBAC including orphaned assignments and PIM eligibility, quotas and limits, diagnostic settings, orphaned resources, service principal secret expiry | Static HTML snapshot; very large output and high memory in large tenants (#292); breaks on API retirements (#291, #294); limits are hardcoded; no findings workflow. [Repo](https://github.com/JulianHayward/Azure-MG-Sub-Governance-Reporting) |
| **azqr (Azure Quick Review)** | Open source (Go), Microsoft | 70+ resource types, APRL and orphan rules, Advisor, Defender, policy, cost, plugins (retirement / EOL, AI throttling, carbon), SARIF / Excel / MCP server | Point-in-time report (Excel); no identity coverage; requests for scan exclusions (#238). [Repo](https://github.com/Azure/azqr) |
| **Azure Orphan Resources workbook** | Open source (Resource Graph workbook) | Free, in-portal, many orphan types | Missing types and no scope exclusions (issues #73-#84); false positives (#82, #83, #87). |
| **PSRule for Azure** | Open source | Checks infrastructure-as-code against the Well-Architected Framework before deployment | Pre-deployment only; AzGovViz's integration with it is paused. |
| **Maester** | Open source (Pester + Graph) | Entra / M365 tests: CISA SCuBA, CIS, EIDSCA, 170+ community tests; email alerts; Conditional Access what-if | Tenant config only (not Azure resources); asks for accepted deviations (#1798). [maester.dev](https://maester.dev/) |
| **Prowler** | Open source + SaaS | 160+ Azure checks including Entra; multi-cloud | Some checks need a custom role beyond Reader. [Prowler auth doc](https://docs.prowler.com/user-guide/providers/azure/authentication) |
| **ScoutSuite** | Open source | Multi-cloud posture snapshot | Last release 5.14.0 on 2024-05-10; last push 2025-09 (checked with GitHub API): slowing. |
| **Steampipe / Powerpipe** | Open source | SQL over Azure; azure_tags, azure_compliance (CIS/NIST) and azure_insights mods | Needs its own runtime and plugin; no ticket workflow. [azure_tags](https://hub.powerpipe.io/mods/turbot/azure_tags) |
| **Azure IPAM** | Open source, Microsoft | IP discovery and utilization UI/API | Separate app to run. |
| **FinOps toolkit / FinOps hubs** | Open source, Microsoft | FOCUS exports, Power BI rate-optimization reports | Heavy (Data Explorer / Fabric); open asks: Terraform, AKS namespace cost. |
| **CloudHealth (Broadcom)** | Commercial | Multi-cloud FinOps | Ownership change to Broadcom; competitors say renewal quotes rose (vendor claims, unverified). [Amnic (vendor)](https://amnic.com/blogs/cloudhealth-alternatives) |
| **Flexera One + Spot** | Commercial | Flexera bought NetApp's Spot FinOps business (announced 2025-01-15, closed March 2025): Kubernetes and commitment management | Enterprise price. [Flexera press release](https://flexera.com/about-us/press-center/flexera-to-acquire-finops-business-from-netapp-to-strengthen-portfolio) |
| **Vantage** | Commercial | Multi-cloud cost reports, anomaly alerts to Slack and Teams | Its Azure FAQ says there is no "Active Resource" support for Azure (undated page). [Vantage Azure](https://www.vantage.sh/blog/azure-cost-management-launched-vantage) |
| **Coreview, Turbo360, Liongard and others** | Commercial | Packaged checks: secret expiry, AHB coverage, savings-plan expiry | Price; each covers a slice. |

**Takeaway:** the open-source tools are good at *snapshots* (HTML or Excel). The gap that keeps coming up is a
*continuously running, multi-subscription service with history, owners, suppressions and tickets*. This dashboard
already has that shape: a managed identity, a scheduler, ServiceNow and SSO roles.

---

## 4. Ranked tool ideas for this dashboard

Ranking weighs: how often the need comes up (section 2), how well built-in Azure covers it (worse coverage ranks
higher), how well it fits the data sources the dashboard already uses (Resource Graph, ARM, Graph), and effort.
Effort: S = up to about 2 days, M = about 1 week, L = more. Permissions assume the scan identity already has Reader on
the root management group and the Graph permissions the current tools use. Table and API names marked *(to verify)*
need a check against current docs.

| Rank | Tool | What it shows | Who wants it | Data source / API | Permissions | Effort | Built-in covers it? |
|---|---|---|---|---|---|---|---|
| 1 | **Orphaned and excess role assignments** (extends Access review) | Role assignments whose principal no longer exists; count per subscription against the fixed 4,000 limit; direct-user assignments that could be group-based | Ops and security; 2.3 (RBAC limits doc, Q&A 1347918, ToDesktop) | Resource Graph `authorizationresources` (roleassignments) + Graph `directoryObjects/getByIds` to resolve principals | Reader + Graph `Directory.Read.All` (or User/Group/Application.Read.All) | S | Poorly: the portal shows "Identity not found" per scope only; AzGovViz in a snapshot |
| 2 | **App and identity hygiene** (extends Expiring secrets) | Apps and service principals with no owner or only disabled owners; service principal credentials (not only app credentials); federated credentials; apps with expired-only credentials; unused apps if sign-in data is available | Identity teams; 2.3 (Quarkslab, Practical365, Q&A) | Graph `/applications?$expand=owners`, `/servicePrincipals` (passwordCredentials, keyCredentials), `/applications/{id}/federatedIdentityCredentials`; optional beta `reports/servicePrincipalSignInActivities` *(to verify)* | `Application.Read.All`, `Directory.Read.All`; `AuditLog.Read.All` for sign-in activity | S-M | Partly: Entra recommendations (preview, licensed); no owner-based view |
| 3 | **High-privilege app permissions** | Service principals holding risky Graph app roles (RoleManagement.ReadWrite.Directory, AppRoleAssignment.ReadWrite.All, Application.ReadWrite.All, Directory.ReadWrite.All, Mail.*, Sites.FullControl.All...), tenant-wide delegated consents, and multi-tenant apps from outside | Security; 2.3 (Quarkslab, Practical365, Sentinel rule) | Graph `/servicePrincipals/{id}/appRoleAssignments`, `/oauth2PermissionGrants`; map app-role GUIDs from the Microsoft Graph service principal | `Application.Read.All`, `Directory.Read.All` | M | No: no admin-center filter (Practical365); Defender for Cloud Apps app governance is a paid add-on |
| 4 | **Standing privileged access (PIM coverage)** (extends Access review) | Per subscription and management group: permanent active Owner, UAA and Contributor versus PIM-eligible; eligibilities that are never activated | Security, auditors; 2.3 (PIM integration doc, azure-cli #13064, AzGovViz offers it) | ARM `Microsoft.Authorization/roleEligibilitySchedules` and `roleAssignmentSchedules` per scope; Resource Graph `authorizationresources` may carry eligibility *(to verify)* | Reader (includes `roleEligibilitySchedules/read` per AzGovViz); P2 tenant for PIM data | M | No cross-subscription report |
| 5 | **Retirement impact** | Each upcoming Azure retirement with the impacted resources, date and subscription owner; can open a ServiceNow task per owner | Platform teams; 2.5 (retirement workbook, Basic IP) | Resource Graph `advisorresources` (retirement recommendations) and `servicehealthresources` per Microsoft's retirement-query doc *(exact filters to verify)* | Reader | S | Partly: Advisor workbook (a subset, by its own words); no per-owner routing |
| 6 | **Budget coverage and burn** | Subscriptions with no budget; budgets past their forecast; spend against budget across all subscriptions | FinOps; 2.1 (Q&A 754722, partner thread, State of FinOps "governance at scale") | ARM `Microsoft.Consumption/budgets` per subscription; Cost Management `query` / `forecast` | Reader / Cost Management Reader | S | No list of "subscriptions without a budget" |
| 7 | **Commitments tracker** | Reservations and savings plans: utilization, expiry in 30/60/90 days, auto-renew off | FinOps; 2.1 (no expiry alert found; Turbo360 and CloudHealth KB) | ARM `Microsoft.Capacity/reservationOrders`, `Microsoft.BillingBenefits/savingsPlanOrders`, utilization summaries *(to verify)* | Reservations Reader / Savings plan reader at tenant or billing scope (extra grant) | M | Partly: utilization email alerts; expiry not found |
| 8 | **Tag value quality and owner suggestion** (extends Tag compliance) | Non-standard values (case and spelling variants mapped to allowed values); placeholder values ("TODO", "n/a"); for untagged resources, the creator from `resourcechanges.changedBy` or `systemData.createdBy` as a suggested Owner | FinOps, platform; 2.2 (azure-noob, Q&A) and 2.5 ("who created") | Resource Graph `resources` (tags) + `resourcechanges`; ARM `$expand=createdTime` / `systemData` *(to verify per type)* | Reader | S | No: Policy checks presence only |
| 9 | **Extended waste finder** (extends Orphaned resources) | Old snapshots, stopped-but-allocated VMs, App Service plans with no apps, load balancers and app gateways with empty backends, unused NSGs and route tables, disconnected private endpoints, unused DCRs, alert rules with missing targets, idle App Insights; with estimated monthly cost | FinOps; 2.5 (orphan workbook issues #73-#78) | Resource Graph (the workbook's queries can be reused; check its licence); cost from the Cost Management query by ResourceId | Reader, Cost Management Reader | S per type | Partly: the workbook and azqr, as a snapshot |
| 10 | **Findings lifecycle and ticketing** (platform feature for all tools) | Per finding: new/active/fixed/reopened, owner, suppression with reason and expiry, "create ServiceNow incident/task" button, weekly digest per owner | Everyone; 2.2 and 2.9 (RuleBeat, Maester #1798, Defender talk) | Dashboard's own store + ServiceNow Table API | Existing ServiceNow user | M | No |
| 11 | **Azure Hybrid Benefit coverage** | Windows and SQL VMs without AHB; VMs under 8 vCPUs that still use 8 core licences | FinOps / licensing; 2.1 | Resource Graph `resources` (`properties.licenseType`, OS type, vCPU via SKU) | Reader | S | Partly: Cost Management Power BI app page |
| 12 | **Public exposure** | NSG rules allowing 22/3389/any from Internet/`*`/`0.0.0.0/0` (with priorities); storage accounts with public network or blob access; PaaS with `publicNetworkAccess=Enabled`; public IPs and what they attach to | Security; 2.4 (Powerpipe CIS, InSpec) | Resource Graph `resources` (NSG securityRules, storage properties) | Reader | M | Partly: Defender for Cloud (paid plans for some), Policy |
| 13 | **Defender / policy posture roll-up** | Secure score and Defender plan per subscription; policy non-compliance per subscription; policy exemptions expiring soon or with no expiry | Security, governance; 2.4 and 2.2 | Resource Graph `securityresources` (secureScores, pricings) and `policyresources` (policy states, exemptions) *(to verify table contents)* | Reader | S | Partly: each in its own blade; no exemption-expiry view |
| 14 | **Backup coverage** | VMs, SQL VMs and file shares not protected; backups whose last job failed | Ops; 2.7 | Resource Graph `resources` left-anti-join `recoveryservicesresources` (protected items) | Reader | S-M | Partly: Resiliency "protectable resources" view |
| 15 | **Change watch (who changed what)** | Last 24 h / 7 d: deletes, NSG and firewall changes, role assignment changes, Key Vault access changes, by actor and client; per-subscription change volume | Ops, security; 2.5 (`resourcechanges` with changedBy) | Resource Graph `resourcechanges`, `resourcecontainerchanges`; Activity Log for role assignments | Reader | M | Partly: Change Analysis per resource |
| 16 | **Quota headroom** | Regions and VM families above 80% of quota, per subscription | Platform; 2.7, 2.8 | ARM `Microsoft.Compute/locations/{loc}/usages` or `Microsoft.Quota/usages` per subscription and region (many calls; cache) | Reader | M | Per subscription only |
| 17 | **Subnet capacity and address overlap** | Subnets above N% used; overlapping VNet address spaces across subscriptions; peerings disconnected | Network; 2.6 | Resource Graph `resources` (virtualNetworks: addressSpace, subnets, ipConfigurations count) | Reader | M | Partly: Virtual Network Manager IPAM (with setup), Azure/ipam (separate app) |
| 18 | **Subscription lifecycle hygiene** (extends the ServiceNow tools) | Subscriptions with no owner tag or owner left the company; in the wrong management group; no budget; disabled and waiting for deletion; created outside the ServiceNow flow (no ticket link) | Platform; 2.8 (CAF vending, ownership after requester leaves) | Resource Graph `resourcecontainers`, management groups API, Graph user lookup, the dashboard's own run logs | Reader, `User.Read.All` | S | No |
| 19 | **Stale users and guests with Azure access** | Guests and members with no sign-in in N days who still hold Azure RBAC or access packages; disabled users still assigned | Identity; 2.3 (inactive users doc) | Graph `users?$select=signInActivity` + existing role data | `User.Read.All`, `AuditLog.Read.All`; Entra P1/P2 | S-M | Partly: access reviews (P2 / ID Governance licence) |
| 20 | **Diagnostic settings coverage** | Key resource types (Key Vault, SQL, storage, firewall, App Gateway) with no diagnostic setting; subscriptions without Activity Log export | Ops, security; 2.7 | ARM `{resourceId}/providers/Microsoft.Insights/diagnosticSettings` per resource (not in Resource Graph); throttle and cache | Reader (Monitoring Reader) | M-L | Partly: Monitor blade per filter; Policy deployIfNotExists |
| 21 | **AI resources and spend** | Azure OpenAI / AI Services accounts and deployments, models near retirement, provisioned (PTU) versus standard, cost per deployment or tag | FinOps (State of FinOps 2026, Flexera 2026), platform | Resource Graph (`microsoft.cognitiveservices/accounts`), ARM deployments list per account, Cost Management query | Reader, Cost Management Reader | M | Partly; attribution is weak (PointFive, Finout; vendor sources) |
| 22 | **Cost anomaly roll-up beyond resource groups** (extends Cost anomalies) | Anomalies by service and meter and by management group; new resource types or meters appearing; week-over-week trend | FinOps; 2.1 (native is subscription-scoped) | Cost Management `query` (grouping by ServiceName, MeterCategory) at subscription or management-group scope | Cost Management Reader | S-M | Partly: subscription-scope smart views and alerts |
| 23 | **Break-glass and Conditional Access exclusions check** | Break-glass accounts still excluded from every CA policy; sign-in alert present | Identity; 2.3 | Graph `identity/conditionalAccess/policies` | `Policy.Read.All` | S | Covered by Maester / EIDSCA: low priority, link out instead |

Not recommended: **AKS cost by namespace** (L effort; Kubecost and the AKS cost analysis add-on exist) and a **hard
spending cap** (cannot be done safely from outside; at most a "budget breached -> ServiceNow ticket" hook, folded into
idea 6).

---

## 5. Quick wins: the top 5 to build next

1. **Orphaned role assignments and the 4,000 limit (idea 1).** It reuses the Access review queries and Graph client
   already in the repo; the 4,000 limit is fixed by Microsoft and has caused real outages; nothing built-in lists it
   across subscriptions.
2. **App and identity hygiene plus high-privilege app permissions (ideas 2 and 3).** These extend the Expiring secrets
   tool with the same Graph permissions (plus Directory.Read.All). They close the most-cited Entra gaps (ownerless apps,
   service principal credentials, risky Graph roles), which have no native report and whose native recommendations are
   preview and licensed.
3. **Retirement impact (idea 5).** One or two Resource Graph queries and a per-owner ServiceNow task. Retirements hit
   every tenant, and Microsoft's own workbook says it covers only a subset.
4. **Budget coverage and commitments (ideas 6 and 7; start with 6).** "Subscriptions without a budget" is a few ARM calls
   per subscription and serves the #1 future FinOps priority (governance at scale); the reservation and savings-plan
   expiry part follows once a billing-scope reader role is granted.
5. **Tag value quality with owner suggestion (idea 8).** It extends Tag compliance with value rules and `resourcechanges`
   creator lookup. It answers the "who owns this?" pain while change data still exists (short retention), and it fixes
   cost allocation, the #2 FinOps priority.

A platform item to do alongside them: **findings lifecycle and ticketing (idea 10).** Every new tool adds findings, and
the sources say the lack of owners, suppressions and expiry is what makes tools like Defender feel noisy.

---

## 6. Sources

*(full)* = page opened and read in this session; *(excerpt)* = read only as a search-engine summary or excerpt;
*(API)* = read through the GitHub or HN Algolia API. Dates are publication or post dates where known.

### Surveys and analyst pieces
- Flexera, "New Flexera Report Finds that 84% of Organizations Struggle to Manage Cloud Spend", 2025-03-19, https://www.flexera.com/about-us/press-center/new-flexera-report-finds-84-percent-of-organizations-struggle-to-manage-cloud-spend *(excerpt)*
- GlobeNewswire / Flexera, "Flexera Finds Cloud Value is Rising While AI Waste Grows", 2026-03-18, https://www.globenewswire.com/de/news-release/2026/03/18/3258065/0/en/flexera-finds-cloud-value-is-rising-while-ai-waste-grows.html *(excerpt)*
- vmblog, "Flexera finds cloud value is rising while AI waste grows", 2026-03, https://vmblog.com/news/flexera-finds-cloud-value-is-rising-while-ai-waste-grows/ *(excerpt)*
- FinOps Foundation, "State of FinOps 2025", 2025, https://data.finops.org/2025-report/ *(full)*
- Finout (vendor), "State of FinOps 2026 Report: Key Trends, Insights, and What Comes Next", page dated 2026-08-02, https://finout.io/blog/state-of-finops-2026-report-key-trends-insights-and-what-comes-next *(full)*

### Practitioner discussion (Hacker News, via the Algolia API)
- HN comment 43215549, "400 reasons to not use Microsoft Azure", 2025-03-01, https://news.ycombinator.com/item?id=43215549 *(API)*
- HN comment 43215780, same thread, 2025-03-01, https://news.ycombinator.com/item?id=43215780 *(API)*
- HN comment 43219847, same thread, 2025-03-01, https://news.ycombinator.com/item?id=43219847 *(API)*
- HN comment 47627451, "Decisions that eroded trust in Azure – by a former Azure Core engineer", 2026-04-03, https://news.ycombinator.com/item?id=47627451 *(API)*
- HN comment 47622096, same thread, 2026-04-03, https://news.ycombinator.com/item?id=47622096 *(API)*
- HN comment 41616736, "It is hard to recommend Google Cloud", 2024-09-22, https://news.ycombinator.com/item?id=41616736 *(API)*
- HN comment 40229452, "The AWS S3 Denial of Wallet Amplification Attack", 2024-05-01, https://news.ycombinator.com/item?id=40229452 *(API)*
- HN comment 42135796, "I Followed the Official AWS Amplify Guide and Was Charged $1,100", 2024-11-14, https://news.ycombinator.com/item?id=42135796 *(API)*
- HN comment 49519776, "AI Can Make You Suck Faster Too", 2026-09-01, https://news.ycombinator.com/item?id=49519776 *(API)*
- HN comment 49760060, 2026-09-18, https://news.ycombinator.com/item?id=49760060 *(API)*
- HN comment 47240223, 2026-03-03, https://news.ycombinator.com/item?id=47240223 *(API)*

### Microsoft Q&A, Tech Community, forums
- Q&A 1642018, "Is there a way to enable alerts on client secret key expiry...", 2024-04-03 (answers to 2025-04-15), https://learn.microsoft.com/en-us/answers/questions/1642018/is-there-a-way-to-enable-alerts-on-client-secret-k *(full)*
- Q&A 1342766, "Alerts for app registration client secret", 2023, https://learn.microsoft.com/en-gb/answers/questions/1342766/alerts-for-app-registration-client-secret *(excerpt)*
- Q&A 2141367, "How to Create Email Notifications for Client Secret Expiry...", 2025, https://learn.microsoft.com/en-us/answers/questions/2141367/how-to-create-email-notifications-for-client-secre *(excerpt)*
- Q&A 1041339, "Azure Policy not enforcing the specified tags", https://learn.microsoft.com/en-gb/answers/questions/1041339/azure-policy-not-enforcing-the-specified-tags *(excerpt)*
- Q&A 1341059, "how to find creator of virtual machine", 2023, https://learn.microsoft.com/en-us/answers/questions/1341059/how-to-find-creator-of-virtual-machine *(excerpt)*
- Q&A 1347918, "Removing IAM Assignments - Unable to find identity", 2023, https://learn.microsoft.com/en-us/answers/questions/1347918/removing-iam-assignments-unable-to-find-identity *(excerpt)*
- Q&A 5725505, "Can Azure OpenAI enforce a hard spending limit...", 2026-01, https://learn.microsoft.com/en-us/answers/questions/5725505/can-azure-openai-enforce-a-hard-spending-limit-or *(excerpt)*
- Q&A 754722, "Azure report for budget vs actual", https://learn.microsoft.com/en-us/answers/questions/754722/azure-report-for-budget-vs-actual *(excerpt)*
- Q&A 4379202, "Azure Cost Management Export", https://learn.microsoft.com/en-us/answers/questions/4379202/azure-cost-management-export *(excerpt)*
- Q&A 1465965, "IPAM solution for Azure tenant...", https://learn.microsoft.com/en-us/answers/questions/1465965/ipam-solution-for-azure-tenant-to-monitor-and-prev *(excerpt)*
- Q&A 5509511, "Enforce the creation of app registrations and enterprise apps...", 2025, https://learn.microsoft.com/en-us/answers/questions/5509511/enforce-the-creation-of-app-registrations-and-ente *(excerpt)*
- Q&A 1366432, "How to get the stopped virtual machines pricing...", https://learn.microsoft.com/en-us/answers/questions/1366432/how-to-get-the-stopped-virtual-machines-pricing-fo *(excerpt)*
- Tech Community, "I built an open-source tool for running ARG governance checks on a schedule and tracking findings" (RuleBeat), 2026-08-30, https://techcommunity.microsoft.com/discussions/azuregovernance/i-built-an-open-source-tool-for-running-arg-governance-checks-on-a-schedule-and-/4551629 *(full)*
- Tech Community, tag "azure diagnostics", https://techcommunity.microsoft.com/tag/azure%20diagnostics *(excerpt)*
- Microsoft partner forum, "Azure Spending (NCE) tab does not show all clients...", https://gxcuf89792.i.lithium.com/t5/azure-partners/azure-spending-nce-tab-does-not-show-all-clients-with-azure/m-p/4038829 *(excerpt)*
- ServiceNow Community, "Exclude a subscriptions from Service Graph Azure", 2025, https://www.servicenow.com/community/service-graph-connectors-forum/exclude-a-subscriptions-from-service-graph-azure-in-servicenow/m-p/3363365 *(excerpt)*
- yomotherboard, "Does anyone else experience fluctuations in Defender for Cloud scores?", https://yomotherboard.com/question/does-anyone-else-experience-fluctuations-in-defender-for-cloud-scores/ *(excerpt)*

### GitHub issues and repos (via the GitHub API)
- Azure Orphan Resources issues #73-#87 (2025-06 to 2026-07), https://github.com/dolevshor/azure-orphan-resources/issues *(API)*
- AzGovViz repo, https://github.com/JulianHayward/Azure-MG-Sub-Governance-Reporting *(full)*; issues #290 (2025-09-19), #291 (2025-11-10), #292 (2026-01-26), #294 (2026-05-18) *(API)*
- azqr repo, https://github.com/Azure/azqr *(full)*; issue #238 "Exclude recommendations on scan", 2024-05-17 *(API)*
- microsoft/finops-toolkit issues #743 (2024-06-12, 33 reactions), #1441 (2025-03-26, 15 reactions), https://github.com/microsoft/finops-toolkit/issues/1441 *(API)*
- Azure/azure-policy issues #1050 (2022, 24 reactions), #1304 (2024-03-29), #1331 (2024-06-04), https://github.com/Azure/azure-policy/issues/1050 *(API)*
- Azure/azure-cli issue #13064 "PIM support" (2020, 74 reactions), https://github.com/Azure/azure-cli/issues/13064 *(API)*
- maester365/maester issue #1798 "Configurable accepted deviations for tests", 2026-05-23, https://github.com/maester365/maester/issues/1798 *(API)*
- nccgroup/ScoutSuite repo metadata (latest release 5.14.0, 2024-05-10), https://github.com/nccgroup/ScoutSuite *(API)*
- Azure/ipam repo metadata (pushed 2026-10-01), https://github.com/Azure/ipam *(API)*
- flavienbwk/azure-spending-limits, https://github.com/flavienbwk/azure-spending-limits *(excerpt)*
- rlowellfl/azure_hybrid_benefit_workbook, https://github.com/rlowellfl/azure_hybrid_benefit_workbook *(excerpt)*

### Microsoft documentation
- Azure spending limit, https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/spending-limit *(excerpt)*
- Identify anomalies and unexpected changes in cost, https://learn.microsoft.com/azure/cost-management-billing/understand/analyze-unexpected-charges *(excerpt)*
- Tutorial: Create and manage Cost Management exports, https://learn.microsoft.com/azure/cost-management-billing/costs/tutorial-export-acm-data *(excerpt)*
- Group and allocate costs using tag inheritance, https://docs.azure.cn/en-us/cost-management-billing/costs/enable-tag-inheritance *(excerpt)*
- Reservation utilization alerts, https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/reservation-utilization-alerts *(excerpt)*
- Get resource changes (Azure Resource Graph), updated 2026-04-03, https://learn.microsoft.com/en-us/azure/governance/resource-graph/how-to/get-resource-changes *(full)*
- Troubleshoot Azure RBAC limits, https://learn.microsoft.com/en-my/azure/role-based-access-control/troubleshoot-limits *(excerpt)*
- PIM integration with Azure RBAC, https://learn.microsoft.com/en-my/azure/role-based-access-control/pim-integration *(excerpt)*
- Microsoft Entra recommendation: Renew expiring application credentials, https://learn.microsoft.com/hr-hr/entra/identity/monitoring-health/recommendation-renew-expiring-application-credential *(excerpt)*
- How to manage inactive user accounts, https://learn.microsoft.com/en-us/entra/identity/monitoring-health/howto-manage-inactive-user-accounts *(excerpt)*
- signInActivity resource type, https://learn.microsoft.com/en-us/graph/api/resources/signInActivity *(excerpt)*
- Service Retirement workbook, https://learn.microsoft.com/en-us/azure/advisor/advisor-how-to-plan-migration-workloads-service-retirement *(excerpt)*
- Identify impacted resources for service retirements by using Azure Resource Graph, https://docs.azure.cn/en-us/service-health/service-retirement-unified-impact-queries *(excerpt)*
- Upgrade to Standard SKU public IP addresses by 30 September 2025, https://azure.microsoft.com/updates/upgrade-to-standard-sku-public-ip-addresses-in-azure-by-30-september-2025-basic-sku-will-be-retired *(excerpt)*
- Prevent overlapping virtual network address spaces with Azure Policy and IPAM, https://learn.microsoft.com/en-us/azure/virtual-network-manager/Prevent-overlapping-ip-address-space-policy-ipam *(excerpt)*
- Quota monitoring and alerting, https://learn.microsoft.com/uk-ua/azure/quotas/monitoring-alerting *(excerpt)*
- Query your backups using Azure Resource Graph, https://learn.microsoft.com/en-my/azure/backup/query-backups-using-azure-resource-graph *(excerpt)*
- View protectable resources, https://learn.microsoft.com/en-ca/Azure/resiliency/tutorial-view-protectable-resources *(excerpt)*
- CAF subscription vending, https://learn.microsoft.com/en-ie/azure/cloud-adoption-framework/ready/landing-zone/design-area/subscription-vending *(excerpt)*
- Azure Monitor Baseline Alerts, https://azure.github.io/azure-monitor-baseline-alerts/welcome/index.html *(excerpt)*

### Blogs, vendors, products
- Quarkslab, "Auditing application permissions in Microsoft Entra ID: hidden risks, pitfalls and Quarkslab's QAZPT tool", 2026-04-30, https://blog.quarkslab.com/auditing-application-permissions-in-microsoft-entra-id-hidden-risks-pitfalls-and-quarkslabs-qazpt-tool.html *(full)*
- David Swann (azure-noob), "Azure Tag Governance Reality...", 2025-12-12, https://dev.to/azurenoob/azure-tag-governance-reality-why-247-variations-of-environment-collapse-your-cost-reports-3408 *(full)*
- Practical365, "Seeking Ownerless Apps", https://practical365.com/ownerless-apps/ *(excerpt)*
- Practical365, "Protect Your Entra Apps", https://practical365.com/identifying-privileged-applications-and-their-secret-passwords/ *(excerpt; full fetch returned HTTP 500)*
- Petri, "Microsoft Entra Workload Identities Service Adds Support for App Health Recommendations", https://petri.com/microsoft-entra-workload-app-health-recommendations/ *(excerpt)*
- CIAOPS, "Microsoft Entra ID P2 Access Reviews: A Critical Evaluation for SMB Customers in Australia", 2025-09-27, https://blog.ciaops.com/2025/09/27/microsoft-entra-id-p2-access-reviews-a-critical-evaluation-for-smb-customers-in-australia/ *(excerpt)*
- Gartner Peer Insights, Microsoft Entra ID Governance, https://www.gartner.com/reviews/product/microsoft-entra-id-governance *(excerpt)*
- Sessionize, Barbara Forbes, "Your secure score is lying to you", https://sessionize.com/s/barbara-forbes/your-secure-score-is-lying-to-you/188284 *(excerpt)*
- Sessionize, Morten Mynster, "Your Graph apps are over-privileged", https://sessionize.com/s/morten-mynster/your-graph-apps-are-over-privileged-lets-fix-that-/170418 *(excerpt)*
- G2, Microsoft Defender for Cloud reviews, https://www.g2.com/products/microsoft-defender-for-cloud *(excerpt)*
- G2, Azure Advisor reviews, https://g2.com/products/azure-advisor/reviews?page=2 *(excerpt)*
- Substack, "Monitor your break glass account", https://thetolkienblackguy.substack.com/p/monitor-your-break-glass-account *(excerpt)*
- Charbel Nemnom, "Finding Azure resources with diagnostic settings enabled with PowerShell", https://charbelnemnom.com/finding-azure-resources-with-diagnostic-settings-enabled-with-powershell/ *(excerpt)*
- Insight APAC, subscription vending part 1, 2024-12-12, https://blog.insight-services-apac.dev/2024/12/12/pe-subvending-part1 *(excerpt)*
- ToDesktop status incident (role assignment limit), https://status.todesktop.com//incidents/01KBKV2SYPHY1CVB45VJRF6Y0X *(excerpt)*
- Broadcom KB on savings-plan expiry alerting (CloudHealth), https://knowledge.broadcom.com/external/article/436049/option-is-not-available-to-create-and-se.html *(excerpt)*
- Liongard metric "Azure: Windows servers missing Hybrid Benefits", https://share.liongard.com/metrics-library/p/azure-windows-servers-missing-hybrid-benefits *(excerpt)*
- PointFive (vendor), "FinOps for AI: managing LLM costs in Azure OpenAI", https://www.pointfive.co/research/finops-for-ai-managing-llm-costs-in-azure-openai *(excerpt)*
- Finout (vendor), "Azure OpenAI Pricing and FinOps Best Practices", https://www.finout.io/blog/azure-openai-pricing *(excerpt)*
- ZopNight (vendor), "Azure cost anomalies hide above and below the subscription line", https://dev.to/zop_8abedcc7e12/azure-cost-anomalies-hide-above-and-below-the-subscription-line-so-zopnight-now-watches-all-three-2398 *(excerpt)*
- Maester, https://maester.dev/ *(full)*
- Prowler Azure authentication docs, https://docs.prowler.com/user-guide/providers/azure/authentication *(excerpt)*
- Powerpipe Azure Tags mod, https://hub.powerpipe.io/mods/turbot/azure_tags *(excerpt)*; CIS v5 7.1 control, https://hub.powerpipe.io/mods/turbot/steampipe-mod-azure-compliance/controls/control.cis_v500_7_1 *(excerpt)*
- InSpec azure_network_security_group, https://docs.chef.io/inspec/resource_packs/azure/azure_network_security_group/ *(excerpt)*
- Flexera, "Flexera to Acquire FinOps Business from NetApp", 2025-01-15, https://flexera.com/about-us/press-center/flexera-to-acquire-finops-business-from-netapp-to-strengthen-portfolio *(excerpt)*
- Vantage, "Vantage Launches Microsoft Azure Cost Support", undated, https://www.vantage.sh/blog/azure-cost-management-launched-vantage *(excerpt)*
- Amnic (vendor), "6 Best CloudHealth Alternatives for FinOps Teams (2026)", https://amnic.com/blogs/cloudhealth-alternatives *(excerpt)*
- EntraCredentialExpiry (PowerShell Gallery), https://www.powershellgallery.com/packages/EntraCredentialExpiry *(excerpt)*
- AzurePIMStuff (PowerShell Gallery), https://www.powershellgallery.com/packages/AzurePIMStuff/ *(excerpt)*

### Not reachable
- reddit.com (blocked for the fetch tool; site-limited searches returned no Reddit pages). One January 2024 r/AZURE
  thread, "What would you add to Azure?", was seen only as a search excerpt through a mirror whose page returned 404.
