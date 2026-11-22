// Token Radar dashboard. Reads window.RADAR (data.js, written by main.ts from
// the same board as board.json) and renders: the ranked pre-token board, a
// live-token reference table kept strictly separate, filters, sortable
// columns, and a per-protocol detail view with the full model breakdown and
// the farm checklist exactly as board.json carries it. No network anywhere.
(function () {
  'use strict';
  var D = window.RADAR;
  if (!D) return;
  var app = document.getElementById('board');
  var S = { q: '', category: 'all', chain: 'all', band: 'all', tab: 'pre', sort: 'implied', dir: -1, selected: null };

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtPct(n) { return n === null || n === undefined ? 'n/a' : (n > 0 ? '+' : '') + n.toFixed(2) + '%'; }
  function fmtAge(d) {
    if (d === null || d === undefined) return 'unknown';
    if (d >= 365) return (d / 365).toFixed(1) + 'y';
    return Math.round(d) + 'd';
  }
  function fmtX(n) { return n === null || n === undefined ? 'n/a' : n.toFixed(2) + 'x'; }
  // Recompute a row's implied value from the factors stored on the row itself.
  // main.ts computes implied from these same rounded factors, so this must
  // reproduce board.json's integer exactly; the detail view shows the check.
  function recompute(r) {
    var m = r.model;
    return Math.max(1, Math.round(r.tvl_usd * m.category_multiple * m.growth_factor * m.maturity_factor * m.chain_factor));
  }
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) node.appendChild(x); });
      else node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }
  function readHash() {
    var h = window.location.hash.replace(/^#/, '');
    if (!h) return;
    var p = new URLSearchParams(h);
    if (p.get('q')) S.q = p.get('q');
    if (p.get('category')) S.category = p.get('category');
    if (p.get('chain')) S.chain = p.get('chain');
    if (p.get('band')) S.band = p.get('band');
    if (p.get('tab')) S.tab = p.get('tab');
    if (p.get('p')) S.selected = p.get('p');
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (S.q) p.set('q', S.q);
    if (S.category !== 'all') p.set('category', S.category);
    if (S.chain !== 'all') p.set('chain', S.chain);
    if (S.band !== 'all') p.set('band', S.band);
    if (S.tab !== 'pre') p.set('tab', S.tab);
    if (S.selected) p.set('p', S.selected);
    var s = p.toString();
    window.history.replaceState(null, '', s ? '#' + s : window.location.pathname + window.location.search);
  }
  var BANDS = { all: [0, Infinity], '1b': [1e9, Infinity], '250m': [2.5e8, 1e9], '50m': [5e7, 2.5e8], 'under50m': [0, 5e7] };
  function filtered() {
    var q = S.q.trim().toLowerCase();
    var band = BANDS[S.band] || BANDS.all;
    return D.rows.filter(function (r) {
      if (S.category !== 'all' && (r.category || 'Uncategorised') !== S.category) return false;
      if (S.chain !== 'all' && (r.chains || []).indexOf(S.chain) < 0) return false;
      if (r.tvl_usd < band[0] || r.tvl_usd >= band[1]) return false;
      if (!q) return true;
      return [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function sorted(list) {
    var k = S.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (k === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (k === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (k === 'growth') { av = a.change_7d === null ? -1e9 : a.change_7d; bv = b.change_7d === null ? -1e9 : b.change_7d; }
      else if (k === 'age') { av = a.age_days === null ? -1 : a.age_days; bv = b.age_days === null ? -1 : b.age_days; }
      else if (k === 'mult') { av = a.model.category_multiple; bv = b.model.category_multiple; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -S.dir;
      if (av > bv) return S.dir;
      return a.slug < b.slug ? -1 : 1;
    });
  }
  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), 'TOKEN RADAR'),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + D.as_of }),
        el('span', { text: D.total_protocols + ' protocols scanned' }),
        el('span', { text: 'Model ' + D.model_version })));
  }
  function lede() {
    var wl = D.rows.filter(function (r) { return r.on_watchlist; }).length;
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: 'Pre-token protocols, ranked by what a launch would be worth' }),
        el('p', { html: '' }, 'Every protocol here ', el('b', { text: 'records no token' }), ' in the snapshot. Implied value = TVL x a category multiple calibrated from tokenized peers in the same snapshot, adjusted for 7-day growth, years survived with no token, and chain reach. The watchlist (TVL at or above ' + fmtUsd(D.floor_usd) + ', no token recorded) is the floor, not the ceiling: the radar adds the strongest early protocols below it.')),
      el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('span', { text: 'Watchlist covered' }), el('b', { text: wl + ' / ' + D.watchlist_size })),
        el('div', { class: 'stat' }, el('span', { text: 'Ranked rows' }), el('b', { text: String(D.board_size) })),
        el('div', { class: 'stat' }, el('span', { text: 'Early, below floor' }), el('b', { text: String(D.early_size) })),
        el('div', { class: 'stat' }, el('span', { text: 'Live tokens aside' }), el('b', { text: String(D.live_size) }))));
  }
  function selectField(id, label, values, current, onchange) {
    var sel = el('select', { id: id, 'aria-label': label });
    values.forEach(function (v) {
      var o = el('option', { value: v[0], text: v[1] });
      if (v[0] === current) o.setAttribute('selected', 'selected');
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { onchange(sel.value); writeHash(); render(); });
    return el('div', { class: 'field' }, el('label', { for: id, text: label }), sel);
  }
  function controls() {
    var cats = Array.from(new Set(D.rows.map(function (r) { return r.category || 'Uncategorised'; }))).sort();
    var chains = Array.from(new Set(D.rows.flatMap(function (r) { return r.chains || []; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name or chain', value: S.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { S.q = search.value; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': S.tab === 'pre' ? 'true' : 'false', text: 'Pre-token board', onclick: function () { S.tab = 'pre'; writeHash(); render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': S.tab === 'live' ? 'true' : 'false', text: 'Live tokens (reference)', onclick: function () { S.tab = 'live'; writeHash(); render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      selectField('fc', 'Category', [['all', 'All categories']].concat(cats.map(function (c) { return [c, c]; })), S.category, function (v) { S.category = v; }),
      selectField('fh', 'Chain', [['all', 'All chains']].concat(chains.map(function (c) { return [c, c]; })), S.chain, function (v) { S.chain = v; }),
      selectField('fb', 'TVL band', [['all', 'All TVL'], ['1b', '$1B and up'], ['250m', '$250M - $1B'], ['50m', '$50M - $250M'], ['under50m', 'Under $50M']], S.band, function (v) { S.band = v; }),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'TOKEN STATUS' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: S.tab === 'pre' ? filtered().length + ' of ' + D.board_size + ' rows' : D.live.length + ' live protocols' }));
  }
  function th(key, label) {
    return el('th', { scope: 'col' }, el('button', { type: 'button', onclick: function () { if (S.sort === key) S.dir = -S.dir; else { S.sort = key; S.dir = -1; } render(); } }, label + (S.sort === key ? (S.dir < 0 ? ' v' : ' ^') : '')));
  }
  function boardTable() {
    var list = sorted(filtered());
    if (!list.length) return el('div', { class: 'panel' }, el('div', { class: 'empty' },
      el('h2', { text: 'No protocol matches that filter' }),
      el('p', { text: 'Clear the search or widen the filters to see the board again.' }),
      el('button', { class: 'btn primary', type: 'button', text: 'Clear filters', onclick: function () { S.q = ''; S.category = 'all'; S.chain = 'all'; S.band = 'all'; writeHash(); render(); } })));
    var max = Math.max.apply(null, list.map(function (r) { return r.implied_value_usd; }));
    var tbody = el('tbody');
    list.slice(0, 400).forEach(function (r) {
      var nameCell = el('div', { class: 'pname' },
        el('span', null, el('b', { text: r.name }), r.on_watchlist ? el('span', { class: 'wl', text: 'WATCHLIST' }) : null),
        el('span', { class: 'sub', text: (r.category || 'Uncategorised') + ' · ' + (r.chains || []).slice(0, 3).join(', ') + ((r.chains || []).length > 3 ? ' +' + (r.chains.length - 3) : '') }));
      tbody.appendChild(el('tr', { 'data-selected': S.selected === r.slug ? 'true' : 'false', tabindex: '0', onclick: function () { openDetail(r.slug); }, onkeydown: function (e) { if (e.key === 'Enter') openDetail(r.slug); } },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, nameCell),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: fmtX(r.model.category_multiple) }),
        el('td', null, el('div', { class: 'implied' }, el('div', { class: 'bar' }, el('i', { style: 'width:' + Math.max(3, Math.round(r.implied_value_usd / max * 100)) + '%' })), el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) }))),
        el('td', { class: 'num', text: '$' + r.farm_capital_usd }),
        el('td', null, el('span', { class: 'status', text: 'no token recorded' }))));
    });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' }, el('table', null,
      el('caption', { text: 'Ranked by implied value. WL = on the snapshot watchlist. Farm $ = suggested capital in the row farm plan. Select any row for its model breakdown and farm checklist. Showing all ' + list.length + ' filtered rows.' }),
      el('thead', null, el('tr', null, th('implied', 'Rank'), th('name', 'Protocol'), th('tvl', 'TVL'), th('growth', '7d'), th('age', 'Age'), th('mult', 'Multiple'), th('implied', 'Implied value'), el('th', { scope: 'col', text: 'Farm $' }), el('th', { scope: 'col', text: 'Token' }))),
      tbody)));
  }
  function liveTable() {
    var tbody = el('tbody');
    D.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('div', { class: 'pname' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Uncategorised') + ' · ' + (r.chains || []).slice(0, 2).join(', ') }))),
        el('td', { class: 'num', text: r.symbol || '—' }),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: fmtX(r.mcap_tvl) }),
        el('td', null, el('span', { class: 'status live', text: 'already trades' }))));
    });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' }, el('table', null,
      el('caption', { text: 'Reference only — never ranked. These protocols already trade; their real market caps are the peer set the category multiples were calibrated from.' }),
      el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'Symbol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Mcap / TVL' }), el('th', { scope: 'col', text: 'Token' }))),
      tbody)));
  }
  function modelPanel() {
    var rows = D.multiples.slice(0, 14).map(function (m) {
      return el('tr', null,
        el('td', { text: m.category }),
        el('td', { class: 'num', text: fmtX(m.multiple) }),
        el('td', { class: 'num', text: String(m.peers) }),
        el('td', { class: 'sub', text: m.source === 'category' ? 'category median' : m.source === 'blend' ? 'shrunk toward global median' : 'global median fallback' }));
    });
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed — model ' + D.model_version }),
      el('div', { class: 'formula', text: 'implied = round( TVL x category_multiple x growth_factor x maturity_factor x chain_factor )' }),
      el('p', { class: 'sub', text: 'category_multiple: median mcap/TVL of tokenized peers in the same category, each ratio winsorized into [0.02, 2.50] so one absurd print cannot poison a category; a category needs 4+ peers for its own median; with 1-3 peers the median is shrunk toward the global median, weighted by peer count, so one lucky peer cannot set a category price; none falls back to the global median; the result is clamped to [0.05, 1.50]. Wrapped, staked and bridged products of tokens that already trade (WBTC, USDT0, canonical bridges) are excluded from the ranked board for the same reason the watchlist excludes them. growth_factor = 1 + clamp(change_7d, -40, +80)% x 0.60 (missing growth counts as 0). maturity_factor = 0.78 + min(age_days, 1825)/1825 x 0.44 (unknown age: 400-day proxy). chain_factor = 1 + min(chains - 1, 5) x 0.03. No protocol name is special-cased anywhere: one function scores every row, and each row stores its own breakdown.' }),
      el('table', { class: 'mult-table' }, el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Category' }), el('th', { scope: 'col', text: 'Multiple' }), el('th', { scope: 'col', text: 'Tokenized peers' }), el('th', { scope: 'col', text: 'Derived as' }))), el('tbody', null, rows)),
      el('p', { class: 'sub', text: 'Implied value is this entry own model claim about a hypothetical launch, not a prediction that a token will exist or a price it would trade at. Protocols are described as recording no token, because the snapshot is a record, not proof.' }));
  }
  var dialog = el('dialog', { class: 'detail', id: 'detail' });
  dialog.addEventListener('close', function () { S.selected = null; writeHash(); });
  function openDetail(slug) {
    var r = D.rows.filter(function (x) { return x.slug === slug; })[0];
    if (!r) return;
    S.selected = slug;
    writeHash();
    dialog.textContent = '';
    var m = r.model;
    var check = recompute(r);
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'rankline', text: 'RANK ' + r.rank + ' OF ' + D.board_size + (r.on_watchlist ? ' · WATCHLIST' : ' · EARLY, BELOW THE FLOOR') }),
        el('h2', { text: r.name }),
        el('p', { class: 'sub', text: (r.category || 'Uncategorised') + ' · ' + (r.chains || []).join(', ') })),
      el('button', { class: 'close', type: 'button', text: 'Close', onclick: function () { dialog.close(); } })));
    dialog.appendChild(el('section', { class: 'dsec' },
      el('h3', { text: 'Model breakdown' }),
      el('div', { class: 'eq' },
        el('div', null, el('span', { text: 'TVL (snapshot)' }), el('b', { text: fmtUsd(r.tvl_usd) })),
        el('div', null, el('span', { text: 'x category multiple (' + m.multiple_peers + (m.multiple_peers === 1 ? ' peer' : ' peers') + ', ' + (m.multiple_source === 'category' ? 'category median' : m.multiple_source === 'blend' ? 'shrunk toward global' : 'global fallback') + ')' }), el('b', { text: fmtX(m.category_multiple) })),
        el('div', null, el('span', { text: '= base value' }), el('b', { text: fmtUsd(m.base_value_usd) })),
        el('div', null, el('span', { text: 'x growth factor (7d ' + fmtPct(r.change_7d) + ')' }), el('b', { text: fmtX(m.growth_factor) })),
        el('div', null, el('span', { text: 'x maturity factor (age ' + fmtAge(r.age_days) + ')' }), el('b', { text: fmtX(m.maturity_factor) })),
        el('div', null, el('span', { text: 'x chain factor (' + (r.chains || []).length + ' chains)' }), el('b', { text: fmtX(m.chain_factor) })),
        el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { text: fmtUsd(r.implied_value_usd) }))),
      el('p', { class: 'sub', text: 'This page recomputes the row from the factors above: ' + fmtUsd(check) + (check === r.implied_value_usd ? ' — identical to board.json.' : ' — differs from board.json, so the data would be stale.') })));
    dialog.appendChild(el('section', { class: 'dsec' },
      el('h3', { text: 'Farm plan — start with $' + r.farm_capital_usd + ' on ' + r.farm_chain }),
      el('ol', { class: 'check' }, r.farm_steps.map(function (s) { return el('li', null, el('span', { text: s })); })),
      el('p', { class: 'foot', text: 'Costs are estimated from the primary chain gas price: Ethereum L1 is priced near $12 per transaction, L2s at $0.10-$0.40, Solana near $0.02. Capital stays at risk in the protocol; a farm plan is not a guarantee of any token or reward.' })));
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute('open', '');
  }
  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(S.tab === 'pre' ? boardTable() : liveTable());
    if (S.tab === 'pre') shell.appendChild(modelPanel());
    shell.appendChild(el('p', { class: 'foot', text: 'Source: DefiLlama protocol index snapshot dated ' + D.as_of + '. Implied values are this radar model claims, never a promise of a launch.' }));
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (S.selected) openDetail(S.selected);
  }
  readHash();
  render();
})();
