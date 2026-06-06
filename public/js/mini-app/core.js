/* 由 views/mini-app.ejs 内联脚本抽离而来。共享全局作用域，按 core→panel→events→verification→leaderboard 顺序加载。请勿改动加载顺序。 */

/* ════════════════════════════════════════════
   Telegram WebApp bootstrap
════════════════════════════════════════════ */
var tg = (window.Telegram && window.Telegram.WebApp) ||
  { initData:'', colorScheme:'dark', expand:function(){}, ready:function(){}, showPopup:null };
tg.expand(); tg.ready();
var initData = tg.initData || '';

/* ════════════════════════════════════════════
   Theme
════════════════════════════════════════════ */
var _theme = (tg.colorScheme === 'light') ? 'light' : 'dark';

function applyTheme(t) {
  _theme = t;
  document.documentElement.setAttribute('data-theme', t);
  document.getElementById('btn-theme').textContent = t === 'dark' ? '☀️' : '🌙';
}
applyTheme(_theme);

document.getElementById('btn-theme').addEventListener('click', function(){
  applyTheme(_theme === 'dark' ? 'light' : 'dark');
});

/* ════════════════════════════════════════════
   State
════════════════════════════════════════════ */
var S = {
  group:    null,
  settings: null,
  titles:   null,
  tab:      'basic',
};

/* ════════════════════════════════════════════
   Helpers
════════════════════════════════════════════ */
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

var _toastTimer = null;
function toast(msg, isErr) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'vis' + (isErr ? ' err' : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function(){ el.className=''; }, 2400);
}

async function api(path, body) {
  var payload = Object.assign({ initData: initData }, body || {});
  var res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    var j = {}; try { j = await res.clone().json(); } catch(e){}
    throw new Error(j.error || ('HTTP ' + res.status));
  }
  return res.json();
}

function setTog(id, val) {
  var el = document.getElementById(id);
  if (el) el.classList.toggle('on', !!val);
}

/* ════════════════════════════════════════════
   Screens
════════════════════════════════════════════ */
function show(id) {
  var ids = ['screen-loading','screen-error','screen-groups','screen-panel','screen-verify','screen-verify-done', 'screen-leaderboard'];
  ids.forEach(function(sid){
    var el = document.getElementById(sid);
    if (sid === 'screen-panel')
      el.style.display = sid === id ? 'flex' : 'none';
    else if (sid === 'screen-verify-done')
      el.style.display = sid === id ? 'flex' : 'none';
    else
      el.style.display = sid === id ? 'block' : 'none';
  });
}

