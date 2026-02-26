// Gmail OTP Catcher — Content Script
// Listens for OTP messages from background and displays a floating overlay

(function () {
  'use strict';

  const OVERLAY_ID = 'gmail-otp-catcher-overlay';
  let dismissTimer = null;

  // ─── Persistent port connection ──────────────────────────────────────────
  // Opens a long-lived port to the background service worker.
  // While this port is open Chrome CANNOT put the service worker to sleep,
  // so the background can run a reliable setInterval to poll Gmail every
  // 10 seconds. When a code is found it is pushed back through this same
  // port — the overlay appears on THIS page instantly with no tab switching.

  let lastShownCode = null;
  let lastShownLink = null;
  let port = null;

  function connectPort() {
    // If the extension was reloaded, the context is gone — stop trying
    if (!chrome.runtime?.id) return;

    try {
      port = chrome.runtime.connect({ name: 'otp-heartbeat' });

      // Background pushes code/link through the port the moment it's detected
      port.onMessage.addListener((msg) => {
        if (msg.type === 'CODE_UPDATE' && msg.code && msg.code !== lastShownCode) {
          lastShownCode = msg.code;
          console.log('[OTP Catcher] ← Port received code:', msg.code);
          showOverlay(msg.code, msg.from || '');
        }
        if (msg.type === 'LINK_UPDATE' && msg.link && msg.link !== lastShownLink) {
          lastShownLink = msg.link;
          console.log('[OTP Catcher] ← Port received link:', msg.link.slice(0, 60));
          showLinkOverlay(msg.link, msg.linkText || '', msg.from || '');
        }
      });

      // If the port drops (extension reloaded), only reconnect if context is still valid
      port.onDisconnect.addListener(() => {
        port = null;
        if (!chrome.runtime?.id) return; // extension reloaded — stop
        console.log('[OTP Catcher] Port disconnected — reconnecting in 3s');
        setTimeout(connectPort, 3000);
      });

      console.log('[OTP Catcher] Port connected to background');
    } catch (e) {
      if (!chrome.runtime?.id) return; // extension reloaded — stop
      console.log('[OTP Catcher] Port connect failed, retrying in 5s:', e.message);
      setTimeout(connectPort, 5000);
    }
  }

  connectPort();

  // ─── Burst mode triggers ──────────────────────────────────────────────────
  // Tell background to enter burst mode (fast History API checks every 2s)
  // so the code appears in 1-4 seconds instead of up to 10.

  function triggerBurst() {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage({ type: 'BURST_MODE' }, () => {
      if (chrome.runtime.lastError) {}
    });
  }

  // Trigger 1: OTP input already visible on this page when it loads
  if (findOTPField()) triggerBurst();

  // Trigger 2: URL/title signals a verification page — fires burst even on
  // "Check your email" pages that have no OTP input field yet
  const hrefLower = location.href.toLowerCase();
  const verifyUrlKw = ['verify', 'confirm', 'reset', 'change-password', 'check-email',
                       'token=', 'magic=', 'activate', '/auth/', 'otp', 'code='];
  if (verifyUrlKw.some(k => hrefLower.includes(k))) triggerBurst();

  // Trigger 3: Any form submission — OTP email is very likely incoming
  document.addEventListener('submit', () => triggerBurst(), true);

  // Trigger 4: Buttons whose text explicitly signals an OTP will be sent
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button, [type="submit"], [role="button"]');
    if (!btn) return;
    const text = (btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase();
    const otpPhrases = ['send code', 'send otp', 'send verification', 'get code',
                        'request code', 'resend', 'resend code', 'send me a code',
                        'send a code', 'get otp', 'email me a code'];
    if (otpPhrases.some(p => text.includes(p))) triggerBurst();
  }, true);

  // ─── Navigate-away consume ────────────────────────────────────────────────
  // If the overlay is visible when the user navigates away, mark it consumed
  // immediately. Without this, a code shown on page A re-appears on page B,
  // page C, etc. until the 45s window expires.
  window.addEventListener('pagehide', () => {
    if (!document.getElementById(OVERLAY_ID)) return;
    consumeCode();
    consumeLink();
  });

  // ─── Backup: one-off message push from background ────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'NEW_OTP') {
      if (message.code !== lastShownCode) {
        lastShownCode = message.code;
        showOverlay(message.code, message.from || '');
      }
      sendResponse({ received: true });
    }
    if (message.type === 'NEW_LINK') {
      if (message.link !== lastShownLink) {
        lastShownLink = message.link;
        showLinkOverlay(message.link, message.linkText || '', message.from || '');
      }
      sendResponse({ received: true });
    }
  });

  // ─── Backup: pull on tab focus (visibilitychange) ─────────────────────────

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    chrome.runtime.sendMessage({ type: 'GET_RECENT_CODE' }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp?.code && resp.code !== lastShownCode) {
        lastShownCode = resp.code;
        showOverlay(resp.code, resp.from || '');
      } else if (resp?.link && resp.link !== lastShownLink) {
        lastShownLink = resp.link;
        showLinkOverlay(resp.link, resp.linkText || '', resp.from || '');
      }
    });
  });

  // ─── Overlay ─────────────────────────────────────────────────────────────

  function showOverlay(code, from) {
    // Remove any existing overlay (update instead of duplicate)
    const existing = document.getElementById(OVERLAY_ID);
    if (existing) {
      existing.remove();
      clearTimeout(dismissTimer);
    }

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('aria-live', 'assertive');
    overlay.setAttribute('role', 'alert');

    const senderLine = from ? `<div class="otp-from">${formatSender(from)}</div>` : '';

    // Adjust font size for longer codes
    const codeLen = code.length;
    const codeFontSize = codeLen <= 6 ? '30px' : codeLen <= 8 ? '24px' : '18px';
    const codeSpacing = codeLen <= 6 ? '5px' : codeLen <= 8 ? '3px' : '2px';

    overlay.innerHTML = `
      <div class="otp-card">
        <div class="otp-header">
          <div class="otp-label-wrap">
            <span class="otp-pulse"></span>
            <span class="otp-label">Code Detected</span>
          </div>
          <button class="otp-close" aria-label="Dismiss overlay" title="Dismiss">✕</button>
        </div>
        <div class="otp-body">
          <span class="otp-code" id="otp-code-display"
            style="font-size:${codeFontSize};letter-spacing:${codeSpacing}">${code}</span>
          <div class="otp-btn-group">
            <button class="otp-fill" aria-label="Fill code into page" title="Auto-fill into field">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2.5"
                   stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 20h9"></path>
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
              </svg>
            </button>
            <button class="otp-copy" aria-label="Copy code" title="Copy to clipboard">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2.5"
                   stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
          </div>
        </div>
        <div class="otp-footer">
          ${senderLine}
          <span class="otp-status-msg" id="otp-status-msg"></span>
        </div>
        <div class="otp-timer-bar">
          <div class="otp-timer-fill" id="otp-timer-fill"></div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    makeDraggable(overlay);

    // Animate in (next frame to trigger CSS transition)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        overlay.classList.add('otp-visible');
      });
    });

    // Wire up buttons
    overlay.querySelector('.otp-close').addEventListener('click', () => {
      consumeCode(); // explicit dismiss = consumed
      dismissOverlay(overlay);
    });

    overlay.querySelector('.otp-fill').addEventListener('click', () => {
      const field = findOTPField();
      if (field) {
        fillField(field, code);
        showFillFeedback(overlay);
      } else {
        copyCode(code, overlay);
      }
      consumeCode();
      clearTimeout(dismissTimer);
      dismissTimer = setTimeout(() => {
        const el = document.getElementById(OVERLAY_ID);
        if (el) dismissOverlay(el);
      }, 2000);
    });

    overlay.querySelector('.otp-copy').addEventListener('click', () => {
      copyCode(code, overlay);
      consumeCode();
      clearTimeout(dismissTimer);
      dismissTimer = setTimeout(() => {
        const el = document.getElementById(OVERLAY_ID);
        if (el) dismissOverlay(el);
      }, 3000);
    });

    // Auto-dismiss countdown (30 seconds) — also marks consumed so it
    // never re-appears on page navigation or other tabs
    startCountdown(overlay, 30000, consumeCode);
  }

  function dismissOverlay(overlay) {
    clearTimeout(dismissTimer);
    overlay.classList.remove('otp-visible');
    overlay.classList.add('otp-fade-out');
    setTimeout(() => {
      if (overlay.parentNode) overlay.remove();
    }, 300);
  }

  function startCountdown(overlay, duration, onConsume) {
    const fill = overlay.querySelector('#otp-timer-fill');
    const startTime = Date.now();

    const tick = () => {
      const elapsed = Date.now() - startTime;
      const pct = Math.max(0, 1 - elapsed / duration);
      if (fill) fill.style.width = `${pct * 100}%`;
      if (elapsed < duration && document.getElementById(OVERLAY_ID)) {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);

    dismissTimer = setTimeout(() => {
      const el = document.getElementById(OVERLAY_ID);
      if (el) {
        if (onConsume) onConsume();
        dismissOverlay(el);
      }
    }, duration);
  }

  // ─── Copy ────────────────────────────────────────────────────────────────

  function copyCode(code, overlay) {
    navigator.clipboard.writeText(code).then(() => {
      showCopiedFeedback(overlay);
    }).catch(() => {
      // Fallback: select the code text
      const codeEl = overlay.querySelector('#otp-code-display');
      if (codeEl) {
        const range = document.createRange();
        range.selectNodeContents(codeEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      showCopiedFeedback(overlay);
    });
  }

  function showCopiedFeedback(overlay) {
    const msg = overlay.querySelector('#otp-status-msg');
    const btn = overlay.querySelector('.otp-copy');
    if (msg) { msg.textContent = '✓ Copied!'; msg.classList.add('otp-status-visible'); }
    if (btn) btn.classList.add('otp-copy-done');
    setTimeout(() => {
      if (msg) msg.classList.remove('otp-status-visible');
      if (btn) btn.classList.remove('otp-copy-done');
    }, 2000);
  }

  // ─── Drag ────────────────────────────────────────────────────────────────

  function makeDraggable(overlay) {
    let dragging = false;
    let startX, startY, origRight, origBottom;

    const card = overlay.querySelector('.otp-card');

    card.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return; // Don't intercept button clicks
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = overlay.getBoundingClientRect();
      origRight = window.innerWidth - rect.right;
      origBottom = window.innerHeight - rect.bottom;
      overlay.classList.add('otp-dragging');
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = startX - e.clientX;
      const dy = startY - e.clientY;
      const newRight = Math.max(8, Math.min(window.innerWidth - 260, origRight + dx));
      const newBottom = Math.max(8, Math.min(window.innerHeight - 120, origBottom + dy));
      overlay.style.right = `${newRight}px`;
      overlay.style.bottom = `${newBottom}px`;
    });

    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        overlay.classList.remove('otp-dragging');
      }
    });
  }

  // ─── Auto-fill ───────────────────────────────────────────────────────────

  function findOTPField() {
    // Priority 0: Split OTP — multiple maxlength="1" inputs (Oracle, Workday, iCIMS…)
    // Must check this FIRST — otherwise we'd grab just one of the boxes and fail
    const singles = Array.from(document.querySelectorAll('input[maxlength="1"]'))
      .filter(isVisibleInput);
    if (singles.length >= 4 && singles.length <= 8) return singles; // array signals split

    // Priority 1: Standard HTML autocomplete attribute — most reliable single-input signal
    const byAutocomplete = document.querySelector('input[autocomplete="one-time-code"]');
    if (byAutocomplete && isVisibleInput(byAutocomplete)) return byAutocomplete;

    // Priority 2: name / id / placeholder / aria-label contains OTP keywords
    const keywords = ['otp','one-time','onetime','verification','verify',
                      'token','passcode','pin','code','auth','2fa','mfa','access'];
    for (const kw of keywords) {
      const el = document.querySelector(
        `input[name*="${kw}" i], input[id*="${kw}" i], ` +
        `input[placeholder*="${kw}" i], input[aria-label*="${kw}" i]`
      );
      if (el && isVisibleInput(el)) return el;
    }

    // Priority 3: tel / number / numeric input with short maxlength (4–8)
    for (const sel of ['input[type="tel"]','input[type="number"]','input[inputmode="numeric"]']) {
      for (const el of document.querySelectorAll(sel)) {
        const ml = parseInt(el.getAttribute('maxlength') || '0', 10);
        if (ml >= 4 && ml <= 8 && isVisibleInput(el)) return el;
      }
    }

    // Priority 4: text input with short maxlength
    for (const el of document.querySelectorAll('input[type="text"], input:not([type])')) {
      const ml = parseInt(el.getAttribute('maxlength') || '0', 10);
      if (ml >= 4 && ml <= 8 && isVisibleInput(el)) return el;
    }

    return null;
  }

  function isVisibleInput(el) {
    if (!el || el.disabled || el.readOnly) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && el.offsetParent !== null;
  }

  // Native value setter — works with React / Vue / Angular synthetic events
  const _nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  ).set;

  function fillField(fieldOrFields, code) {
    if (Array.isArray(fieldOrFields)) {
      // ── Split inputs (Oracle-style: one box per digit) ──────────────────
      // Fill asynchronously — each box may only become enabled AFTER the
      // previous one is filled. Synchronous fill skips disabled boxes.
      fillSplitAsync(fieldOrFields, code.split(''), 0);
    } else {
      // ── Single input (Western Alliance, Greenhouse-style) ───────────────
      fieldOrFields.focus();
      _nativeSetter.call(fieldOrFields, code);
      fieldOrFields.dispatchEvent(new Event('input', { bubbles: true }));
      fieldOrFields.dispatchEvent(new Event('change', { bubbles: true }));
      console.log('[OTP Catcher] Auto-filled single field:', fieldOrFields.name || fieldOrFields.id || fieldOrFields.type);
    }
  }

  function fillSplitAsync(fields, chars, i) {
    if (i >= chars.length || i >= fields.length) {
      console.log('[OTP Catcher] Auto-filled split inputs:', i, 'boxes');
      return;
    }

    const input = fields[i];

    // If this box is still disabled (waiting for previous box to enable it),
    // retry after a short wait — up to 10 times (500ms max per box)
    if (!input || input.disabled || input.readOnly) {
      const retries = (input._otpRetries = (input._otpRetries || 0) + 1);
      if (retries <= 10) {
        setTimeout(() => fillSplitAsync(fields, chars, i), 50);
      }
      return;
    }

    input._otpRetries = 0;
    input.focus();

    // Fire full key event sequence — some frameworks (Oracle JET) listen to
    // keydown/keypress rather than input events
    const key = chars[i];
    const keyCode = key.charCodeAt(0);
    _nativeSetter.call(input, key);
    input.dispatchEvent(new KeyboardEvent('keydown',  { bubbles: true, cancelable: true, key, keyCode }));
    input.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, cancelable: true, key, keyCode }));
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup',    { bubbles: true, key, keyCode }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // 60ms gap — gives the framework time to validate and enable the next box
    setTimeout(() => fillSplitAsync(fields, chars, i + 1), 60);
  }

  function attemptAutoFill(code, overlay) {
    // Small delay — some pages render the OTP input after a brief animation
    setTimeout(() => {
      const field = findOTPField();
      if (!field) return; // no detectable field — overlay stays, Fill button is there
      fillField(field, code);
      showFillFeedback(overlay);
      consumeCode(); // auto-filled = job done, never show again
      clearTimeout(dismissTimer);
      dismissTimer = setTimeout(() => {
        const el = document.getElementById(OVERLAY_ID);
        if (el) dismissOverlay(el);
      }, 2000);
    }, 400);
  }

  function consumeCode() {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage({ type: 'CONSUME_CODE' }, () => {
      if (chrome.runtime.lastError) {} // ignore — background may be restarting
    });
  }

  function showFillFeedback(overlay) {
    const msg = overlay.querySelector('#otp-status-msg');
    const btn = overlay.querySelector('.otp-fill');
    if (msg) { msg.textContent = '⚡ Auto-filled!'; msg.classList.add('otp-status-visible'); }
    if (btn) btn.classList.add('otp-fill-done');
  }

  // ─── Magic Link Overlay ───────────────────────────────────────────────────

  function consumeLink() {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage({ type: 'CONSUME_LINK' }, () => {
      if (chrome.runtime.lastError) {}
    });
  }

  function showLinkOverlay(url, linkText, from) {
    const existing = document.getElementById(OVERLAY_ID);
    if (existing) {
      existing.remove();
      clearTimeout(dismissTimer);
    }

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('aria-live', 'assertive');
    overlay.setAttribute('role', 'alert');

    const senderLine = from ? `<div class="otp-from">${formatSender(from)}</div>` : '';
    const displayText = linkText || 'Open link';

    overlay.innerHTML = `
      <div class="otp-card">
        <div class="otp-header">
          <div class="otp-label-wrap">
            <span class="otp-pulse"></span>
            <span class="otp-label">Link Detected</span>
          </div>
          <button class="otp-close" aria-label="Dismiss overlay" title="Dismiss">✕</button>
        </div>
        <div class="otp-link-body">
          <span class="otp-link-text">${displayText}</span>
          <button class="otp-open-link" aria-label="Open link" title="Open in new tab">
            Open
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2.5"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
              <polyline points="15 3 21 3 21 9"></polyline>
              <line x1="10" y1="14" x2="21" y2="3"></line>
            </svg>
          </button>
        </div>
        <div class="otp-footer">
          ${senderLine}
          <span class="otp-status-msg" id="otp-status-msg"></span>
        </div>
        <div class="otp-timer-bar">
          <div class="otp-timer-fill" id="otp-timer-fill"></div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    makeDraggable(overlay);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        overlay.classList.add('otp-visible');
      });
    });

    overlay.querySelector('.otp-close').addEventListener('click', () => {
      consumeLink();
      dismissOverlay(overlay);
    });

    overlay.querySelector('.otp-open-link').addEventListener('click', () => {
      window.open(url, '_blank', 'noopener,noreferrer');
      const btn = overlay.querySelector('.otp-open-link');
      if (btn) btn.classList.add('otp-open-done');
      const msg = overlay.querySelector('#otp-status-msg');
      if (msg) { msg.textContent = '✓ Opened!'; msg.classList.add('otp-status-visible'); }
      consumeLink();
      clearTimeout(dismissTimer);
      dismissTimer = setTimeout(() => {
        const el = document.getElementById(OVERLAY_ID);
        if (el) dismissOverlay(el);
      }, 2000);
    });

    startCountdown(overlay, 30000, consumeLink);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function formatSender(from) {
    if (!from) return '';
    const nameMatch = from.match(/^([^<]+)</);
    const emailMatch = from.match(/<([^>]+)>/);
    if (emailMatch) {
      const email = emailMatch[1];
      const name = nameMatch ? nameMatch[1].trim() : '';
      return name ? `${name}` : email;
    }
    return from.length > 32 ? from.slice(0, 32) + '…' : from;
  }
})();
