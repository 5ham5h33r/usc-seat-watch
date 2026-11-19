# Changelog

## 2.1.1 - 2026-11-18

First packaged GitHub release of USC Seat Watch.

- Search USC's course catalog by department, code, or title and choose sections.
- Watch multiple course groups, including required lecture/lab components.
- Isolate each available course's checkout and restore other scheduled selections.
- Preserve recovery records and pause after uncertain changes or submissions.
- Reuse an existing SSO session and select the configured semester during recovery.
- Gate notifications on Start in the popup; keep startup, updates, and Stop silent.
- Start fresh installations with an empty watchlist and preserve saved configurations.
- Add manifest validation, automated tests, CI, release packaging, and installation docs.

Production multi-course transactions have not been verified against a live
opening. Automated tests use simulated USC pages and responses.
