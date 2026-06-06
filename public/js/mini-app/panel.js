/* 由 views/mini-app.ejs 内联脚本抽离而来。共享全局作用域，按 core→panel→events→verification→leaderboard 顺序加载。请勿改动加载顺序。 */
/* ════════════════════════════════════════════
   Groups
════════════════════════════════════════════ */
async function loadGroups() {
  show('screen-loading');
  if (!initData) {
    show('screen-error');
    document.getElementById('err-msg').textContent =
      '请通过 Telegram 机器人私聊中的按钮打开此页面。\n\n向机器人发送 /admin 即可获取入口。';
    return;
  }
  try {
    var data = await api('/api/admin/groups');
    if (!data.groups || data.groups.length === 0) {
      show('screen-error');
      document.getElementById('err-msg').textContent =
        '您没有可管理的群组。\n请确认机器人已加入群组且拥有管理员权限。';
      return;
    }
    var list = document.getElementById('group-list');
    list.innerHTML = '';
    data.groups.forEach(function(g){
      var el = document.createElement('div');
      el.className = 'group-item';
      el.innerHTML =
        '<span class="gi-title">'+esc(g.title)+'</span>'+
        '<span class="gi-arr">›</span>';
      el.addEventListener('click', function(){ openPanel(g); });
      list.appendChild(el);
    });
    show('screen-groups');
  } catch(e) {
    show('screen-error');
    document.getElementById('err-msg').textContent =
      String(e).indexOf('401') !== -1
        ? '身份验证失败，请关闭后重新从 Telegram 打开。'
        : '加载失败：' + e.message;
  }
}

/* ════════════════════════════════════════════
   Panel
════════════════════════════════════════════ */
function openPanel(group) {
  S.group = group;
  document.getElementById('panel-name').textContent = group.title;
  show('screen-panel');
  switchTab('basic');
  loadSettings();
}

function closePanel() {
  S.group = null; S.settings = null; S.titles = null;
  loadGroups();
}

/* ════════════════════════════════════════════
   Tabs
════════════════════════════════════════════ */
function switchTab(name) {
  S.tab = name;
  document.querySelectorAll('.tab-btn').forEach(function(b){
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.querySelectorAll('.tab-pane').forEach(function(p){
    p.classList.toggle('active', p.id === 'tab-' + name);
  });
  if (name === 'lottery') loadLotteries();
}

/* ════════════════════════════════════════════
   Settings: load & debounced save
════════════════════════════════════════════ */
async function loadSettings() {
  try {
    var data = await api('/api/admin/settings', { groupId: S.group.id });
    S.settings = data;
    S.titles = JSON.parse(JSON.stringify(data.customTitles || []));
    renderAll();
  } catch(e) {
    toast('设置加载失败：' + e.message, true);
  }
}

var _saveTimer = null;
var _pending = {};

function scheduleSave(updates) {
  // Deep-merge the nested `filter` (and `filter.flood`) so rapid successive
  // toggles within the debounce window don't clobber each other — a shallow
  // Object.assign would replace the whole `filter` object and lose earlier keys.
  if (updates.filter) {
    var pf = _pending.filter || (_pending.filter = {});
    if (updates.filter.flood) {
      pf.flood = Object.assign({}, pf.flood, updates.filter.flood);
    }
    for (var fk in updates.filter) {
      if (fk !== 'flood') pf[fk] = updates.filter[fk];
    }
    for (var k in updates) {
      if (k !== 'filter') _pending[k] = updates[k];
    }
  } else {
    Object.assign(_pending, updates);
  }
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(commitSave, 450);
}

async function commitSave() {
  if (!S.group) return;
  var upd = _pending; _pending = {};
  try {
    await api('/api/admin/settings/update', { groupId: S.group.id, updates: upd });
    toast('已保存');
  } catch(e) {
    toast('保存失败：' + e.message, true);
  }
}

function renderAll() {
  renderBasic(); renderFilter(); renderFlood();
  renderKeywords(); renderTitles();
}

/* ════════════════════════════════════════════
   ⚙️ Basic tab
════════════════════════════════════════════ */
function renderBasic() {
  var s = S.settings;
  setTog('t-verify', s.verificationEnabled);
  document.getElementById('btn-ttl').textContent = s.ttlMinutes + ' 分钟';
  document.getElementById('btn-auto-action').textContent =
    s.autoAction === 'mute' ? '🔇 禁言' : '👢 踢出';
}

var TTL_OPTS = [3,5,10,15,30];
function cycleTTL() {
  var i = TTL_OPTS.indexOf(S.settings.ttlMinutes);
  S.settings.ttlMinutes = TTL_OPTS[(i+1) % TTL_OPTS.length];
  renderBasic();
  scheduleSave({ ttlMinutes: S.settings.ttlMinutes });
}
function cycleAutoAction() {
  S.settings.autoAction = S.settings.autoAction === 'mute' ? 'kick' : 'mute';
  renderBasic();
  scheduleSave({ autoAction: S.settings.autoAction });
}
function togVerify() {
  S.settings.verificationEnabled = !S.settings.verificationEnabled;
  renderBasic();
  scheduleSave({ verificationEnabled: S.settings.verificationEnabled });
}

/* ════════════════════════════════════════════
   🛡 Filter tab
════════════════════════════════════════════ */
function renderFilter() {
  var f = (S.settings && S.settings.filter) || {};
  setTog('t-filter',  f.enabled);
  setTog('t-urls',    f.blockUrls);
  setTog('t-invite',  f.blockInviteLinks);
  setTog('t-phone',   f.blockPhoneNumbers);
  setTog('t-forward', f.blockForwards);
  var al = { warn:'⚠️ 警告', mute:'🔇 禁言', ban:'🚫 封禁' };
  document.getElementById('btn-filter-action').textContent = al[f.action] || '⚠️ 警告';
  document.getElementById('btn-max-warn').textContent = (f.maxWarnings||3) + ' 次';
}

function togFilter(key) {
  var f = S.settings.filter;
  f[key] = !f[key]; renderFilter();
  var u = {}; u[key] = f[key];
  scheduleSave({ filter: u });
}

var FA = ['warn','mute','ban'];
function cycleFilterAction() {
  var f = S.settings.filter;
  f.action = FA[(FA.indexOf(f.action)+1) % FA.length];
  renderFilter();
  scheduleSave({ filter: { action: f.action } });
}
function cycleMaxWarn() {
  var f = S.settings.filter;
  f.maxWarnings = (f.maxWarnings||3) >= 10 ? 3 : (f.maxWarnings||3)+1;
  renderFilter();
  scheduleSave({ filter: { maxWarnings: f.maxWarnings } });
}

/* Keywords */
function renderKeywords() {
  var kws = ((S.settings.filter||{}).customKeywords)||[];
  var el = document.getElementById('kw-list');
  if (kws.length === 0) {
    el.innerHTML = '<div class="kw-empty">暂无自定义关键词</div>';
    return;
  }
  el.innerHTML = '<div class="kw-wrap"></div>';
  var wrap = el.querySelector('.kw-wrap');
  kws.forEach(function(kw){
    var tag = document.createElement('span');
    tag.className = 'kw-tag';
    tag.innerHTML = esc(kw) +
      '<button class="kw-del" data-kw="'+esc(kw)+'">×</button>';
    tag.querySelector('.kw-del').addEventListener('click', function(){
      delKeyword(this.dataset.kw);
    });
    wrap.appendChild(tag);
  });
}
function addKeyword() {
  var inp = document.getElementById('kw-input');
  var kw = (inp.value||'').trim().toLowerCase();
  if (!kw) { toast('请输入关键词', true); return; }
  var f = S.settings.filter;
  if (!f.customKeywords) f.customKeywords = [];
  if (f.customKeywords.includes(kw)) { toast('关键词已存在', true); return; }
  f.customKeywords.push(kw);
  renderKeywords();
  scheduleSave({ filter: { customKeywords: f.customKeywords } });
  inp.value = '';
  inp.focus();
}
function delKeyword(kw) {
  var f = S.settings.filter;
  f.customKeywords = (f.customKeywords||[]).filter(function(k){ return k!==kw; });
  renderKeywords();
  scheduleSave({ filter: { customKeywords: f.customKeywords } });
}

/* ════════════════════════════════════════════
   🌊 Flood tab
════════════════════════════════════════════ */
function renderFlood() {
  var fl = ((S.settings.filter)||{}).flood || {};
  setTog('t-flood', fl.enabled);
  document.getElementById('btn-flood-preset').textContent =
    (fl.maxMessages||10) + '条/' + (fl.windowSeconds||10) + '秒';
  var al = { warn:'⚠️ 警告', mute:'🔇 禁言', ban:'🚫 封禁' };
  document.getElementById('btn-flood-action').textContent = al[fl.action] || '🔇 禁言';
  document.getElementById('btn-flood-mute').textContent = (fl.muteDuration||5) + ' 分钟';
}

function togFlood() {
  var fl = S.settings.filter.flood;
  fl.enabled = !fl.enabled; renderFlood();
  scheduleSave({ filter: { flood: fl } });
}

var FP = [[5,10],[8,10],[10,10],[15,10],[20,10],[10,30],[15,30],[20,30]];
function cycleFloodPreset() {
  var fl = S.settings.filter.flood;
  var i = FP.findIndex(function(p){ return p[0]===fl.maxMessages && p[1]===fl.windowSeconds; });
  var n = FP[(i+1) % FP.length];
  fl.maxMessages = n[0]; fl.windowSeconds = n[1];
  renderFlood();
  scheduleSave({ filter: { flood: fl } });
}

var FL = ['warn','mute','ban'];
function cycleFloodAction() {
  var fl = S.settings.filter.flood;
  fl.action = FL[(FL.indexOf(fl.action)+1) % FL.length];
  renderFlood();
  scheduleSave({ filter: { flood: fl } });
}

var FM = [1,5,15,30,60];
function cycleFloodMute() {
  var fl = S.settings.filter.flood;
  fl.muteDuration = FM[(FM.indexOf(fl.muteDuration)+1) % FM.length];
  renderFlood();
  scheduleSave({ filter: { flood: fl } });
}

/* ════════════════════════════════════════════
   🏷 Titles tab
════════════════════════════════════════════ */
function renderTitles() {
  var card = document.getElementById('titles-card');
  if (!S.titles || S.titles.length === 0) {
    card.innerHTML = '<div class="empty">暂无自定义称号（使用默认称号）</div>';
    return;
  }
  var sorted = S.titles.slice().sort(function(a,b){ return b.minLevel - a.minLevel; });
  card.innerHTML = '';
  sorted.forEach(function(t){
    var row = document.createElement('div');
    row.className = 'ti-row';
    row.innerHTML =
      '<span class="ti-lv">Lv.'+t.minLevel+'+</span>'+
      '<span class="ti-txt">'+esc(t.title)+'</span>'+
      '<span class="ti-edit-hint">✏️ 编辑</span>'+
      '<button class="del-btn" data-lv="'+t.minLevel+'">×</button>';

    // Click row (except delete) → fill edit form
    row.addEventListener('click', function(e){
      if (e.target && e.target.classList && e.target.classList.contains('del-btn')) return;
      // Highlight selected row
      document.querySelectorAll('.ti-row').forEach(function(r){ r.classList.remove('editing'); });
      row.classList.add('editing');
      // Scroll to form and fill values
      var lvEl  = document.getElementById('title-lv');
      var txtEl = document.getElementById('title-txt');
      lvEl.value  = String(t.minLevel);
      txtEl.value = t.title;
      // Focus the text field so user can start typing immediately
      txtEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(function(){ txtEl.focus(); txtEl.select(); }, 300);
    });

    row.querySelector('.del-btn').addEventListener('click', function(e){
      e.stopPropagation();
      deleteTitle(parseInt(this.dataset.lv));
    });
    card.appendChild(row);
  });
}

function addTitle() {
  var lvEl  = document.getElementById('title-lv');
  var txtEl = document.getElementById('title-txt');
  var lv  = parseInt(lvEl.value);
  var txt = (txtEl.value||'').trim();
  if (!lv || lv < 1 || lv > 999) { toast('等级范围 1–999', true); return; }
  if (!txt) { toast('请输入称号文字', true); return; }
  S.titles = (S.titles||[]).filter(function(t){ return t.minLevel !== lv; });
  S.titles.push({ minLevel: lv, title: txt });
  renderTitles();
  saveTitlesNow();
  lvEl.value = ''; txtEl.value = '';
  // Remove editing highlight after save
  document.querySelectorAll('.ti-row').forEach(function(r){ r.classList.remove('editing'); });
  lvEl.focus();
}

function deleteTitle(lv) {
  S.titles = (S.titles||[]).filter(function(t){ return t.minLevel !== lv; });
  renderTitles();
  saveTitlesNow();
}

function saveTitlesNow() {
  // Flush any pending filter saves first, then save titles immediately
  if (_saveTimer) { clearTimeout(_saveTimer); commitSave(); }
  var payload = S.titles && S.titles.length > 0 ? S.titles : null;
  api('/api/admin/settings/update', {
    groupId: S.group.id,
    updates: { customTitles: payload }
  }).then(function(){ toast('称号已保存'); })
    .catch(function(e){ toast('保存失败：'+e.message, true); });
}

function resetTitles() {
  function doReset() {
    S.titles = [];
    renderTitles();
    api('/api/admin/settings/update', {
      groupId: S.group.id, updates: { customTitles: null }
    }).then(function(){
      toast('已恢复默认称号');
      loadSettings();
    }).catch(function(e){ toast('失败：'+e.message, true); });
  }
  if (tg.showPopup) {
    tg.showPopup({
      title: '恢复默认',
      message: '确认恢复默认称号？当前所有自定义称号将被清除。',
      buttons: [{ id:'ok', type:'destructive', text:'恢复默认' }, { type:'cancel' }]
    }, function(bid){ if (bid === 'ok') doReset(); });
  } else { doReset(); }
}

/* ════════════════════════════════════════════
   🎰 Lottery tab
════════════════════════════════════════════ */
async function loadLotteries() {
  if (!S.group) return;
  var card = document.getElementById('lottery-card');
  card.innerHTML =
    '<div class="empty"><span class="spin" style="vertical-align:middle;margin-right:6px;display:inline-block;"></span>加载中...</div>';
  try {
    var data = await api('/api/admin/lottery/list', { groupId: S.group.id });
    renderLotteries(data.lotteries || []);
  } catch(e) {
    card.innerHTML = '<div class="empty" style="color:var(--error)">加载失败：'+esc(e.message)+'</div>';
  }
}

function renderLotteries(list) {
  var card = document.getElementById('lottery-card');
  if (list.length === 0) {
    card.innerHTML = '<div class="empty">当前没有进行中的抽奖</div>';
    return;
  }
  card.innerHTML = '';
  list.forEach(function(l){
    var remain = Math.max(0, Math.ceil((new Date(l.endsAt)-Date.now())/60000));
    var meta = '#' + l.id + ' · ' + l.participants + ' 人参与 · 剩余 ' + remain + ' 分钟';
    if (l.minLevel > 0) meta += ' · 需 Lv.' + l.minLevel;
    if (l.costCoins > 0) meta += ' · 费用 ' + l.costCoins + ' 积分';
    var item = document.createElement('div');
    item.className = 'lt-item';
    item.innerHTML =
      '<div class="lt-prize">🎁 '+esc(l.prize)+'（'+l.winnerCount+' 人中奖）</div>'+
      '<div class="lt-meta">'+esc(meta)+'</div>'+
      '<div class="lt-actions">'+
        '<button class="lt-btn lt-draw" data-id="'+l.id+'">🎉 立即开奖</button>'+
        '<button class="lt-btn lt-cancel" data-id="'+l.id+'">取消</button>'+
      '</div>';
    item.querySelector('.lt-draw').addEventListener('click', function(){
      drawLottery(parseInt(this.dataset.id));
    });
    item.querySelector('.lt-cancel').addEventListener('click', function(){
      cancelLottery(parseInt(this.dataset.id));
    });
    card.appendChild(item);
  });
}

async function drawLottery(id) {
  try {
    var r = await api('/api/admin/lottery/draw', { lotteryId: id });
    toast('🎉 开奖成功！' + r.winnersCount + ' 人中奖，结果已发送至群组');
    loadLotteries();
  } catch(e) { toast('开奖失败：'+e.message, true); }
}

async function cancelLottery(id) {
  try {
    await api('/api/admin/lottery/cancel', { lotteryId: id });
    toast('抽奖已取消，积分已退还');
    loadLotteries();
  } catch(e) { toast('取消失败：'+e.message, true); }
}

async function createLottery() {
  var prize  = (document.getElementById('lt-prize').value||'').trim();
  var count  = parseInt(document.getElementById('lt-count').value)||1;
  var dur    = parseInt(document.getElementById('lt-dur').value)||30;
  var level  = parseInt(document.getElementById('lt-level').value)||0;
  var coins  = parseInt(document.getElementById('lt-coins').value)||0;
  if (!prize) { toast('请输入奖品名称', true); return; }
  if (count < 1 || count > 50) { toast('中奖人数需在 1–50 之间', true); return; }
  var btn = document.getElementById('btn-create-lt');
  btn.disabled = true; btn.textContent = '创建中...';
  try {
    var r = await api('/api/admin/lottery/create', {
      groupId: S.group.id, prize: prize,
      winnerCount: count, durationMinutes: dur,
      minLevel: level, costCoins: coins
    });
    toast('🎰 抽奖 #'+r.lottery.id+' 已创建，公告已发送至群组！');
    document.getElementById('lt-prize').value = '';
    document.getElementById('lt-count').value = '1';
    document.getElementById('lt-level').value = '0';
    document.getElementById('lt-coins').value = '0';
    loadLotteries();
  } catch(e) {
    toast('创建失败：'+e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = '🎰 创建抽奖';
  }
}

