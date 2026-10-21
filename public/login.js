(async () => {
  let me = {};
  try {
    me = await (await fetch("/api/me")).json();
  } catch (err) { /* treat as not signed in */ }
  if (me.signedIn) {
    window.location.href = "/";
    return;
  }
  document.getElementById("sso-card").classList.toggle("hidden", !me.ssoConfigured);
  document.getElementById("local-card").classList.toggle("hidden", !me.localAdminConfigured);
  document.getElementById("none-msg").classList.toggle("hidden", Boolean(me.ssoConfigured || me.localAdminConfigured));
  // The callback sends people back here with ?error=<code> when sign-in was refused.
  const error = new URLSearchParams(window.location.search).get("error");
  if (error === "no-role") {
    const note = document.getElementById("none-msg");
    note.textContent = "Your account has no role on this dashboard. Ask an admin to assign you the Admin or User role in the Enterprise App.";
    note.classList.remove("hidden");
  }
})();

document.getElementById("local-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const status = document.getElementById("local-status");
  const btn = ev.target.querySelector("button");
  status.textContent = "";
  btn.disabled = true;
  try {
    const res = await fetch("/auth/local-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: document.getElementById("password").value }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      window.location.href = "/";
      return;
    }
    status.textContent = data.error || "sign-in failed";
  } catch (err) {
    status.textContent = "sign-in failed";
  }
  btn.disabled = false;
});
