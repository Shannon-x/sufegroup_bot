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

    fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token, turnstileToken: turnstileToken })
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.success) {
          showMsg('success', data.message);
          setTimeout(function () {
            window.location.href = data.redirectUrl;
          }, 800);
        } else {
          showMsg('error', data.message);
          submitBtn.disabled = false;
          submitBtn.classList.remove('loading');
          submitBtn.textContent = '完成验证';
        }
      })
      .catch(function () {
        showMsg('error', '网络错误，请重试');
        submitBtn.disabled = false;
        submitBtn.classList.remove('loading');
        submitBtn.textContent = '完成验证';
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
