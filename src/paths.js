// Where state is kept. In a container on App Service set DATA_DIR to a folder
// under /home (with WEBSITES_ENABLE_APP_SERVICE_STORAGE=true) so settings,
// findings and logs survive restarts and redeploys.
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const LOG_DIR = process.env.LOG_DIR || (process.env.DATA_DIR ? path.join(DATA_DIR, "logs") : path.join(__dirname, "..", "logs"));

module.exports = { DATA_DIR, LOG_DIR };
