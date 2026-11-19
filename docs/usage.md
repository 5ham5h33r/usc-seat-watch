# USC Seat Watch

A local Chrome extension with a configurable watchlist for multiple USC courses and departments. It checks USC's public course data about every 30 seconds and submits **one available course group per checkout**. A closed class on the watchlist does not get bundled into another class's checkout.

## Load or update

1. Open `chrome://extensions` in Chrome. For a first installation, enable Developer mode, choose **Load unpacked**, and select this project's `extension` folder.
2. For an existing installation, click **Reload** on USC Seat Watch. The new version is **2.1.1**.
3. Reload your USC Web Registration tab so its content scripts match the updated helper. Sign in and choose the intended semester.
4. Open USC Seat Watch from Chrome's Extensions menu. If an interrupted checkout needs review or restoration, finish that first.
5. Configure the watchlist, select the USC tab, and click **Start automatic registration**. **Stop** disables further submissions; if selections were temporarily isolated, known changes are restored before stopping. An uncertain change pauses for review instead.

Closing the popup does not stop the background worker. The popup shows the saved status when reopened. Chrome or extension restarts require starting again, and unresolved recovery is preserved.

Desktop notifications are allowed only for a watch enabled with **Start automatic registration** in the current Chrome session. Startup, updates, and a stopped watch stay silent. **Stop** immediately silences the watch, including while saved selections are being restored.

## Configure courses

Expand **Add a course**. Fresh installations start with an empty watchlist. Existing installations keep their saved entries.

- **Semester:** choose a readable semester name, such as Spring 2027. Changing semester explicitly clears the old watchlist; there is no term-code entry.
- **Find a course:** type at least two characters of a course code, department, or title, such as `DSCI`, `EE 450`, or `geospatial`. Choose a result from USC's course list.
- **Pick sections:** section cards show the type, instructor, meeting details, seats, and available registration notes. Check the lecture and all required labs/discussions for the same entry. If there is only one usable section, it is preselected. Full sections can be watched; cancelled or unsupported sections cannot be selected.
- **Units:** fixed units, including zero-unit labs/discussions, are supplied automatically. Only a section with variable units asks you to choose a value from USC's choices.
- **Advanced grade options:** Letter Grade is the default. Expand the advanced options only when another grade is needed. Set variable units and grade options in WebReg to match; the helper does not silently change those choices.

Click **Add to watchlist**. The helper fills section IDs internally and verifies course/section membership and unit choices with USC before saving. There is no manual section-number form. Repeat for more courses. Configuration supports up to 12 course groups with up to 6 section components each, and a section can belong to only one group. Every entry represents an enrollment you want; separate entries are not alternative-section preferences or automatic course swaps.

Search uses USC's public semester catalog. The reduced code/title list is cached for up to eight hours in Chrome session storage (at most three semesters), so typing does not send a network request for every keystroke or reveal your search terms to USC. Selecting a course retrieves its section details; saving validates the choice again. The picker shows USC's registration notes but does not guess which lecture/lab combinations fulfill a course requirement. Include all required components before adding.

Start acts on the saved watchlist. Configuration editing is locked while running or while a checkout recovery is unresolved. Use the same controlled tab for WebReg and avoid changing scheduled selections while a checkout is being prepared.

## Isolated checkout

USC submits all pending changes together. To avoid a full class blocking an available one, the helper:

1. Waits until all components in a selected course group have seats.
2. Reads fresh Course Bin data and saves an isolation journal **before** changing any selection.
3. Temporarily unschedules other **unregistered** sections, including closed watchlist entries and unrelated scheduled courses. Registered courses are not unscheduled. Any pending drop blocks the flow for manual resolution.
4. Adds missing target components and schedules them using USC's existing controls. Fresh server reads confirm each change; a visual AJAX callback alone is insufficient.
5. Checks fresh and displayed Checkout contents. Exactly the selected course and all its requested components must be present, with the correct semester, units, grade choices, and open status. The public API is checked again immediately before submission.
6. Saves a durable attempt ID and clicks Submit once. It checks fresh Course Bin data for confirmed enrollment before moving to another target.
7. Restores the other originally scheduled selections. Components added only for an unsuccessful attempt return to unscheduled status; newly added Course Bin entries may remain saved there. Successfully registered components are left registered.

When two different courses are open, they use two separate confirmed checkouts. When one is closed, it stays out of the available course's checkout. When a seat fills during preparation, the helper restores selections and waits for a fresh opening rather than repeatedly cycling the cart.

## Recovery and uncertain results

The isolation journal and submission attempt are stored locally. If Chrome closes, a tab disappears, an operation times out, or the worker restarts during a change, the helper retains that information and does not replay an uncertain mutation or submission.

- **Restore scheduled selections** restores journaled selections after you check an interrupted section change. It does not submit registration.
- **I reviewed the USC result** is for an uncertain prior submission. Check the actual result in USC first. Acknowledgment lets the helper read the current state, restore saved selections, and stop. It does not retry registration; restarting afterward is a separate action.
- Missing or changed journal identities, pending drops, partial registration of a linked group, and unrecognized page layouts require manual review.

A click is not enrollment. The helper labels a target registered only after USC Course Bin reports all of its selected components registered. It pauses if a full result is not confirmed instead of moving on with an uncertain checkout.

## Timing and sign-in

The watchlist is checked about every **30 seconds**; authenticated Course Bin/session health is checked separately every **5 minutes** and during each transaction. Targets for the same course share a public API response within a sweep. Requests run sequentially, so large watchlists or slow responses can lengthen a sweep. Transactions and required fresh checks take precedence over the normal polling interval.

Each API request has a 12-second timeout. Failures receive increasing retry delays, capped at 15 minutes unless USC requests a longer `Retry-After`. Cooldowns survive Stop/Start. One target's delayed lookup does not make stale availability authorize its checkout.

Normal Microsoft/Shibboleth redirects can reuse an existing SSO session. The selected semester is chosen on USC's term page when needed. Password, Windows Hello passkey, Duo, or CAPTCHA prompts require you. The helper does not store passwords/PINs, extract passkeys, or bypass authentication. Native verification cannot be guaranteed unattended. Public monitoring can continue while authentication waits, but no registration is submitted until the session is valid.

Keep Chrome running, the laptop plugged in, and the lid open. The helper requests prevention of idle sleep while active; screen-off is allowed. Forced sleep, lid closure, shutdown, lack of connectivity, registration holds, deadlines, restrictions, and seat contention can still prevent enrollment. An opening cannot guarantee the seat.

## Permissions and local data

Host access remains limited to `classes.usc.edu` and `webreg.usc.edu`; no extra login-domain or cookie permissions were added. Public course requests explicitly omit credentials. USC's existing page controls and form handle authenticated changes and submission with their current session and verification tokens.

Local storage contains the watchlist, expected grade/units, selected tab, per-target seat/status data, retry deadlines, isolation journal, and durable mutation/submission IDs. Chrome session storage can also contain the public course catalog cache. Neither stores checkout HTML, passwords, passkeys, tokens, or your name. No third-party notification service receives your data.

Permissions are `alarms` for scheduling, `storage` for durable recovery, `notifications` for local notices, and `power` for preventing idle sleep while active. The `extension` folder is self-contained; runtime operation needs no Node.js, build, or external package.

## Development and verification

For development tests, use Node.js 22 or later, run `npm ci`, then `npm run check`. `linkedom` is a development-only DOM fixture dependency. It is not included in or loaded by the installed extension.

The test suite covers catalog search and caching, section metadata, fixed and variable units, stale search/section responses, checkbox choices, semester changes, preserved typing during status polling, strict checkout validation, open A versus closed B, multiple departments, linked groups, restoration, uncertain operations, cancellation, interrupted durable claims, and rate limits. The popup has also been rendered in Chromium with a mock extension API. The live public catalog and PHYS-151 section response were checked read-only during development.

No live enrollment or temporary unscheduling was performed to test the new multi-course flow. Automated tests simulate USC responses; the real production multi-course transaction remains unverified until it runs against a real opening.

Earlier live API timing research is retained in [the API check report](research/api-check-results.json): six requests at 30-second intervals on November 13, 2026 yielded five HTTP 200 responses and one 12-second timeout, without a 429 response. That small sample does not establish a sustained rate limit. [The probe script](../scripts/check-api.mjs) reproduces that small historical CSCI-specific probe; the extension itself uses the configurable watchlist. The probe makes live public requests and is excluded from automated checks.

The original Schedule Helper's public source is [jonluca/USC-Class-Notifier-API](https://github.com/jonluca/USC-Class-Notifier-API). Earlier login research is in [Login recovery findings](login-recovery.md). This helper independently implements local polling and guarded checkout handling.
