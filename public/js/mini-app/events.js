/* 由 views/mini-app.ejs 内联脚本抽离而来。共享全局作用域，按 core→panel→events→verification→leaderboard 顺序加载。请勿改动加载顺序。 */
/* ════════════════════════════════════════════
   Event bindings — all via addEventListener,
   isComposing guard prevents CJK IME conflicts
════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', function(){

  // Navigation
  document.getElementById('btn-back').addEventListener('click', closePanel);
  document.getElementById('btn-refresh').addEventListener('click', function(){
    loadSettings();
    if (S.tab === 'lottery') loadLotteries();
    toast('已刷新');
  });

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(function(b){
    b.addEventListener('click', function(){ switchTab(this.dataset.tab); });
  });

  // ── 设置 ──
  document.getElementById('t-verify').addEventListener('click', togVerify);
  document.getElementById('btn-ttl').addEventListener('click', cycleTTL);
  document.getElementById('btn-auto-action').addEventListener('click', cycleAutoAction);

  // ── 过滤 ──
  document.getElementById('t-filter').addEventListener('click',  function(){ togFilter('enabled'); });
  document.getElementById('t-urls').addEventListener('click',    function(){ togFilter('blockUrls'); });
  document.getElementById('t-invite').addEventListener('click',  function(){ togFilter('blockInviteLinks'); });
  document.getElementById('t-phone').addEventListener('click',   function(){ togFilter('blockPhoneNumbers'); });
  document.getElementById('t-forward').addEventListener('click', function(){ togFilter('blockForwards'); });
  document.getElementById('btn-filter-action').addEventListener('click', cycleFilterAction);
  document.getElementById('btn-max-warn').addEventListener('click', cycleMaxWarn);
  document.getElementById('btn-add-kw').addEventListener('click', addKeyword);
  // isComposing guard: prevents CJK Enter-confirm from firing addKeyword
  document.getElementById('kw-input').addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.isComposing) addKeyword();
  });

  // ── 刷屏 ──
  document.getElementById('t-flood').addEventListener('click', togFlood);
  document.getElementById('btn-flood-preset').addEventListener('click', cycleFloodPreset);
  document.getElementById('btn-flood-action').addEventListener('click', cycleFloodAction);
  document.getElementById('btn-flood-mute').addEventListener('click', cycleFloodMute);

  // ── 称号 ──
  document.getElementById('btn-add-title').addEventListener('click', addTitle);
  document.getElementById('btn-reset-titles').addEventListener('click', resetTitles);
  // isComposing guard for both title inputs
  document.getElementById('title-lv').addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.isComposing) {
      document.getElementById('title-txt').focus();
    }
  });
  document.getElementById('title-txt').addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.isComposing) addTitle();
  });

  // ── 抽奖 ──
  document.getElementById('btn-create-lt').addEventListener('click', createLottery);
  document.getElementById('lt-prize').addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.isComposing)
      document.getElementById('lt-count').focus();
  });

  // Telegram Desktop (Linux) focus fix:
  // Qt WebEngine sometimes doesn't forward focus to inputs on click.
  // Using pointerdown (fires before click) forces the element to be focused.
  document.addEventListener('pointerdown', function(e){
    var el = e.target;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
      setTimeout(function(){ el.focus(); }, 0);
    }
  }, true);

  // Start
  // Start: check if this is a verification flow or admin panel
  var startParam = '';
  try { startParam = tg.initDataUnsafe && tg.initDataUnsafe.start_param ? tg.initDataUnsafe.start_param : ''; } catch(e) {}
  // Also check URL query parameter for testing
  if (!startParam) {
    try {
      var sp = new URLSearchParams(window.location.search);
      startParam = sp.get('startapp') || '';
    } catch(e) {}
  }

  if (!window.Telegram || !window.Telegram.WebApp) {
    show('screen-error');
    document.getElementById('err-msg').textContent = '请在 Telegram 客户端内打开此页面';
  } else if (startParam && startParam.indexOf('verify_') === 0) {
    // Verification mode
    initVerification(startParam.substring(7), 'group');
  } else if (startParam && startParam.indexOf('chatwoot_') === 0) {
    // Chatwoot Telegram inbox verification mode
    initVerification(startParam.substring(9), 'chatwoot');
  } else if (startParam && startParam.indexOf('rank_') === 0) {
    // Leaderboard mode
    initLeaderboard(startParam.substring(5));
  } else {
    loadGroups();
  }
});

