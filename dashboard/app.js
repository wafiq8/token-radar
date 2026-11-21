// Token Radar dashboard. Renders entirely from window.RADAR (data.js, written
// by main.ts from the same board.json the gate grades): the board, a detail
// view per protocol, and filters. No network, no framework.
//
// Routes (location hash):
//   #/                      the board
//   #/?cat=&chain=&wl=&q=&sort=   the board with a filter applied
//   #/p/<slug>              one protocol's detail view

(function () {
  'use strict';
  var R = window.RADAR;
  var app = document.getElementById('app');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function commas(n) {
    return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function usd(n) {
    return '$' + commas(n);
  }
  function compact(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return usd(n);
  }
  function pct(x) {
    if (x === null || x === undefined) return '—';
    return (x > 0 ? '+' : '') + x.toFixed(1) + '%';
  }
  function fx(x) {
    return x.toFixed(3).replace(/0$/, '') + '×';
  }

  function parseHash() {
    var h = location.hash.replace(/^#/, '') || '/';
    var q = {};
    var qi = h.indexOf('?');
    if (qi >= 0) {
      new URLSearchParams(h.slice(qi + 1)).forEach(function (v, k) { q[k] = v; });
      h = h.slice(0, qi);
    }
    return { path: h, q: q };
  }

  function header(sub) {
    var s = R.stats;
    return (
      '<div class="topbar"><div class="brand"><div class="logo"></div><div>' +
      '<h1>TOKEN <span class="thin">RADAR</span></h1>' +
      '<p class="tagline">' + esc(sub) + '</p></div></div>' +
      '<div class="asof">Snapshot <b>' + esc(R.as_of) + '</b><br>' + esc(R.source) + '</div></div>' +
      '<div class="stats">' +
      '<div class="stat"><div class="k">Pre-token protocols ranked</div><div class="v">' + s.candidates + '</div><div class="s">of ' + s.protocols + ' protocols in the snapshot</div></div>' +
      '<div class="stat"><div class="k">House watchlist covered</div><div class="v">' + s.watchlist + ' / ' + s.watchlist + '</div><div class="s">every watchlist protocol, ranked in</div></div>' +
      '<div class="stat"><div class="k">Combined implied value</div><div class="v">' + compact(s.total_implied_usd) + '</div><div class="s">if every one launched today</div></div>' +
      '<div class="stat"><div class="k">Market multiple (median)</div><div class="v">' + s.global_multiple.toFixed(3) + '×</div><div class="s">market cap / TVL of traded protocols</div></div>' +
      '</div>' +
      '<div class="method"><b>The model:</b> implied value <span class="fx">= TVL × category multiple × momentum × maturity × breadth × size dampener</span> — every input is a figure from the snapshot itself; open any protocol to see its arithmetic. Each row also carries <b>launch odds</b> (its category’s launch base rate in this snapshot) and an <b>expected value</b> = implied × odds, and the model publishes its own held-out scores. <a href="#methodology">Full methodology below</a>.</div>'
    );
  }

  function categories() {
    var set = {};
    R.rows.forEach(function (r) { if (r.category) set[r.category] = 1; });
    return Object.keys(set).sort();
  }
  function chains() {
    var set = {};
    R.rows.forEach(function (r) { r.chains.forEach(function (c) { set[c] = 1; }); });
    return Object.keys(set).sort();
  }

  function boardView(q) {
    var cat = q.cat || '';
    var chain = q.chain || '';
    var wl = q.wl === '1';
    var query = (q.q || '').toLowerCase();
    var sort = q.sort || 'rank';

    var rows = R.rows.filter(function (r) {
      if (cat && r.category !== cat) return false;
      if (chain && r.chains.indexOf(chain) < 0) return false;
      if (wl && !r.watchlist) return false;
      if (query && r.name.toLowerCase().indexOf(query) < 0 && r.slug.indexOf(query) < 0) return false;
      return true;
    });
    var by = {
      rank: function (a, b) { return a.rank - b.rank; },
      ev: function (a, b) { return b.expected_value_usd - a.expected_value_usd; },
      odds: function (a, b) { return b.odds - a.odds; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      change: function (a, b) { return (b.change_7d || -1e9) - (a.change_7d || -1e9); },
      name: function (a, b) { return a.name < b.name ? -1 : 1; },
    };
    rows.sort(by[sort] || by.rank);

    var catOpts = '<option value="">All categories</option>' + categories().map(function (c) {
      return '<option' + (c === cat ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    var chainOpts = '<option value="">All chains</option>' + chains().map(function (c) {
      return '<option' + (c === chain ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    var sortOpts = [['rank', 'Sort: implied value'], ['ev', 'Sort: expected value'], ['odds', 'Sort: launch odds'], ['tvl', 'Sort: TVL'], ['change', 'Sort: 7-day change'], ['name', 'Sort: name']].map(function (o) {
      return '<option value="' + o[0] + '"' + (o[0] === sort ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('');

    var body = rows.map(function (r) {
      var chg = r.change_7d === null ? '<span class="num">—</span>'
        : '<span class="num ' + (r.change_7d >= 0 ? 'pos' : 'neg') + '">' + pct(r.change_7d) + '</span>';
      return '<tr data-slug="' + esc(r.slug) + '"' + (r.rank <= 3 ? ' class="top"' : '') + '>' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span>' + (r.watchlist ? '<span class="wl">WATCHLIST</span>' : '') +
        '<br><span class="pslug">' + esc(r.slug) + '</span></td>' +
        '<td><span class="cat">' + esc(r.category || 'Uncategorized') + '</span></td>' +
        '<td class="chains">' + r.chains.length + ' · ' + esc(r.chains.slice(0, 2).join(', ')) + (r.chains.length > 2 ? '…' : '') + '</td>' +
        '<td class="num">' + compact(r.tvl_usd) + '</td>' +
        '<td>' + chg + '</td>' +
        '<td class="num implied">' + compact(r.implied_value_usd) + '</td>' +
        '<td class="num">' + Math.round(r.odds * 100) + '%</td>' +
        '<td class="num ev">' + compact(r.expected_value_usd) + '</td>' +
        '<td class="farm"><b>' + esc(r.farm_cost) + '</b><br>' + esc(r.farm_time) + '</td></tr>';
    }).join('');

    return header('Protocols that record no token yet, ranked by what a launch would be worth — with the steps to farm each one before it happens.') +
      '<div class="controls">' +
      '<input type="search" id="q" placeholder="Search protocol or slug…" value="' + esc(q.q || '') + '">' +
      '<select id="cat">' + catOpts + '</select>' +
      '<select id="chain">' + chainOpts + '</select>' +
      '<label class="chk"><input type="checkbox" id="wl"' + (wl ? ' checked' : '') + '> Watchlist only</label>' +
      '<select id="sort">' + sortOpts + '</select>' +
      '<span class="count">' + rows.length + ' of ' + R.rows.length + ' shown</span></div>' +
      '<table><thead><tr>' +
      '<th data-sort="rank">#</th><th data-sort="name">Protocol</th><th>Category</th><th>Chains</th>' +
      '<th class="num" data-sort="tvl">TVL</th><th class="num" data-sort="change">7d</th>' +
      '<th class="num" data-sort="rank">Implied value</th><th class="num" data-sort="odds">Odds</th><th class="num" data-sort="ev">Expected value</th><th>Farm cost · time</th>' +
      '</tr></thead><tbody>' + (body || '<tr><td colspan="10"><div class="empty">No protocol matches that filter.</div></td></tr>') + '</tbody></table>' +
      methodology() +
      '<footer>Data: ' + esc(R.source) + '. Implied values are this board’s own model output, not a prediction that any token will launch; launch odds are category base rates from this snapshot — history, not a promise. Farm plans are starting points with typical costs — verify on the protocol’s official site and size to your own risk.</footer>';
  }

  function methodology() {
    var mult = R.multiples.slice(0, 14).map(function (m) {
      return '<tr><td>' + esc(m.category) + '</td><td class="num">' + m.n + '</td><td class="num">' + m.multiple.toFixed(3) + '×</td></tr>';
    }).join('');
    return '<section class="block" id="methodology"><h2>How this board is built</h2>' +
      '<p><b>The universe.</b> The snapshot holds ' + R.stats.protocols + ' protocols at $5M TVL or more. ' + R.stats.tokenized + ' already record a token and are set aside — this radar is only about the ones still to come. Of the ' + R.stats.tokenless + ' that record no token, ' + R.stats.excluded + ' are removed as wrapped, staked, bridged or versioned products of something that already trades (a V2, a liquid-staking wrapper, an exchange product): their launch already happened under another name. The remaining <b>' + R.stats.candidates + ' protocols are the board</b>, and every one of the snapshot’s ' + R.stats.watchlist + ' watchlist protocols is among them. “Records no token” is DefiLlama’s record, not a guarantee — a protocol may have a token its record does not carry.</p>' +
      '<p><b>The category multiple.</b> For each category, take every protocol whose token already trades, compute its market cap / TVL, winsorize to [0.02×, 3×], and take the median. Blend that median toward the market-wide median (' + R.stats.global_multiple.toFixed(3) + '×) in log space with weight n/(n+4), so a category with eleven traded peers keeps its character and a category with one peer cannot outvote the market.</p>' +
      '<p><b>The four tilts.</b> Momentum: the 7-day TVL change, clamped to ±30 points, worth at most ±15%. Maturity: +5% per year the protocol has run with no token, up to +20% — years of tokenless operation is the strongest sign of a product a launch can be priced on. Breadth: +1% per chain beyond the first, up to +9%. Size dampener: above $1B of TVL the multiple compresses toward a floor of 0.55, because billion-dollar protocols do not launch at full category multiples.</p>' +
      '<p><b>Category multiples used</b> (traded peers = n):</p>' +
      '<table class="mult"><thead><tr><th>Category</th><th class="num">Traded peers</th><th class="num">Multiple</th></tr></thead><tbody>' + mult +
      '<tr><td>All other categories</td><td class="num">—</td><td class="num">' + R.stats.global_multiple.toFixed(3) + '× market median</td></tr></tbody></table>' +
      '<p><b>Launch odds.</b> A base rate, not a prophecy: among the independent protocols in a category — the ones already trading a token plus the candidates on this board — the share that has launched. Market-wide that share is ' + Math.round(R.stats.global_launch_rate * 100) + '%. Each category’s raw share is shrunk toward it with the same n/(n+4) weight as the multiples, so a two-protocol category cannot claim certainty the market does not support. <b>Expected value</b> = implied value × odds: what a launch is worth, weighted by how often launches in its category actually happen. Sort the board by it and the ranking changes — big-but-unlikely gives ground to likely.</p>' +
      '<p><b>Evidence — the model grades itself.</b> The figures above are fitted on the whole snapshot; to test what that is worth, this program also re-fits both models twice on one half of the protocols (split by a hash of the slug) and predicts the other half, so every graded protocol was held out from its own fit. Value model: of the ' + R.evidence.value_tested + ' traded protocols carrying a market cap above zero, the median held-out prediction lands within ×' + R.evidence.value_median_factor + ' of the real market cap, ' + R.evidence.value_within_2x + '% land within 2×, and the ranking correlates with reality at Spearman ρ = ' + R.evidence.value_spearman.toFixed(2) + '. That scatter is the honest price of pricing from TVL alone — market caps also price narrative, float and timing, which no snapshot field carries — so it is published here rather than hidden. Odds model: across all ' + R.evidence.odds_tested + ' independent protocols, the category base rates score a Brier error of ' + R.evidence.odds_brier_model.toFixed(3) + ' against ' + R.evidence.odds_brier_naive.toFixed(3) + ' for quoting the market-wide rate for everyone — ' + R.evidence.odds_brier_gain + '% better calibrated, out of sample. Both scores are recomputed from the snapshot on every run; nothing here is a remembered number.</p>' +
      '<p><b>Farm plans.</b> Each row carries a five-step plan for its own category, filled with the protocol’s own chains, its scale tier and the gas its main chain actually costs — what to do, what it costs, and how long it takes. Costs are typical network fees, not protocol guarantees.</p></section>';
  }

  function detailView(slug) {
    var r = null;
    R.rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) return boardView({});
    var f = r.factors;
    var multNote = r.multiple_n > 0
      ? 'median of ' + r.multiple_n + ' traded ' + esc(r.category || '') + ' peer' + (r.multiple_n > 1 ? 's' : '') + ', blended toward the market'
      : 'no traded peers in this category — the market median';
    var ageTxt = r.age_years === null ? 'not reported' : r.age_years.toFixed(1) + ' years (since ' + esc(r.listed_at) + ')';
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    var chainChips = r.chains.map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('');
    return '<a class="back" href="#/">← Back to the board</a>' +
      '<div class="dhead"><h1>' + esc(r.name) + '</h1>' +
      (r.watchlist ? '<span class="wl">WATCHLIST</span>' : '') +
      '<span class="drank">Rank #' + r.rank + ' of ' + R.rows.length + '</span></div>' +
      '<p class="tagline">' + esc(r.category || 'Uncategorized') + ' · records no token in the ' + esc(R.as_of) + ' snapshot · ' + esc(r.slug) + '</p>' +
      '<div class="dgrid">' +
      '<div class="card"><h3>Protocol</h3>' +
      '<div class="kv"><span class="k">TVL</span><span class="v">' + usd(r.tvl_usd) + '</span></div>' +
      '<div class="kv"><span class="k">TVL change, 7 days</span><span class="v ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg') + '">' + pct(r.change_7d) + '</span></div>' +
      '<div class="kv"><span class="k">Running without a token</span><span class="v">' + ageTxt + '</span></div>' +
      '<div class="kv"><span class="k">Chains</span><span class="v">' + r.chains.length + '</span></div>' +
      '<div class="chips">' + chainChips + '</div>' +
      '<div class="kv"><span class="k">On the house watchlist</span><span class="v">' + (r.watchlist ? 'Yes — TVL above the $50M floor' : 'No — found below the floor by this radar') + '</span></div>' +
      '</div>' +
      '<div class="card"><h3>How the implied value is built</h3>' +
      '<div class="factor"><span class="fname">TVL<small>the snapshot’s figure, ' + esc(R.as_of) + '</small></span><span class="fval">' + usd(r.tvl_usd) + '</span></div>' +
      '<div class="factor"><span class="fname">× Category multiple<small>' + multNote + '</small></span><span class="fval">' + fx(r.multiple) + '</span></div>' +
      '<div class="factor"><span class="fname">× Momentum<small>7-day TVL change ' + pct(r.change_7d) + ', clamped to ±30 points</small></span><span class="fval">' + fx(f.momentum) + '</span></div>' +
      '<div class="factor"><span class="fname">× Maturity<small>' + (r.age_years === null ? 'listing date not reported — neutral' : r.age_years.toFixed(1) + ' years tokenless, +5% a year up to +20%') + '</small></span><span class="fval">' + fx(f.maturity) + '</span></div>' +
      '<div class="factor"><span class="fname">× Breadth<small>' + r.chains.length + ' chain' + (r.chains.length > 1 ? 's' : '') + ', +1% per extra chain up to +9%</small></span><span class="fval">' + fx(f.breadth) + '</span></div>' +
      '<div class="factor"><span class="fname">× Size dampener<small>' + (f.dampener < 1 ? 'TVL above $1B — the multiple compresses' : 'TVL below $1B — no compression') + '</small></span><span class="fval">' + fx(f.dampener) + '</span></div>' +
      '<div class="total"><span>Implied launch value</span><span class="v">' + usd(r.implied_value_usd) + '</span></div>' +
      '</div></div>' +
      '<section class="block"><h2>Launch odds & expected value</h2>' +
      '<div class="factor"><span class="fname">Category launch record<small>' + r.odds_launched + ' of ' + r.odds_n + ' independent ' + esc(r.category || 'Uncategorized') + ' protocols in this snapshot already trade a token</small></span><span class="fval">' + Math.round(r.odds_rate * 100) + '%</span></div>' +
      '<div class="factor"><span class="fname">Shrunk toward the market<small>market-wide launch rate ' + Math.round(R.stats.global_launch_rate * 100) + '%, weight n/(n+4) — small categories borrow the market’s evidence</small></span><span class="fval">' + Math.round(r.odds * 100) + '%</span></div>' +
      '<div class="total"><span>Expected value (implied × odds)</span><span class="v">' + usd(r.expected_value_usd) + '</span></div>' +
      '<p>Odds are a base rate from one snapshot: how often protocols in this category have launched, not whether this one will. A protocol can also stay tokenless by choice — the rate cannot see intent.</p></section>' +
      '<section class="block"><h2>Farm plan — ' + esc(r.name) + '</h2>' +
      '<div class="chips"><span class="chip">Cost <b>' + esc(r.farm_cost) + '</b></span><span class="chip">Time <b>' + esc(r.farm_time) + '</b></span><span class="chip">Category <b>' + esc(r.category || 'Uncategorized') + '</b></span></div>' +
      '<ol class="steps">' + steps + '</ol>' +
      '<p>Costs are typical network fees on the protocol’s main chain; protocol fees and minimums vary. A plan is a starting point, not a promise of any airdrop or token.</p></section>';
  }

  function render() {
    var parsed = parseHash();
    var html;
    if (parsed.path.indexOf('/p/') === 0) {
      html = '<div class="wrap">' + detailView(decodeURIComponent(parsed.path.slice(3))) + '</div>';
    } else {
      html = '<div class="wrap">' + boardView(parsed.q) + '</div>';
    }
    app.innerHTML = html;
    app.setAttribute('aria-busy', 'false');
    wire(parsed);
    window.scrollTo(0, 0);
  }

  function setParam(key, value) {
    var parsed = parseHash();
    var q = parsed.q;
    if (value) q[key] = value; else delete q[key];
    var qs = new URLSearchParams(q).toString();
    history.replaceState(null, '', '#/' + (qs ? '?' + qs : ''));
    render();
  }

  function wire(parsed) {
    if (parsed.path.indexOf('/p/') === 0) return;
    var q = document.getElementById('q');
    var cat = document.getElementById('cat');
    var chain = document.getElementById('chain');
    var wl = document.getElementById('wl');
    var sort = document.getElementById('sort');
    var timer = null;
    if (q) q.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { setParam('q', q.value.trim()); }, 220);
    });
    if (cat) cat.addEventListener('change', function () { setParam('cat', cat.value); });
    if (chain) chain.addEventListener('change', function () { setParam('chain', chain.value); });
    if (wl) wl.addEventListener('change', function () { setParam('wl', wl.checked ? '1' : ''); });
    if (sort) sort.addEventListener('change', function () { setParam('sort', sort.value); });
    Array.prototype.forEach.call(document.querySelectorAll('thead th[data-sort]'), function (th) {
      th.addEventListener('click', function () { setParam('sort', th.getAttribute('data-sort')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('tbody tr[data-slug]'), function (tr) {
      tr.addEventListener('click', function () { location.hash = '#/p/' + tr.getAttribute('data-slug'); });
    });
    var anchor = document.querySelector('a[href="#methodology"]');
    if (anchor) anchor.addEventListener('click', function (e) {
      e.preventDefault();
      var el = document.getElementById('methodology');
      if (el) el.scrollIntoView();
    });
  }

  window.addEventListener('hashchange', render);
  render();
})();
