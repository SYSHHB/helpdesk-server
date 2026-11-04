# SYSHHB IT Helpdesk on your own server (Coolify): steps

One container does two jobs: it shows the website (the `public` folder) with real security
headers, and it answers `/api/` after checking who the person is and what their role allows.
The data is kept as files in a folder on your server (a Coolify "persistent storage" volume).

The website in `public/` is helpdesk version 63 with `BACKEND: "api"` in `public/config.js`: it talks
ONLY to this server. Nothing is read from or written to OneDrive any more, and the Microsoft sign-in
token the website gets is for the helpdesk server only.

## What you need
* A server with Coolify, reachable from the internet on ports 80 and 443.
* The right to create DNS records for `syayasan.edu.bn`.
* Your GitHub account, and the Microsoft Entra admin center.

## Step 1. Put the project in a new private GitHub repository
1. GitHub, **New repository**. Name `helpdesk-server`. Choose **Private**. Create.
2. Upload everything from this folder (keep the folders `src`, `server`, `public`, `tools` and the
   files `Dockerfile`, `docker-entrypoint.sh`, `package.json`, `.dockerignore`).
   On a phone this is easier on a computer: **Add file**, **Upload files**, drag the whole folder in.
3. Check that `Dockerfile` is at the top of the repository, not inside another folder.

## Step 2. Change the Entra app (same as for the old plan)
Microsoft Entra admin center, **App registrations**, your helpdesk app (client ID starts `598ea952`):
1. **Expose an API**: Application ID URI `api://598ea952-e9df-4684-a109-85832dc34e59`.
   Add a scope named `access_as_user`, "Admins and users", state Enabled.
2. **Manifest**: set `accessTokenAcceptedVersion` to `2`, Save.
3. **Authentication**, **Single-page application**: add `https://ithelpdesk.syayasan.edu.bn/`
   (with the slash at the end, exactly like that). You can leave the other addresses there for now.
4. **API permissions**: add your own app's `access_as_user`, then **Grant admin consent**.
   Keep `User.Read` and `Mail.Send` (the website uses them to read the person's own mail address
   and to send the helpdesk emails). Remove the old ones in Step 8, after everything works.

## Step 3. The DNS record
Make a DNS record: **A** record named `ithelpdesk` (so the full name is `ithelpdesk.syayasan.edu.bn`)
pointing to your server's public IP address.
Your current helpdesk on GitHub keeps working untouched while you set this up, because it uses a
different address.

## Step 4. Create the app in Coolify
(The menu names can differ a little between Coolify versions.)
1. **Projects**, your project, **New resource**, **Private repository** (with the GitHub App or a
   deploy key), pick `helpdesk-server`, branch `main`.
2. **Build pack: Dockerfile**. **Ports exposes: 3000**.
3. **Domains**: `https://ithelpdesk.syayasan.edu.bn`
   Coolify gets the HTTPS certificate by itself once the DNS record is in place.
4. **Persistent storage**: add a volume. Name `helpdesk-data`. Destination (mount path) `/data`.
   This is where all complaints and photos live. Without it, data is lost at every update.
5. **Environment variables** (add each, then save):

| Name | Value |
|---|---|
| `TENANT_ID` | `d3ab4c65-3ba1-4c04-98fd-66a0c7730cdf` |
| `API_CLIENT_ID` | `598ea952-e9df-4684-a109-85832dc34e59` |
| `ALLOWED_DOMAIN` | `syayasan.edu.bn` |
| `ADMIN_EMAILS` | `it.helpdesk@syayasan.edu.bn` |
| `SEED_USERS` | `[{"email":"zulfa.zaini@syayasan.edu.bn","role":"technician"}]` |
| `LEGACY_YEAR` | `2026` |

6. **Health check** (optional but good): path `/api/health`.
7. Press **Deploy**. The first build takes a few minutes.

## Step 5. Check it works
1. Open `https://ithelpdesk.syayasan.edu.bn/api/health`. You should see `{"ok":true}`.
2. Open `https://ithelpdesk.syayasan.edu.bn/`. The helpdesk login page appears.
3. In Coolify, open **Logs**. Lines such as `GET /api/health 200` show it is running.
4. Ask a developer's browser tool, or me, to check the headers: the site should send
   `Strict-Transport-Security`, `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`.

## Step 5b. Make sure staff can reach it from outside (mobile data)
Staff use their phones on mobile data, so the address must work from the public internet:
1. The DNS record points to a **public** IP address. If the server is inside the school network, the
   router or firewall must forward **ports 80 and 443** to the Coolify server. (Port 80 is needed for
   the free HTTPS certificate.) If the school cannot open ports, ask your network team about a
   Cloudflare Tunnel instead.
2. Test from a phone with Wi-Fi switched OFF: open `https://ithelpdesk.syayasan.edu.bn/api/health`.
   If it fails only on mobile data, it is the router, firewall or DNS, not the helpdesk.
3. Keep SSH and the Coolify screen (usually port 8000) closed to the internet. Only 80 and 443 are needed.
4. Create your Coolify admin account straight away. Whoever reaches that page first becomes the admin.

## Step 5c. Move the old data from OneDrive (one time)
1. On a computer, download the OneDrive folder `SYSHHB-Helpdesk` and unzip it.
2. Sign in to `https://ithelpdesk.syayasan.edu.bn/` as the administrator (the first sign-in asks
   for your name, group and phone).
3. **Accounts**, scroll to **Import the old data**. Choose the data files (users.json, tickets.json,
   notifs.json, settings.json and the audit-….json files), wait for "Done", then choose the `photos` folder.
4. Old complaints keep their old numbers (shown as `IT-2026-0013`), and new complaints carry on
   after the last old number. Everyone confirms their details once on their next sign-in.
Do the import before staff start using the new address. Importing twice only overwrites with the same records.

## Step 6. Backups (do this now, not later)
The only copy of your data is the `helpdesk-data` volume.
1. Copy `tools/backup.sh` to the server, set `VOLUME=` to the volume's real name (`docker volume ls`).
2. `chmod +x backup.sh`, run it once, check a `.tgz` appears.
3. Add it to cron for every night, and copy the backups to another place (another computer or OneDrive).
4. Test restoring once on a spare folder before you ever need it.

## Step 7. Tell everyone the new address
When the test above works and the old data is imported:
1. Tell staff the new address: `https://ithelpdesk.syayasan.edu.bn/`.
2. Each person opens it, signs in, and confirms their details once.
3. On phones: remove the old installed helpdesk app, open the new address in Chrome (not from inside
   WhatsApp), and use **Install app on this phone**. The installed app belongs to one address, so
   the new address needs a new install.
4. Keep the old GitHub site for a short time as a fallback, then turn it off in Step 8.
The address in the Coolify domain field and the DNS record must stay `ithelpdesk.syayasan.edu.bn`.

## Step 8. Close the old door (after staff have used the new address for a few days)
1. Entra, your app, **API permissions**: remove `Files.ReadWrite.All` and any `Sites.*` and
   `User.ReadBasic.All` permission. Keep `User.Read`, `Mail.Send` and `access_as_user`.
2. In OneDrive, stop sharing the folder `SYSHHB-Helpdesk` (Manage access, remove the links).
   Keep it as a backup copy, owned by it.helpdesk only.
3. Turn the GitHub Pages site off.

## If something goes wrong
* **Everyone is refused (401 or "Wrong audience")**: the Entra step 2 values do not match the
  settings in Coolify (`API_CLIENT_ID`, `TENANT_ID`). `accessTokenAcceptedVersion` must be 2.
* **The page is blank or sign-in does nothing and the browser console mentions "Content Security
  Policy"**: in Coolify add the variable `CSP_HEADER` with the value `off`, redeploy, and tell the developer.
  (The page keeps its own policy inside the page.)
* **"Server is not set up" / the server stops at start**: `TENANT_ID` or `API_CLIENT_ID` is missing.
* **Data disappeared after an update**: the persistent volume was not mounted at `/data`.

## Updating later
Change files in the repository. Coolify redeploys (turn on automatic deploy, or press Deploy).
The data volume is kept.

## What was tested here, and what was not
Tested (23 automatic tests, `npm test`), plus a full run of the real website in a real browser against
the real server with four people signed in (administrator, technician, two users): first sign-in,
a complaint with a photo, the technician's update, the notification and comment reaching the right
person, other people's attempts being refused, the audit log, and importing old OneDrive files
(old numbers kept, photos shown, internal notes hidden, numbering carried on). Details of the unit tests:
the sign-in token checks, every rule in the who-can-do-what
table, per-year complaint numbers, the file storage (restart, two people at once, 60 counter
requests at once, a half-written file, unsafe names), the website server (headers, files outside the
website folder and hidden files are never served, `/api` rules over real HTTP, data kept after a
restart), and the real server started with environment variables.

**Not** tested here: the Docker build and the container (Docker is not available where I work),
Coolify itself, fetching Microsoft's signing keys from your server, and real Microsoft sign-in (the
browser test used a stand-in for Microsoft that hands out test tokens). Email sending uses the same
Microsoft call as before and was tested only with a stand-in. Expect to fix a small thing the first
time it runs.

## Who can do what (checked by the server)

| What | Person (user) | Technician | Admin |
|---|---|---|---|
| Make a complaint | yes (server gives number IT-year-0000, owner, status) | yes | yes |
| See complaints | only their own | all | all |
| Change a complaint | only reopen their own resolved/closed one | status, progress, technician, date, urgency | same, and delete |
| Change who owns a complaint | nobody | nobody | nobody |
| Comments | own complaint, never internal; see non-internal | add, internal notes, see all | same |
| Notifications | only their own | team + own | same |
| Audit log | add a line | add a line | read, never erase |
| Accounts | own name, group, phone | see all | create, roles, disable, delete (not themselves) |
| Hijri calendar settings | read | read | change |
| Photos | own and their complaint's | all | all |
