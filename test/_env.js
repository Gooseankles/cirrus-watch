// Shared by the tests: a fresh, empty DATA_DIR (and LOG_DIR under it) for the
// process, set before any module under src/ is loaded, so nothing touches the
// repo's data folder or a real .env. Each test file runs in its own process
// (node --test), so one folder per file is enough. No Azure: no vault, no
// storage account, no sign-in.
const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cirrus-test-"));
const LOG_DIR = path.join(DATA_DIR, "logs");
process.env.DATA_DIR = DATA_DIR;
process.env.LOG_DIR = LOG_DIR;
for (const k of ["SECRET_VAULT_URL", "STORAGE_ACCOUNT_URL", "DASHBOARD_TENANTS", "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"]) delete process.env[k];

// Two customers "from Terraform", as the Settings page and the removal see them.
const TERRAFORM_TENANTS = [
  { key: "contoso", name: "Contoso", tenantId: "aaaaaaaa-0000-4000-8000-000000000001", clientId: "bbbbbbbb-0000-4000-8000-000000000001" },
  { key: "fabrikam", name: "Fabrikam", tenantId: "aaaaaaaa-0000-4000-8000-000000000002" },
];
function useTerraformTenants(list = TERRAFORM_TENANTS) {
  process.env.DASHBOARD_TENANTS = JSON.stringify(list);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function cleanup() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

module.exports = { DATA_DIR, LOG_DIR, TERRAFORM_TENANTS, useTerraformTenants, readJson, cleanup };
