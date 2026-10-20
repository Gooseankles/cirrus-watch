const axios = require("axios");

// Posts a work note back onto the originating ticket so the requester/agent
// can see progress without leaving ServiceNow.
async function addWorkNote(table, sysId, note) {
  const instance = process.env.SNOW_INSTANCE_URL;
  const user = process.env.SNOW_API_USER;
  const password = process.env.SNOW_API_PASSWORD;
  if (!instance || !user || !password) {
    throw new Error("SNOW_INSTANCE_URL / SNOW_API_USER / SNOW_API_PASSWORD not set — see .env.example");
  }

  const url = `${instance}/api/now/table/${table}/${sysId}`;
  const response = await axios.patch(
    url,
    { work_notes: note },
    {
      auth: { username: user, password },
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      validateStatus: () => true,
    }
  );

  if (response.status >= 300) {
    throw new Error(`ServiceNow work note update failed (${response.status}): ${JSON.stringify(response.data)}`);
  }
  return response.data;
}

module.exports = { addWorkNote };
