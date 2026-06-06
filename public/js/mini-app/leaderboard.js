/* 由 views/mini-app.ejs 内联脚本抽离而来。共享全局作用域，按 core→panel→events→verification→leaderboard 顺序加载。请勿改动加载顺序。 */
/* ════════════════════════════════════════════
   🏆 Leaderboard Mode
════════════════════════════════════════════ */
var _lbData = null;
var _lbMode = 'xp'; // 'xp' or 'coins'

async function initLeaderboard(groupIdParams) {
  // groupIdParams uses "m" for negative values to bypass startapp limitation
  var groupId = groupIdParams.replace(/m/g, '-');
  show('screen-loading');

  if (!initData) {
    show('screen-error');
    document.getElementById('err-msg').textContent = '验证失败：请确保您从 Telegram 内置浏览器打开。';
    return;
  }

  try {
    var res = await fetch('/api/miniapp/leaderboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: initData, groupId: groupId })
    });
    var data = await res.json();

    if (!res.ok) {
      show('screen-error');
      document.getElementById('err-msg').textContent = data.error || '无法加载排行数据。您可能不在该群组内。';
      return;
    }

    _lbData = data;
    document.getElementById('lb-group-name').textContent = data.groupName;
    renderLeaderboard();
    show('screen-leaderboard');

  } catch (e) {
    show('screen-error');
    document.getElementById('err-msg').textContent = '网络请求失败：' + e.message;
  }
}

function renderLeaderboard() {
  if (!_lbData) return;
  var container = document.getElementById('lb-list-container');
  container.innerHTML = '';
  
  // Tab UI update
  document.getElementById('lb-btn-xp').className = 'lb-tab' + (_lbMode === 'xp' ? ' active' : '');
  document.getElementById('lb-btn-coins').className = 'lb-tab' + (_lbMode === 'coins' ? ' active' : '');

  // My Score Widget
  var myStats = _lbData.myStats;
  var myEl = document.getElementById('lb-my-score');
  if (_lbMode === 'xp') {
    myEl.innerHTML = '<div class="lb-item me"><div class="lb-rank">#'+myStats.xpRank+'</div><div class="lb-avatar">我</div><div class="lb-info"><div class="lb-name">您的数据</div><div class="lb-tag">Lv.'+myStats.level+' '+esc(myStats.title)+'</div></div><div class="lb-score">'+myStats.xp+'<span class="lb-score-lbl">XP</span></div></div>';
  } else {
    myEl.innerHTML = '<div class="lb-item me"><div class="lb-rank">#'+myStats.coinsRank+'</div><div class="lb-avatar">我</div><div class="lb-info"><div class="lb-name">您的财富</div><div class="lb-tag">积分资产</div></div><div class="lb-score">'+myStats.coins+'<span class="lb-score-lbl">Coins</span></div></div>';
  }

  // Generate list
  var list = _lbMode === 'xp' ? _lbData.xpList : _lbData.coinsList;
  if (!list || list.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text3);font-size:14px;">暂无数据</div>';
    return;
  }

  list.forEach(function(p, i) {
    var rankStr = (i + 1).toString();
    var rankClass = '';
    if (i === 0) { rankStr = '🥇'; rankClass = ' top1'; }
    else if (i === 1) { rankStr = '🥈'; rankClass = ' top2'; }
    else if (i === 2) { rankStr = '🥉'; rankClass = ' top3'; }

    var el = document.createElement('div');
    el.className = 'lb-item';
    
    var scoreValue = _lbMode === 'xp' ? p.xp : p.coins;
    var scoreLbl = _lbMode === 'xp' ? 'XP' : 'Coins';
    
    el.innerHTML = 
      '<div class="lb-rank' + rankClass + '">' + rankStr + '</div>' +
      '<div class="lb-avatar">' + p.avatarChar + '</div>' +
      '<div class="lb-info">' +
        '<div class="lb-name">' + esc(p.name) + '</div>' +
        '<div class="lb-tag">Lv.' + p.level + ' ' + esc(p.title) + '</div>' +
      '</div>' +
      '<div class="lb-score">' + scoreValue + '<span class="lb-score-lbl">' + scoreLbl + '</span></div>';
    
    container.appendChild(el);
  });
}

document.getElementById('lb-btn-xp').addEventListener('click', function() {
  if (_lbMode === 'xp') return;
  _lbMode = 'xp';
  renderLeaderboard();
});

document.getElementById('lb-btn-coins').addEventListener('click', function() {
  if (_lbMode === 'coins') return;
  _lbMode = 'coins';
  renderLeaderboard();
});

