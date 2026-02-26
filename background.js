// Gmail OTP Catcher — Background Service Worker
// Polls Gmail every ~1 minute (Chrome's minimum alarm interval is 30–60s)

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const POLL_ALARM_NAME = 'gmail_poll';
const POLL_INTERVAL_MINUTES = 0.5; // 30 seconds (Chrome 120+); older Chrome clamps to 60s

// ─── Lifecycle ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log('[OTP Catcher] Extension installed');
  setupAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[OTP Catcher] Extension started');
  setupAlarm();
});

function setupAlarm() {
  chrome.alarms.get(POLL_ALARM_NAME, (alarm) => {
    if (!alarm) {
      chrome.alarms.create(POLL_ALARM_NAME, {
        delayInMinutes: 0.1, // First check after 6 seconds
        periodInMinutes: POLL_INTERVAL_MINUTES
      });
      console.log('[OTP Catcher] Polling alarm created (every ~1 min)');
    }
  });
}

// ─── Alarm Handler ──────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM_NAME) {
    console.log('[OTP Catcher] Alarm fired — checking Gmail...');
    checkGmail();
  }
});

// ─── Persistent port connections ────────────────────────────────────────────
// Each tab's content script opens a port named "otp-heartbeat".
// While ANY port is open Chrome CANNOT kill this service worker, so we run
// a reliable setInterval to poll Gmail every 10 seconds.
// When a code is found it is instantly pushed through ALL open ports →
// the overlay appears on the page you're sitting on with no interaction needed.

const activePorts = new Map(); // tabId → port  (only one port per tab)
let portPollInterval = null;
let isChecking = false;
let burstTimers = []; // exponential-backoff burst timers

// Burst mode: fired when user submits a form or lands on an OTP page.
// Uses Gmail History API (delta-only, ultra-light) at 0→2→4→8→15s,
// then drops back to the normal 10s poll. Clears itself the moment
// a code is found — no wasted calls after success.
function enterBurstMode() {
  clearBurstMode(); // reset any existing burst
  console.log('[OTP Catcher] ⚡ Burst mode — checking at 0, 2, 4, 8, 15s');
  [0, 2000, 4000, 8000, 15000].forEach(delay => {
    burstTimers.push(setTimeout(() => {
      if (!isChecking) checkGmailBurst();
    }, delay));
  });
}

function clearBurstMode() {
  burstTimers.forEach(t => clearTimeout(t));
  burstTimers = [];
}

// Push the code ONLY to the currently active tab — not every open tab.
// This prevents the overlay from appearing on LinkedIn, Gmail, or any
// irrelevant page the user happens to have open.
function pushCodeToPorts(code, from) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTabId = tabs[0]?.id;
    if (!activeTabId) return;
    const port = activePorts.get(activeTabId);
    if (port) {
      try { port.postMessage({ type: 'CODE_UPDATE', code, from: from || '' }); }
      catch (e) { activePorts.delete(activeTabId); }
    }
  });
}

function pushLinkToPorts(link, linkText, from) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTabId = tabs[0]?.id;
    if (!activeTabId) return;
    const port = activePorts.get(activeTabId);
    if (port) {
      try { port.postMessage({ type: 'LINK_UPDATE', link, linkText, from: from || '' }); }
      catch (e) { activePorts.delete(activeTabId); }
    }
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'otp-heartbeat') return;

  const tabId = port.sender?.tab?.id;
  if (!tabId) return;

  activePorts.set(tabId, port);
  console.log(`[OTP Catcher] Port opened — tab ${tabId}, ${activePorts.size} tab(s) live`);

  // First tab connecting: kick off a 10-second Gmail poll loop
  if (!portPollInterval) {
    console.log('[OTP Catcher] Starting fast Gmail poll loop (every 10s)');
    checkGmail(); // immediate first hit
    portPollInterval = setInterval(() => {
      if (!isChecking) checkGmail();
    }, 10000);
  }

  // On new page load: push a stored code/link ONLY if it is fresh (< 45s) and
  // not yet consumed. The 45s window covers normal OTP flows (click "send code"
  // → email arrives → navigate to OTP entry page) while preventing codes from
  // haunting unrelated pages opened minutes later.
  const FRESH_WINDOW = 45 * 1000;
  chrome.storage.local.get(
    ['lastCode', 'lastCodeTime', 'lastCodeFrom', 'lastCodeConsumed',
     'lastLink', 'lastLinkText', 'lastLinkTime', 'lastLinkFrom', 'lastLinkConsumed', 'enabled'],
    (d) => {
      const codeAge = Date.now() - (d.lastCodeTime || 0);
      if (d.lastCode && codeAge < FRESH_WINDOW && !d.lastCodeConsumed && d.enabled !== false) {
        try { port.postMessage({ type: 'CODE_UPDATE', code: d.lastCode, from: d.lastCodeFrom || '' }); }
        catch (e) {}
      }
      const linkAge = Date.now() - (d.lastLinkTime || 0);
      if (d.lastLink && linkAge < FRESH_WINDOW && !d.lastLinkConsumed && d.enabled !== false) {
        try { port.postMessage({ type: 'LINK_UPDATE', link: d.lastLink, linkText: d.lastLinkText || '', from: d.lastLinkFrom || '' }); }
        catch (e) {}
      }
    }
  );

  port.onDisconnect.addListener(() => {
    if (activePorts.get(tabId) === port) activePorts.delete(tabId);
    console.log(`[OTP Catcher] Port closed — tab ${tabId}, ${activePorts.size} tab(s) remaining`);
    if (activePorts.size === 0 && portPollInterval) {
      clearInterval(portPollInterval);
      portPollInterval = null;
      console.log('[OTP Catcher] All tabs closed — stopping fast poll loop');
    }
  });
});

// Tab-change listeners as a fallback (covers restricted pages, fresh tabs, etc.)
let lastPollTime = 0;
const POLL_DEBOUNCE_MS = 10000;
function pollGmailDebounced() {
  const now = Date.now();
  if (now - lastPollTime < POLL_DEBOUNCE_MS) return;
  lastPollTime = now;
  checkGmail();
}
chrome.tabs.onActivated.addListener(() => pollGmailDebounced());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') pollGmailDebounced();
});

// ─── Auth Helpers ───────────────────────────────────────────────────────────

function getAuthToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token || null);
      }
    });
  });
}

function refreshToken(expiredToken) {
  console.log('[OTP Catcher] Refreshing expired token...');
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token: expiredToken }, () => {
      chrome.identity.getAuthToken({ interactive: false }, (newToken) => {
        if (chrome.runtime.lastError || !newToken) {
          console.log('[OTP Catcher] Token refresh failed — user must sign in again');
          resolve(null);
        } else {
          console.log('[OTP Catcher] Token refreshed successfully');
          resolve(newToken);
        }
      });
    });
  });
}

// ─── Main Poll ──────────────────────────────────────────────────────────────

async function checkGmail() {
  if (isChecking) return; // prevent overlapping calls
  isChecking = true;

  try {
    // Check if extension is enabled
    const { enabled } = await chrome.storage.local.get('enabled');
    if (enabled === false) {
      console.log('[OTP Catcher] Extension disabled, skipping poll');
      return;
    }

    let token;
    try {
      token = await getAuthToken(false);
    } catch (e) {
      console.log('[OTP Catcher] Not authenticated:', e.message);
      return;
    }

    if (!token) {
      console.log('[OTP Catcher] No token available — skipping poll');
      return;
    }

    const { lastMessageId } = await chrome.storage.local.get('lastMessageId');

    // Query Gmail for recent OTP emails — no "is:unread" so it works even
    // if the user opens the email before the extension polls.
    // newer_than:1d keeps results recent; lastMessageId prevents re-showing old codes.
    const query = encodeURIComponent(
      'newer_than:1d (OTP OR "verification code" OR "your code" OR "use this code" OR ' +
      '"confirm your identity" OR "one-time" OR passcode OR "security code" OR ' +
      '"two-factor" OR 2FA OR subject:verification OR subject:confirm OR ' +
      'subject:login OR subject:"sign in" OR subject:authenticate)'
    );
    const listUrl = `${GMAIL_API_BASE}/messages?q=${query}&maxResults=10`;

    console.log('[OTP Catcher] Fetching message list...');
    let listResp = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });

    // Handle token expiry
    if (listResp.status === 401) {
      console.log('[OTP Catcher] 401 received — refreshing token');
      token = await refreshToken(token);
      if (!token) return;
      listResp = await fetch(listUrl, {
        headers: { Authorization: `Bearer ${token}` }
      });
    }

    if (!listResp.ok) {
      console.error('[OTP Catcher] List API error:', listResp.status, await listResp.text());
      return;
    }

    const listData = await listResp.json();
    const messages = listData.messages || [];
    console.log(`[OTP Catcher] Found ${messages.length} candidate message(s)`);

    if (messages.length === 0) return;

    // Determine which messages are new (newer than lastMessageId)
    const newMessages = lastMessageId
      ? messages.filter(m => isNewerMessageId(m.id, lastMessageId))
      : [messages[0]]; // First run: only check the most recent

    console.log(`[OTP Catcher] New messages to process: ${newMessages.length}`);

    // Always update lastMessageId to the newest seen, even if no OTP found
    const newestId = messages[0].id;

    if (newMessages.length === 0) {
      console.log('[OTP Catcher] No new messages since last check');
      return;
    }

    // Process from oldest → newest so we show the most recent OTP last
    const sorted = [...newMessages].reverse();

    let foundOTP = false;
    for (const msg of sorted) {
      console.log(`[OTP Catcher] Processing message ID: ${msg.id}`);
      const result = await processMessage(msg.id, token);

      if (result?.code) {
        const { code, from } = result;
        console.log(`[OTP Catcher] ✓ OTP found: ${code} from ${from}`);

        await chrome.storage.local.set({
          lastCode: code,
          lastCodeTime: Date.now(),
          lastCodeFrom: from,
          lastMessageId: newestId,
          lastCodeConsumed: false
        });

        pushCodeToPorts(code, from);
        await sendOTPToActiveTab(code, from);
        clearBurstMode();
        foundOTP = true;
        break;

      } else if (result?.link) {
        const { link, linkText, from } = result;
        console.log(`[OTP Catcher] ✓ Link found: "${linkText}" from ${from}`);

        await chrome.storage.local.set({
          lastLink: link,
          lastLinkText: linkText || '',
          lastLinkTime: Date.now(),
          lastLinkFrom: from,
          lastMessageId: newestId,
          lastLinkConsumed: false
        });

        pushLinkToPorts(link, linkText, from);
        await sendLinkToActiveTab(link, linkText, from);
        clearBurstMode();
        foundOTP = true;
        break;
      }
    }

    if (!foundOTP) {
      // Still advance the cursor so we don't re-process these messages
      await chrome.storage.local.set({ lastMessageId: newestId });
      console.log('[OTP Catcher] No OTP found in new messages');
    }

    // Save current historyId so burst mode can use the lightweight History API
    // instead of a full messages.list scan. One tiny profile call per regular poll.
    try {
      const pResp = await fetch(`${GMAIL_API_BASE}/profile`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (pResp.ok) {
        const p = await pResp.json();
        if (p.historyId) await chrome.storage.local.set({ lastHistoryId: p.historyId });
      }
    } catch (_) {}

  } catch (e) {
    console.error('[OTP Catcher] Unexpected error during poll:', e);
  } finally {
    isChecking = false; // always release the lock so the next interval tick can run
  }
}

// ─── Burst Check (History API) ───────────────────────────────────────────────
// Called during burst mode. Uses gmail.users.history.list which returns ONLY
// the delta since the last known historyId — an empty inbox returns near-zero
// bytes. Far lighter than a full messages.list scan.

async function checkGmailBurst() {
  if (isChecking) return;

  const { lastHistoryId, enabled } = await chrome.storage.local.get(['lastHistoryId', 'enabled']);
  if (enabled === false) return;

  // No historyId yet (first run) — fall back to regular check which will save it
  if (!lastHistoryId) { return checkGmail(); }

  isChecking = true;
  try {
    let token;
    try { token = await getAuthToken(false); } catch (e) { return; }
    if (!token) return;

    const histUrl = `${GMAIL_API_BASE}/history` +
      `?startHistoryId=${lastHistoryId}&historyTypes=messageAdded&labelIds=INBOX`;

    let resp = await fetch(histUrl, { headers: { Authorization: `Bearer ${token}` } });

    if (resp.status === 401) {
      token = await refreshToken(token);
      if (!token) return;
      resp = await fetch(histUrl, { headers: { Authorization: `Bearer ${token}` } });
    }

    // 404 means historyId is too old — fall back to full check
    if (resp.status === 404) {
      console.log('[OTP Catcher] Burst: historyId expired, falling back');
      isChecking = false;
      return checkGmail();
    }

    if (!resp.ok) { console.log('[OTP Catcher] Burst: history API error', resp.status); return; }

    const data = await resp.json();

    // Always advance historyId so next burst starts from here
    if (data.historyId) await chrome.storage.local.set({ lastHistoryId: data.historyId });

    const added = (data.history || [])
      .flatMap(h => h.messagesAdded || [])
      .map(m => m.message);

    if (added.length === 0) { console.log('[OTP Catcher] Burst: no new messages'); return; }

    console.log(`[OTP Catcher] Burst: ${added.length} new message(s) — processing`);

    for (const msg of [...added].reverse()) {
      const result = await processMessage(msg.id, token);
      if (result?.code) {
        const { code, from } = result;
        console.log(`[OTP Catcher] ⚡ Burst found OTP: ${code}`);

        await chrome.storage.local.set({
          lastCode: code,
          lastCodeTime: Date.now(),
          lastCodeFrom: from,
          lastMessageId: msg.id,
          lastCodeConsumed: false
        });

        pushCodeToPorts(code, from);
        await sendOTPToActiveTab(code, from);
        clearBurstMode();
        return;

      } else if (result?.link) {
        const { link, linkText, from } = result;
        console.log(`[OTP Catcher] ⚡ Burst found link: "${linkText}"`);

        await chrome.storage.local.set({
          lastLink: link,
          lastLinkText: linkText || '',
          lastLinkTime: Date.now(),
          lastLinkFrom: from,
          lastMessageId: msg.id,
          lastLinkConsumed: false
        });

        pushLinkToPorts(link, linkText, from);
        await sendLinkToActiveTab(link, linkText, from);
        clearBurstMode();
        return;
      }
    }

  } catch (e) {
    console.error('[OTP Catcher] Burst check error:', e);
  } finally {
    isChecking = false;
  }
}

// Returns true if id1 is a newer Gmail message than id2
// Gmail message IDs are hex strings; larger hex value = newer message
function isNewerMessageId(id1, id2) {
  try {
    return BigInt('0x' + id1) > BigInt('0x' + id2);
  } catch {
    return id1 > id2; // Lexicographic fallback
  }
}

// ─── Message Processing ─────────────────────────────────────────────────────

async function processMessage(messageId, token) {
  try {
    const url = `${GMAIL_API_BASE}/messages/${messageId}?format=full`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!resp.ok) {
      console.log(`[OTP Catcher] Failed to fetch message ${messageId}: ${resp.status}`);
      return null;
    }

    const msg = await resp.json();
    const headers = msg.payload?.headers || [];
    const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
    const from = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';

    console.log(`[OTP Catcher] Email — From: "${from}" | Subject: "${subject}"`);

    // Extract body text
    const body = extractBody(msg.payload);
    console.log(`[OTP Catcher] Body extracted: ${body.length} chars`);

    if (!body) {
      console.log('[OTP Catcher] Could not extract body');
      return null;
    }

    // ── Subject keyword check ──────────────────────────────────────────────
    const subjectKeywords = [
      'otp', 'verification', 'verify', 'code', 'confirm', 'one-time',
      'passcode', 'pin', 'authenticate', 'authentication', 'security',
      'sign-in', 'signin', 'login', '2fa', 'two-factor', 'access',
      // Link-type email subjects
      'reset', 'password', 'magic', 'activate', 'invitation', 'invite',
      'welcome', 'approve', 'validate', 'complete', 'accept'
    ];
    const subjectLower = subject.toLowerCase();
    const subjectHasKeyword = subjectKeywords.some(kw => subjectLower.includes(kw));

    // ── Code extraction (highest priority) ────────────────────────────────
    const code = extractCode(body, subject, subjectHasKeyword);
    if (code) {
      console.log(`[OTP Catcher] ✓ Code extracted: "${code}"`);
      return { code, from };
    }

    // ── Magic link extraction (fallback — emails with links not codes) ────
    // Must run on raw HTML so we can read actual href values
    const rawHtml = extractRawHtml(msg.payload);
    if (rawHtml && subjectHasKeyword) {
      const magicLink = extractMagicLink(rawHtml, subject);
      if (magicLink) {
        console.log(`[OTP Catcher] ✓ Link extracted: "${magicLink.text}" → ${magicLink.url.slice(0, 60)}…`);
        return { link: magicLink.url, linkText: magicLink.text, from };
      }
    }

    console.log('[OTP Catcher] No code or link found in this message');
    return null;

  } catch (e) {
    console.error(`[OTP Catcher] Error processing message ${messageId}:`, e);
    return null;
  }
}

// ─── Smart Code Extraction ──────────────────────────────────────────────────
// Supports: 6-digit numeric, 4-10 digit numeric, mixed-case alphanumeric
// (e.g. Greenhouse "XaQcsGx7"). Uses context-first approach.

function extractCode(body, subject, subjectHasKeyword) {
  // Normalise spaced / hyphenated codes into plain digits so all strategies
  // below work uniformly.
  // "482 910" → "482910"   "482-910" → "482910"   "1234 5678" → "12345678"
  const normalizedBody = body
    .replace(/\b(\d{3,4})[\s\u00a0\-–](\d{3,4})\b/g, '$1$2')
    .replace(/\b(\d{3})[\s\u00a0\-–](\d{3})[\s\u00a0\-–](\d{3})\b/g, '$1$2$3');

  // Trigger phrases that appear near OTP codes in email bodies
  const triggerWord =
    '(?:security[\\s\\-]?code|verification[\\s\\-]?code|' +
    'your[\\s\\-]?code|the[\\s\\-]?code|' +
    'use\\s+this\\s+code|paste\\s+this\\s+code|enter\\s+this\\s+code|' +
    'one[\\s\\-]time[\\s\\-]?(?:password|passcode|code)?|' +
    'passcode|otp\\b|p\\.?i\\.?n\\.?|access[\\s\\-]?code|' +
    'confirm(?:ation)?[\\s\\-]?code|auth(?:entication)?[\\s\\-]?code)';

  // Helper: determines if a string looks like an OTP/security code vs a real word
  function isValidCode(s) {
    if (!s || s.length < 4) return false;

    // ── All-digit: always a code (482910, 7823) ──────────────────────────────
    if (/^\d+$/.test(s)) return true;

    const hasDigit = /[0-9]/.test(s);
    const hasUpper = /[A-Z]/.test(s);
    const hasLower = /[a-z]/.test(s);

    // ── Digit + letters (XaQcsGx7) ───────────────────────────────────────────
    if (hasDigit) {
      // Reject ordinals and CSS units: 18th, 11th, 1st, 10px, 2em, etc.
      if (/^\d+(st|nd|rd|th|px|em|rem|vh|vw|pt|cm|mm|km|kg|mg|ml|gb|mb|kb|am|pm)$/i.test(s)) return false;
      const unitBlocked = new Set(['h1','h2','h3','h4','h5','h6','co2','mp3','mp4','no1','2fa','3rd']);
      if (unitBlocked.has(s.toLowerCase())) return false;
      return true;
    }

    // ── Pure letters, mixed case (mTjzdPVi, XaQcsGx) ────────────────────────
    // Greenhouse sends codes with no digits — just random mixed-case letters.
    // Key distinction: real English words and brand names are either all-lowercase,
    // normally-capitalised (Hello), or CamelCase (RealPage, LinkedIn, PayPal).
    // True random codes have 3+ uppercase letters scattered non-uniformly.
    if (hasUpper && hasLower) {
      // Reject "normally capitalised" words: Hello, After, Enter, Rakshith
      if (/^[A-Z][a-z]+$/.test(s)) return false;
      // Reject CamelCase brand names: RealPage → R+P=2, LinkedIn → L+I=2
      // Real random codes (mTjzdPVi, XaQcsGx) always have 3+ uppercase letters
      const upperCount = (s.match(/[A-Z]/g) || []).length;
      if (upperCount < 3) return false;
      // Reject common words
      const commonWords = new Set([
        'after','before','enter','click','please','thank','hello',
        'copy','paste','code','from','with','your','this','that',
        'have','will','when','what','here','there','about','email',
        'send','submit','apply','verify','confirm','resend','resubmit'
      ]);
      if (commonWords.has(s.toLowerCase())) return false;
      // 3+ scattered uppercase letters → code-like ✓
      return true;
    }

    // ── All-uppercase, 5+ chars (ABCDEF) — could be a PIN/code ──────────────
    if (hasUpper && !hasLower && s.length >= 5) return true;

    // ── All-lowercase → plain English word → reject ──────────────────────────
    return false;
  }

  // ── Strategy 1a: keyword immediately before code ──────────────────────────
  // Matches: "Your code: 482910"  "OTP — XaQ7"  "Security Code: XaQcsGx7"
  const s1a = new RegExp(
    triggerWord + '\\s*(?:is\\s*)?[:\\-–—]?\\s*([A-Za-z0-9]{4,12})\\b',
    'gi'
  );
  let m = s1a.exec(normalizedBody);
  if (m && isValidCode(m[1])) { console.log('[OTP Catcher] S1a:', m[1]); return m[1]; }

  // ── Strategy 1b: keyword + up to 120 chars + colon + code ────────────────
  // Matches Greenhouse: "security code field on your application: XaQcsGx7"
  const s1b = new RegExp(
    triggerWord + '[^\\n\\r]{0,120}[:\\-–—]\\s*([A-Za-z0-9]{4,12})\\b',
    'gi'
  );
  m = s1b.exec(normalizedBody);
  if (m && isValidCode(m[1])) { console.log('[OTP Catcher] S1b:', m[1]); return m[1]; }

  // ── Strategy 2: code appears BEFORE keyword phrase ────────────────────────
  // Matches: "XaQcsGx7 is your security code"
  const s2 = new RegExp(
    '\\b([A-Za-z0-9]{4,12})\\b\\s+is\\s+your\\s+' + triggerWord,
    'gi'
  );
  m = s2.exec(normalizedBody);
  if (m && isValidCode(m[1])) { console.log('[OTP Catcher] S2:', m[1]); return m[1]; }

  // ── Strategy 3: code on its own line right after a keyword line ───────────
  const s3 = new RegExp(
    triggerWord + '[^\\n]*[\\r\\n]+\\s*([A-Za-z0-9]{4,12})\\s*[\\r\\n]',
    'gi'
  );
  m = s3.exec(normalizedBody);
  if (m && isValidCode(m[1])) { console.log('[OTP Catcher] S3:', m[1]); return m[1]; }

  // ── Strategy 4a: classic standalone 6-digit number ───────────────────────
  // Run BEFORE mixed-alphanum so numeric OTPs (Oracle, JPMorgan) are caught
  // cleanly without scanning noisy URL/tracking tokens in the email body.
  const s4a = normalizedBody.match(/\b(\d{6})\b/g);
  if (s4a) { console.log('[OTP Catcher] S4a (6-digit):', s4a[0]); return s4a[0]; }

  // ── Strategy 4b: 8-digit codes (banking, government, enterprise portals) ──
  const s4b = normalizedBody.match(/\b(\d{8})\b/g);
  if (s4b) { console.log('[OTP Catcher] S4b (8-digit):', s4b[0]); return s4b[0]; }

  // ── Strategy 5: mixed-case code — letters+digits OR pure mixed-case letters ─
  // Handles: XaQcsGx7 (has digit) AND mTjzdPVi (no digit, random mixed case).
  // Strip URLs first — tracking tokens in links look code-like and must be excluded.
  if (subjectHasKeyword) {
    const bodyNoUrls = normalizedBody
      .replace(/https?:\/\/[^\s]+/gi, ' ')
      .replace(/www\.[^\s]+/gi, ' ');
    const tokenRe = /\b([A-Za-z0-9]{4,12})\b/g;
    let tok;
    while ((tok = tokenRe.exec(bodyNoUrls)) !== null) {
      const t = tok[1];
      if (/[A-Za-z]/.test(t) && isValidCode(t)) {
        console.log('[OTP Catcher] S5 (mixed code):', t);
        return t;
      }
    }
  }

  // ── Strategy 6: 4–8 digit number in an email with OTP subject keywords ───
  if (subjectHasKeyword) {
    const digits = (normalizedBody.match(/\b(\d{4,8})\b/g) || []).filter(d => {
      const n = parseInt(d, 10);
      return !(n >= 1900 && n <= 2030);
    });
    if (digits.length > 0) {
      console.log('[OTP Catcher] S6 (4-8 digit):', digits[0]);
      return digits[0];
    }
  }

  return null;
}

// ─── Magic Link Extraction ──────────────────────────────────────────────────
// Detects verification / password-reset / magic-sign-in links from raw HTML.
// Called BEFORE html stripping so we can read actual <a href> values.

function extractRawHtml(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    for (const part of payload.parts) {
      const r = extractRawHtml(part);
      if (r) return r;
    }
  }
  return '';
}

function extractMagicLink(html, subject) {
  if (!html) return null;

  // Keywords in anchor text that signal an action link
  const textKw = [
    'verify', 'confirm', 'reset', 'password', 'sign in', 'log in', 'login',
    'magic', 'activate', 'accept', 'validate', 'authenticate', 'complete',
    'get started', 'click here', 'open', 'access', 'secure link', 'continue',
    'join', 'invitation', 'approve', 'authorise', 'authorize'
  ];

  // URL path/param patterns that strongly suggest an action link
  const urlKw = [
    '/verify', '/confirm', '/reset', '/activate', '/auth', '/magic',
    '/validate', '/secure', '/invite', '/accept', '/approve', '/login',
    '/signin', '/signup/confirm', '/register/confirm', '/change-password',
    'token=', 'magic=', 'key=', 'secret=', 'otp=', 'code=', 'link='
  ];

  // Links we never want to surface
  const blocklist = ['unsubscribe', 'optout', 'opt-out', 'mailto:', 'privacy',
                     'terms', 'help', 'support', 'twitter.com', 'facebook.com',
                     'linkedin.com', 'instagram.com', 'youtube.com'];

  const anchorRe = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const candidates = [];
  let m;

  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1].trim();
    const rawText = m[2].replace(/<[^>]+>/g, '').trim();

    if (!href.startsWith('http')) continue;
    if (rawText.length < 2 || rawText.length > 100) continue;
    if (blocklist.some(b => href.toLowerCase().includes(b))) continue;

    const tl = rawText.toLowerCase();
    const hl = href.toLowerCase();

    let score = 0;
    if (textKw.some(k => tl.includes(k))) score += 3;
    if (urlKw.some(k => hl.includes(k)))  score += 3;
    if (href.length > 80) score += 1; // longer url = likely has a token

    if (score >= 3) candidates.push({ url: href, text: rawText, score });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || b.url.length - a.url.length);
  return candidates[0];
}

// ─── Body Extraction ────────────────────────────────────────────────────────

function extractBody(payload) {
  if (!payload) return '';

  // Non-multipart: body is directly on payload
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  if (payload.parts) {
    // Prefer text/plain for clean OTP extraction
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }

    // Fall back to text/html (strip tags)
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = decodeBase64Url(part.body.data);
        return stripHtml(html);
      }
    }

    // Recurse into nested multipart parts
    for (const part of payload.parts) {
      const result = extractBody(part);
      if (result) return result;
    }
  }

  return '';
}

function decodeBase64Url(data) {
  try {
    const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
  } catch (e) {
    console.error('[OTP Catcher] Base64 decode error:', e);
    return '';
  }
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    // Block elements → newline so code on its own line stays detectable
    .replace(/<\/?(p|div|tr|li|br|h[1-6]|blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')       // remaining tags → space
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#160;/g, ' ')
    .replace(/[ \t]+/g, ' ')        // collapse spaces (but keep newlines)
    .replace(/\n[ \t]+/g, '\n')     // trim leading spaces from lines
    .replace(/\n{3,}/g, '\n\n')     // max 2 consecutive newlines
    .trim();
}

// ─── Send OTP to Active Tab ──────────────────────────────────────────────────

async function sendOTPToActiveTab(code, from) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      console.log('[OTP Catcher] No active tab found');
      return;
    }

    // Cannot inject into chrome://, devtools, or extension pages
    const restricted = !tab.url ||
      tab.url.startsWith('chrome://') ||
      tab.url.startsWith('chrome-extension://') ||
      tab.url.startsWith('devtools://') ||
      tab.url.startsWith('about:');

    if (restricted) {
      console.log('[OTP Catcher] Active tab is restricted, cannot inject:', tab.url);
      return;
    }

    console.log(`[OTP Catcher] Sending OTP to tab ${tab.id}: ${tab.url}`);

    try {
      // Content script injected via manifest should already be present
      await chrome.tabs.sendMessage(tab.id, { type: 'NEW_OTP', code, from });
      console.log('[OTP Catcher] Message sent to content script successfully');
    } catch (e) {
      // Content script may not be ready — inject it manually
      console.log('[OTP Catcher] Content script not ready, injecting manually...');
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ['styles.css']
        });
        // Brief pause for script initialization
        await new Promise(r => setTimeout(r, 150));
        await chrome.tabs.sendMessage(tab.id, { type: 'NEW_OTP', code, from });
        console.log('[OTP Catcher] Injected and sent successfully');
      } catch (e2) {
        console.error('[OTP Catcher] Failed to inject content script:', e2.message);
      }
    }
  } catch (e) {
    console.error('[OTP Catcher] Error sending OTP to tab:', e);
  }
}

async function sendLinkToActiveTab(link, linkText, from) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const restricted = !tab.url ||
      tab.url.startsWith('chrome://') ||
      tab.url.startsWith('chrome-extension://') ||
      tab.url.startsWith('devtools://') ||
      tab.url.startsWith('about:');
    if (restricted) return;

    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'NEW_LINK', link, linkText, from });
    } catch (e) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['styles.css'] });
        await new Promise(r => setTimeout(r, 150));
        await chrome.tabs.sendMessage(tab.id, { type: 'NEW_LINK', link, linkText, from });
      } catch (e2) {
        console.error('[OTP Catcher] Failed to send link to tab:', e2.message);
      }
    }
  } catch (e) {
    console.error('[OTP Catcher] Error sending link to tab:', e);
  }
}

// ─── Messages from Popup ────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[OTP Catcher] Background received:', message.type);

  // Content script heartbeat — fires every 4 seconds from every foreground tab.
  // Dual purpose:
  //  1. Return any freshly-detected code so the overlay appears immediately
  //  2. Use the ping to drive Gmail polling every 10 seconds — this keeps
  //     the service worker alive and checks Gmail without needing alarms.
  if (message.type === 'GET_RECENT_CODE') {
    chrome.storage.local.get(
      ['lastCode', 'lastCodeTime', 'lastCodeFrom', 'lastCodeConsumed',
       'lastLink', 'lastLinkText', 'lastLinkTime', 'lastLinkFrom', 'lastLinkConsumed', 'enabled'],
      (data) => {
        const FRESH_WINDOW = 45 * 1000;
        const codeAge = Date.now() - (data.lastCodeTime || 0);
        const freshCode = data.lastCode && codeAge < FRESH_WINDOW && !data.lastCodeConsumed && data.enabled !== false;

        if (freshCode) {
          sendResponse({ code: data.lastCode, from: data.lastCodeFrom || '' });
        } else {
          const linkAge = Date.now() - (data.lastLinkTime || 0);
          const freshLink = data.lastLink && linkAge < FRESH_WINDOW && !data.lastLinkConsumed && data.enabled !== false;
          sendResponse(freshLink
            ? { link: data.lastLink, linkText: data.lastLinkText || '', from: data.lastLinkFrom || '' }
            : null);
        }

        const now = Date.now();
        if (now - lastPollTime > 10000) {
          lastPollTime = now;
          console.log('[OTP Catcher] Heartbeat-driven Gmail check');
          checkGmail();
        }
      }
    );
    return true;
  }

  if (message.type === 'GET_STATUS') {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      const authenticated = !!(token && !chrome.runtime.lastError);
      chrome.storage.local.get(
        ['lastCode', 'lastCodeTime', 'lastCodeFrom', 'enabled'],
        (data) => {
          sendResponse({
            authenticated,
            lastCode: data.lastCode || null,
            lastCodeTime: data.lastCodeTime || null,
            lastCodeFrom: data.lastCodeFrom || null,
            enabled: data.enabled !== false // Default true
          });
        }
      );
    });
    return true; // Keep channel open for async response
  }

  if (message.type === 'SIGN_IN') {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError || !token) {
        sendResponse({
          success: false,
          error: chrome.runtime.lastError?.message || 'Authentication failed'
        });
      } else {
        setupAlarm();
        checkGmail(); // Immediate check after sign-in
        sendResponse({ success: true });
      }
    });
    return true;
  }

  if (message.type === 'RESET_CURSOR') {
    chrome.storage.local.remove('lastMessageId', () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'SIGN_OUT') {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      const cleanup = () => {
        chrome.storage.local.clear(() => sendResponse({ success: true }));
      };
      if (token && !chrome.runtime.lastError) {
        chrome.identity.removeCachedAuthToken({ token }, cleanup);
      } else {
        cleanup();
      }
    });
    return true;
  }

  if (message.type === 'TOGGLE_ENABLED') {
    chrome.storage.local.set({ enabled: message.enabled }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'BURST_MODE') {
    enterBurstMode();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'CONSUME_CODE') {
    chrome.storage.local.set({ lastCodeConsumed: true }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'CONSUME_LINK') {
    chrome.storage.local.set({ lastLinkConsumed: true }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'CHECK_NOW') {
    // Clear the cursor so we always do a fresh scan of today's emails
    chrome.storage.local.remove('lastMessageId', () => {
      checkGmail();
    });
    sendResponse({ success: true });
    return true;
  }
});
