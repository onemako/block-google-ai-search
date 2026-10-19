# Google Web Results Only

A self-hosted Manifest V3 extension for Google Chrome and Microsoft Edge that makes Google Search open in the
**Web** results view, which has no AI Overview. Any top-level navigation to
`google.com/search?…` (and the other listed Google domains) that lacks `udm=14`
is redirected to the same URL with `udm=14` added.

It is meant to be force-installed through the `ExtensionInstallForcelist`
policy, so it is hosted on GitHub Pages instead of a browser's web store. Edge
installs the same signed `.crx`, so the extension ID is the same in both browsers.

| Browser | Platform | How it is deployed |
|---|---|---|
| Google Chrome | Windows (domain-joined) | Group Policy, or `deploy/Set-ExtensionForceInstall.ps1` |
| Microsoft Edge | Windows (domain-joined) | Group Policy, or `deploy/Set-ExtensionForceInstall.ps1` |
| Google Chrome | macOS | Chrome Enterprise Core enrollment (`deploy/mac/enroll-chrome-enterprise-core.sh`, run by your RMM agent), or `deploy/mac/GoogleWebResultsOnly-Chrome.mobileconfig` through an MDM |

Firefox and Safari are not supported. Firefox needs a Mozilla-signed `.xpi`, and
Safari needs a signed and notarized Mac app.

- Uses `declarativeNetRequest` static rules only. There is no background script, no
  content script, no remote code, no analytics and no data collection.
- Permissions: `declarativeNetRequest`, plus host access to the listed Google domains
  (Chrome requires host access for a redirect rule).

## How it works

[`extension/rules.json`](extension/rules.json) holds two rules, applied to
`main_frame` (top-level page) requests only:

| Rule | Priority | Matches | Action |
|---|---|---|---|
| 1 | 2 | URL contains `udm=14` | **allow**, so the request is left alone. This prevents a redirect loop. |
| 2 | 1 | URL contains `/search?` | **redirect**, adding or replacing `udm=14` in the query string |

A search for `?q=cats` becomes `?q=cats&udm=14`. A search for `?q=cats&udm=2`
(Images) becomes `?q=cats&udm=14`. A URL that already has `udm=14` matches rule 1,
which outranks rule 2, so it is never redirected again.

### Domains (the one place to edit)

The domain list lives in **[`extension/domains.json`](extension/domains.json)**
and nowhere else:

```json
{
  "domains": ["google.com"]
}
```

Each entry is a bare domain. It also covers its subdomains, so `google.com` covers
`www.google.com`. The build script (`scripts/build.mjs`) copies the list into
`requestDomains` in every rule and into `host_permissions` in the manifest. To add
a domain, for example `google.co.uk`, add it to the list, bump the version, and push.

### Optional: allow another view (not enabled)

By default every Google tab (Images, Videos, News, Shopping…) is sent back to
Web results. To let users reach the Images tab, add one more allow rule to
`extension/rules.json`. The build fills in `requestDomains`. This snippet is
**not** part of the shipped rules:

```jsonc
// OPTIONAL: add as a third entry in extension/rules.json to allow Google Images.
// {
//   "id": 3,
//   "priority": 2,
//   "action": { "type": "allow" },
//   "condition": {
//     "urlFilter": "udm=2",
//     "requestDomains": [],
//     "resourceTypes": ["main_frame"]
//   }
// }
```

Older Images links use `tbm=isch` instead of `udm=2`. Add a similar rule with
`"urlFilter": "tbm=isch"` and a new `id` if you need those too.

## Repository layout

```
extension/            Extension source (the workflow runs when this folder changes)
  manifest.json       Version, update_url, permissions (host_permissions filled by build)
  rules.json          The two declarativeNetRequest rules (requestDomains filled by build)
  domains.json        The domain list. Not shipped in the .crx.
  icons/              Placeholder icons (regenerate with scripts/make-icons.py)
scripts/build.mjs     Build, sign (CRX3), verify, and write updates.xml
.github/workflows/release.yml   CI: build, sign, publish to Pages, create a Release
deploy/Set-ExtensionForceInstall.ps1   Adds the Chrome + Edge policy entries on a single PC
deploy/mac/enroll-chrome-enterprise-core.sh   Enrolls Chrome on a Mac in Chrome Enterprise Core (no MDM)
deploy/mac/GoogleWebResultsOnly-Chrome.mobileconfig   macOS profile for Chrome (deploy with MDM)
```

## One-time setup

### 1. Create the signing key and the `EXTENSION_PEM` secret

The private key decides the extension ID. **Keep it safe and never change it.**
A new key means a new extension ID, and every PC would need a new policy entry.
Never commit it. `.gitignore` excludes `*.pem`.

On any machine with OpenSSL (Git for Windows includes it):

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out webonly.pem
```

Then in GitHub, open **Settings → Secrets and variables → Actions → New repository
secret**:

- Name: `EXTENSION_PEM`
- Value: the whole contents of `webonly.pem`, including the `-----BEGIN PRIVATE KEY-----`
  and `-----END PRIVATE KEY-----` lines

Store `webonly.pem` somewhere safe outside the repository, such as a password
manager. You need it again only if you move hosting.

The workflow writes the secret to a temporary file in the runner's temp directory,
outside the checkout. It uses the file only to sign, deletes it afterwards, and
never prints it. If the secret is missing, the build fails. It never quietly
generates a new key.

### 2. Enable GitHub Pages

Open **Settings → Pages → Build and deployment → Source** and choose **GitHub
Actions**.

The site is served at `https://onemako.github.io/block-google-ai-search/`. The
repository itself can be private; Pages for a private repository needs a paid
GitHub plan. The **site** must still be publicly reachable, because Chrome
downloads `updates.xml` and `webonly.crx` without signing in. On GitHub Pro and
Team, Pages sites are always public. On GitHub Enterprise Cloud, leave the
Pages visibility set to public. After each deploy, the workflow fetches both
files anonymously and fails if they can't be reached or don't match the build.

If you fork or rename the repository, change `update_url` in
`extension/manifest.json` to match. The build fails if it doesn't match the
repository's Pages URL.

## Releasing a new version

1. Bump `"version"` in `extension/manifest.json`, for example `1.0.0` → `1.0.1`.
2. Commit and push to `main`, or merge a pull request.

Any push to `main` that changes `extension/` runs **Build, sign and publish
extension**. You can also start it by hand from the Actions tab
(**Run workflow**). The workflow:

1. Fails if the version is not higher than the one in the published `updates.xml`,
   or if a Release `v<version>` already exists. A manual re-run without a version
   bump therefore fails on purpose.
2. Builds `dist/extension/`, then packs and signs `webonly.crx` (CRX3) with
   `EXTENSION_PEM`.
3. Computes the extension ID from the public key, then checks it against the ID
   inside the signed CRX header. It also verifies the CRX signature.
4. Publishes `webonly.crx`, `updates.xml` and a small `index.html` to GitHub Pages,
   then downloads them anonymously over HTTPS to check the live copies match.
5. Creates a GitHub Release `v<version>` with the `.crx` attached, as an archive
   copy. Chrome never downloads from the Release. `updates.xml` points at the
   Pages URL, because Release downloads redirect.
6. Writes the extension ID and the force-install string to the run summary.

Chrome and Edge check for updates every few hours. To update a PC right away,
open `chrome://extensions` (or `edge://extensions`), turn on Developer mode, and
click **Update**.

## Finding the extension ID

The current values (fixed for as long as `EXTENSION_PEM` stays the same) are:

- Extension ID: `enkieoehgkejdljiejbjmenfloafdfgg`
- Force-install string: `enkieoehgkejdljiejbjmenfloafdfgg;https://onemako.github.io/block-google-ai-search/updates.xml`

To look them up yourself, any of these works:

- The **summary** of the latest workflow run (Actions tab → the run → Summary).
- `https://onemako.github.io/block-google-ai-search/updates.xml`: the `appid` attribute.
- `https://onemako.github.io/block-google-ai-search/`: the index page lists it.
- From the key, locally:
  `openssl pkey -in webonly.pem -pubout -outform DER | sha256sum | head -c32 | tr 0-9a-f a-p`

## Deploying with Group Policy (ExtensionInstallForcelist)

The policy value is `<extension-id>;<update URL>`:

```
<extension-id>;https://onemako.github.io/block-google-ai-search/updates.xml
```

Copy the exact string from the workflow summary.

1. Install the ADMX templates in your central store
   (`\\<domain>\SYSVOL\<domain>\Policies\PolicyDefinitions`) if they aren't
   there yet:
   - **Chrome**: `chrome.admx` and `en-US\chrome.adml` from Google's Chrome
     Enterprise bundle.
   - **Edge**: `msedge.admx` and `en-US\msedge.adml` from Microsoft's Edge policy
     templates (download them from the Microsoft Edge for Business page).
2. In **Group Policy Management**, edit (or create) a GPO linked to the computers' OU.
3. Add the string above as a new row in each browser's list. Keep any existing rows.
   - **Chrome:** **Computer Configuration → Policies → Administrative Templates →
     Google → Google Chrome → Extensions → Configure the list of force-installed
     apps and extensions**. Set it to **Enabled** and click **Show…**.
   - **Edge:** **Computer Configuration → Policies → Administrative Templates →
     Microsoft Edge → Extensions → Control which extensions are installed
     silently**. Set it to **Enabled** and click **Show…**.
4. On a client, run `gpupdate /force` and then check each browser (see below).

Force-installed extensions can't be disabled or removed by users.

### Single PC without GPO: `deploy/Set-ExtensionForceInstall.ps1`

`$ExtensionId` and `$UpdateUrl` at the top of the script are already filled in.
`$Browsers` lists `Chrome` and `Edge`. Remove one if you want the script to handle
only the other. Run it in an **elevated** PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\Set-ExtensionForceInstall.ps1           # add
powershell -ExecutionPolicy Bypass -File .\deploy\Set-ExtensionForceInstall.ps1 -Remove   # remove only this extension
```

Run it as **SYSTEM** (in an RMM tool, choose to run as System) or as an elevated
local administrator. The policy is machine-wide (`HKLM`), so it applies to every
user on the PC. If the script is started in 32-bit PowerShell, it relaunches
itself in 64-bit PowerShell, so the values land where Chrome and Edge read them.

For each browser, the script appends a new numbered value under
`HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist` (Chrome) or
`HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist` (Edge). It
never overwrites or renumbers existing entries, skips the change if the ID is already
there, and prints what it did. If a GPO also manages that policy, the GPO
overwrites the script's change at the next refresh. In that case, add the entry to
the GPO instead.

## Incognito and InPrivate windows

Chrome and Edge don't run extensions in Incognito/InPrivate windows unless the user
turns on **Allow in Incognito** on the extension's details page. There is **no
policy** to turn that on for users, even for a force-installed extension.

To close that gap, turn private browsing off with policy:

| Browser | Group Policy setting | Value |
|---|---|---|
| Chrome | Google → Google Chrome → **Incognito mode availability** | Incognito mode disabled (`IncognitoModeAvailability` = 1) |
| Edge | Microsoft Edge → **Configure InPrivate mode availability** | InPrivate mode disabled (`InPrivateModeAvailability` = 1) |

Without Group Policy, set `$DisablePrivateBrowsing = $true` at the top of
`deploy/Set-ExtensionForceInstall.ps1`. It is `$false` by default. `-Remove`
always turns Incognito/InPrivate back on, whatever this setting is. This affects every user on the PC:
the Incognito/InPrivate menu items and shortcuts disappear.

## Deploying to Macs (Chrome)

Chrome on macOS only force-installs a self-hosted extension when Chrome is
managed in one of these ways:
- the Mac is enrolled in an MDM;
- the Mac is bound to a directory through MCX;
- Chrome is enrolled in **Chrome Enterprise Core**.

An RMM agent alone doesn't count. Chrome then marks
the entry `[BLOCKED]`, the same way it does on a Windows PC that isn't
domain-joined.

### Option A: Chrome Enterprise Core + an RMM agent (no MDM needed)

Chrome Enterprise Core is Google's free cloud management for the Chrome browser.
Chrome is enrolled with a token, and policies, including the extension
force-install, are set in the Google Admin console.

1. **Sign up / open the Admin console.** Go to https://admin.google.com. Use your
   existing Google Workspace admin account, or sign up for Chrome Enterprise Core,
   which is free.
2. **Create an enrollment token.** Go to **Devices → Chrome → Managed browsers**,
   choose the organizational unit, then **⋮ → Enrollment token** (or **Add
   token**). Copy the token. Treat it like a password and don't commit it.
3. **Force-install the extension.** Go to **Devices → Chrome → Apps & extensions →
   Users & browsers**, and select the same organizational unit. Click **+** and
   choose **Add Chrome app or extension by ID**. Select **From a custom URL**, then
   enter:
   - Extension ID: `enkieoehgkejdljiejbjmenfloafdfgg`
   - URL: `https://onemako.github.io/block-google-ai-search/updates.xml`

   Set its installation policy to **Force install** and save.
4. **Enroll Chrome on each Mac through your RMM agent.** Add
   [`deploy/mac/enroll-chrome-enterprise-core.sh`](deploy/mac/enroll-chrome-enterprise-core.sh)
   as a macOS script in your RMM tool and run it as root. Pass the token either as a
   script variable named `CHROME_ENROLLMENT_TOKEN` or as the first script
   parameter. The script writes the token to
   `/Library/Google/Chrome/CloudManagementEnrollmentToken`. Chrome enrolls the next
   time it starts.
5. **Check on a Mac.** Quit and reopen Chrome, then check:
   - `chrome://management` should say the browser is managed by your organization.
   - `chrome://policy` should show `ExtensionInstallForcelist` (source: Cloud) as
     **OK**.
   - `chrome://extensions` should list **Google Web Results Only**.

   Enrolled browsers also show up under **Devices → Chrome → Managed browsers**.

The same approach also works for Windows PCs that aren't domain-joined. Enroll
Chrome there with the token through Google's Windows instructions, and the Admin
console force-install applies.

### Option B: an MDM configuration profile

If the Macs are ever enrolled in an MDM (Jamf, Intune, Kandji, Mosyle…),
deploy
[`deploy/mac/GoogleWebResultsOnly-Chrome.mobileconfig`](deploy/mac/GoogleWebResultsOnly-Chrome.mobileconfig)
as a custom configuration profile scoped to computers. The profile sets
`ExtensionInstallForcelist` for `com.google.Chrome`. On a Mac, `System Settings →
General → Device Management` should list "Google Web Results Only (Chrome)".

If another profile on the same Mac already sets `ExtensionInstallForcelist` for
Chrome, macOS doesn't merge the two lists, and only one of them takes effect. In
that case, add this entry to that profile's list instead of deploying a second
profile.

## Testing on one PC or Mac

1. Apply the policy (GPO + `gpupdate /force`, or the script above).
2. Open `chrome://policy` (Edge: `edge://policy`), click **Reload policies**,
   and confirm that `ExtensionInstallForcelist` shows your string with status
   **OK**. If it shows `[BLOCKED]` with "not detected as enterprise managed", the
   device isn't domain-joined or MDM-enrolled (see Known limits).
3. Open `chrome://extensions` (Edge: `edge://extensions`).
   **Google Web Results Only** should appear with
   *Installed by your administrator*, the expected ID, and the expected version.
   If it is missing, wait a minute, or turn on Developer mode and click **Update**.
4. Search on google.com. The URL should end up containing `udm=14`, and the page
   should show the **Web** tab with no AI Overview.
5. Click the **Images** tab. It should land back on Web results. This is expected;
   see Known limits.

To try the rules without the policy, run `npm ci && npm run build` and load
`dist/extension/` with **Load unpacked** (Developer mode). An unpacked copy gets a
different extension ID. That doesn't matter for testing the rules.

## Known limits

- **Chrome and Edge only.** Firefox and Safari are not supported (see the
  table at the top). Other Chromium browsers (Brave, Opera, Vivaldi) have their
  own policies and aren't covered here.
- **Other Google tabs are redirected to Web.** Images, Videos, News, Shopping,
  Books and similar tabs all use `/search?` URLs without `udm=14`, so they land on
  Web results. See *Optional: allow another view* above.
- **Not in Incognito/InPrivate by default.** Users must allow the extension in
  private windows themselves, or you turn private browsing off (see *Incognito and
  InPrivate windows*).
- **Only top-level navigations are changed.** Searches inside iframes, and
  in-page navigations Google makes without loading a new page, are not redirected.
  When Google switches tabs that way, the next full page load is corrected.
- **Only the listed domains are covered.** A search on `google.de`, for example, is
  untouched until you add that domain to `extension/domains.json`.
- **Rule 2 matches any URL on those domains that contains `/search?`.** That
  includes other Google products that use that path.
- **Managed devices only.** Chrome and Edge force-install self-hosted extensions
  only on Windows PCs that are domain-joined or MDM-enrolled, on Macs that are
  MDM-enrolled, and (Chrome only) where the browser is enrolled in Chrome
  Enterprise Core. Anywhere else, `chrome://policy` shows the entry as
  `[BLOCKED]` with "Invalid extension ID" and a "not detected as enterprise
  managed" warning, and nothing is installed.
- **Google can change `udm=14`.** If Google drops or renames the Web view
  parameter, the rules need updating.
