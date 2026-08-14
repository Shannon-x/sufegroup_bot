(function () {
  'use strict';

  // ── Countdown ──
  var timerEl = document.getElementById('timer');
  var barEl = document.getElementById('timerBar');
  var remaining = TOTAL_SECONDS;
  var interval;

  function pad(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function tick() {
    remaining--;
    if (remaining <= 0) {
      clearInterval(interval);
      window.location.reload();
      return;
    }

    var m = Math.floor(remaining / 60);
    var s = remaining % 60;
    timerEl.textContent = m + ':' + pad(s);

    // Progress bar
    var pct = (remaining / TOTAL_SECONDS) * 100;
    barEl.style.width = pct + '%';

    // Urgent state at last 2 minutes
    if (remaining <= 120) {
      timerEl.classList.add('urgent');
      barEl.classList.add('urgent');
    }
  }

  interval = setInterval(tick, 1000);

  // Pause timer when tab is hidden
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      clearInterval(interval);
    } else {
      interval = setInterval(tick, 1000);
    }
  });

  // ── Turnstile ──
  var turnstileToken = null;
  var submitBtn = document.getElementById('submitBtn');

  window.onTurnstileSuccess = function (token) {
    turnstileToken = token;
    submitBtn.disabled = false;
    submitBtn.textContent = '完成验证';
  };

  window.onTurnstileError = function () {
    showMsg('error', '人机验证失败，请刷新页面重试');
  };

  /**
   * Throw away the solved token and ask Turnstile for a fresh challenge.
   *
   * The server now redeems each token exactly once, so a token that has been
   * submitted is spent whatever the outcome. Leaving it in place meant the
   * "please retry" advice sent the same burnt token back and every retry failed
   * with the same message — and on the legacy page that loop ends with the
   * member being removed for running out of time.
   */
  function resetChallenge() {
    turnstileToken = null;
    submitBtn.disabled = true;
    try {
      if (window.turnstile && typeof window.turnstile.reset === 'function') {
        window.turnstile.reset();
      }
    } catch (err) {
      // Widget already gone or not ready; the disabled button still prevents a
      // resubmit of the spent token.
    }
  }

  // ── Form submit ──
  var form = document.getElementById('verifyForm');

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    if (!turnstileToken) {
      showMsg('error', '请先完成人机验证');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.classList.add('loading');
    submitBtn.textContent = '验证中…';

    var token = form.querySelector('input[name="token"]').value;

    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 20000);

    fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token, turnstileToken: turnstileToken }),
      signal: ctrl.signal
    })
      .then(function (res) { clearTimeout(timer); return res.json(); })
      .then(function (data) {
        if (data.success) {
          showMsg('success', data.message);
          setTimeout(function () {
            window.location.href = data.redirectUrl;
          }, 800);
        } else {
          showMsg('error', data.message);
          submitBtn.classList.remove('loading');
          submitBtn.textContent = '重新验证';
          resetChallenge();
        }
      })
      .catch(function () {
        clearTimeout(timer);
        // The request may still have reached the server and spent the token, so
        // a fresh challenge is required here too.
        showMsg('error', ctrl.signal.aborted ? '请求超时，请重试' : '网络错误，请重试');
        submitBtn.classList.remove('loading');
        submitBtn.textContent = '重新验证';
        resetChallenge();
      });
  });

  // ── Messages ──
  function showMsg(type, text) {
    // Hide both first
    var errEl = document.getElementById('errorMsg');
    var sucEl = document.getElementById('successMsg');
    errEl.style.display = 'none';
    sucEl.style.display = 'none';

    var el = type === 'error' ? errEl : sucEl;
    el.textContent = text;
    el.style.display = 'block';
  }
})();
