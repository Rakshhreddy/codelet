// Gmail OTP Catcher — Popup Script

document.addEventListener('DOMContentLoaded', async () => {
  const authSection    = document.getElementById('auth-section');
  const mainSection    = document.getElementById('main-section');
  const signInBtn      = document.getElementById('sign-in-btn');
  const signOutBtn     = document.getElementById('sign-out-btn');
  const checkNowBtn    = document.getElementById('check-now-btn');
  const enabledToggle  = document.getElementById('enabled-toggle');
  const statusDot      = document.getElementById('status-dot');
  const statusText     = document.getElementById('status-text');
  const lastCodeDiv    = document.getElementById('last-code-display');

  // Initial load
  await refreshStatus();

  // ── Sign In ────────────────────────────────────────────────────────────
  signInBtn.addEventListener('click', async () => {
    signInBtn.disabled = true;
    signInBtn.textContent = 'Signing in…';

    const res = await sendMessage({ type: 'SIGN_IN' });

    if (res?.success) {
      await refreshStatus();
    } else {
      signInBtn.disabled = false;
      signInBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="white" aria-hidden="true">
          <path d="M12.545 10.239v3.821h5.445c-.712 2.315-2.647 3.972-5.445
            3.972-3.332 0-6.033-2.701-6.033-6.032s2.701-6.032 6.033-6.032c1.498
            0 2.866.549 3.921 1.453l2.814-2.814C17.503 2.988 15.139 2 12.545
            2 7.021 2 2.543 6.477 2.543 12s4.478 10 10.002
            10c8.396 0 10.249-7.85 9.426-11.748L12.545 10.239z"/>
        </svg>
        Sign in with Google`;
      alert('Sign-in failed: ' + (res?.error || 'Unknown error. Make sure your Client ID is set in manifest.json.'));
    }
  });

  // ── Sign Out ───────────────────────────────────────────────────────────
  signOutBtn.addEventListener('click', async () => {
    if (!confirm('Sign out of Codelet?')) return;
    signOutBtn.disabled = true;
    await sendMessage({ type: 'SIGN_OUT' });
    await refreshStatus();
    signOutBtn.disabled = false;
  });

  // ── Check Now ──────────────────────────────────────────────────────────
  checkNowBtn.addEventListener('click', async () => {
    checkNowBtn.disabled = true;
    checkNowBtn.textContent = 'Checking…';
    await sendMessage({ type: 'CHECK_NOW' });
    // Give background 2s to poll and update storage, then refresh
    await delay(2500);
    await refreshStatus();
    checkNowBtn.textContent = '↻  Check Gmail Now';
    checkNowBtn.disabled = false;
  });

  // ── Toggle ─────────────────────────────────────────────────────────────
  enabledToggle.addEventListener('change', async () => {
    await sendMessage({ type: 'TOGGLE_ENABLED', enabled: enabledToggle.checked });
  });

  // ── Refresh UI ─────────────────────────────────────────────────────────
  async function refreshStatus() {
    try {
      const status = await sendMessage({ type: 'GET_STATUS' });

      if (!status || !status.authenticated) {
        showAuthSection();
        return;
      }

      showMainSection(status);
    } catch (e) {
      console.error('[OTP Popup] Error refreshing status:', e);
      showAuthSection();
    }
  }

  function showAuthSection() {
    authSection.style.display = 'block';
    mainSection.style.display = 'none';
  }

  function showMainSection(status) {
    authSection.style.display = 'none';
    mainSection.style.display = 'block';

    statusDot.className = 'status-dot connected';
    statusText.textContent = 'Connected to Gmail';
    enabledToggle.checked = status.enabled !== false;

    if (status.lastCode) {
      const timeAgo = formatTimeAgo(status.lastCodeTime);
      const fromLine = status.lastCodeFrom
        ? `<div class="code-meta">from: ${escapeHtml(friendlyFrom(status.lastCodeFrom))}</div>`
        : '';

      lastCodeDiv.innerHTML = `
        <div class="code-value">${escapeHtml(status.lastCode)}</div>
        <div class="code-meta">${timeAgo}</div>
        ${fromLine}
      `;
    } else {
      lastCodeDiv.innerHTML = '<div class="no-code">No code detected yet</div>';
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[OTP Popup] Message error:', chrome.runtime.lastError.message);
            resolve(null);
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        console.error('[OTP Popup] sendMessage threw:', e);
        resolve(null);
      }
    });
  }

  function formatTimeAgo(ts) {
    if (!ts) return '';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 10)   return 'just now';
    if (s < 60)   return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  function friendlyFrom(from) {
    if (!from) return '';
    const nameMatch = from.match(/^([^<]+)</);
    const emailMatch = from.match(/<([^>]+)>/);
    if (nameMatch && emailMatch) {
      const name = nameMatch[1].trim();
      return name || emailMatch[1];
    }
    return from.length > 40 ? from.slice(0, 40) + '…' : from;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
});
