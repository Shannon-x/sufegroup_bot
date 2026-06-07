/* 由 views/mini-app.ejs 内联脚本抽离而来。共享全局作用域，按 core→panel→events→verification→leaderboard 顺序加载。请勿改动加载顺序。 */
/* ════════════════════════════════════════════
   🔐 Verification Mode
════════════════════════════════════════════ */
var SITE_KEY = (window.MINIAPP_CONFIG || {}).siteKey || '';
var HCAPTCHA_SITE_KEY = (window.MINIAPP_CONFIG || {}).hcaptchaSiteKey || '';
var _vTimer = null;
var _vTurnstileToken = null;
var _vHcaptchaToken = null;
var _activeCaptcha = 'cf';
var _hcWidgetId = null;
var _vSessionId = null;
var _vTotalSeconds = 0;
var _vRemaining = 0;
var _vMode = 'group';

function verificationEndpoints() {
  if (_vMode === 'chatwoot') {
    return {
      session: '/api/miniapp/chatwoot/verify/session',
      submit: '/api/miniapp/chatwoot/verify',
      timeout: '验证已超时，请重新发送消息获取验证入口。'
    };
  }
  return {
    session: '/api/miniapp/verify/session',
    submit: '/api/miniapp/verify',
    timeout: '验证已超时，请返回群组重新获取验证链接。'
  };
}

async function initVerification(sessionId, mode) {
  _vSessionId = sessionId;
  _vMode = mode || 'group';
  show('screen-loading');

  if (!initData) {
    show('screen-error');
    document.getElementById('err-msg').textContent = _vMode === 'chatwoot'
      ? '请通过 Telegram 客服聊天中的验证按钮打开此页面。'
      : '请通过群组中的验证按钮打开此页面。';
    return;
  }

  try {
    var endpoints = verificationEndpoints();
    var res = await fetch(endpoints.session, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: initData, sessionId: sessionId })
    });
    var data = await res.json();

    if (!res.ok) {
      show('screen-error');
      document.getElementById('err-msg').textContent = data.message || '验证会话无效';
      return;
    }

    // Populate UI
    document.getElementById('v-title').textContent = _vMode === 'chatwoot' ? '客服消息验证' : '入群验证';
    document.getElementById('v-sub').textContent = _vMode === 'chatwoot'
      ? '请完成人机验证，验证通过后客服系统才会接收您的消息'
      : '请完成人机验证以加入群组';
    document.getElementById('v-group-name').textContent = data.groupName;
    var fullName = data.userFirstName + (data.userLastName ? ' ' + data.userLastName : '');
    // NFKC-normalise (folds 𝒦/fancy Unicode → K) then take the first code point
    // so surrogate pairs (fancy letters / emoji) aren't split into a broken glyph.
    var _an = (data.userFirstName || '').normalize('NFKC').trim();
    var _initial = Array.from(_an)[0];
    _initial = _initial ? _initial.toUpperCase() : '?';
    // Prefer the real Telegram profile photo (server-resolved data URI; or
    // photo_url when Telegram provides it), else fall back to the initial.
    var _tgUser = (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user) || {};
    var _photo = data.avatarUrl || _tgUser.photo_url || '';
    var _av = document.getElementById('v-avatar');
    if (_photo) {
      _av.textContent = '';
      _av.classList.add('has-photo');
      _av.style.backgroundImage = 'url("' + _photo + '")';
    } else {
      _av.classList.remove('has-photo');
      _av.style.backgroundImage = '';
      _av.textContent = _initial;
    }
    document.getElementById('v-uname').textContent = fullName;
    document.getElementById('v-handle').textContent = data.username ? '@' + data.username : '';
    document.getElementById('v-user-section').style.display = 'flex';
    document.getElementById('v-timer-section').style.display = 'block';

    // Verify Dual Nav
    if (HCAPTCHA_SITE_KEY) {
      var dnav = document.getElementById('v-dual-nav');
      if (dnav) dnav.style.display = 'block';
    }

    // Timer
    _vTotalSeconds = data.ttlSeconds;
    _vRemaining = data.ttlSeconds;
    updateVerifyTimer();
    _vTimer = setInterval(function() {
      _vRemaining--;
      if (_vRemaining <= 0) {
        clearInterval(_vTimer);
        show('screen-error');
        document.getElementById('err-msg').textContent = endpoints.timeout;
        return;
      }
      updateVerifyTimer();
    }, 1000);

    // Render Turnstile
    if (window.turnstile) {
      renderTurnstile();
    } else {
      // Wait for Turnstile script to load (cap at ~10s to avoid an endless poll
      // if the script is blocked by the network/CSP).
      var twAttempts = 0;
      var tw = setInterval(function() {
        if (window.turnstile) {
          clearInterval(tw);
          renderTurnstile();
        } else if (++twAttempts >= 50) {
          clearInterval(tw);
          showVerifyMsg('error', '人机验证组件加载超时，请检查网络后刷新重试');
        }
      }, 200);
    }

    show('screen-verify');

  } catch (e) {
    show('screen-error');
    document.getElementById('err-msg').textContent = '网络错误，请重试。\n' + e.message;
  }
}

function renderTurnstile() {
  var container = document.getElementById('v-turnstile-container');
  container.innerHTML = '';
  window.turnstile.render(container, {
    sitekey: SITE_KEY,
    theme: _theme,
    callback: function(token) {
      _vTurnstileToken = token;
      _vHcaptchaToken = null;
      document.getElementById('v-submit').disabled = false;
    },
    'error-callback': function() {
      showVerifyMsg('error', 'CF人机验证组件加载失败被拦截，您可以尝试切换');
    }
  });
}

function renderHCaptcha() {
  var container = document.getElementById('v-hcaptcha-container');
  if (_hcWidgetId !== null) {
    window.hcaptcha.reset(_hcWidgetId);
  } else {
    _hcWidgetId = window.hcaptcha.render(container, {
      sitekey: HCAPTCHA_SITE_KEY,
      theme: _theme,
      callback: function(token) {
        _vHcaptchaToken = token;
        _vTurnstileToken = null;
        document.getElementById('v-submit').disabled = false;
      },
      'error-callback': function() {
        showVerifyMsg('error', 'hCaptcha加载失败，请重试');
      }
    });
  }
}

function switchCaptcha(type) {
  if (_activeCaptcha === type) return;
  _activeCaptcha = type;
  _vTurnstileToken = null;
  _vHcaptchaToken = null;
  document.getElementById('v-submit').disabled = true;
  hideVerifyMsg();

  var tabCf = document.getElementById('v-tab-cf');
  var tabHc = document.getElementById('v-tab-hc');
  if (tabCf) tabCf.classList.remove('active');
  if (tabHc) tabHc.classList.remove('active');
  
  var activeTab = document.getElementById('v-tab-' + type);
  if (activeTab) activeTab.classList.add('active');

  if (type === 'cf') {
    document.getElementById('v-hcaptcha-container').style.display = 'none';
    document.getElementById('v-turnstile-container').style.display = 'block';
    renderTurnstile();
  } else {
    document.getElementById('v-turnstile-container').style.display = 'none';
    document.getElementById('v-hcaptcha-container').style.display = 'block';
    if (window.hcaptcha) {
      renderHCaptcha();
    } else {
      var hwAttempts = 0;
      var hw = setInterval(function() {
        if (window.hcaptcha) {
          clearInterval(hw);
          renderHCaptcha();
        } else if (++hwAttempts >= 50) {
          clearInterval(hw);
          showVerifyMsg('error', 'hCaptcha 加载超时，请检查网络后刷新重试');
        }
      }, 200);
    }
  }
}

function updateVerifyTimer() {
  var m = Math.floor(_vRemaining / 60);
  var s = _vRemaining % 60;
  var timerEl = document.getElementById('v-timer');
  var barEl = document.getElementById('v-bar');
  timerEl.textContent = m + ':' + (s < 10 ? '0' : '') + s;
  var pct = (_vRemaining / _vTotalSeconds) * 100;
  barEl.style.width = pct + '%';
  if (_vRemaining <= 120) {
    timerEl.classList.add('urgent');
    barEl.classList.add('urgent');
  } else {
    timerEl.classList.remove('urgent');
    barEl.classList.remove('urgent');
  }
}

async function submitVerification() {
  if (!_vTurnstileToken && !_vHcaptchaToken) {
    showVerifyMsg('error', '请先完成人机验证');
    return;
  }

  var btn = document.getElementById('v-submit');
  btn.disabled = true;
  btn.classList.add('loading');
  btn.textContent = '验证中…';
  hideVerifyMsg();

  try {
    var endpoints = verificationEndpoints();
    var res = await fetch(endpoints.submit, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        initData: initData,
        sessionId: _vSessionId,
        turnstileToken: _vTurnstileToken || undefined,
        hcaptchaToken: _vHcaptchaToken || undefined
      })
    });
    var data = await res.json();

    if (data.success) {
      clearInterval(_vTimer);
      document.getElementById('v-done-sub').textContent =
        _vMode === 'chatwoot'
          ? '验证成功。请返回客服聊天并重新发送您的消息。'
          : '您已通过 ' + (data.groupName || '群组') + ' 的验证，现在可以正常发言了。';
      show('screen-verify-done');
      // Auto close after 3 seconds
      setTimeout(function() {
        if (tg.close) tg.close();
      }, 3000);
    } else {
      showVerifyMsg('error', data.message || '验证失败，请重试');
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.textContent = '完成验证';
      // Reset Tokens for retry
      _vTurnstileToken = null;
      _vHcaptchaToken = null;
      if (_activeCaptcha === 'cf' && window.turnstile) {
        renderTurnstile();
      } else if (_activeCaptcha === 'hc' && window.hcaptcha && _hcWidgetId !== null) {
        window.hcaptcha.reset(_hcWidgetId);
      }
    }
  } catch (e) {
    showVerifyMsg('error', '网络错误，请重试');
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.textContent = '完成验证';
  }
}

function showVerifyMsg(type, text) {
  hideVerifyMsg();
  var el = document.getElementById(type === 'error' ? 'v-error' : 'v-success');
  el.textContent = text;
  el.style.display = 'block';
}
function hideVerifyMsg() {
  document.getElementById('v-error').style.display = 'none';
  document.getElementById('v-success').style.display = 'none';
}

// Verification button event
document.getElementById('v-submit').addEventListener('click', submitVerification);
document.getElementById('v-done-close').addEventListener('click', function() {
  if (tg.close) tg.close();
});

// Captcha switch tabs (bound via addEventListener instead of inline onclick,
// so the page carries no inline event handlers — CSP can block script-src-attr).
var _vTabCf = document.getElementById('v-tab-cf');
var _vTabHc = document.getElementById('v-tab-hc');
if (_vTabCf) _vTabCf.addEventListener('click', function() { switchCaptcha('cf'); });
if (_vTabHc) _vTabHc.addEventListener('click', function() { switchCaptcha('hc'); });

