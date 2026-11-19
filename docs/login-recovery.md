# USC login recovery findings

Investigated on November 13, 2026. These observations describe a point in time; USC can change its authentication flow.

## Observed flow

An unauthenticated request to `https://webreg.usc.edu/Checkout` redirected to Microsoft's authorization service. The returned page contained a SAML form targeting USC's Shibboleth identity provider. WebReg uses a federated browser sign-in flow.

With an existing SSO session, browser navigation to Checkout reached USC's term-selection page. Selecting the requested semester reached the registration application. This demonstrated reuse of an existing session and term selection, but did not establish unattended sign-in after all SSO sessions expire.

## Implemented recovery

1. Check the authenticated Course Bin during monitoring and before a transaction.
2. If authentication expires, navigate the selected tab through the normal Checkout route. The browser handles existing Microsoft and USC SSO sessions.
3. If USC displays its term picker, select the exact configured semester.
4. Validate the semester and Course Bin before resuming the saved phase. Recheck seats and exact checkout contents before submission.
5. If a password, passkey, Duo, CAPTCHA, account picker, or unknown page remains, notify the user once and wait for sign-in. Do not generate repeated MFA requests.

Uncertain section changes and submission claims remain saved for review. An ambiguous result never authorizes a repeated registration request.

## Authentication limits

The extension requests no access to login domains, the password manager, or cookies. Existing-session recovery uses browser redirects. Password, Windows Hello passkey, and Duo prompts can require the user's participation; the extension cannot promise unattended authentication.

Chrome's [password documentation](https://support.google.com/chrome/answer/95606?hl=en) describes saved-credential autofill. It does not establish that an extension can retrieve passwords or complete USC's flow. [USC's Duo documentation](https://itservices.usc.edu/duo/) and [Duo's remembered-device guide](https://guide.duo.com/universal-prompt/) describe authentication and session behavior subject to the institution's configuration.

Chrome's [Identity API](https://developer.chrome.com/docs/extensions/reference/api/identity) supports registered OAuth flows; it does not replace WebReg's own Microsoft client and callback.

No credentials or token values were collected for this research. No logout was forced, MFA challenge initiated, or registration submitted.
