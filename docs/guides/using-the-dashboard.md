# Using the dashboard

How to read and act on what the scans find: scan pages, accepting findings, the monthly report, weekly trends and
the compliance pages. What each scan checks is in [tools.md](../tools.md).

## Scan pages

Every scan run is kept, so each tool shows a trend and what was new or resolved since the run before. Anyone
who may see a scan can start it with **Run now** instead of waiting for the schedule.

Scans a tenant does not need can be turned off in Settings → Scans, on that tenant's tab: they no longer run there,
their results are hidden (also in the report, trends and compliance), and a scan off in every tenant you look at
leaves the menu. A customer tenant's list does not follow Home: there, all scans are on until you untick some.

The sidebar groups (Access, Identity, Resources and so on) fold away with a click on their heading; the browser
remembers which are folded.

## Findings, reports and compliance

- **Accept or snooze**: a finding that is known and fine (the public IP is the VPN gateway) can be accepted with a
  reason, for 30 to 365 days, until a chosen date or until reopened. It stays in the results but no longer counts as
  open; a snoozed one counts again from its end date. The **Accepted** chip on a scan page lists them, with who
  accepted them and why, and reopens them. Anyone who may read the scan in the finding's tenant may accept or
  reopen it; every accept and reopen goes to the activity log. Stored per tenant as
  `suppressions/<tool>.json` next to the scan results. API: `POST /api/tools/<id>/accept`
  `{ key, tenant, reason, until }` (`until` = `YYYY-MM-DD` or null) and `POST /api/tools/<id>/unaccept` `{ key, tenant }`.
- **Monthly report** (`#/report`): for one tenant or all you can see, where every scan stood at the end of the
  month against its start, a score out of 100, open critical findings, what was found and fixed, and the
  compliance controls with open findings. **Print / PDF** gives a light, printable page for the customer.
  API: `GET /api/report?month=YYYY-MM[&tenant=<key>]`.
- **Weekly trends** (`#/trends`): open findings at the end of each week across every scan (by severity and per
  tool), with what was found and fixed each week, for 8 to 52 weeks. Built from the stored run history, so it runs
  no scans; a tool's first scan counts as the starting point, not as new findings. API:
  `GET /api/trends?weeks=12[&tenant=<key>]`.
- **Compliance tags**: each finding shows the NIS2 Article 21(2) points, the sections of the NIS2 Implementing
  Regulation (EU) 2024/2690, NSM ICT security principles (Norway's baseline, v2.1) and CIS Controls v8.1 safeguards it
  bears on (`public/compliance.js`), and the scan pages filter on
  them. A finding shows a control is not met somewhere; no finding does not prove it is met.
- **Compliance page** (`#/compliance`): every NIS2 point, Implementing Regulation section, NSM principle or mapped CIS
  safeguard for the tenant tab in
  view: critical findings, findings, no findings (the scans that look at it ran and found nothing), not run yet, or
  check by hand (training, incident handling, supplier contracts: things no scan can see). Each row links the scans
  that check it and when they last ran. **Print / PDF** as for the report. Built from the scans only; Microsoft
  Defender for Cloud is not needed.

Related: [Sign-in and roles](sign-in-and-roles.md) (who may see and accept what), [Notifications](notifications.md).
