"use strict";
/* Compliance mapping: the framework controls each kind of finding bears on, shown as tags on the scan pages and
   counted in the monthly report. A pointer for auditors, not a full assessment: a finding shows a control is not
   met somewhere; no finding does not prove it is met.
   cis = CIS Critical Security Controls v8 (safeguard numbers), nis2 = NIS2 Directive Article 21(2) (point letters). */
const FRAMEWORKS = { cis: "CIS Controls v8", nis2: "NIS2 Art. 21(2)" };

const CONTROLS = {
  "cis:1.1": "Detailed enterprise asset inventory",
  "cis:2.2": "Authorised software is currently supported",
  "cis:3.3": "Data access control lists",
  "cis:3.10": "Encrypt sensitive data in transit",
  "cis:3.11": "Encrypt sensitive data at rest",
  "cis:4.1": "Secure configuration process",
  "cis:5.1": "Inventory of accounts",
  "cis:5.3": "Disable dormant accounts",
  "cis:5.4": "Administrator privileges on dedicated accounts",
  "cis:5.5": "Inventory of service accounts",
  "cis:6.1": "Access granting process",
  "cis:6.2": "Access revoking process",
  "cis:6.3": "MFA for externally exposed applications",
  "cis:6.5": "MFA for administrative access",
  "cis:6.8": "Role-based access control",
  "cis:7.1": "Vulnerability management process",
  "cis:8.2": "Collect audit logs",
  "cis:11.2": "Automated backups",
  "cis:11.3": "Protect recovery data",
  "cis:12.2": "Secure network architecture",
  "cis:15.1": "Inventory of service providers",
  "nis2:a": "Risk analysis and information system security policies",
  "nis2:b": "Incident handling",
  "nis2:c": "Business continuity, backups and disaster recovery",
  "nis2:d": "Supply chain security",
  "nis2:e": "Security in acquisition, development and maintenance",
  "nis2:f": "Assessing the effectiveness of measures",
  "nis2:h": "Cryptography and encryption",
  "nis2:i": "Access control and asset management",
  "nis2:j": "Multi-factor authentication",
};

const ASSETS = ["cis:1.1", "nis2:i"];
const ACCESS = ["cis:6.8", "nis2:i"];
const POLICY = ["cis:4.1", "nis2:a", "nis2:f"];
const KIND_CONTROLS = {
  "unattached-disk": ASSETS,
  "orphaned-nic": ASSETS,
  "unused-public-ip": ["cis:1.1", "cis:12.2", "nis2:i"],
  "empty-resource-group": ASSETS,
  "missing-tags": ASSETS,
  "stale-direct-assignment": ["cis:6.8", "cis:6.2", "nis2:i"],
  "stale-group-assignment": ["cis:6.8", "cis:6.2", "nis2:i"],
  "app-credential-expiring": ["cis:5.5", "nis2:i"],
  "keyvault-cert-expiring": ["cis:3.10", "nis2:h"],
  "kv-soft-delete-off": ["cis:11.3", "nis2:c"],
  "kv-purge-protection-off": ["cis:11.3", "nis2:c"],
  "kv-public-network": ["cis:3.3", "cis:12.2", "nis2:i"],
  "kv-access-policies": ACCESS,
  "kv-expired": ["cis:3.11", "nis2:h"],
  "kv-expiring": ["cis:3.11", "nis2:h"],
  "kv-no-expiry": ["cis:3.11", "nis2:h"],
  "kv-broad-secret-access": ["cis:3.3", "cis:6.8", "nis2:i"],
  "kv-many-readers": ["cis:3.3", "cis:6.8", "nis2:i"],
  "kv-guest-access": ["cis:3.3", "cis:6.8", "nis2:i"],
  "kv-deleted-principal": ["cis:6.2", "nis2:i"],
  "kv-no-diagnostics": ["cis:8.2", "nis2:b"],
  "kv-no-owner-tag": ASSETS,
  "kv-empty": ASSETS,
  "kv-unused": ASSETS,
  "access-package-expiring": ["cis:6.1", "nis2:i"],
  "access-package-auto-approved-no-expiry": ["cis:6.1", "cis:6.2", "nis2:i"],
  "access-package-duplicate-name": ["cis:6.1", "nis2:i"],
  "access-package-pending-too-long": ["cis:6.1", "nis2:i"],
  "access-package-single-approver": ["cis:6.1", "nis2:i"],
  "access-package-unused": ["cis:6.1", "nis2:i"],
  "orphaned-assignment": ["cis:6.2", "nis2:i"],
  "probe-not-blocked": POLICY,
  "probe-only-audited": POLICY,
  "enforcement-off": POLICY,
  "effect-disabled": POLICY,
  "definition-missing": POLICY,
  "identity-missing": POLICY,
  "identity-lacks-roles": POLICY,
  "remediation-failed": POLICY,
  "remediation-not-run": POLICY,
  "evaluates-nothing": POLICY,
  "exemption-no-expiry": POLICY,
  "exemption-expired": POLICY,
  "exemption-expiring": POLICY,
};
// Policy probes: what the probed resource itself would break.
const PROBE_CONTROLS = {
  "storage-public-blob": ["cis:3.3", "nis2:i"],
  "storage-http": ["cis:3.10", "nis2:h"],
  "storage-old-tls": ["cis:3.10", "nis2:h"],
  "public-ip": ["cis:12.2"],
  "keyvault-no-purge-protection": ["cis:11.3", "nis2:c"],
  "sql-public-network": ["cis:12.2", "nis2:i"],
  "untagged-resource": ["cis:1.1"],
};

const Compliance = {
  FRAMEWORKS,
  CONTROLS,
  // [{ id: "cis:5.3", fw: "cis", ref: "5.3", label: "CIS 5.3", title }]
  of(f) {
    const ids = new Set([...(KIND_CONTROLS[f.kind] || []), ...((f.probe && PROBE_CONTROLS[f.probe]) || [])]);
    return [...ids].map(Compliance.control).sort((a, b) => a.fw.localeCompare(b.fw) || a.ref.localeCompare(b.ref, "en", { numeric: true }));
  },
  control(id) {
    const [fw, ref] = id.split(":");
    return { id, fw, ref, label: fw === "cis" ? `CIS ${ref}` : `NIS2 (${ref})`, title: CONTROLS[id] || "" };
  },
};
