/* ============================================================
   strategy-monitor-site 交互脚本
   数据源：window.STRATEGY_SNAPSHOT（data/results.js，schema=strategy-monitor-public-summary-v1）
   规则要点：
   - 默认 中文 / 近三个月；语言与时期可切换
   - 公开摘要已经在生成阶段匿名化；浏览器只接收 M1-M4
   - 缺值 null 一律显示「未计算 / Not available」，绝不补 0 或估算
   - 数据截止以 data_cutoff_exclusive_utc 的前一日为准（右端不含），
     generated_at_utc 只作快照生成时间参考，不得当作数据截止
   ============================================================ */
(function () {
  'use strict';

  /* 输入只包含公开模型代号；四行顺序固定，缺值仍占一行。 */
  var MODEL_ORDER = ['M1', 'M2', 'M3', 'M4'];
  var PERIOD_ORDER = ['近五年', '近三年', '近一年', '近三个月'];
  var SCHEMA = 'strategy-monitor-public-summary-v1';

  /* ---------- 状态：当前语言与时期 ---------- */
  var state = { lang: 'zh', period: '近三个月' };
  var $ = function (selector) { return document.querySelector(selector); };

  /* ---------- 双语文案（所有可见文本仅经 textContent 输出） ---------- */
  var T = {
    zh: {
      heroLead: '收益。', heroAccent: '风险。', heroTail: '看得更清楚。', na: '未计算',
      featureId: '01 / M1', featureHeading: '更稳健的起点',
      featureCopy: '基于已完成回测的收益与回撤平衡，目前作为重点观察模型。',
      featureNet: '账户净利润', featureMdd: '最大回撤',
      sectionLabel: '四个模型 · 同期比较',
      footer: '历史回测 · 每个窗口独立从 300U 开始 · 策略细节保持私有。技术来源检查已完成，独立绩效审计待进行。',
      net: '账户净利润', mddPct: '最大回撤', trades: '成交笔数',
      unit: '固定单位收益', mddU: '最大回撤金额', lossRun: '最长连亏',
      window: '窗口（UTC，左闭右开）', incl: '（含）', excl: '（不含）',
      heroMeta: function (d) { return 'BTC / ETH · 30分钟方向研究\n数据截至 ' + d + ' UTC'; },
      err: '数据快照缺失或 schema 校验失败，已停止渲染，不展示任何估算值。'
    },
    en: {
      heroLead: 'RETURN.', heroAccent: 'RISK.', heroTail: 'IN PERSPECTIVE.', na: 'Not available',
      featureId: '01 / M1', featureHeading: 'A steadier starting point',
      featureCopy: 'Current research focus based on the balance of historical return and drawdown.',
      featureNet: 'Account net profit', featureMdd: 'Max drawdown',
      sectionLabel: 'Four models · one period',
      footer: 'Historical backtests · Each window restarts from 300U · Strategy details remain private. Source checks passed; an independent performance audit is pending.',
      net: 'Account net profit', mddPct: 'Max drawdown', trades: 'Trades',
      unit: 'Fixed unit profit', mddU: 'Max drawdown (amount)', lossRun: 'Longest loss run',
      window: 'Window (UTC, left-inclusive / right-exclusive)', incl: ' (incl.)', excl: ' (excl.)',
      heroMeta: function (d) { return 'BTC / ETH · 30-minute direction research\nData through ' + d + ' UTC'; },
      err: 'Snapshot missing or schema validation failed. Rendering stopped; no estimated values shown.'
    }
  };
  /* 时期英文标签（中文直接用原名） */
  var PERIOD_EN = { '近五年': 'Past 5 Years', '近三年': 'Past 3 Years', '近一年': 'Past 1 Year', '近三个月': 'Past 3 Months' };

  /* ---------- 工具：数字/日期格式化（两位小数 + 千分位），null → 未计算 ---------- */
  function fmtNum(v, suffix) {
    if (v === null || v === undefined || typeof v !== 'number' || !isFinite(v)) return T[state.lang].na;
    return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (suffix || '');
  }
  function fmtInt(v) {
    if (v === null || v === undefined || typeof v !== 'number' || !isFinite(v)) return T[state.lang].na;
    return Math.round(v).toLocaleString('en-US');
  }
  /* UTC 日期仅取 YYYY-MM-DD；解析失败返回原文，绝不虚构日期 */
  function fmtDate(iso) {
    if (!iso) return T[state.lang].na;
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso) : d.toISOString().slice(0, 10);
  }
  /* 报告的 end_exclusive_utc 是右端不含日期。公众看到的最后一天必须减一日，
     例如 2026-09-01 代表实际数据只到 2026-08-31，不能写成 9 月 1 日。 */
  function fmtCutoff(exclusive) {
    if (typeof exclusive !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(exclusive)) return T[state.lang].na;
    var millis = Date.parse(exclusive + 'T00:00:00Z');
    return isNaN(millis) ? T[state.lang].na : new Date(millis - 86400000).toISOString().slice(0, 10);
  }

  /* ---------- 数据校验：schema 不符即视为整体异常，优雅报错 ---------- */
  function validate(snap) {
    if (!snap || typeof snap !== 'object') return false;
    if (snap.schema !== SCHEMA || !Array.isArray(snap.windows) || snap.windows.length !== 16) return false;
    for (var i = 0; i < snap.windows.length; i++) {
      var w = snap.windows[i];
      if (!w || PERIOD_ORDER.indexOf(w.period) === -1) return false;
      if (typeof w.model !== 'string' || MODEL_ORDER.indexOf(w.model) === -1) return false;
    }
    return true;
  }
  /* 取当前时期的四行数据，按 M1-M4 固定顺序输出（四模型都显示，缺行也占位） */
  function rowsForPeriod(period) {
    return MODEL_ORDER.map(function (name) {
      var hit = (window.STRATEGY_SNAPSHOT.windows || []).filter(function (w) { return w.period === period && w.model === name; });
      return (hit.length === 1) ? hit[0] : { period: period, model: name, unit_profit_u: null, account_net_u: null, mdd_u: null, mdd_percent: null, longest_loss_run: null, trades: null, start_utc: null, end_exclusive_utc: null };
    });
  }

  /* ---------- 主渲染 ---------- */
  function render() {
    var t = T[state.lang];
    var snap = window.STRATEGY_SNAPSHOT;
    var ok = validate(snap);

    /* 标题分三个安全文本节点：只给中间词上蓝色，不插入动态 HTML。 */
    var title = $('#hero-title');
    title.replaceChildren();
    if (ok) {
      var accent = document.createElement('span'); accent.className = 'accent'; accent.textContent = t.heroAccent;
      title.append(document.createTextNode(t.heroLead + ' '), accent, document.createElement('br'), document.createTextNode(t.heroTail));
    } else { title.textContent = t.err; }
    document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
    $('#hero-meta').textContent = ok
      ? t.heroMeta(fmtCutoff(snap.data_cutoff_exclusive_utc))
      : t.err;
    $('#section-label').textContent = ok ? t.sectionLabel : t.err;
    $('#footer-copy').textContent = t.footer;
    $('#feature-id').textContent = t.featureId;
    $('#feature-heading').textContent = t.featureHeading;
    $('#feature-copy').textContent = t.featureCopy;
    $('#feature-net-label').textContent = t.featureNet;
    $('#feature-mdd-label').textContent = t.featureMdd;

    var rows = ok ? rowsForPeriod(state.period) : [];
    /* feature 固定 M1；当期缺值则如实显示未计算 */
    var m1 = rows[0] || null;
    $('#feature-net').textContent = m1 ? fmtNum(m1.account_net_u, ' U') : t.na;
    $('#feature-mdd').textContent = m1 ? fmtNum(m1.mdd_percent, '%') : t.na;

    /* 模型列表 */
    var list = $('#model-list');
    while (list.firstChild) list.removeChild(list.firstChild);
    if (!ok) return;

    /* bar 基准：当前时期最大正 account_net_u（统一零点）；负值不画正 bar */
    var maxPos = 0;
    rows.forEach(function (r) { if (typeof r.account_net_u === 'number' && r.account_net_u > maxPos) maxPos = r.account_net_u; });

    rows.forEach(function (r) {
      var li = document.createElement('li'); li.className = 'model-row' + (r.model === 'M1' ? ' is-selected' : '');
      var det = document.createElement('details');
      var sum = document.createElement('summary'); sum.className = 'row-head';

      var id = document.createElement('span'); id.className = 'model-id';
      id.textContent = r.model; sum.appendChild(id);

      var net = document.createElement('span'); net.className = 'row-net';
      net.textContent = fmtNum(r.account_net_u, ' U'); sum.appendChild(net);

      var track = document.createElement('div'); track.className = 'bar-track';
      var fill = document.createElement('div'); fill.className = 'bar-fill';
      var w = 0;
      if (typeof r.account_net_u === 'number' && r.account_net_u > 0 && maxPos > 0) w = Math.min(100, (r.account_net_u / maxPos) * 100);
      fill.style.width = w.toFixed(2) + '%';
      if (typeof r.account_net_u === 'number' && r.account_net_u < 0) fill.className = 'bar-fill is-negative';
      if (r.account_net_u === null) track.classList.add('is-missing');
      track.appendChild(fill); sum.appendChild(track);

      var meta = document.createElement('div'); meta.className = 'row-meta';
      meta.textContent = t.mddPct + ' ' + fmtNum(r.mdd_percent, '%') + '   ·   ' + t.trades + ' ' + fmtInt(r.trades);
      sum.appendChild(meta);
      det.appendChild(sum);

      var d = document.createElement('div'); d.className = 'row-detail';
      [t.unit + '：' + fmtNum(r.unit_profit_u, ' U'),
       t.mddU + '：' + fmtNum(r.mdd_u, ' U'),
       t.lossRun + '：' + fmtInt(r.longest_loss_run),
       t.window + '：' + fmtDate(r.start_utc) + t.incl + ' → ' + fmtDate(r.end_exclusive_utc) + t.excl
      ].forEach(function (line) {
        var p = document.createElement('p'); p.textContent = line; d.appendChild(p);
      });
      det.appendChild(d);
      li.appendChild(det);
      list.appendChild(li);
    });

    /* 更新时期按钮上的文字与选中态 */
    Array.prototype.forEach.call(document.querySelectorAll('#period-switch button'), function (b) {
      var on = b.getAttribute('data-period') === state.period;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('is-active', on);
      b.textContent = state.lang === 'zh' ? b.getAttribute('data-period') : PERIOD_EN[b.getAttribute('data-period')];
    });
  }

  /* ---------- 事件绑定：语言 / 时期切换 ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('#language-switch button'), function (b) {
    b.addEventListener('click', function () {
      state.lang = b.getAttribute('data-lang') === 'en' ? 'en' : 'zh';
      Array.prototype.forEach.call(document.querySelectorAll('#language-switch button'), function (x) {
        var on = x === b;
        x.setAttribute('aria-pressed', on ? 'true' : 'false');
        x.classList.toggle('is-active', on);
      });
      render();
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('#period-switch button'), function (b) {
    b.addEventListener('click', function () {
      var p = b.getAttribute('data-period');
      if (PERIOD_ORDER.indexOf(p) !== -1) { state.period = p; render(); }
    });
  });

  /* 初始化默认按钮态并首渲染 */
  document.querySelector('#language-switch button[data-lang="zh"]').classList.add('is-active');
  document.querySelector('#language-switch button[data-lang="zh"]').setAttribute('aria-pressed', 'true');
  render();
})();
