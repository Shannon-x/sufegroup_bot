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
var _vNeedsBind = false;
var _vCaptchaRequired = true;
var _vBoundViaPanel = false;
var _vPollTimer = null;
var _vOneClick = false;

/** Xboard gate: show the binding options when the server asks for them. */
function showBindField(data) {
  var box = document.getElementById('v-bind');
  if (!box) return;
  _vNeedsBind = !!data.needsBind;
  box.style.display = _vNeedsBind ? 'block' : 'none';
  if (!_vNeedsBind) return;
  if (data.panelName) {
    document.getElementById('v-panel-name').textContent = data.panelName;
    var names = document.querySelectorAll('.v-panel-name-2');
    for (var i = 0; i < names.length; i++) names[i].textContent = data.panelName;
  }
  var link = document.getElementById('v-panel-link');
  if (data.panelUrl) {
    link.href = data.panelUrl;
    link.style.display = 'inline-block';
    link.addEventListener('click', function(e) {
      if (tg.openLink) { e.preventDefault(); tg.openLink(data.panelUrl); }
    });
  }
  // One-click binding on the panel is the main path; pasting the
  // subscription link stays one tap away for anyone who cannot sign in.
  _vOneClick = !_vCaptchaRequired && !!data.bindLinkAvailable;
  document.getElementById('v-oneclick-box').style.display = _vOneClick ? 'block' : 'none';
  setPasteVisible(!_vOneClick);
  document.getElementById('v-sub').textContent = _vCaptchaRequired
    ? '请填写订阅链接并完成人机验证以加入群组'
    : _vOneClick
      ? '绑定面板账号后即可开始聊天，只需一次'
      : '粘贴你的订阅链接，绑定面板账号后即可开始聊天';
}

/** In one-click mode the submit button belongs to the paste fallback. */
function setPasteVisible(visible) {
  document.getElementById('v-paste-box').classList.toggle('collapsed', !visible);
  // On gated groups the captcha section holds only the submit button and the
  // messages; the messages must stay visible either way.
  document.getElementById('v-captcha').classList.toggle('oneclick', !visible);
  var toggle = document.getElementById('v-paste-toggle');
  if (toggle) toggle.style.display = visible ? 'none' : '';
  // One primary button at a time: with the paste form open, submit leads.
  var oneClick = document.getElementById('v-oneclick');
  if (oneClick && visible) oneClick.classList.add('secondary');
}

async function startOneClickBind() {
  var btn = document.getElementById('v-oneclick');
  hideVerifyMsg();
  btn.disabled = true;
  try {
    var res = await fetch('/api/miniapp/verify/bind-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: initData, sessionId: _vSessionId })
    });
    var data = await res.json();
    if (!res.ok || !data.url) throw new Error(data.error || 'unavailable');
    if (tg.openLink) tg.openLink(data.url); else window.open(data.url, '_blank', 'noopener');
    btn.classList.add('secondary');
    btn.textContent = '重新打开' + document.getElementById('v-panel-name').textContent;
    document.getElementById('v-wait').style.display = 'flex';
    startBindPolling();
  } catch (e) {
    showVerifyMsg('error', '暂时无法打开一键绑定，请稍后重试，或改为粘贴订阅链接');
  } finally {
    btn.disabled = false;
  }
}

function startBindPolling() {
  if (_vPollTimer) return;
  _vPollTimer = setInterval(pollBindStatus, 3000);
}

function stopBindPolling() {
  if (_vPollTimer) clearInterval(_vPollTimer);
  _vPollTimer = null;
}

async function pollBindStatus() {
  if (_vBoundViaPanel) return;
  try {
    var res = await fetch('/api/miniapp/verify/gate-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: initData, sessionId: _vSessionId })
    });
    if (!res.ok) return; // 429 or a blip: the next tick tries again.
    var data = await res.json();
    if (data.banned) {
      stopBindPolling();
      document.getElementById('v-wait').style.display = 'none';
      showVerifyMsg('error', '这个面板账号已被停用，无法入群');
    } else if (data.bound) {
      stopBindPolling();
      _vBoundViaPanel = true;
      document.getElementById('v-wait').style.display = 'none';
      document.getElementById('v-oneclick').style.display = 'none';
      document.getElementById('v-paste-toggle').style.display = 'none';
      // submitVerification clears messages before its first await, so the
      // note goes up after it starts.
      submitVerification();
      showVerifyMsg('success', '✅ 已绑定面板账号，正在为你解除禁言…');
    }
  } catch (e) {
    // Offline for a moment; keep polling.
  }
}

function submitLabel() {
  if (_vCaptchaRequired) return '完成验证';
  return _vNeedsBind ? '绑定并加入' : '加入群组';
}

/** A subscription link carries a 32-hex token, in ?token= or as the last path segment. */
function looksLikeSubscribeUrl(url) {
  return /^https?:\/\/\S+$/i.test(url) && /(?:[?&]token=|\/)[a-f0-9]{32}(?:[\/?&#]|$)/i.test(url);
}

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
    // Groups behind the panel gate use the panel account in place of the captcha.
    _vCaptchaRequired = !(_vMode === 'group' && data.captchaRequired === false);
    if (_vMode === 'group') showBindField(data);
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

    if (!_vCaptchaRequired) {
      document.getElementById('v-turnstile-container').style.display = 'none';
      var hcBox = document.getElementById('v-hcaptcha-container');
      if (hcBox) hcBox.style.display = 'none';
      var btn = document.getElementById('v-submit');
      btn.disabled = false;
      btn.textContent = submitLabel();
      if (!_vNeedsBind) document.getElementById('v-sub').textContent = '已识别你的面板账号，点下方按钮即可开始聊天';
    }

    // Verify Dual Nav
    if (_vCaptchaRequired && HCAPTCHA_SITE_KEY) {
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
    if (!_vCaptchaRequired) {
      // Nothing to render: the panel account is the check.
    } else if (window.turnstile) {
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
  // Without a session id there is nothing to bind the token to, and the server
  // now rejects an unbound Turnstile token. Fail here, where we can explain it,
  // instead of letting the user solve a challenge that cannot be redeemed.
  if (!_vSessionId) {
    showVerifyMsg('error', '验证会话信息缺失，请返回群组重新点击验证按钮。');
    return;
  }
  container.innerHTML = '';
  window.turnstile.render(container, {
    sitekey: SITE_KEY,
    theme: _theme,
    // Bind the token to this session: Turnstile echoes cData back in the
    // siteverify response, so the server can reject a token that was solved
    // for someone else's session and relayed here. Always sent — the binding
    // used to be skippable, and the widget runs on the client, so "optional"
    // meant an attacker simply left it out.
    cData: _vSessionId,
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

// hCaptcha has no free-tier counterpart to Turnstile's cData (rqdata is
// Enterprise only), so a solved hCaptcha token cannot be bound to a session at
// the provider. What holds instead, server-side: the token is single-use, and
// it can only be redeemed for a pending session owned by the
// initData-authenticated caller.
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
  var subscribeUrl = '';
  if (_vNeedsBind && !_vBoundViaPanel) {
    subscribeUrl = (document.getElementById('v-sub-url').value || '').trim();
    // Checked before the captcha is spent: a solved token is single-use.
    if (!looksLikeSubscribeUrl(subscribeUrl)) {
      showVerifyMsg('error', '请粘贴完整的订阅链接（以 https:// 开头）');
      return;
    }
  }
  if (_vCaptchaRequired && !_vTurnstileToken && !_vHcaptchaToken) {
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
        hcaptchaToken: _vHcaptchaToken || undefined,
        subscribeUrl: subscribeUrl || undefined
      })
    });
    var data = await res.json();

    if (data.success) {
      clearInterval(_vTimer);
      stopBindPolling();
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
      if (_vBoundViaPanel) {
        // The panel said bound but the submit did not go through: let the
        // member retry with the button.
        document.getElementById('v-captcha').classList.remove('oneclick');
      }
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.textContent = submitLabel();
      // Reset Tokens for retry
      _vTurnstileToken = null;
      _vHcaptchaToken = null;
      if (!_vCaptchaRequired) {
        // No widget to reset.
      } else if (_activeCaptcha === 'cf' && window.turnstile) {
        renderTurnstile();
      } else if (_activeCaptcha === 'hc' && window.hcaptcha && _hcWidgetId !== null) {
        window.hcaptcha.reset(_hcWidgetId);
      }
    }
  } catch (e) {
    showVerifyMsg('error', '网络错误，请重试');
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.textContent = submitLabel();
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
var _vOneClickBtn = document.getElementById('v-oneclick');
if (_vOneClickBtn) _vOneClickBtn.addEventListener('click', startOneClickBind);
var _vPasteToggle = document.getElementById('v-paste-toggle');
if (_vPasteToggle) _vPasteToggle.addEventListener('click', function() { setPasteVisible(true); });
// Back from the panel: check at once instead of waiting for the next tick.
document.addEventListener('visibilitychange', function() {
  if (!document.hidden && _vPollTimer) pollBindStatus();
});
document.getElementById('v-done-close').addEventListener('click', function() {
  if (tg.close) tg.close();
});

// Captcha switch tabs (bound via addEventListener instead of inline onclick,
// so the page carries no inline event handlers — CSP can block script-src-attr).
var _vTabCf = document.getElementById('v-tab-cf');
var _vTabHc = document.getElementById('v-tab-hc');
if (_vTabCf) _vTabCf.addEventListener('click', function() { switchCaptcha('cf'); });
if (_vTabHc) _vTabHc.addEventListener('click', function() { switchCaptcha('hc'); });

