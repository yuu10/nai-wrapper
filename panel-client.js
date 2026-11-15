// 画面の上に重ねて表示するパネル(自動生成・生成時間・入力補助・入力補助の設定・タグセット・プロンプト点検。それぞれ別のパネルで、別々に動かせる)。main.js が、NovelAI のページの中で実行する(executeJavaScript)。
// 全体が「payload を受け取る関数」の式になっている: (function (payload) { ... })
// payload: { token, showTime, showBatch, showAssist, showAssistSettings, showSets, showCheck, emphasis, assist: 入力補助の設定の状態, batch: 自動生成の状態 または null }
// ページからアプリへの操作(CSV を読み込む・停止など)は、console.log('__naiwrapper__:トークン:操作') で伝える(main.js が受け取る)。
(function (payload) {
  'use strict';

  // 再注入のときは、前のものを片付けてから作り直す
  if (window.__naiPanels) window.__naiPanels.dispose();

  const log = console.log.bind(console);
  const send = (cmd) => log('__naiwrapper__:' + payload.token + ':' + cmd);
  const settings = {
    showTime: payload.showTime !== false, showBatch: payload.showBatch !== false,
    showAssist: payload.showAssist !== false, showAssistSettings: payload.showAssistSettings !== false,
    showSets: payload.showSets !== false, showCheck: payload.showCheck !== false, markDuplicates: payload.markDuplicates !== false, showChips: payload.showChips !== false, chipsAlways: payload.chipsAlways === true, showViewBox: payload.showViewBox !== false,
    emphasis: payload.emphasis !== false,
  };
  let batch = payload.batch || null;
  const simpleCfg = Object.assign({ max: 10, minutes: 60 }, payload.simple || {}); // 連続生成の、最大回数と連続上限(分)

  // ---- 小さな保存(失敗しても動くようにする) ----
  const store = {
    get(area, key) { try { return window[area].getItem(key); } catch (_) { return null; } },
    set(area, key, value) { try { window[area].setItem(key, value); } catch (_) { /* 無視 */ } },
  };

  // ---- 表示用の整形 ----
  const fmt = (ms) => {
    const s = Math.max(0, ms) / 1000;
    if (s < 60) return s.toFixed(1) + ' 秒';
    const m = Math.floor(s / 60);
    return m + ' 分 ' + Math.floor(s - m * 60) + ' 秒';
  };

  // ---- 部品づくり(スタイルは style の代入だけで付ける) ----
  const COLORS = { bg: '#14163a', line: '#2a3070', text: '#dde0f5', sub: '#8a93c8', accent: '#6e7bff', ok: '#62dc8c', err: '#ff8080' };
  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  const btnCss = 'font:inherit;font-size:11px;color:' + COLORS.text + ';background:#232866;border:1px solid ' + COLORS.line +
    ';border-radius:4px;padding:3px 8px;cursor:pointer;';

  const container = el('div', 'position:fixed;right:12px;bottom:12px;z-index:2147483646;display:flex;flex-direction:column;gap:8px;' +
    'max-height:calc(100vh - 24px);overflow-y:auto;scrollbar-width:thin;align-items:flex-end;pointer-events:none;font:12px/1.5 system-ui,-apple-system,"Segoe UI","Yu Gothic UI",sans-serif;color:' + COLORS.text + ';');
  const host = el('div');
  container.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const wrap = el('div', 'display:flex;flex-direction:column;gap:8px;align-items:flex-end;');
  root.appendChild(wrap);
  // パネルの中の入力欄(名前・数字・選択)で打ったキーを、ページ側に渡さない。
  // 影の中のイベントは、ページから見ると「ただの div からのキー」になり、NovelAI のショートカットに横取りされて、打てないキーが出るため
  for (const type of ['keydown', 'keyup', 'keypress']) {
    root.addEventListener(type, (e) => {
      const t = e.composedPath()[0];
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) e.stopPropagation();
    });
  }
  (document.body || document.documentElement).appendChild(container);

  // ---- パネルごとに、ヘッダーのドラッグで動かせる ----
  // 動かしていないパネルは、右下の「まとめ置き場」(wrap)に縦に並ぶ。ドラッグすると、そのパネルだけが離れて、好きな位置に置ける。
  // 位置は「動ける範囲の、どのあたりか」の割合で持つ({ fx, fy }: 0 = 左・上の端、1 = 右・下の端、0.5 = 中央)。
  // 窓の大きさが変わっても(最大化・リサイズ)、同じ割合の位置に付いてくる。端から MARGIN だけ空け、窓の外には出さない
  const POS_KEY = 'naiWrapperPanelPos4'; // { パネルの id: { fx, fy } }
  const MARGIN = 12;
  const panels = []; // 作った順 = まとめ置き場での並び順
  const clamp01 = (n) => Math.min(1, Math.max(0, n));
  const savePositions = () => {
    const out = {};
    for (const p of panels) if (p.pos) out[p.id] = p.pos;
    store.set('localStorage', POS_KEY, JSON.stringify(out));
  };
  function dock(p) { // まとめ置き場に戻す(並び順は、作った順)
    p.pos = null;
    p.box.style.position = '';
    p.box.style.left = '';
    p.box.style.top = '';
    p.box.style.zIndex = '';
    const next = panels.slice(panels.indexOf(p) + 1).find(q => !q.pos && q.box.parentNode === wrap);
    wrap.insertBefore(p.box, next ? next.box : null);
  }
  function applyPanelPos(p) {
    if (!p.pos) return;
    if (p.box.parentNode !== root) root.appendChild(p.box); // 離れたパネルは、まとめ置き場の外に出す
    p.box.style.position = 'fixed';
    p.box.style.zIndex = '1';
    // 位置の基準は「ヘッダー」(幅も高さも、開閉で変わらない)。本体を開閉しても、ヘッダーは動かない。
    // 開いたときに下にはみ出す分だけ、そのときだけ上へずらす(閉じれば、元の位置に戻る)
    const r = p.box.getBoundingClientRect();
    const rangeX = Math.max(0, window.innerWidth - r.width - MARGIN * 2);
    const rangeY = Math.max(0, window.innerHeight - p.head.offsetHeight - MARGIN * 2);
    const top = MARGIN + p.pos.fy * rangeY;
    p.box.style.left = (MARGIN + p.pos.fx * rangeX) + 'px';
    p.box.style.top = Math.max(MARGIN, Math.min(top, window.innerHeight - MARGIN - r.height)) + 'px';
  }
  // まとめ置き場は、初めは右下の隅に付けて(下から伸びる)おく。パネルを開閉したときは、押したヘッダーが動かないように、
  // その時点の上の位置(dockTop)に固定して、下へ伸び縮みさせる。窓の大きさが変わったとき・まとめ直したときは、また右下に付ける
  let dockTop = null;
  function freezeDock() {
    if (dockTop !== null) return;
    dockTop = container.getBoundingClientRect().top;
    container.style.top = dockTop + 'px';
    container.style.bottom = 'auto';
  }
  function unfreezeDock() {
    dockTop = null;
    container.style.top = '';
    container.style.bottom = MARGIN + 'px';
  }
  function clampDock() { // 下にはみ出す分だけ、そのときだけ上へずらす(閉じれば、元の位置に戻る)
    if (dockTop === null) return;
    const h = container.getBoundingClientRect().height;
    container.style.top = Math.max(MARGIN, Math.min(dockTop, window.innerHeight - MARGIN - h)) + 'px';
  }
  const applyAllPos = () => { panels.forEach(applyPanelPos); clampDock(); };
  let drag = null;
  function startDrag(p, e) {
    if (e.button !== 0 || e.target.closest('button')) return;
    const r = p.box.getBoundingClientRect();
    drag = { p, dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.preventDefault();
  }
  function onMove(e) {
    if (!drag) return;
    const p = drag.p;
    const r = p.box.getBoundingClientRect();
    const rangeX = window.innerWidth - r.width - MARGIN * 2;
    const rangeY = window.innerHeight - p.head.offsetHeight - MARGIN * 2;
    p.pos = {
      fx: rangeX > 0 ? clamp01((e.clientX - drag.dx - MARGIN) / rangeX) : 1,
      fy: rangeY > 0 ? clamp01((e.clientY - drag.dy - MARGIN) / rangeY) : 1,
    };
    applyPanelPos(p);
  }
  function onUp() {
    if (!drag) return;
    drag = null;
    savePositions(); // 次に開いたときも、同じ位置に出す
  }
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('mouseup', onUp, true);
  const onResize = () => { unfreezeDock(); applyAllPos(); };
  window.addEventListener('resize', onResize);

  // パネル 1 枚: ヘッダー(題名・要約・最小化ボタン)と本体。最小化の状態は覚えておく(minimizedDefault: 初めての最小化の状態)
  function makePanel(id, title, opts = {}) {
    const key = 'naiWrapperPanelMin:' + id;
    const savedMin = store.get('localStorage', key);
    let minimized = savedMin === null ? !!opts.minimizedDefault : savedMin === '1';
    const box = el('div', 'pointer-events:auto;width:260px;background:' + COLORS.bg + ';border:1px solid ' + COLORS.line +
      ';border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.45);overflow:hidden;');
    const head = el('div', 'display:flex;align-items:center;gap:6px;padding:5px 8px;background:#1b1e4d;cursor:move;user-select:none;');
    const titleEl = el('span', 'font-weight:bold;', title);
    const summary = el('span', 'flex:1;text-align:right;color:' + COLORS.sub + ';font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;');
    const toggle = el('button', btnCss + 'padding:0 6px;line-height:16px;');
    const bar = el('div', 'height:3px;background:#0e0f21;display:none;');
    const fill = el('div', 'height:100%;width:0;background:' + COLORS.accent + ';');
    bar.appendChild(fill);
    const body = el('div', 'padding:8px;display:flex;flex-direction:column;gap:6px;');
    head.append(titleEl, summary, toggle);
    box.append(head, bar, body);
    const panel = {
      id, box, head, body, pos: null, visible: true,
      isOpen: () => !minimized,
      setSummary(text, color) { summary.textContent = text; summary.style.color = color || COLORS.sub; },
      setProgress(ratio) { bar.style.display = ratio === null ? 'none' : 'block'; fill.style.width = Math.round((ratio || 0) * 100) + '%'; },
      onOpen: null, // 開いたときに呼ぶ(最小化中は描き直さない内容を、開いたときに描くため)
    };
    head.addEventListener('mousedown', (e) => startDrag(panel, e));
    const apply = () => {
      body.style.display = minimized ? 'none' : 'flex';
      toggle.textContent = minimized ? '＋' : '－';
      toggle.title = minimized ? '開く' : '最小化';
    };
    toggle.addEventListener('click', () => {
      if (!panel.pos) freezeDock(); // まとめ置き場のパネルは、押したヘッダーが動かないようにする
      minimized = !minimized;
      store.set('localStorage', key, minimized ? '1' : '0');
      apply();
      clampDock();
      if (!minimized && panel.onOpen) panel.onOpen();
    });
    apply();
    panels.push(panel);
    return panel;
  }

  function row(label, value, color) {
    const r = el('div', 'display:flex;justify-content:space-between;gap:8px;');
    r.append(el('span', 'color:' + COLORS.sub + ';', label), el('span', 'font-variant-numeric:tabular-nums;' + (color ? 'color:' + color + ';' : ''), value));
    return r;
  }

  // ======== 生成時間のパネル ========
  const HISTORY_KEY = 'naiWrapperTimes';
  const HISTORY_MAX = 20;
  let times = [];
  try { times = JSON.parse(store.get('sessionStorage', HISTORY_KEY) || '[]').filter(n => typeof n === 'number'); } catch (_) { times = []; }
  let armed = null; // 生成中の計測: { t0, btn, sawBusy }

  const timePanel = makePanel('time', '生成時間');
  const isBusy = (b) => b.disabled || b.getAttribute('aria-disabled') === 'true';
  const matchesGen = (b) => /generate|生成/i.test(b.textContent || '');
  const findGen = () => [...document.querySelectorAll('button')].find(matchesGen) || null;

  function renderTime() {
    const b = timePanel.body;
    b.textContent = '';
    const now = Date.now();
    if (armed) b.appendChild(row('今の生成', armed.sawBusy ? fmt(now - armed.t0) : '開始待ち…', COLORS.accent));
    if (times.length) {
      const sum = times.reduce((a, n) => a + n, 0);
      b.appendChild(row('前回', fmt(times[times.length - 1])));
      b.appendChild(row('平均(' + times.length + ' 回)', fmt(sum / times.length)));
      b.appendChild(row('最短 / 最長', fmt(Math.min(...times)) + ' / ' + fmt(Math.max(...times))));
      const recent = times.slice(-5).reverse().map(n => (n / 1000).toFixed(1)).join(' / ');
      b.appendChild(el('div', 'color:' + COLORS.sub + ';font-size:11px;', '直近(秒): ' + recent));
    } else if (!armed) {
      b.appendChild(el('div', 'color:' + COLORS.sub + ';', 'まだ記録がありません。生成すると、ここに時間が出ます。'));
    }
    if (times.length) {
      const reset = el('button', btnCss + 'align-self:flex-end;', '記録を消す');
      reset.addEventListener('click', () => { times = []; store.set('sessionStorage', HISTORY_KEY, '[]'); renderTime(); });
      b.appendChild(reset);
    }
    timePanel.setSummary(armed ? (armed.sawBusy ? '生成中 ' + fmt(now - armed.t0) : '開始待ち') : times.length ? '前回 ' + fmt(times[times.length - 1]) : '');
  }

  function arm(btn) {
    if (armed || !btn || isBusy(btn)) return;
    armed = { t0: Date.now(), btn, sawBusy: false };
    renderTime();
  }
  // 生成ボタンの押下と、Ctrl(Cmd)+Enter を見て計測を始める(ボタンが「押せない状態」になったら生成中とみなし、戻ったら終わり)
  function onClick(e) {
    const b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (b && matchesGen(b)) arm(b);
  }
  function onKey(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) arm(findGen());
  }
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);

  function watchGeneration() {
    if (!armed) return;
    const now = Date.now();
    const b = armed.btn.isConnected ? armed.btn : findGen();
    const busy = !!b && isBusy(b);
    if (busy) armed.sawBusy = true;
    else if (armed.sawBusy) {
      times.push(now - armed.t0);
      if (times.length > HISTORY_MAX) times = times.slice(-HISTORY_MAX);
      store.set('sessionStorage', HISTORY_KEY, JSON.stringify(times));
      armed = null;
    } else if (now - armed.t0 > 4000) armed = null; // 押しても生成が始まらなかった(入力不足など)
    if (armed && now - armed.t0 > 10 * 60 * 1000) armed = null; // 長すぎる(異常)ときはやめる
  }

  // ======== 自動生成のパネル ========
  const batchPanel = makePanel('batch', '自動生成');

  function renderBatch() {
    const b = batchPanel.body;
    b.textContent = '';
    const s = batch;
    const running = !!(s && s.running);
    if (!s || !s.total) {
      b.appendChild(el('div', 'color:' + COLORS.sub + ';', '待機中。下の「CSV 自動生成」か「連続生成」を始めると、ここに進み具合が出ます。'));
      batchPanel.setSummary('待機中');
      batchPanel.setProgress(null);
    } else {
      const now = s.endedAt || s.pausedAt || Date.now(); // 一時停止中は、経過時間を止めて見せる
      const elapsed = s.startedAt ? now - s.startedAt : 0;
      const pct = s.done / s.total;
      if (s.mode === 'simple') { // 連続生成: 回数と時間の、どちらかが先に上限に達したら止まる。バーは、上限に近いほうを出す
        const limitMs = s.limitMs || 0;
        batchPanel.setProgress(Math.max(pct, limitMs ? Math.min(1, elapsed / limitMs) : 0));
        b.appendChild(row('連続生成', s.done + ' / ' + s.total + ' 回(' + Math.round(pct * 100) + '%)'));
        if (running) {
          b.appendChild(row('今の回', s.row + ' 回目 ' + (s.stage || '')));
          b.appendChild(row('経過 / 上限', fmt(elapsed) + ' / ' + fmt(limitMs)));
          if (s.done > 0) {
            const byCount = elapsed / s.done * (s.total - s.done);
            const byTime = Math.max(0, limitMs - elapsed);
            b.appendChild(row('終わるまで(目安)', fmt(Math.min(byCount, byTime)) + (byTime < byCount ? '(時間の上限)' : '(最大回数)')));
          }
        } else if (s.startedAt) {
          b.appendChild(row('かかった時間', fmt(elapsed)));
        }
      } else {
        batchPanel.setProgress(pct);
        b.appendChild(row('進み具合', s.done + ' / ' + s.total + ' 件(' + Math.round(pct * 100) + '%)'));
        if (running) {
          b.appendChild(row('今の行', s.row + ' 行目 ' + (s.stage || '')));
          b.appendChild(row('経過', fmt(elapsed)));
          if (s.done > 0) b.appendChild(row('残り(目安)', fmt(elapsed / s.done * (s.total - s.done))));
        } else if (s.startedAt) {
          b.appendChild(row('かかった時間', fmt(elapsed)));
        }
      }
      if (s.message) b.appendChild(el('div', 'font-size:11px;word-break:break-all;color:' + (s.kind === 'error' ? COLORS.err : s.kind === 'ok' ? COLORS.ok : COLORS.sub) + ';', s.message));
      const unit = s.mode === 'simple' ? ' 回' : '';
      batchPanel.setSummary(running ? (s.stopping ? '停止中 ' : s.paused ? '一時停止中 ' : s.pausing ? '一時停止待ち ' : '') + s.done + ' / ' + s.total + unit : (s.kind === 'error' ? '中断 ' : s.kind === 'ok' ? '完了 ' : '') + s.done + ' / ' + s.total + unit);
    }
    // 一時停止・再開と、停止: CSV 自動生成・連続生成の、どちらにも効く。進み具合のすぐ下に、横に並べて置く(動いている間だけ押せる)
    // 一時停止は、押したとき生成中なら、その 1 枚が終わってから止まる(「一時停止待ち」)。もう一度押すと再開(待っている間は、取り消し)
    const ctrlRow = el('div', 'display:flex;gap:6px;');
    const pause = el('button', btnCss + 'flex:1;padding:5px 8px;font-weight:bold;');
    const pauseOn = !!(s && (s.paused || s.pausing));
    pause.textContent = s && s.paused ? '再開' : s && s.pausing ? '一時停止待ち(取り消す)' : '一時停止';
    pause.disabled = !running || !!(s && s.stopping);
    if (pause.disabled) pause.style.opacity = '.4';
    else if (pauseOn) { pause.style.background = '#1f4a2b'; pause.style.borderColor = '#7fe08f'; pause.style.color = '#d0ffd8'; }
    pause.title = '次の回に進む前で止めて、もう一度押すと続きから再開する(メニュー「自動生成 → 一時停止」でも同じ)。生成中の 1 枚は、終わるまで待つ';
    pause.addEventListener('click', () => send('pause'));
    ctrlRow.appendChild(pause);
    const stop = el('button', btnCss + 'flex:1;padding:5px 8px;font-weight:bold;');
    stop.textContent = s && s.stopping ? '停止しています…' : '停止';
    stop.disabled = !running || !!(s && s.stopping);
    if (stop.disabled) stop.style.opacity = '.4';
    else { stop.style.background = '#5a1f2b'; stop.style.borderColor = '#ff8080'; stop.style.color = '#ffd0d0'; }
    stop.title = 'CSV 自動生成・連続生成を止める(メニュー「自動生成 → 停止」でも同じ)';
    stop.addEventListener('click', () => send('stop'));
    ctrlRow.appendChild(stop);
    b.appendChild(ctrlRow);

    const section = (title) => { // 区画(上に線と見出しを付ける)
      const box = el('div', 'border-top:1px solid ' + COLORS.line + ';padding-top:6px;display:flex;flex-direction:column;gap:5px;');
      box.appendChild(el('div', 'font-size:11px;color:' + COLORS.sub + ';', title));
      return box;
    };
    const numInputCss = 'width:64px;font:inherit;font-size:11px;color:' + COLORS.text + ';background:#0e0f21;border:1px solid ' + COLORS.line + ';border-radius:4px;padding:2px 4px;';

    // CSV 自動生成: CSV の行ごとに、プロンプトを変えて生成する
    const csvBox = section('CSV 自動生成(CSV の行ごとに、プロンプトを変えて生成)');
    const fromRow = el('label', 'display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11px;color:' + COLORS.sub + ';');
    const fromInput = el('input', numInputCss); // 何件目から始めるか(途中から再開するとき。開始するたびに 1 に戻る)
    fromInput.type = 'number';
    fromInput.min = '1';
    fromInput.step = '1';
    fromInput.value = String(s && s.startFrom >= 1 ? s.startFrom : 1);
    fromInput.disabled = running;
    fromInput.addEventListener('change', () => send('from:' + (Math.floor(Number(fromInput.value)) || 1))); // 入力中ではなく、確定したときに送る
    fromRow.append(document.createTextNode('何件目から始める'), fromInput);
    csvBox.appendChild(fromRow);
    const start = el('button', btnCss + 'width:100%;', 'CSV を読み込んで生成…');
    start.disabled = running;
    if (running) start.style.opacity = '.5';
    start.addEventListener('click', () => send('start'));
    csvBox.appendChild(start);
    b.appendChild(csvBox);

    // 連続生成: CSV を使わず、いまの画面の設定のまま、くり返す。最大回数と連続上限(分)のどちらかに先に達したら止まる
    const simpleBox = section('連続生成(いまの画面の設定で、くり返す)');
    const numRow = (label, value, max, cmd) => {
      const r = el('label', 'display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11px;color:' + COLORS.sub + ';');
      const input = el('input', numInputCss);
      input.type = 'number';
      input.min = '1';
      input.max = String(max);
      input.step = '1';
      input.value = String(value);
      input.disabled = running;
      input.addEventListener('change', () => { // 確定したときに、範囲に収めて送る
        const n = Math.min(max, Math.max(1, Math.floor(Number(input.value)) || 1));
        input.value = String(n);
        send(cmd + n);
      });
      r.append(document.createTextNode(label), input);
      return r;
    };
    simpleBox.appendChild(numRow('最大回数(1〜9999 回)', (s && s.simpleMax) || simpleCfg.max, 9999, 'simple:max:'));
    simpleBox.appendChild(numRow('連続上限(1〜180 分)', (s && s.simpleMinutes) || simpleCfg.minutes, 180, 'simple:min:'));
    const simpleStart = el('button', btnCss + 'width:100%;', '連続生成を開始');
    simpleStart.disabled = running;
    if (running) simpleStart.style.opacity = '.5';
    simpleStart.addEventListener('click', () => send('simple:start'));
    simpleBox.appendChild(simpleStart);
    b.appendChild(simpleBox);

    // 共通: Anlas を消費するときは止める
    const label = el('label', 'display:flex;align-items:center;gap:6px;font-size:11px;color:' + COLORS.sub + ';cursor:pointer;border-top:1px solid ' + COLORS.line + ';padding-top:6px;');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !s || s.stopIfCost !== false;
    cb.addEventListener('change', () => send(cb.checked ? 'cost:1' : 'cost:0'));
    label.append(cb, document.createTextNode('Anlas を消費するときは止める(どちらの生成でも)'));
    b.appendChild(label);
  }

  // ======== 生成エラーの検出 ========
  // NovelAI は、生成に失敗すると画面の端に通知(トースト)を出す。自動生成の実行中だけ、新しく追加された要素を見張り、
  // トーストらしい要素の中身がエラーらしければ、アプリに知らせる(止めるかどうかは、アプリ側の設定で決める)。
  // 実行前から出ていたトーストは「新しく追加された」ものではないので、対象にならない。
  const TOAST_SEL = '.Toastify__toast, [class*="toast" i], [role="alert"]';
  const ERROR_WORDS = /error|failed|failure|unable to|could ?n[o']t|too many|concurrent|busy|overloaded|try again|unavailable|timed? ?out|エラー|失敗|できませんでした|混雑|混み合|しばらく|再試行|もう一度/i;
  const toastText = (e) => (e.textContent || '').replace(/\s+/g, ' ').trim();
  const isErrorToast = (e) => {
    if (container.contains(e)) return false;
    const text = toastText(e);
    if (!text) return false;
    return /(^|[-_\s])error\b/i.test(typeof e.className === 'string' ? e.className : '') || ERROR_WORDS.test(text); // react-toastify のエラー用の見た目か、文言がエラーらしいか
  };
  const errorObserver = new MutationObserver((records) => {
    if (!batch || !batch.running) return;
    for (const rec of records) {
      for (const node of [...rec.addedNodes, ...(rec.type === 'characterData' ? [rec.target] : [])]) {
        const e = node.nodeType === 1 ? node : node.parentElement;
        if (!e) continue;
        const hit = [e.closest(TOAST_SEL), ...(e.querySelectorAll ? e.querySelectorAll(TOAST_SEL) : [])].find(c => c && isErrorToast(c));
        if (hit) { send('error:' + toastText(hit).slice(0, 120)); return; }
      }
    }
  });
  errorObserver.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });

  // ======== 強調の補助(Ctrl+↑ / Ctrl+↓) ========
  // 選んでいる文字(なければ、カーソルのあるタグ)の重みを、0.1 ずつ上げ下げする。NovelAI の「1.2::タグ::」の書き方で書き換える
  // (1.0 になったら記号を外す)。書き換えたあとも、その文字を選んだままにするので、続けて押せる
  const EDITOR_SEL = '.ProseMirror[contenteditable="true"]';
  // その入力欄に、いまフォーカスがあるか(カーソルが点滅しているか)。フォーカスが外れたあとも、選択の跡は画面に残るので、選択だけでは判断しない
  const hasFocus = (editor) => { const a = document.activeElement; return !!a && (a === editor || editor.contains(a)); };
  const EMPH_STEP = 0.1;
  const EMPH_MIN = -9.9; // 重みは、マイナスも使える(-9.9 〜 +9.9)
  const EMPH_MAX = 9.9;
  const blockOfNode = (node, editor) => {
    let n = node.nodeType === 1 ? node : node.parentNode;
    while (n && n.parentNode !== editor) n = n.parentNode;
    return n || editor;
  };
  const textUpTo = (block, node, offset) => {
    const r = document.createRange();
    r.selectNodeContents(block);
    r.setEnd(node, offset);
    return r.toString();
  };
  function rangeInBlock(block, start, end) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let at = 0;
    let sNode = null; let sOff = 0; let eNode = null; let eOff = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const len = node.nodeValue.length;
      if (!sNode && start <= at + len) { sNode = node; sOff = start - at; }
      if (end <= at + len) { eNode = node; eOff = end - at; break; }
      at += len;
    }
    if (!sNode || !eNode) return null;
    const range = document.createRange();
    range.setStart(sNode, sOff);
    range.setEnd(eNode, eOff);
    return range;
  }
  // 重みを変えた文字列を作る(text: 今の文字列。dir: +1 / -1)。変えられないときは null
  function reweigh(text, dir, step = EMPH_STEP) {
    const m = text.match(/^(-?\d+(?:\.\d+)?)::([\s\S]*?)::$/);
    const weight = m ? Number(m[1]) : 1;
    const inner = m ? m[2] : text;
    if (!inner.trim()) return null;
    const next = Math.round((weight + dir * step) * 10) / 10;
    const clamped = Math.min(EMPH_MAX, Math.max(EMPH_MIN, next));
    if (Math.abs(clamped - 1) < 0.001) return inner; // 1.0 は、記号なし
    return clamped.toFixed(1) + '::' + inner + '::';
  }
  // 今、重みを変える対象(選んでいる文字、なければカーソルのあるタグ)。なければ null
  function emphasisTarget() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.anchorNode) return null;
    const editorEl = (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    const editor = editorEl && editorEl.closest(EDITOR_SEL);
    if (!editor || !hasFocus(editor)) return null; // フォーカスのない入力欄には、重みをかけない
    const block = blockOfNode(sel.anchorNode, editor);
    let start; let end;
    if (!sel.isCollapsed) { // 選んでいる文字(1 つの段落の中だけ)
      const r = sel.getRangeAt(0);
      if (blockOfNode(r.startContainer, editor) !== block || blockOfNode(r.endContainer, editor) !== block) return null;
      start = textUpTo(block, r.startContainer, r.startOffset).length;
      end = textUpTo(block, r.endContainer, r.endOffset).length;
    } else { // カーソルのあるタグ(前後のカンマ・改行まで)
      const before = textUpTo(block, sel.anchorNode, sel.anchorOffset);
      const whole = block.textContent || '';
      const caret = before.length;
      const cutBefore = Math.max(before.lastIndexOf(','), before.lastIndexOf('、'), before.lastIndexOf('\n'));
      const rest = whole.slice(caret).search(/[,、\n]/);
      start = cutBefore + 1;
      end = rest < 0 ? whole.length : caret + rest;
      while (start < end && /\s/.test(whole[start])) start++;
      while (end > start && /\s/.test(whole[end - 1])) end--;
    }
    const text = (block.textContent || '').slice(start, end);
    if (!text.trim()) return null;
    return { sel, block, start, end, text };
  }
  // 今の文字列の、重みと中身({ weight, inner })
  function parseWeight(text) {
    const m = text.match(/^(-?\d+(?:\.\d+)?)::([\s\S]*?)::$/);
    return m ? { weight: Number(m[1]), inner: m[2] } : { weight: 1, inner: text };
  }
  // 対象の重みを変える(dir: +1 / -1 / 0 = 記号を外して 1.0 に戻す)。変えたら true
  function applyEmphasis(dir, step = EMPH_STEP) {
    const t = emphasisTarget();
    if (!t) return false;
    const replaced = dir === 0 ? parseWeight(t.text).inner : reweigh(t.text, dir, step);
    if (replaced === null || replaced === t.text) return false;
    const range = rangeInBlock(t.block, t.start, t.end);
    if (!range) return false;
    t.sel.removeAllRanges();
    t.sel.addRange(range);
    document.execCommand('insertText', false, replaced);
    // 入れた文字を選び直す(続けて押せるように)
    const now = window.getSelection();
    if (now && now.anchorNode) {
      const ed2 = (now.anchorNode.nodeType === 1 ? now.anchorNode : now.anchorNode.parentElement).closest(EDITOR_SEL);
      if (ed2) {
        const block2 = blockOfNode(now.anchorNode, ed2);
        const endAt = textUpTo(block2, now.anchorNode, now.anchorOffset).length;
        const again = rangeInBlock(block2, endAt - replaced.length, endAt);
        if (again) { now.removeAllRanges(); now.addRange(again); }
      }
    }
    return true;
  }
  function onEmphasisKey(e) {
    if (!settings.emphasis || !(e.ctrlKey || e.metaKey) || e.altKey) return; // Ctrl+↑↓ = 0.1 ずつ / Ctrl+Shift+↑↓ = 1.0 ずつ(超強・超弱のチップと同じ)
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (e.isComposing || e.keyCode === 229) return;
    if (!emphasisTarget()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    applyEmphasis(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey ? 1 : EMPH_STEP);
    renderAssist();
    updateChipWeight();
  }
  document.addEventListener('keydown', onEmphasisKey, true);

  // ======== 入力補助のパネル(強調・お気に入り・最近使ったタグ) ========
  // お気に入りと最近使ったタグは、suggest-client.js(辞書を取り込んでいるときだけ動く)が持っている。window.__naiSuggest から読む
  const assistPanel = makePanel('assist', '入力補助');
  const chipCss = 'display:inline-flex;align-items:center;gap:4px;background:#232866;border:1px solid ' + COLORS.line +
    ';border-radius:12px;padding:1px 8px;font-size:11px;cursor:pointer;color:' + COLORS.text + ';';
  const keepFocus = (node) => node.addEventListener('mousedown', (e) => e.preventDefault()); // 押しても、入力欄のカーソル・選択を動かさない
  const subLabel = (text) => el('div', 'color:' + COLORS.sub + ';font-size:11px;', text);

  // 強調(最初に 1 度だけ作り、文字だけ書き換える)
  const emphTag = el('div', 'font-size:11px;color:' + COLORS.sub + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;');
  const emphWeight = el('span', 'flex:1;text-align:center;font-size:15px;font-weight:bold;font-variant-numeric:tabular-nums;');
  const emphRow = el('div', 'display:flex;align-items:center;gap:6px;');
  const emphBtn = (label, title, dir) => {
    const bt = el('button', btnCss + 'padding:3px 10px;', label);
    bt.title = title;
    keepFocus(bt);
    bt.addEventListener('click', () => { applyEmphasis(dir); updateEmphasis(); });
    return bt;
  };
  emphRow.append(emphBtn('－', '重みを 0.1 下げる(Ctrl+↓)', -1), emphWeight, emphBtn('＋', '重みを 0.1 上げる(Ctrl+↑)', 1), emphBtn('戻す', '重みの記号を外して 1.0 に戻す', 0));
  let lastTarget = null; // 最後に見た、強調の対象
  function updateEmphasis() {
    const t = emphasisTarget();
    if (t) lastTarget = parseWeight(t.text);
    if (lastTarget) {
      emphTag.textContent = lastTarget.inner.length > 30 ? lastTarget.inner.slice(0, 30) + '…' : lastTarget.inner;
      emphWeight.textContent = lastTarget.weight.toFixed(1);
    } else {
      emphTag.textContent = 'プロンプト欄で、文字を選ぶか、タグにカーソルを置く';
      emphWeight.textContent = '—';
    }
  }

  // お気に入り・最近使ったタグ(変わったときだけ、作り直す)
  const favBox = el('div', 'display:flex;flex-wrap:wrap;gap:5px;');
  const recentBox = el('div', 'display:flex;flex-wrap:wrap;gap:5px;');
  const noDictMsg = el('div', 'color:' + COLORS.sub + ';font-size:11px;', '辞書を取り込むと、お気に入りと最近使ったタグが使えます(メニュー「入力補助」)。');
  const clearBtn = el('span', 'color:' + COLORS.sub + ';font-size:11px;text-decoration:underline;text-decoration-style:dotted;cursor:pointer;', '消す');
  clearBtn.addEventListener('click', () => { if (window.__naiSuggest) window.__naiSuggest.clearUserData(); updateLists(true); });
  const recentHead = el('div', 'display:flex;justify-content:space-between;align-items:baseline;');
  recentHead.append(subLabel('最近使ったタグ(☆でお気に入りへ)'), clearBtn);
  const favHead = subLabel('お気に入り(押すと、入力欄に入る)');
  let seenKey = null;
  function chip(name, isFav) {
    const sg = window.__naiSuggest;
    const c = el('span', chipCss);
    const star = el('span', 'font-size:11px;color:' + (isFav ? '#ffd24d' : '#667') + ';', isFav ? '★' : '☆');
    star.title = isFav ? 'お気に入りから外す' : 'お気に入りに入れる';
    star.addEventListener('click', (e) => { e.stopPropagation(); sg.toggleFav(name); updateLists(true); });
    const info = sg.tagInfo ? sg.tagInfo(name) : null; // 分類の色(候補リストと同じ)
    const label = el('span', info ? 'color:' + info.color + ';' : '', sg.display(name));
    c.append(star, label);
    c.title = '入力欄に入れる' + (info && info.label ? '(' + info.label + ')' : '');
    c.addEventListener('click', () => { sg.insert(name); updateLists(true); });
    keepFocus(c);
    return c;
  }
  function updateLists(force) {
    const sg = window.__naiSuggest;
    const has = !!(sg && sg.getUserData);
    const key = has ? sg.version() : -1;
    if (!force && key === seenKey) return;
    seenKey = key;
    const user = has ? sg.getUserData() : { favs: [], recents: [] };
    favHead.style.display = recentHead.style.display = favBox.style.display = recentBox.style.display = legend.style.display = has ? '' : 'none';
    renderLegend();
    noDictMsg.style.display = has ? 'none' : '';
    favBox.textContent = '';
    recentBox.textContent = '';
    for (const n of user.favs) favBox.appendChild(chip(n, true));
    for (const n of user.recents.filter(n => !user.favs.includes(n)).slice(0, 20)) recentBox.appendChild(chip(n, false));
    if (has && !user.favs.length) favBox.appendChild(el('span', 'color:' + COLORS.sub + ';font-size:11px;', 'まだありません。候補の ☆ を押すと入ります。'));
    if (has && !recentBox.children.length) recentBox.appendChild(el('span', 'color:' + COLORS.sub + ';font-size:11px;', 'まだありません。'));
    assistPanel.setSummary(has ? '★ ' + user.favs.length + ' ・ 最近 ' + user.recents.length : '');
  }
  const emphHead = subLabel('強調(選んだ文字・カーソルのタグ)');
  const legend = el('div', 'display:flex;flex-wrap:wrap;gap:8px;font-size:10px;'); // 色の見方(分類は、辞書から読む)
  const renderLegend = () => {
    legend.textContent = '';
    const sg = window.__naiSuggest;
    if (!sg || !sg.categories) return;
    for (const c of sg.categories()) legend.appendChild(el('span', 'color:' + c.color + ';', '■ ' + c.label));
  };
  assistPanel.body.append(emphHead, emphTag, emphRow, favHead, favBox, recentHead, recentBox, legend, noDictMsg);
  assistPanel.body.style.gap = '8px';
  const renderAssist = () => { updateEmphasis(); updateLists(); };
  assistPanel.onOpen = () => { updateEmphasis(); updateLists(true); };
  let selTimer = null;
  const onSelectionChange = () => {
    if (!settings.showAssist || !assistPanel.isOpen()) return;
    clearTimeout(selTimer);
    selTimer = setTimeout(updateEmphasis, 100);
  };
  document.addEventListener('selectionchange', onSelectionChange);

  // ======== 入力補助の設定のパネル ========
  // 設定の本体はアプリ側(settings.json)。ここは表示と操作だけで、変えたいときはアプリに知らせ、アプリが新しい状態を送り返してくる(setAssist)
  const setPanel = makePanel('assistset', '入力補助の設定', { minimizedDefault: true });
  let assist = { suggest: true, suggestComma: true, suggestSpace: true, suggestJa: true, suggestMigemo: true, suggestOnCaret: true, markDuplicates: true, showChips: true, chipsAlways: false, emphasis: settings.emphasis, suggestMax: 200, maxChoices: [50, 100, 200, 500], dict: '' };
  function renderSettings() {
    const b = setPanel.body;
    b.textContent = '';
    const check = (label, key) => {
      const l = el('label', 'display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !!assist[key];
      cb.addEventListener('change', () => send('opt:' + key + ':' + (cb.checked ? 1 : 0)));
      l.append(cb, document.createTextNode(label));
      b.appendChild(l);
    };
    check('タグのサジェストを使う', 'suggest');
    check('確定したとき「, 」を付ける', 'suggestComma');
    check('アンダーバーを空白にして入れる', 'suggestSpace');
    check('日本語名で検索する(日本語訳があるとき)', 'suggestJa');
    check('ローマ字で日本語を検索する(migemo)', 'suggestMigemo');
    check('文字の途中にカーソルを置いても候補を出す', 'suggestOnCaret');
    check('入力欄のそばに、強弱・お気に入り・履歴のチップを出す', 'showChips');
    check('チップを常に表示する(つまみ ≡ をドラッグして動かせる)', 'chipsAlways');
    check('プロンプトの重複タグを色で示す(点検パネル)', 'markDuplicates');
    check('強調のショートカット(Ctrl+↑↓)', 'emphasis');
    const maxRow = el('label', 'display:flex;align-items:center;justify-content:space-between;font-size:11px;');
    const sel = el('select', 'font:inherit;font-size:11px;color:' + COLORS.text + ';background:#0e0f21;border:1px solid ' + COLORS.line + ';border-radius:4px;padding:1px 4px;');
    for (const n of assist.maxChoices) {
      const o = document.createElement('option');
      o.value = String(n);
      o.textContent = n + ' 件';
      o.selected = n === assist.suggestMax;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => send('opt:suggestMax:' + sel.value));
    maxRow.append(document.createTextNode('候補の最大数'), sel);
    b.appendChild(maxRow);
    if (assist.dict) b.appendChild(el('div', 'white-space:pre-line;color:' + COLORS.sub + ';font-size:11px;border-top:1px solid ' + COLORS.line + ';padding-top:6px;', assist.dict));
  }

  // ======== タグセットのパネル ========
  // よく使うタグの組み合わせに名前を付けて覚え、押すと、入力欄のカーソルの位置にまとめて入れる。
  // ページの localStorage に、名前と文字だけ覚える。保存する文字は、入力欄で選んだ文字(選んでいなければ、カーソルのある段落)
  const SETS_KEY = 'naiWrapperTagSets';
  const SETS_MAX = 50;
  const SET_TEXT_MAX = 2000;
  const inputCss = 'font:inherit;font-size:11px;color:' + COLORS.text + ';background:#0e0f21;border:1px solid ' + COLORS.line + ';border-radius:4px;padding:2px 4px;';
  const setsPanel = makePanel('sets', 'タグセット', { minimizedDefault: true });
  let tagSets = [];
  try {
    const v = JSON.parse(store.get('localStorage', SETS_KEY) || '[]');
    if (Array.isArray(v)) tagSets = v.filter(x => x && typeof x.name === 'string' && typeof x.text === 'string');
  } catch (_) { tagSets = []; }
  const saveSets = () => store.set('localStorage', SETS_KEY, JSON.stringify(tagSets));
  const countTags = (text) => text.split(/[,、\n]/).map(t => t.trim()).filter(Boolean).length;

  // 入力欄の中のカーソル・選択(なければ null)
  function editorSelection() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.anchorNode) return null;
    const node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
    const editor = node && node.closest(EDITOR_SEL);
    return editor && hasFocus(editor) ? { sel, editor } : null; // フォーカスのない入力欄には、入れない
  }
  // 保存する文字: 選んでいる文字。なければ、カーソルのある段落。改行はカンマにまとめる
  function captureText() {
    const es = editorSelection();
    if (!es) return null;
    const raw = es.sel.isCollapsed ? (blockOfNode(es.sel.anchorNode, es.editor).textContent || '') : es.sel.toString();
    const text = raw.split(/\n+/).map(p => p.trim()).filter(Boolean).join(', ').replace(/[,、]\s*$/, '').trim();
    return text || null;
  }

  const setsMsg = el('div', 'font-size:11px;min-height:14px;color:' + COLORS.sub + ';');
  const say = (text, bad) => { setsMsg.textContent = text; setsMsg.style.color = bad ? COLORS.err : COLORS.sub; };
  const setsList = el('div', 'display:flex;flex-wrap:wrap;gap:5px;');
  let pendingText = null; // 「取り込む」で覚えた、保存する文字
  const pendingView = el('div', 'font-size:11px;color:' + COLORS.sub + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;', '保存する内容: (まだ取り込んでいません)');
  const nameInput = el('input', inputCss + 'flex:1;min-width:0;');
  nameInput.placeholder = 'セットの名前';
  nameInput.maxLength = 30;

  function insertSet(text) { // 入れたら true(入力欄にカーソルがないときは false)
    if (!editorSelection()) { say('入力欄にカーソルを置いてから押してください。', true); return false; }
    document.execCommand('insertText', false, text + (assist.suggestComma ? ', ' : ''));
    say('入れました。');
    return true;
  }
  function renderSets() {
    setsList.textContent = '';
    for (const s of tagSets) {
      const chip = el('span', chipCss);
      const label = el('span', '', s.name + '(' + countTags(s.text) + ')');
      const del = el('span', 'color:#8a93c8;font-size:11px;', '×');
      del.title = 'このセットを消す';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        tagSets = tagSets.filter(x => x !== s);
        saveSets();
        renderSets();
      });
      chip.append(label, del);
      chip.title = s.text.length > 200 ? s.text.slice(0, 200) + '…' : s.text;
      chip.addEventListener('click', () => insertSet(s.text));
      keepFocus(chip);
      setsList.appendChild(chip);
    }
    if (!tagSets.length) setsList.appendChild(el('span', 'color:' + COLORS.sub + ';font-size:11px;', 'まだありません。入力欄でタグを選んで「取り込む」を押し、名前を付けて保存します。'));
    setsPanel.setSummary(tagSets.length ? tagSets.length + ' 個' : '');
  }
  const importBtn = el('button', btnCss, '選んだ文字を取り込む');
  keepFocus(importBtn);
  importBtn.addEventListener('click', () => {
    const text = captureText();
    if (!text) { say('入力欄で、文字を選ぶか、カーソルを置いてから押してください。', true); return; }
    pendingText = text.length > SET_TEXT_MAX ? text.slice(0, SET_TEXT_MAX) : text;
    pendingView.textContent = '保存する内容: ' + pendingText;
    pendingView.title = pendingText;
    say(countTags(pendingText) + ' 個のタグを取り込みました。名前を付けて保存してください。');
  });
  const saveBtn = el('button', btnCss, '保存');
  saveBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!pendingText) { say('先に、入力欄で文字を選んで「取り込む」を押してください。', true); return; }
    if (!name) { say('セットの名前を入れてください。', true); return; }
    const same = tagSets.findIndex(x => x.name === name);
    if (same < 0 && tagSets.length >= SETS_MAX) { say('セットは ' + SETS_MAX + ' 個までです。', true); return; }
    if (same >= 0) tagSets[same] = { name, text: pendingText }; else tagSets.push({ name, text: pendingText });
    saveSets();
    renderSets();
    say(same >= 0 ? '「' + name + '」を上書きしました。' : '「' + name + '」を保存しました。');
    pendingText = null;
    pendingView.textContent = '保存する内容: (まだ取り込んでいません)';
    nameInput.value = '';
  });
  const saveRow = el('div', 'display:flex;gap:6px;');
  saveRow.append(nameInput, saveBtn);
  setsPanel.body.append(setsList, importBtn, pendingView, saveRow, setsMsg);
  setsPanel.body.style.gap = '8px';
  renderSets();

  // ======== プロンプト点検のパネル(タグ数・重複) ========
  // 入力欄ごとに、タグの数と、重複しているタグを出す。プロンプトとネガティブの両方にあるタグ(食い違い)も知らせる。
  // キャラクタープロンプトも数える(開いているカードは入力欄から。閉じているカードは、プレビューのボタンの文字から)。
  // タグの比べ方: 強調の記号(1.2:: :: { } [ ] ( ))を外し、大文字小文字と「_」と空白の違いを無視する
  const checkPanel = makePanel('check', 'プロンプト点検', { minimizedDefault: true });
  const normTag = (t) => t.trim().replace(/^[\[{(\s]+/, '').replace(/[\]})\s]+$/, '').replace(/^-?\d*\.?\d+::/, '').replace(/::$/, '').trim().toLowerCase().replace(/_/g, ' ').trim();
  const isShown = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const WARN_COLOR = '#ffe14d'; // 重複(入力欄の中の色と同じ)
  const CONFLICT_COLOR = '#5fd8ff'; // プロンプトとネガティブの両方にある(入力欄の中の色と同じ)

  // キャラクターのカード一覧(見出し「キャラクタープロンプト」の近く。自動生成と同じ見つけ方)。見出しは、見つけたものを覚えておく
  let charHeading = null;
  function findCharCards() {
    if (!charHeading || !charHeading.isConnected) {
      charHeading = [...document.querySelectorAll('div')].find(e => !e.children.length &&
        /^(キャラクタープロンプト|character prompts?)$/i.test((e.textContent || '').trim()) && isShown(e)) || null;
    }
    if (!charHeading) return [];
    for (let a = charHeading.parentElement; a; a = a.parentElement) {
      if (!a.querySelector('span > div > button')) continue;
      const top = a.parentElement;
      const section = top && top.parentElement;
      if (!section) return [];
      return [...section.children].filter(c => c !== top && c.querySelector('input'));
    }
    return [];
  }

  // 1 つ分の結果を作る。occ = タグごとの位置(入力欄の中で色を付けるため。プレビューの文字には付けられないので、空)
  function makeEntry(label, role, occ, approx) {
    const count = {};
    for (const o of occ) count[o.norm] = (count[o.norm] || 0) + 1;
    return {
      label, role, approx: !!approx,
      count: occ.length,
      tagSet: new Set(occ.map(o => o.norm)),
      dups: Object.keys(count).filter(k => count[k] > 1).map(k => [k, count[k]]),
      occ, countMap: count,
    };
  }
  function occFromEditor(ed) {
    const occ = [];
    for (const block of ed.children) {
      const text = block.textContent || '';
      const re = /[^,、\n]+/g;
      let m;
      while ((m = re.exec(text))) {
        const norm = normTag(m[0]);
        if (!norm) continue;
        const lead = m[0].length - m[0].trimStart().length;
        occ.push({ norm, block, start: m.index + lead, end: m.index + lead + m[0].trim().length });
      }
    }
    return occ;
  }
  function occFromText(text) {
    return text.split(/[,、\n]/).map(normTag).filter(Boolean).map(norm => ({ norm, block: null, start: 0, end: 0 }));
  }

  // キャラクターごとのネガティブ(除外したい要素)は、カードを開いているときしか画面に出ない。
  // 開いていたときの数と重複を覚えておき、閉じたあとは「前回の内容」として出す(このタブの間だけ。再読み込みしても残す)
  const CHAR_CACHE_KEY = 'naiWrapperCharCache';
  let charCache = {};
  try { charCache = JSON.parse(store.get('sessionStorage', CHAR_CACHE_KEY) || '{}') || {}; } catch (_) { charCache = {}; }
  function rememberChar(k, kind, e) {
    const prev = JSON.stringify(charCache[k] && charCache[k][kind]);
    const next = { count: e.count, dups: e.dups.slice(0, 20) };
    if (prev === JSON.stringify(next)) return;
    charCache[k] = Object.assign(charCache[k] || {}, { [kind]: next });
    store.set('sessionStorage', CHAR_CACHE_KEY, JSON.stringify(charCache));
  }
  function trimCharCache(n) { // カードが減ったら、なくなった分を忘れる
    let changed = false;
    for (const k of Object.keys(charCache)) if (Number(k) >= n) { delete charCache[k]; changed = true; }
    if (changed) store.set('sessionStorage', CHAR_CACHE_KEY, JSON.stringify(charCache));
  }
  function cachedEntry(label, role, c) { // c: 覚えていた { count, dups }。なければ「未確認」
    const e = makeEntry(label, role, []);
    if (c) { e.count = c.count; e.dups = c.dups; e.cached = true; } else e.unknown = true;
    return e;
  }

  function analyzeEditors() {
    const eds = [...document.querySelectorAll(EDITOR_SEL)].filter(isShown);
    const cards = findCharCards();
    const entries = [];
    // カードの外の入力欄: 1 つ目がプロンプト、2 つ目がネガティブ
    eds.filter(ed => !cards.some(c => c.contains(ed))).forEach((ed, i) => {
      entries.push(makeEntry(i === 0 ? 'プロンプト' : i === 1 ? 'ネガティブ' : '入力欄' + (i + 1), i === 0 ? 'prompt' : i === 1 ? 'negative' : 'other', occFromEditor(ed)));
    });
    // キャラクターのカード: 開いているものは入力欄(1 つ目がプロンプト、2 つ目が除外したい要素)。閉じているものは、プレビューの文字
    if (cards.length) trimCharCache(cards.length);
    cards.forEach((card, k) => {
      const name = 'キャラクタープロンプト' + (k + 1);
      const inside = eds.filter(ed => card.contains(ed));
      const cache = charCache[k] || {};
      if (inside.length) {
        inside.forEach((ed, j) => {
          const e = makeEntry(j === 0 ? name : name + '(除外)', j === 0 ? 'char' : 'charuc', occFromEditor(ed));
          entries.push(e);
          rememberChar(k, j === 0 ? 'prompt' : 'uc', e);
        });
        if (inside.length < 2) entries.push(cachedEntry(name + '(除外)', 'charuc', cache.uc)); // 入力欄が 1 つしか出ていないとき
      } else {
        const btn = card.querySelector(':scope > button');
        const text = btn ? (btn.textContent || '').trim() : '';
        const approx = /(…|\.\.\.)$/.test(text); // 末尾が省略されていたら、数は「以上」
        if (text && !(approx && cache.prompt)) entries.push(makeEntry(name, 'char', occFromText(text), approx));
        else if (cache.prompt) entries.push(cachedEntry(name, 'char', cache.prompt)); // プレビューが省略されているときは、覚えていた数
        // ネガティブは、カードを閉じていると画面に出ない。開いていたときの内容を出す
        entries.push(cachedEntry(name + '(除外)', 'charuc', cache.uc));
      }
    });
    return entries;
  }

  // 入力欄の中で、重複しているタグ(黄)と、プロンプトとネガティブの両方にあるタグ(水色)に色を付ける。
  // NovelAI は、もともと強調したタグの背景を赤くするので、赤とは違う色にしてある。
  // ブラウザの「ハイライト」(文字の範囲に色を重ねる機能)を使うので、入力欄の中身は書き換えない
  const HAS_MARKS = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined' && typeof CSSStyleSheet !== 'undefined';
  let markSheet = null;
  if (HAS_MARKS) {
    try {
      markSheet = new CSSStyleSheet();
      markSheet.replaceSync('::highlight(nai-wrapper-dup){background-color:' + WARN_COLOR + ';color:#111;text-decoration:underline;text-decoration-color:#111;}' +
        '::highlight(nai-wrapper-conflict){background-color:' + CONFLICT_COLOR + ';color:#111;text-decoration:underline;text-decoration-color:#111;}');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, markSheet];
    } catch (_) { markSheet = null; }
  }
  function clearMarks() {
    if (!HAS_MARKS) return;
    CSS.highlights.delete('nai-wrapper-dup');
    CSS.highlights.delete('nai-wrapper-conflict');
  }
  function applyMarks(list, both) {
    if (!HAS_MARKS || !markSheet) return;
    if (!settings.showCheck || !settings.markDuplicates) { clearMarks(); return; }
    const dup = [];
    const conflict = [];
    for (const x of list) {
      for (const o of x.occ) {
        if (!o.block) continue; // プレビューの文字には、色を付けられない
        const isDup = x.countMap[o.norm] > 1;
        const isBoth = (x.role === 'prompt' || x.role === 'negative') && both.includes(o.norm);
        if (!isDup && !isBoth) continue;
        const r = rangeInBlock(o.block, o.start, o.end);
        if (r) (isDup ? dup : conflict).push(r);
      }
    }
    if (dup.length) CSS.highlights.set('nai-wrapper-dup', new Highlight(...dup)); else CSS.highlights.delete('nai-wrapper-dup');
    if (conflict.length) CSS.highlights.set('nai-wrapper-conflict', new Highlight(...conflict)); else CSS.highlights.delete('nai-wrapper-conflict');
  }
  let checkSignature = '';
  let checkTick = 0;
  function renderCheck() {
    const list = analyzeEditors();
    const prompt = list.find(x => x.role === 'prompt');
    const negative = list.find(x => x.role === 'negative');
    const both = prompt && negative ? [...prompt.tagSet].filter(t => negative.tagSet.has(t)) : [];
    applyMarks(list, both); // 色は、毎回付け直す(入力欄が描き直されると、範囲が無効になるため)
    const signature = JSON.stringify([list.map(x => [x.label, x.count, x.dups, x.approx, x.cached, x.unknown]), both]);
    if (signature === checkSignature) return;
    checkSignature = signature;
    const b = checkPanel.body;
    b.textContent = '';
    if (!list.length) {
      b.appendChild(el('div', 'color:' + COLORS.sub + ';', '入力欄が見つかりません。'));
      checkPanel.setSummary('');
      return;
    }
    const dupTotal = list.reduce((n, x) => n + x.dups.length, 0); // 重複しているタグの数(入力欄をまたいで足す)
    const warn = dupTotal + both.length;
    for (const x of list) {
      if (x.unknown) { // カードを開いたことがなく、数えられない
        b.appendChild(row(x.label, '開くと数えます', COLORS.sub));
        continue;
      }
      b.appendChild(row(x.label, (x.cached ? '前回 ' : x.approx ? '約 ' : '') + x.count + ' タグ' + (x.dups.length ? '(重複 ' + x.dups.length + ')' : ''), x.dups.length ? WARN_COLOR : null));
      if (x.dups.length) {
        const shown = x.dups.slice(0, 6).map(d => d[0] + ' ×' + d[1]).join(', ') + (x.dups.length > 6 ? ' …' : '');
        b.appendChild(el('div', 'font-size:11px;color:' + WARN_COLOR + ';word-break:break-all;', shown));
      }
    }
    if (both.length) {
      b.appendChild(row('プロンプトとネガティブの両方', both.length + ' 個', CONFLICT_COLOR));
      b.appendChild(el('div', 'font-size:11px;color:' + CONFLICT_COLOR + ';word-break:break-all;', both.slice(0, 6).join(', ') + (both.length > 6 ? ' …' : '')));
    }
    if (!warn) b.appendChild(el('div', 'font-size:11px;color:' + COLORS.ok + ';', '重複はありません。'));
    // ヘッダーの表示: 重複しているタグの数(全部の入力欄の合計)。プロンプトとネガティブの両方にあるタグがあれば、その数も
    checkPanel.setSummary([dupTotal ? '重複 ' + dupTotal : '重複なし', both.length ? '両方 ' + both.length : ''].filter(Boolean).join(' ・ '),
      dupTotal ? WARN_COLOR : both.length ? CONFLICT_COLOR : COLORS.ok);
  }
  checkPanel.onOpen = () => { checkSignature = ''; renderCheck(); };
  // 入力したあと(0.25 秒待って)すぐ色を付け直す。そのほかは、1 秒ごと
  let markTimer = null;
  const onEditorInput = () => { if (!settings.showCheck) return; clearTimeout(markTimer); markTimer = setTimeout(renderCheck, 250); };
  document.addEventListener('input', onEditorInput, true);
  renderCheck();

  // ======== 入力欄のそばのチップ(強弱・お気に入り・履歴) ========
  // いまカーソルのある入力欄の右がわに、チップ(30px の四角)を縦に並べる。押しても、入力欄のカーソル・選択は動かさない。
  //   超強 / 強 / 弱 / 超弱 … いまフォーカスしているタグ(選んでいれば、選んだ文字)の重みを、1.0 / 0.1 ずつ上げ下げする(-9.9 〜 +9.9)
  //   ★ / 履歴 … 押すと、お気に入り / 最近使ったタグの候補の一覧が開き、行を押すと、カーソルの位置(選んでいれば、その上)に入る
  const CHIP_SIZE = 30;
  const MOD = /Mac/.test(navigator.platform || '') ? 'Cmd' : 'Ctrl'; // ショートカットの表示(macOS は Cmd)
  const chipBar = el('div', 'position:fixed;z-index:1;display:none;flex-direction:column;gap:4px;align-items:center;pointer-events:auto;');
  // 常に表示のとき: つまみ(≡)をドラッグして動かせる。位置は、窓全体に対する割合(パネルと同じ考え方)で覚える
  const CHIP_POS_KEY = 'naiWrapperChipPos';
  const CHIP_POS_DEFAULT = { fx: 1, fy: 0.4 };
  let chipPos = Object.assign({}, CHIP_POS_DEFAULT);
  try {
    const v = JSON.parse(store.get('localStorage', CHIP_POS_KEY) || 'null');
    if (v && Number.isFinite(v.fx) && Number.isFinite(v.fy)) chipPos = { fx: clamp01(v.fx), fy: clamp01(v.fy) };
  } catch (_) { /* 既定の位置のまま */ }
  const chipGrip = el('div', 'display:none;width:' + CHIP_SIZE + 'px;height:12px;line-height:12px;text-align:center;font-size:12px;color:' + COLORS.sub + ';cursor:move;user-select:none;', '≡');
  chipGrip.title = 'ドラッグで動かせる';
  chipBar.appendChild(chipGrip);
  const chipWeight = el('div', 'font-size:11px;line-height:14px;height:14px;color:' + COLORS.sub + ';font-variant-numeric:tabular-nums;', '—');
  chipBar.appendChild(chipWeight);
  function makeChip(label, color, title, onClick) {
    const c = el('div', 'width:' + CHIP_SIZE + 'px;height:' + CHIP_SIZE + 'px;box-sizing:border-box;border-radius:6px;background:#232866;border:1px solid #3a4aa8;' +
      'display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:bold;color:' + color + ';cursor:pointer;user-select:none;box-shadow:0 2px 6px rgba(0,0,0,.4);', label);
    c.title = title;
    keepFocus(c);
    c.addEventListener('click', (e) => { e.stopPropagation(); onClick(c); });
    chipBar.appendChild(c);
    return c;
  }
  function updateChipWeight() {
    const t = emphasisTarget();
    if (!t) return;
    const w = parseWeight(t.text).weight;
    chipWeight.textContent = w.toFixed(1);
    chipWeight.style.color = w === 1 ? COLORS.sub : COLORS.text;
  }
  // 入力欄にフォーカス(カーソル)がないときは、何も入れず、挿入する場所にカーソルを置くよう知らせる
  const chipNotice = el('div', 'position:fixed;z-index:3;display:none;max-width:220px;padding:6px 10px;background:#3a1420;border:1px solid #ff8080;border-radius:6px;color:#ffd0d0;font-size:12px;line-height:1.5;box-shadow:0 4px 16px rgba(0,0,0,.5);pointer-events:none;');
  let chipNoticeTimer = null;
  function showChipNotice(text) {
    chipNotice.textContent = text;
    chipNotice.style.display = 'block';
    const bar = chipBar.getBoundingClientRect();
    let left = bar.left - chipNotice.offsetWidth - 8;
    if (left < 4) left = Math.min(bar.right + 8, window.innerWidth - chipNotice.offsetWidth - 4);
    chipNotice.style.left = Math.max(4, left) + 'px';
    chipNotice.style.top = Math.max(4, Math.min(bar.top, window.innerHeight - chipNotice.offsetHeight - 4)) + 'px';
    clearTimeout(chipNoticeTimer);
    chipNoticeTimer = setTimeout(() => { chipNotice.style.display = 'none'; }, 3000);
  }
  const needFocus = () => {
    if (focusedEditor()) return true;
    closeChipList();
    showChipNotice('挿入する場所(入力欄)に、カーソルを置いてから押してください。');
    return false;
  };
  const strengthChip = (dir, step) => () => { if (!needFocus()) return; closeChipList(); applyEmphasis(dir, step); updateChipWeight(); };
  makeChip('超強', '#ff7a5c', '重みを 1.0 上げる(' + MOD + '+Shift+↑)', strengthChip(1, 1));
  makeChip('強', '#ffb85c', '重みを 0.1 上げる(' + MOD + '+↑)', strengthChip(1, 0.1));
  makeChip('1.0', '#dde0f5', '重みを 1.0 に戻す(強調の記号を外す)', () => { if (!needFocus()) return; closeChipList(); applyEmphasis(0); updateChipWeight(); }); // 強と弱の間: ニュートラル
  makeChip('弱', '#7fc4ff', '重みを 0.1 下げる(' + MOD + '+↓)', strengthChip(-1, 0.1));
  makeChip('超弱', '#5c8cff', '重みを 1.0 下げる(' + MOD + '+Shift+↓)', strengthChip(-1, 1));
  const listChip = (kind, label, color, title) => makeChip(label, color, title, () => { if (needFocus()) toggleChipList(kind); });
  listChip('fav', '★', '#ffd24d', 'お気に入りの一覧を開く(' + MOD + '+Shift+F)');
  listChip('recent', '履歴', '#9fb4ff', '最近使ったタグの一覧を開く(' + MOD + '+Shift+H)');
  listChip('sets', 'セット', '#c79bff', 'タグセットの一覧を開く(' + MOD + '+Shift+S。「タグセット」パネルで保存したもの)');
  root.appendChild(chipBar);
  root.appendChild(chipNotice);

  // 候補の一覧(お気に入り / 履歴)
  const chipList = el('div', 'position:fixed;z-index:2;display:none;width:230px;max-height:260px;overflow-y:auto;background:#14162e;border:1px solid #3a3f78;' +
    'border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.5);font-size:12px;pointer-events:auto;');
  root.appendChild(chipList);
  let chipListKind = null;
  function closeChipList() { chipListKind = null; chipList.style.display = 'none'; }
  function positionChipList() {
    const bar = chipBar.getBoundingClientRect();
    chipList.style.display = 'block';
    const w = chipList.offsetWidth;
    const h = chipList.offsetHeight;
    let left = bar.left - w - 6;
    if (left < 4) left = Math.min(bar.right + 6, window.innerWidth - w - 4);
    chipList.style.left = Math.max(4, left) + 'px';
    chipList.style.top = Math.max(4, Math.min(bar.top, window.innerHeight - h - 4)) + 'px';
  }
  function renderChipList() {
    chipList.textContent = '';
    if (chipListKind === 'sets') { // タグセット(辞書がなくても使える)
      if (!tagSets.length) {
        chipList.appendChild(el('div', 'padding:8px;color:' + COLORS.sub + ';', 'タグセットはまだありません。「タグセット」パネルで保存します。'));
        return;
      }
      for (const s of tagSets) {
        const item = el('div', 'display:flex;align-items:baseline;gap:6px;padding:4px 8px;cursor:pointer;');
        item.append(el('span', 'font-weight:bold;color:#c79bff;white-space:nowrap;', s.name + '(' + countTags(s.text) + ')'));
        item.appendChild(el('span', 'margin-left:auto;color:#8a93c8;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100px;', s.text));
        item.title = s.text.length > 200 ? s.text.slice(0, 200) + '…' : s.text;
        item.addEventListener('mouseenter', () => { item.style.background = '#2a3070'; });
        item.addEventListener('mouseleave', () => { item.style.background = ''; });
        item.addEventListener('click', () => {
          if (insertSet(s.text)) { closeChipList(); updateChipWeight(); return; }
          item.textContent = '入力欄にカーソルを置いてから押してください。';
          item.style.color = COLORS.err;
        });
        keepFocus(item);
        chipList.appendChild(item);
      }
      return;
    }
    const sg = window.__naiSuggest;
    if (!sg || !sg.getUserData) {
      chipList.appendChild(el('div', 'padding:8px;color:' + COLORS.sub + ';', '辞書を取り込むと使えます(メニュー「入力補助」)。'));
      return;
    }
    const user = sg.getUserData();
    const names = chipListKind === 'fav' ? user.favs : user.recents.slice(0, 30);
    if (!names.length) {
      chipList.appendChild(el('div', 'padding:8px;color:' + COLORS.sub + ';', chipListKind === 'fav' ? 'お気に入りはまだありません。候補の ☆ を押すと入ります。' : '履歴はまだありません。'));
      return;
    }
    for (const name of names) {
      const info = sg.tagInfo ? sg.tagInfo(name) : null; // 分類の色(候補リストと同じ)
      const isFav = user.favs.includes(name);
      const item = el('div', 'display:flex;align-items:baseline;gap:6px;padding:4px 8px;cursor:pointer;');
      const star = el('span', 'font-size:11px;color:' + (isFav ? '#ffd24d' : '#667') + ';', isFav ? '★' : '☆');
      star.title = isFav ? 'お気に入りから外す' : 'お気に入りに入れる';
      star.addEventListener('click', (e) => { e.stopPropagation(); sg.toggleFav(name); renderChipList(); positionChipList(); });
      item.append(star, el('span', 'font-weight:bold;color:' + (info ? info.color : '#aab') + ';', sg.display(name)));
      const ja = sg.ja ? sg.ja(name) : '';
      if (ja) item.appendChild(el('span', 'margin-left:auto;color:#8a93c8;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:90px;', ja));
      item.addEventListener('mouseenter', () => { item.style.background = '#2a3070'; });
      item.addEventListener('mouseleave', () => { item.style.background = ''; });
      item.addEventListener('click', () => {
        if (!sg.insert(name)) { closeChipList(); showChipNotice('挿入する場所(入力欄)に、カーソルを置いてから押してください。'); return; }
        closeChipList();
        updateChipWeight();
      });
      keepFocus(item);
      chipList.appendChild(item);
    }
  }
  function toggleChipList(kind) {
    if (chipListKind === kind) { closeChipList(); return; }
    chipListKind = kind;
    renderChipList();
    positionChipList();
  }

  // 位置と表示: カーソルのある入力欄だけに出す。入力欄の外へフォーカスが移ったら消す
  function focusedEditor() {
    const a = document.activeElement;
    const ed = a && a.closest ? a.closest(EDITOR_SEL) : null;
    return ed && isShown(ed) ? ed : null;
  }
  function updateChips() {
    chipGrip.style.display = settings.showChips && settings.chipsAlways ? 'block' : 'none';
    if (settings.showChips && settings.chipsAlways) { // 常に表示: 入力欄のフォーカスに関係なく、決めた位置に出す
      chipBar.style.display = 'flex';
      const rangeX = Math.max(0, window.innerWidth - (CHIP_SIZE + 2) - MARGIN * 2);
      const rangeY = Math.max(0, window.innerHeight - chipBar.offsetHeight - MARGIN * 2);
      chipBar.style.left = (MARGIN + chipPos.fx * rangeX) + 'px';
      chipBar.style.top = (MARGIN + chipPos.fy * rangeY) + 'px';
      if (chipListKind) positionChipList();
      return;
    }
    const ed = settings.showChips ? focusedEditor() : null;
    if (!ed) { chipBar.style.display = 'none'; chipNotice.style.display = 'none'; closeChipList(); return; }
    chipBar.style.display = 'flex';
    const r = ed.getBoundingClientRect();
    const w = CHIP_SIZE + 2;
    let left = r.right + 6;
    if (left + w > window.innerWidth - 4) left = Math.max(4, r.right - w - 6); // 右に入らないときは、入力欄の右端に重ねる
    const top = Math.max(4, Math.min(r.top, window.innerHeight - chipBar.offsetHeight - 4));
    chipBar.style.left = left + 'px';
    chipBar.style.top = top + 'px';
    if (chipListKind) positionChipList();
  }
  let chipDrag = null;
  chipGrip.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !settings.chipsAlways) return;
    const r = chipBar.getBoundingClientRect();
    chipDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.preventDefault();
  });
  const onChipDragMove = (e) => {
    if (!chipDrag) return;
    const rangeX = window.innerWidth - (CHIP_SIZE + 2) - MARGIN * 2;
    const rangeY = window.innerHeight - chipBar.offsetHeight - MARGIN * 2;
    chipPos = {
      fx: rangeX > 0 ? clamp01((e.clientX - chipDrag.dx - MARGIN) / rangeX) : 1,
      fy: rangeY > 0 ? clamp01((e.clientY - chipDrag.dy - MARGIN) / rangeY) : 0,
    };
    updateChips();
  };
  const onChipDragUp = () => {
    if (!chipDrag) return;
    chipDrag = null;
    store.set('localStorage', CHIP_POS_KEY, JSON.stringify(chipPos)); // 次に開いたときも、同じ位置に出す
  };
  window.addEventListener('mousemove', onChipDragMove, true);
  window.addEventListener('mouseup', onChipDragUp, true);
  let chipTimer = null;
  const scheduleChips = () => { clearTimeout(chipTimer); chipTimer = setTimeout(updateChips, 60); };
  let chipSelTimer = null;
  const onChipSelection = () => {
    if (chipBar.style.display === 'none') return;
    clearTimeout(chipSelTimer);
    chipSelTimer = setTimeout(updateChipWeight, 100);
  };
  const onChipOutside = (e) => { // 一覧の外を押したら閉じる(チップと一覧は、影の中)
    if (chipListKind && !e.composedPath().includes(host)) closeChipList();
  };
  const CHIP_LIST_KEYS = { KeyF: 'fav', KeyH: 'recent', KeyS: 'sets' }; // Ctrl(Cmd)+Shift+F / H / S で、一覧を開く・閉じる
  const onChipKey = (e) => {
    if (e.key === 'Escape' && chipListKind) { closeChipList(); return; }
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.isComposing || e.keyCode === 229) return;
    const kind = CHIP_LIST_KEYS[e.code];
    if (!kind || !settings.showChips || !focusedEditor()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    updateChips(); // 一覧は、チップの横に出すので、先にチップの位置を決める
    toggleChipList(kind);
  };
  document.addEventListener('focusin', scheduleChips, true);
  document.addEventListener('focusout', scheduleChips, true);
  document.addEventListener('selectionchange', onChipSelection);
  document.addEventListener('mousedown', onChipOutside, true);
  document.addEventListener('keydown', onChipKey, true);
  window.addEventListener('scroll', scheduleChips, true);
  window.addEventListener('resize', scheduleChips);
  updateChips(); // 常に表示のときは、起動した直後から出す

  // ======== 「表示」ツールチップ(再読み込み・拡大縮小・全画面と、今の拡大率) ========
  // メニュー「View」と同じ操作を、画面の中のボタンにしたもの。強弱などのチップ・パネルとは別の、独立した小さな箱。
  // ヘッダーをドラッグして動かせる(位置は、窓全体に対する割合で覚える)。ヘッダーのボタンで、最小化できる
  const VIEW_POS_KEY = 'naiWrapperViewBoxPos';
  const VIEW_MIN_KEY = 'naiWrapperViewBoxMin';
  const VIEW_POS_DEFAULT = { fx: 0, fy: 1 }; // 既定は左下
  let viewPos = Object.assign({}, VIEW_POS_DEFAULT);
  try {
    const v = JSON.parse(store.get('localStorage', VIEW_POS_KEY) || 'null');
    if (v && Number.isFinite(v.fx) && Number.isFinite(v.fy)) viewPos = { fx: clamp01(v.fx), fy: clamp01(v.fy) };
  } catch (_) { /* 既定の位置のまま */ }
  let viewMinimized = store.get('localStorage', VIEW_MIN_KEY) === '1';
  const viewBox = el('div', 'position:fixed;z-index:1;width:200px;background:' + COLORS.bg + ';border:1px solid ' + COLORS.line +
    ';border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.45);overflow:hidden;pointer-events:auto;display:none;');
  const viewHead = el('div', 'display:flex;align-items:center;gap:6px;padding:4px 8px;background:#1b1e4d;cursor:move;user-select:none;');
  const viewZoom = el('span', 'flex:1;text-align:right;color:' + COLORS.accent + ';font-weight:bold;font-variant-numeric:tabular-nums;', Math.round((payload.zoom || 1) * 100) + '%');
  viewZoom.title = '今の拡大率';
  const viewToggle = el('button', btnCss + 'padding:0 6px;line-height:16px;');
  viewHead.append(el('span', 'font-weight:bold;', '表示'), viewZoom, viewToggle);
  const viewBody = el('div', 'padding:4px 0;');
  const VIEW_ITEMS = [ // [操作, 表示, キー]
    ['reload', '再読み込み', MOD + '+R'],
    ['forceReload', '強制再読み込み', MOD + '+Shift+R'],
    null,
    ['zoomReset', '実際のサイズ', MOD + '+0'],
    ['zoomIn', '拡大', MOD + '++'],
    ['zoomOut', '縮小', MOD + '+-'],
    null,
    ['fullscreen', '全画面の切り替え', 'F11'],
  ];
  for (const item of VIEW_ITEMS) {
    if (!item) { viewBody.appendChild(el('div', 'height:1px;background:' + COLORS.line + ';margin:3px 0;')); continue; }
    const rowEl = el('div', 'display:flex;justify-content:space-between;gap:8px;padding:3px 10px;cursor:pointer;');
    rowEl.append(el('span', '', item[1]), el('span', 'color:' + COLORS.sub + ';font-size:11px;', item[2]));
    rowEl.addEventListener('mouseenter', () => { rowEl.style.background = '#2a3070'; });
    rowEl.addEventListener('mouseleave', () => { rowEl.style.background = ''; });
    rowEl.addEventListener('click', () => send('view:' + item[0]));
    keepFocus(rowEl); // 押しても、入力欄のカーソル・選択は動かさない
    viewBody.appendChild(rowEl);
  }
  viewBox.append(viewHead, viewBody);
  root.appendChild(viewBox);
  function updateViewBox() {
    viewBox.style.display = settings.showViewBox ? 'block' : 'none';
    viewBody.style.display = viewMinimized ? 'none' : 'block';
    viewToggle.textContent = viewMinimized ? '＋' : '－';
    viewToggle.title = viewMinimized ? '開く' : '最小化';
    if (!settings.showViewBox) return;
    // 位置の基準は、ヘッダー(最小化しても、ヘッダーは動かない)。下にはみ出す分だけ、そのときだけ上へずらす
    const r = viewBox.getBoundingClientRect();
    const rangeX = Math.max(0, window.innerWidth - r.width - MARGIN * 2);
    const top = MARGIN + viewPos.fy * Math.max(0, window.innerHeight - viewHead.offsetHeight - MARGIN * 2);
    viewBox.style.left = (MARGIN + viewPos.fx * rangeX) + 'px';
    viewBox.style.top = Math.max(MARGIN, Math.min(top, window.innerHeight - MARGIN - r.height)) + 'px';
  }
  viewToggle.addEventListener('click', () => {
    viewMinimized = !viewMinimized;
    store.set('localStorage', VIEW_MIN_KEY, viewMinimized ? '1' : '0');
    updateViewBox();
  });
  let viewDrag = null;
  viewHead.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const r = viewBox.getBoundingClientRect();
    viewDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.preventDefault();
  });
  const onViewDragMove = (e) => {
    if (!viewDrag) return;
    const r = viewBox.getBoundingClientRect();
    const rangeX = window.innerWidth - r.width - MARGIN * 2;
    const rangeY = window.innerHeight - viewHead.offsetHeight - MARGIN * 2;
    viewPos = {
      fx: rangeX > 0 ? clamp01((e.clientX - viewDrag.dx - MARGIN) / rangeX) : 0,
      fy: rangeY > 0 ? clamp01((e.clientY - viewDrag.dy - MARGIN) / rangeY) : 0,
    };
    updateViewBox();
  };
  const onViewDragUp = () => {
    if (!viewDrag) return;
    viewDrag = null;
    store.set('localStorage', VIEW_POS_KEY, JSON.stringify(viewPos)); // 次に開いたときも、同じ位置に出す
  };
  window.addEventListener('mousemove', onViewDragMove, true);
  window.addEventListener('mouseup', onViewDragUp, true);
  updateViewBox();

  // ======== お知らせ(画像を保存したときなど) ========
  // 画面の下の真ん中に、数秒出す。押すと、保存したフォルダを開く(アプリ側が、最後に保存したファイルを覚えている)
  const toastBox = el('div', 'position:fixed;z-index:3;left:50%;bottom:28px;transform:translateX(-50%);display:none;max-width:70vw;padding:8px 14px;background:' + COLORS.bg +
    ';border:1px solid #3a4aa8;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.55);color:' + COLORS.text + ';font-size:12px;line-height:1.5;cursor:pointer;pointer-events:auto;overflow-wrap:anywhere;');
  const toastMsg = el('div', '');
  toastBox.append(toastMsg, el('div', 'font-size:10px;color:' + COLORS.sub + ';margin-top:2px;', 'クリックで、保存したフォルダを開く'));
  let toastTimer = null;
  const hideToast = () => { clearTimeout(toastTimer); toastBox.style.display = 'none'; };
  function showToast(text) {
    toastMsg.textContent = text;
    toastBox.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 6000);
  }
  toastBox.addEventListener('click', () => { send('reveal'); hideToast(); });
  root.appendChild(toastBox);

  // ---- まとめ ----
  wrap.append(batchPanel.box, timePanel.box, assistPanel.box, setPanel.box, setsPanel.box, checkPanel.box);
  function applyVisibility() {
    timePanel.box.style.display = settings.showTime ? 'block' : 'none';
    batchPanel.box.style.display = settings.showBatch ? 'block' : 'none';
    assistPanel.box.style.display = settings.showAssist ? 'block' : 'none';
    setPanel.box.style.display = settings.showAssistSettings ? 'block' : 'none';
    setsPanel.box.style.display = settings.showSets ? 'block' : 'none';
    checkPanel.box.style.display = settings.showCheck ? 'block' : 'none';
  }
  const ticker = setInterval(() => {
    applyAllPos(); // 最小化などでパネルの大きさが変わっても、窓の外にはみ出さないようにする
    if (settings.showAssist && assistPanel.isOpen()) updateLists();
    updateChips(); // 位置の追従(入力欄が動く・大きさが変わるとき)
    updateViewBox(); // 窓の大きさが変わったとき、窓の外にはみ出さないように
    if (settings.showCheck && ++checkTick % 2 === 0) renderCheck(); // 1 秒ごと(中身が変わったときだけ、描き直す)
    const was = !!armed;
    watchGeneration();
    if (settings.showTime && (was || armed)) renderTime(); // 計測中と、終わった直後だけ描き直す
    if (settings.showBatch && batch && batch.running) renderBatch();
  }, 500);
  applyVisibility();
  renderTime();
  renderBatch();
  if (payload.assist) Object.assign(assist, payload.assist);
  renderSettings();
  renderAssist();
  try { // 前回、動かして離したパネルは、その位置に出す(それ以外は、右下のまとめ置き場)
    const saved = JSON.parse(store.get('localStorage', POS_KEY) || '{}') || {};
    for (const p of panels) {
      const v = saved[p.id];
      if (v && Number.isFinite(v.fx) && Number.isFinite(v.fy)) p.pos = { fx: clamp01(v.fx), fy: clamp01(v.fy) };
    }
  } catch (_) { /* 既定の位置のまま */ }
  applyAllPos();

  window.__naiPanels = {
    dispose() {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('resize', onResize);
      errorObserver.disconnect();
      document.removeEventListener('keydown', onEmphasisKey, true);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('input', onEditorInput, true);
      document.removeEventListener('focusin', scheduleChips, true);
      document.removeEventListener('focusout', scheduleChips, true);
      document.removeEventListener('selectionchange', onChipSelection);
      document.removeEventListener('mousedown', onChipOutside, true);
      document.removeEventListener('keydown', onChipKey, true);
      window.removeEventListener('mousemove', onViewDragMove, true);
      window.removeEventListener('mouseup', onViewDragUp, true);
      window.removeEventListener('mousemove', onChipDragMove, true);
      window.removeEventListener('mouseup', onChipDragUp, true);
      window.removeEventListener('scroll', scheduleChips, true);
      window.removeEventListener('resize', scheduleChips);
      clearTimeout(chipTimer);
      clearTimeout(chipSelTimer);
      clearTimeout(chipNoticeTimer);
      clearTimeout(toastTimer);
      clearTimeout(markTimer);
      clearMarks();
      if (markSheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter(x => x !== markSheet);
      clearTimeout(selTimer);
      clearInterval(ticker);
      container.remove();
      delete window.__naiPanels;
    },
    configure(next) { Object.assign(settings, next || {}); applyVisibility(); renderCheck(); updateViewBox(); },
    toast(text) { showToast(String(text)); }, // アプリ側からのお知らせ(画像を保存したとき)
    setZoom(factor) { viewZoom.textContent = Math.round(factor * 100) + '%'; }, // アプリ側が送ってくる、今の拡大率
    resetPosition() { // すべてのパネルを、右下のまとめ置き場に戻す
      try { window.localStorage.removeItem(POS_KEY); } catch (_) { /* 無視 */ }
      panels.forEach(dock);
      unfreezeDock();
      try { window.localStorage.removeItem(CHIP_POS_KEY); } catch (_) { /* 無視 */ }
      chipPos = Object.assign({}, CHIP_POS_DEFAULT); // チップの位置も、初めに戻す
      updateChips();
      try { window.localStorage.removeItem(VIEW_POS_KEY); } catch (_) { /* 無視 */ }
      viewPos = Object.assign({}, VIEW_POS_DEFAULT); // 「表示」ツールチップの位置も、初めに戻す
      updateViewBox();
    },
    setBatch(next) {
      batch = next || null;
      if (batch && batch.simpleMax) simpleCfg.max = batch.simpleMax;
      if (batch && batch.simpleMinutes) simpleCfg.minutes = batch.simpleMinutes;
      renderBatch();
    },
    setAssist(next) { // アプリ側の、入力補助の設定の状態
      Object.assign(assist, next || {});
      settings.emphasis = !!assist.emphasis;
      settings.markDuplicates = assist.markDuplicates !== false;
      settings.showChips = assist.showChips !== false;
      settings.chipsAlways = assist.chipsAlways === true;
      updateChips();
      renderCheck();
      renderSettings();
    },
  };
})
