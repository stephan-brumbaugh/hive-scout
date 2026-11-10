# Hive Scout: offline BIOBUZZ scouting for iPad

Hive Scout is a scouting app for the 2026–27 FTC season (BIOBUZZ). It runs in the iPad's browser and keeps working with no internet.

- Scouts collect match and pit data on their iPads.
- Each scout iPad sends its data to a "hub" iPad or laptop by showing QR codes on screen.
- The hub ranks every team by how well they would pair with **your** robot.

There is no app store and no login for scouts. Data is saved on each iPad first. Add the optional Google Sheet backup (section 6) and every iPad also syncs with the Sheet on its own whenever it's online.

---

## 1. Put it on GitHub Pages (one time, about 10 minutes)

Free hosting is the easiest option. The app needs HTTPS to use the camera, and GitHub Pages provides that.

1. Sign in at github.com (create a free account if needed). Click **+ → New repository**.
   - Name it something like `hive-scout`.
   - Make it **Public**. GitHub Pages is free for public repositories.
   - Click **Create repository**.
2. On the new repository page, click **uploading an existing file**.
   - Unzip `hive-scout.zip` on your computer.
   - Open the `hive-scout` folder, select everything inside it, and **drag** it onto the GitHub upload page: `index.html`, `sw.js`, `manifest.webmanifest`, `README.md`, and the `css`, `js`, `lib`, `icons` and `tools` folders. Drag and drop keeps the folders; the "choose your files" button can only add single files.
   - `index.html` must end up at the top level of the repository, not inside another folder.
   - Click **Commit changes**.
3. Go to **Settings → Pages**. Under *Build and deployment*:
   - Set **Source** to *Deploy from a branch*.
   - Set **Branch** to `main` and the folder to `/ (root)`.
   - Click **Save**.
4. Wait a minute or two. The address appears at the top of that page, for example `https://yourname.github.io/hive-scout/`.

The scouting data never goes to GitHub. GitHub only hosts the app's code. Everything you scout is stored on each iPad.

## 2. Install it on each iPad (while online)

1. Open the address in **Safari**.
2. Tap **Share → Add to Home Screen → Add**.
3. Open Hive Scout **from the new Home Screen icon**. It saves itself for offline use the first time it opens.
4. Close it, turn on Airplane Mode, and open it again to confirm it works offline.

**School network filters.** Each iPad only has to reach the site once, to install it. That first load can happen on any network: school Wi-Fi, home Wi-Fi or a phone hotspot. A district web filter that follows the iPad everywhere (common on managed iPads) may block `*.github.io` on every network. If so, ask IT to allow your exact address, for example `yourname.github.io`. The app contacts only that address and, when you download an event, `api.ftcscout.org`.

> **Important:** iPadOS keeps the Home Screen app's data separate from Safari's data. Always scout from the Home Screen icon, not a Safari tab, or the data will appear to be "missing".

## 3. Set up before the event

On **every** iPad, open the **Event** tab and enter:
- the scout's name
- your team number

Then load the event in one of these ways:

| Way | When to use it |
|---|---|
| **FTCScout** | iPad is online. Tap *Find events for team …*, or type the event code (e.g. `USTXHOQ1`) and tap **Download**. FTCScout is free and copies FIRST's official data, so no account or key is needed. Codes appear in the event's URL on ftc-events.firstinspires.org. |
| **FIRST API** | You have an official FTC Events API key. FIRST's servers normally block requests from a web page. If the in-app download fails, run `tools/ftc_event_download.py 2026 EVENTCODE` on a laptop and import the `.json` file it creates (**Event → File**). |
| **Manual** | No internet at all. Paste or type the team numbers (one per line, name optional). The schedule is optional, one line per match: `1 12345 23456 34567 45678` (red 1, red 2, blue 1, blue 2). |
| **QR from another iPad** | Load the event on one iPad. Tap **Share event by QR**. Each other iPad scans it from **Sync → Start camera**. No internet needed. |

The schedule is usually published shortly before qualification matches start. If you loaded the event early, tap **Refresh from FTCScout** (or Edit) once the schedule is out.

## 4. At the event

**Match scouts:**
1. Open **Scout**.
2. Tap your assigned position (for example *Red 1*). The app remembers it, so each new match fills in the right team automatically.
3. Tap counters and toggles during the match.
4. Tap **Save** at the end. The form moves on to the next match.

**Pit scouts:** open **Scout → Pit scouting**, tap a team, and fill in the robot profile. The ✓ marks teams that are already done.

**Sending data to the hub** (every few matches, or at breaks):
1. The scout taps **Sync → Send my unsent records**.
2. The hub taps **Sync → Start camera** and points it at the scout's screen.
3. Larger batches show an animated series of QR codes. The hub collects the parts in any order, and the green squares show progress.
4. When the hub says *Complete*, the scout taps **Received ✓ Mark as sent**.

Scanning the same code twice does no harm. Records are matched by ID and only newer copies replace older ones.

**Pick list (hub):**
- The **Teams** tab shows sortable stats for every team. Tap a team for details, match history and notes.
- Mark teams **★ Want / ? Maybe / ✕ Avoid**.
- The **Partners** tab ranks teams by how well they fit your robot.
- To give the drive coach a copy: **Sync → Send all event data** on the hub, then scan it with the coach's iPad.

**Scout your own matches too.** The Partners tab compares other teams against *your* robot's real numbers. It uses your team's records from every event, or your own pit entry if you have no match data yet.

## 5. How the partner score works

The score runs from 0 to 100. It is a weighted mix of four parts, and you can change the weights with the sliders on the Partners tab.

| Part | What it measures |
|---|---|
| **Complementary roles** | Strength in HIVE launching and FLOWER endgame, weighted toward what *your* robot is weaker at. Bonus if the two teams prefer different roles in the pit survey; penalty if they prefer the same one. |
| **AUTO doesn't collide** | Distance between the starting tiles each team uses: same tile scores poorly, an adjacent tile is a warning, two or more tiles apart is good. Penalty if both teams take pieces from the GARDEN or FLOWERs in AUTO. Also counts how many AUTO points the partner scores. |
| **Ranking-point odds** | Pairs each of your recent matches with each of theirs (up to 12 each) and checks every pairing against the bonus ranking points: SWARM (LEAVE + PARK ≥ 16), POLLINATOR 1 (≥ 4 tips) and POLLINATOR 2 (≥ 7 tips). Tips are estimated from launches: 3 for the first tip (the CELL starts holding 3 NECTAR), then 8 per tip after that. |
| **Reliability & clean play** | Matches where the robot broke down, disconnected or didn't show up; foul points given away; and any YELLOW or RED CARDS. |

You can change all thresholds and the tip model on **Event → Game & scoring settings**. Do this if Team Updates announce different values, or once you learn how many launches really tip a HIVE.

**Field symmetry:** starting tiles are recorded as seen from the audience. A6 is the top-left tile on screen, and row 1 is nearest the audience. To compare a red start with a blue start, the app flips the blue half onto the red half. Check Figure 9-2 in the manual, then choose *Mirror* or *Rotated 180°* to match the real field.

## 6. Automatic cloud backup to a Google Sheet (optional)

Whenever an iPad is online, it uploads its new records to a Google Sheet and downloads every other iPad's records. It does this by itself, with no taps. With no internet the app keeps working, and the iPad catches up the next time it's online. QR codes are then only needed when nobody has internet.

**One-time setup, on a computer (about 5 minutes):**

1. Open the **Hive Scout Data** Google Sheet, or create a blank one. Go to **Extensions → Apps Script**.
2. Delete the sample code. Paste in all of `tools/hive-scout-sync.gs`.
3. Change `TEAM_KEY` at the top to your own password. Use only letters, numbers and dashes. Click **Save**.
4. Pick **setup** in the function menu at the top and click **Run**. Approve the permissions; the script can only use this Sheet.
5. Click **Deploy → New deployment**. Click the gear icon and pick **Web app**. Set **Execute as: Me** and **Who has access: Anyone**. Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).
6. Open Hive Scout on that computer, using the same web address as the iPads. Go to **Sync → Cloud backup** and paste the URL and the team key. The status should change to **Synced**.
7. On each iPad, go to **Sync → Start camera** and scan the computer's **Share cloud setup by QR**. **Share event by QR** also includes the cloud setup.

The Sheet gets two readable tabs, **Matches** and **Pits**, that you can sort, filter or chart. They are rebuilt on every change, so don't type in them. The hidden tabs `_records` and `_events` hold the sync data; don't edit those either.

**If "Anyone" isn't offered** in step 5, your school Google account doesn't allow outside access. Copy the Sheet and script into a personal Google account and deploy it there instead. The iPads don't need to sign in to anything.

**Header badge:** `☁ Synced`, `☁ 3 waiting` (saved on the iPad, will upload when online) or `☁ Problem`. Tap the badge to see details on the Sync tab.

## 7. Backups and exports

- Make a backup at the end of every event day: **Sync → Save backup**, then save to Files or AirDrop to a laptop. iPadOS can delete website data that hasn't been used for a while.
- To restore a backup, or merge in data from another device, use **Sync → Import**. Merging never deletes anything.
- **Match data CSV / Pit data CSV** open in Excel or Google Sheets.

## 8. Updating the app

1. Edit or replace the files in your GitHub repository.
2. Change the `VERSION` line at the top of `sw.js` (for example `hive-scout-v1.1.2`), and `APP_VERSION` at the top of `js/app.js` to match. This tells the iPads that a new version exists. The Event tab shows which version an iPad is running.
3. The next time each iPad opens the app while online, it shows *A new version is ready → Reload*.

Each record's field order is the format used in the QR codes. If you add fields, add them only at the end of the lists in `js/schema.js`, so iPads running older and newer versions can still exchange data.

## Files

```
index.html             app shell
css/app.css            styles (light and dark mode)
js/app.js              screens and interactions
js/schema.js           match and pit fields (also the QR format)
js/store.js            on-device storage
js/api.js              FTCScout, FIRST API, manual and file import
js/qr.js               QR splitting, drawing and camera scanning
js/analysis.js         team stats and partner compatibility
js/cloud.js            automatic two-way sync with the Google Sheet
sw.js                  offline cache
lib/                   qrcode-generator (MIT) and jsQR (Apache-2.0)
tools/ftc_event_download.py   FIRST API → event file (laptop)
tools/hive-scout-sync.gs      Google Apps Script for the cloud backup Sheet
```

Hive Scout is an unofficial tool. It is not affiliated with FIRST®, FTCScout or RTX. BIOBUZZ and FIRST Tech Challenge are trademarks of FIRST.
