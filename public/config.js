/* SYSHHB IT Helpdesk settings. This copy is for the version that runs on your own server (Coolify). */
window.HELPDESK_CONFIG = {
  /* "api" = the website talks to your own server (this one). Leave it as it is. */
  BACKEND: "api",

  /* From Microsoft Entra ID > App registrations > your app > Overview */
  CLIENT_ID: "598ea952-e9df-4684-a109-85832dc34e59",
  TENANT_ID: "d3ab4c65-3ba1-4c04-98fd-66a0c7730cdf",

  /* Only these school accounts can sign in. */
  ALLOWED_DOMAIN: "syayasan.edu.bn",

  /* Used only to choose who receives the team emails. Roles are kept on the server (Accounts page),
     and the first administrators are set in Coolify (ADMIN_EMAILS). */
  ADMIN_EMAILS: ["it.helpdesk@syayasan.edu.bn"],

  /* How emails are sent: "graph" = from the signed-in person's mailbox, "off" = no emails. */
  EMAIL_MODE: "graph",
  /* Who gets the [ALERT] emails. The technician assigned to the complaint is always added. */
  NOTIFY_EMAILS: ["it.helpdesk@syayasan.edu.bn"],

  /* Hijri date on the login page. Copy the two lines shown in Calendar > Brunei calendar settings. */
  HIJRI_ADJ: -1,
  HIJRI_STARTS: {},

  /* Security */
  CSP: true,
  IDLE_MINUTES: 0,
  IDLE_FULL_SIGNOUT: false,
  MSAL_SRI: "",
  ALLOW_FRAMING: false,

  /* How often (seconds) the page asks the server for new things. */
  POLL_SECONDS: 10
};
