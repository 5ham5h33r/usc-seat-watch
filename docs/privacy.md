# Privacy and permissions

USC Seat Watch runs in your browser. It has no application server, analytics,
advertising code, or third-party notification service.

## Requests

The extension requests public course and catalog data from `classes.usc.edu`
with credentials omitted. Course searches use a cached code/title catalog;
typing a search does not transmit the search text to USC. Choosing a course
requests its section data from USC.

While enabled, the extension reads your Course Bin and Checkout in the
selected `webreg.usc.edu` tab. It uses USC's controls to add or schedule course
sections, isolate a checkout, and submit registration. Those actions use your
USC session. Existing browser redirects handle SSO. Password, passkey, Duo,
and other authentication challenges require your participation.

## Storage

Chrome local storage holds the chosen semester and sections, units and grade
options, selected tab ID, monitoring results, retry deadlines, and recovery
records. Recovery records include the original scheduled selections and
claims for pending section changes or submissions. Chrome session storage
holds the public catalog cache and the enabled run ID for this browser session.

The extension does not save passwords, passkeys, session cookies, tokens,
checkout HTML, or student names. USC pages and Chrome retain their own data
under their respective policies.

Click **Stop** to stop registration and silence notifications. Finish any
checkout recovery before removing the extension; uninstalling removes its
local recovery records. Chrome removes extension storage when you uninstall.

## Permissions

| Permission | Purpose |
| --- | --- |
| `alarms` | Run monitoring and recovery checks |
| `storage` | Save the watchlist and recovery records |
| `notifications` | Show local notices for a watch enabled from the popup |
| `power` | Request prevention of idle sleep while the watch is active |
| `classes.usc.edu` | Read public catalog and seat data |
| `webreg.usc.edu` | Read and operate the chosen registration tab |

The manifest requests no access to other websites, the password manager,
browser history, or cookies. Chrome startup and extension updates require a
new Start action before monitoring or notifications can resume.
