# Gmail OTP Catcher

A Chrome extension that monitors your Gmail for OTP codes and verification links — and surfaces them as a floating overlay on whatever page you're on. No tab switching. No copy-pasting. Just the code, right where you need it.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-blue?logo=googlechrome)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)
![License](https://img.shields.io/badge/License-MIT-yellow)

---

## Why this exists

Every time you apply for a job, log into a portal, or reset a password — you get an email OTP. Then you alt-tab to Gmail, find the email, read the code, switch back, and type it in. By then it's expired or you misread it.

This extension eliminates that entirely. The code floats over whatever you're doing, ready to copy or auto-fill.

---

## Features

- **Instant overlay** — OTP codes appear as a floating card on your current tab the moment Gmail receives them
- **Magic link detection** — verification emails, password reset links, and email confirmation links surface as one-tap overlays
- **Auto-fill** — click Fill to inject the code directly into the OTP field (supports split inputs like Oracle Cloud)
- **Burst mode** — when you submit a form or land on a verify/reset page, checks Gmail every 2s instead of every 10s
- **Smart detection** — handles spaced codes (`482 910`), 8-digit codes, alphanumeric codes (Greenhouse), and more
- **Zero noise** — codes auto-dismiss after 30s and never re-appear on unrelated pages

---

## Setup

### 1. Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or use an existing one)
3. Enable the **Gmail API** — APIs & Services → Enable APIs → search "Gmail API"
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**
5. Application type: **Chrome Extension**
6. For the extension ID — load the extension unpacked first (step below), Chrome will show you the ID on `chrome://extensions`
7. Copy the generated **Client ID**

### 2. Configure the extension

```bash
git clone https://github.com/YOUR_USERNAME/gmail-otp-catcher.git
cd gmail-otp-catcher

# Copy the example manifest and fill in your client ID
cp manifest.example.json manifest.json
```

Open `manifest.json` and replace `YOUR_GOOGLE_CLIENT_ID_HERE` with your actual client ID.

### 3. Load in Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `gmail-otp-catcher` folder
5. Pin the extension, click the icon, and sign in with your Google account

---

## How it works

```
Gmail inbox
    │
    ▼ (Gmail API — gmail.readonly scope)
Background service worker
    │  polls every 10s via setInterval (port keep-alive)
    │  burst mode: 0 → 2 → 4 → 8 → 15s on OTP page detection
    │
    ▼ (chrome.runtime port / tabs.sendMessage)
Content script (runs on every tab)
    │
    ▼
Floating overlay — copy / fill / open link
```

**Detection pipeline** (in priority order):
1. Keyword before code — `"Your code: 482910"`
2. Keyword + colon anywhere — `"paste this code into the field: XaQcsGx7"`
3. Code before keyword — `"482910 is your security code"`
4. Code on next line after keyword
5. Standalone 6-digit number
6. Standalone 8-digit number
7. Mixed-case alphanumeric (Greenhouse-style)
8. 4–8 digit number in an email with OTP subject

**Magic links** — extracts `<a href>` tags from raw HTML, scores by anchor text keywords (`verify`, `reset`, `confirm`) and URL patterns (`/verify`, `token=`, `magic=`), blocks unsubscribe/social links.

---

## Tech stack

- Manifest V3 Chrome Extension
- Gmail REST API (messages, history, profile)
- Persistent port connections (keep-alive pattern for service workers)
- No build step — vanilla JS, no dependencies

---

## Project structure

```
├── background.js          # Service worker — Gmail polling, detection, port management
├── content.js             # Overlay UI, auto-fill, burst triggers
├── styles.css             # Overlay styles (scoped, !important-guarded)
├── popup.html / popup.js  # Extension popup — sign in, status, last code
├── manifest.example.json  # Template — copy to manifest.json and add your client ID
├── icons/                 # Extension icons (16, 48, 128px)
└── create_icons.py        # Script used to generate icons
```

---

## Contributing

PRs welcome. Some areas worth improving:

- [ ] Support for more OTP formats (5-digit, alphanumeric with special chars)
- [ ] Multi-account Gmail support
- [ ] Keyboard shortcut to dismiss / copy
- [ ] Chrome Web Store release
- [ ] Firefox port (Manifest V3 compatible)

---

## License

MIT — see [LICENSE](LICENSE)

---

Built by [Rakshith Reddy](https://github.com/YOUR_USERNAME)
