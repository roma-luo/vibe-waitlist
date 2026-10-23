# vibe waitlist landing page

Static site (no build step) + Google Sheets backend.

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The landing page |
| `config.js` | **The only file you edit**: backend URL, headlines, pixels, social links |
| `links.html` | Team-only builder for tagged campaign links |
| `privacy.html` | Privacy policy linked under every form |
| `og.png`, `favicon.svg` | Share preview image and tab icon |
| `backend/Code.gs` | Google Apps Script backend; paste into a Google Sheet |

What gets recorded, per visitor (random browser ID, no personal data until they sign up):
`page_view → scroll_50 → cta_click → orb_complete → signup → survey → share_click`,
each tagged with channel, utm_source / medium / campaign / content / term, headline variant, device and in-app browser.

Test traffic: `?test=1` marks one visit; `?internal=1` marks a whole browser (undo with `?internal=0`).
Both are written to the sheet with `is_test = test` and left out of the Summary.

Setup steps are in `backend/Code.gs` (top comment).
