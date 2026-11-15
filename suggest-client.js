// タグのサジェスト(入力補助)。main.js が、NovelAI のページの中で実行する(executeJavaScript)。
// 全体が「payload を受け取る関数」の式になっている: (function (payload) { ... })
// payload: { tags: [[タグ名, 種別, 件数, 別名(カンマ区切り), 日本語名]…], settings: {…}, migemoDict: 辞書の base64 または '' }
(function (payload) {
  'use strict';

  // 再注入のときは、前のものを片付けてから作り直す
  if (window.__naiSuggest) window.__naiSuggest.dispose();

  const settings = Object.assign({ enabled: true, comma: true, space: true, ja: true, migemo: true, max: 200, onCaret: true }, payload.settings || {});
  const CAT_NAMES = { 0: '一般', 1: '作者', 3: '作品', 4: 'キャラ', 5: 'メタ' };
  // タグ名の文字の色(Danbooru の配色に合わせて、暗い背景で読みやすい明るさにしてある): 一般=青 / 作者=赤 / 作品=紫 / キャラ=緑 / メタ=橙
  const CAT_COLORS = { 0: '#6eaaff', 1: '#ff8080', 3: '#d78cff', 4: '#62dc8c', 5: '#ffb85c' };
  const DEFAULT_COLOR = '#aab';
  const danbooruUrl = (name) => 'https://danbooru.donmai.us/wiki_pages/' + encodeURIComponent(name); // タグの説明ページ

  // ---- お気に入り・最近使ったタグ(このページの localStorage に、タグ名だけ覚える) ----
  const FAV_KEY = 'naiWrapperFavTags';
  const RECENT_KEY = 'naiWrapperRecentTags';
  const RECENT_MAX = 100;
  const readList = (key) => {
    try { const v = JSON.parse(window.localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v.filter(s => typeof s === 'string') : []; } catch (_) { return []; }
  };
  const writeList = (key, list) => { try { window.localStorage.setItem(key, JSON.stringify(list)); } catch (_) { /* 無視 */ } };
  let favList = readList(FAV_KEY);
  let recentList = readList(RECENT_KEY).slice(0, RECENT_MAX);
  let favs = new Set(favList);
  let recentSet = new Set(recentList);
  let userVersion = 0; // お気に入り・最近が変わるたびに増える(パネルが、描き直す時を知るため)
  function toggleFav(name) {
    if (favs.has(name)) favList = favList.filter(n => n !== name); else favList = [name, ...favList];
    favs = new Set(favList);
    writeList(FAV_KEY, favList);
    userVersion++;
  }
  function addRecent(name) {
    recentList = [name, ...recentList.filter(n => n !== name)].slice(0, RECENT_MAX);
    recentSet = new Set(recentList);
    writeList(RECENT_KEY, recentList);
    userVersion++;
  }

  // ---- 検索用の索引 ----
  const names = [];
  const compacts = []; // 英数字だけにした名前(記号・アンダーバー・空白を無視して探すため)
  const cats = [];
  const counts = [];
  const aliasText = []; // ",別名1,別名2," の形(前方一致を includes で調べる)
  const aliasList = [];
  const jas = [];
  for (const t of payload.tags || []) {
    names.push(t[0]);
    compacts.push(t[0].replace(/[^a-z0-9]/g, ''));
    cats.push(t[1]);
    counts.push(t[2]);
    aliasList.push(t[3] ? t[3].split(',') : []);
    aliasText.push(t[3] ? ',' + t[3] + ',' : '');
    jas.push(String(t[4] || '').toLowerCase());
  }
  const jaOriginal = (payload.tags || []).map(t => t[4] || '');
  // 1 つのタグに複数の訳が「A,B,C」と入っているとき(Civitai の翻訳 CSV など)は、表示は最初の 1 つだけにする(検索は、全部の訳で行う)。
  // 数字の間のカンマ(「40,000」)と、カンマのあとに空白が続くもの(「若い, 浸透する」)は、1 つの訳の一部として、区切りにしない
  function firstJa(text) {
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== ',') continue;
      if (/\d/.test(s[i - 1] || '') && /\d/.test(s[i + 1] || '')) continue;
      if (s[i + 1] === ' ') continue;
      return s.slice(0, i).trim() || s;
    }
    return s;
  }
  const jaShown = jaOriginal.map(firstJa);

  // ---- migemo(ローマ字から日本語の検索用の正規表現を作る) ----
  let migemo = null;
  const jm = window.jsmigemo;
  try { delete window.jsmigemo; } catch (_) { window.jsmigemo = undefined; }
  if (jm && payload.migemoDict) {
    try {
      const bin = atob(payload.migemoDict);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      migemo = new jm.Migemo();
      migemo.setDict(new jm.CompactDictionary(bytes.buffer));
    } catch (_) {
      migemo = null;
    }
  }
  const migemoCache = new Map();
  function migemoRegex(q) {
    if (!migemo) return null;
    if (migemoCache.has(q)) return migemoCache.get(q);
    let re = null;
    try { re = new RegExp(migemo.query(q), 'i'); } catch (_) { re = null; }
    if (migemoCache.size > 100) migemoCache.clear();
    migemoCache.set(q, re);
    return re;
  }

  // ---- 検索 ----
  // 順位(参考にしたアプリと同じ考え方): 0 タグ名の完全一致 / 1 タグ名の前方一致 / 2 記号を無視した前方一致 /
  // 3 別名の完全一致 / 4 別名の前方一致 / 5 日本語名・migemo / 6 タグ名の部分一致 / 7 記号を無視した部分一致 / 8 別名の部分一致
  // 同じ順位の中は、件数が多い順(辞書は件数順に並んでいるので、先に見つかったものが上)
  // 分類ごとの ON/OFF(OFF にした分類は、候補に出さない)。候補リストの上のボタンで切り替え、ページの localStorage に覚える
  const CAT_OFF_KEY = 'naiWrapperCatOff';
  let catOff = new Set();
  try { catOff = new Set((JSON.parse(window.localStorage.getItem(CAT_OFF_KEY) || '[]') || []).filter(n => typeof n === 'number')); } catch (_) { catOff = new Set(); }
  function toggleCat(cat) {
    if (catOff.has(cat)) catOff.delete(cat); else catOff.add(cat);
    try { window.localStorage.setItem(CAT_OFF_KEY, JSON.stringify([...catOff])); } catch (_) { /* 無視 */ }
  }

  function search(raw, ignoreFilter) {
    const q = raw.trim().toLowerCase().replace(/\s+/g, '_');
    if (!q) return [];
    const max = Math.max(1, Number(settings.max) || 200);
    const ascii = /^[\x20-\x7e]+$/.test(q);
    const qc = q.replace(/[^a-z0-9]/g, '');
    const groups = [[], [], [], [], [], [], [], [], []];
    const re = ascii && settings.ja && settings.migemo && q.length >= 2 && /^[a-z]+$/.test(q) ? migemoRegex(q) : null;
    const aliasExact = ',' + q + ',';
    const aliasKey = ',' + q;
    const jaQuery = q.replace(/_/g, ' ');
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      let g = -1;
      let pos = 0; // 日本語名の中で、一致した位置
      let m;
      if (ascii) {
        const al = aliasText[i];
        if (name === q) g = 0;
        else if (name.startsWith(q)) g = 1;
        else if (qc && compacts[i].startsWith(qc)) g = 2;
        else if (al && al.includes(aliasKey)) g = al.includes(aliasExact) ? 3 : 4;
        else if (re && jas[i] && (m = re.exec(jaOriginal[i]))) { g = 5; pos = m.index; }
        else if (q.length >= 2 && name.includes(q)) g = 6;
        else if (qc.length >= 2 && compacts[i].includes(qc)) g = 7;
        else if (al && q.length >= 2 && al.includes(q)) g = 8;
      } else if (settings.ja && jas[i] && (pos = jas[i].indexOf(jaQuery)) >= 0) {
        g = 5;
      }
      // 日本語名の一致(5)は、あとで並べ替えるため、上限まで切らずに集める
      if (g >= 0 && !ignoreFilter && catOff.has(cats[i])) g = -1; // OFF の分類は出さない
      if (g >= 0 && (g === 5 || groups[g].length < max)) groups[g].push({ i, g, q, pos });
    }
    // 日本語名の一致は、訳の先頭に近いもの・訳が短いもの(= 訳全体に近いもの)を上に出す。同じなら辞書の順(件数順)のまま
    // さらに、各グループの中では、お気に入り → 最近使ったタグ → それ以外の順にする(同じ段なら、上の順のまま)
    const tierOf = (e) => (favs.has(names[e.i]) ? 0 : recentSet.has(names[e.i]) ? 1 : 2);
    groups.forEach((g, gi) => {
      if (gi === 5) g.sort((a, b) => tierOf(a) - tierOf(b) || a.pos - b.pos || jaOriginal[a.i].length - jaOriginal[b.i].length || a.i - b.i);
      else if (favs.size || recentSet.size) g.sort((a, b) => tierOf(a) - tierOf(b));
    });
    return groups.flat().slice(0, max);
  }

  // ---- 入力欄と、いまのタグ(カンマの後ろから、キャラクターの位置まで)の取り出し ----
  const isEditor = (el) => !!(el && el.nodeType === 1 && el.matches && el.matches('.ProseMirror[contenteditable="true"]'));
  function editorOf(node) {
    for (let n = node; n; n = n.parentNode) if (isEditor(n)) return n;
    return null;
  }
  function blockOf(node, editor) {
    let n = node.nodeType === 1 ? node : node.parentNode;
    while (n && n.parentNode !== editor) n = n.parentNode;
    return n || editor;
  }
  function currentToken() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed || !sel.anchorNode) return null;
    const editor = editorOf(sel.anchorNode);
    if (!editor) return null;
    const block = blockOf(sel.anchorNode, editor);
    const pre = document.createRange();
    pre.selectNodeContents(block);
    pre.setEnd(sel.anchorNode, sel.anchorOffset);
    const before = pre.toString();
    const cut = Math.max(before.lastIndexOf(','), before.lastIndexOf('、'), before.lastIndexOf('\n'));
    const rawTail = before.slice(cut + 1);
    const lead = rawTail.length - rawTail.trimStart().length;
    const token = rawTail.slice(lead);
    // 強調の記号({ [ ( と「1.2::」)は、検索には使わず、置き換えるときにも残す
    const mark = token.match(/^[[{(]*(?:-?\d*\.?\d+::)?/)[0];
    const start = before.length - token.length + mark.length;
    // カーソルより後ろにも、同じタグの続きがあるとき(文字の途中にカーソルを置いたとき)は、タグ全体を対象にする。
    // 後ろの強調の記号(」]) ::)と空白は、検索にも置き換えにも含めない
    const post = document.createRange();
    post.selectNodeContents(block);
    post.setStart(sel.anchorNode, sel.anchorOffset);
    const after = post.toString();
    const cutAfter = after.search(/[,、\n]/);
    const rest = cutAfter < 0 ? after : after.slice(0, cutAfter);
    const trailing = rest.match(/[\]})]*(?:::)?\s*$/)[0];
    const restBody = rest.slice(0, rest.length - trailing.length);
    const end = before.length + restBody.length;
    return { editor, block, query: token.slice(mark.length) + restBody, start, end, afterText: after.slice(rest.length) };
  }
  function rangeAt(block, start, end) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let pos = 0;
    let sNode = null; let sOff = 0; let eNode = null; let eOff = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const len = node.nodeValue.length;
      if (!sNode && start <= pos + len) { sNode = node; sOff = start - pos; }
      if (end <= pos + len) { eNode = node; eOff = end - pos; break; }
      pos += len;
    }
    if (!sNode || !eNode) return null;
    const range = document.createRange();
    range.setStart(sNode, sOff);
    range.setEnd(eNode, eOff);
    return range;
  }

  // ---- 候補の表示 ----
  const box = document.createElement('div');
  box.setAttribute('data-nai-suggest', '1');
  box.style.cssText = 'position:fixed;z-index:2147483647;display:none;min-width:240px;max-width:460px;max-height:340px;overflow:auto;' +
    'background:#14162e;color:#e8e8f0;border:1px solid #3a3f78;border-radius:6px;box-shadow:0 4px 16px #000a;font:12px/1.35 sans-serif;';
  document.body.appendChild(box);
  let items = [];
  let active = 0;
  let timer = null;
  let composing = false;

  const display = (name) => (settings.space ? name.replace(/_/g, ' ') : name);
  function close() { box.style.display = 'none'; items = []; }
  const isOpen = () => box.style.display !== 'none' && items.length > 0;

  // 候補を開いた理由: 'input' = 文字を打った(↑↓ Enter Tab で選べる) / 'caret' = カーソルを動かしただけ(↑↓ Enter は、そのまま入力欄で使う。選ぶのはクリックか Tab)
  let openMode = 'input';
  let showFilter = true; // 分類のボタンを出すか(お気に入りの一覧のときは出さない)
  // 候補リストの上に出す、分類ごとの ON/OFF ボタン(押しても、入力欄のカーソルは動かさない)
  function filterBar() {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:sticky;top:0;z-index:1;display:flex;flex-wrap:wrap;gap:4px;padding:4px 6px;background:#14162e;border-bottom:1px solid #2a2f66;';
    for (const key of Object.keys(CAT_NAMES).map(Number)) {
      const on = !catOff.has(key);
      const color = CAT_COLORS[key] || DEFAULT_COLOR;
      const b = document.createElement('span');
      b.textContent = CAT_NAMES[key];
      b.title = on ? CAT_NAMES[key] + ' を候補に出している(押すと出さない)' : CAT_NAMES[key] + ' を候補に出していない(押すと出す)';
      b.style.cssText = 'cursor:pointer;font-size:10px;padding:0 7px;border-radius:9px;border:1px solid ' + (on ? color : '#4a4f80') + ';' +
        (on ? 'color:' + color + ';background:#1c2050;' : 'color:#7a7fa8;text-decoration:line-through;background:transparent;');
      b.addEventListener('mousedown', (e) => {
        e.preventDefault(); // 入力欄のカーソルを動かさない
        e.stopPropagation();
        toggleCat(key);
        update();
      });
      bar.append(b);
    }
    return bar;
  }

  function render() {
    box.textContent = '';
    if (showFilter) box.append(filterBar());
    if (!items.length) { // 分類の絞り込みで、候補が全部消えたとき
      const none = document.createElement('div');
      none.textContent = '絞り込みで、候補がありません';
      none.style.cssText = 'padding:6px 8px;color:#99a;font-size:11px;';
      box.append(none);
    }
    items.forEach((it, k) => {
      const i = it.i;
      const row = document.createElement('div');
      row.style.cssText = 'padding:3px 8px;cursor:pointer;' + (k === active ? 'background:#2a3070;' : '');
      // 1 行目: タグ名(種類の色)、別名のヒント、件数(押すと Danbooru のそのタグの説明ページを開く)
      const line1 = document.createElement('div');
      line1.style.cssText = 'display:flex;align-items:baseline;gap:6px;';
      const star = document.createElement('span'); // ★ = お気に入り(押すと付け外し。Ctrl+D でも同じ)
      const isFav = favs.has(names[i]);
      star.textContent = isFav ? '★' : '☆';
      star.title = isFav ? 'お気に入りから外す' : 'お気に入りに入れる';
      star.style.cssText = 'cursor:pointer;font-size:11px;color:' + (isFav ? '#ffd24d' : '#667') + ';';
      star.addEventListener('mousedown', (e) => {
        e.preventDefault(); // 入力欄のカーソルを動かさない
        e.stopPropagation(); // 候補を入れる動きにはしない
        toggleFav(names[i]);
        render();
      });
      line1.append(star);
      const main = document.createElement('span');
      main.textContent = display(names[i]);
      main.title = CAT_NAMES[cats[i]] || '';
      main.style.cssText = 'font-weight:bold;font-size:12px;color:' + (CAT_COLORS[cats[i]] || DEFAULT_COLOR) + ';';
      line1.append(main);
      if (it.g === 3 || it.g === 4 || it.g === 8) { // 別名で見つかったとき、その別名を出す
        const via = document.createElement('span');
        via.textContent = '← ' + ((aliasList[i].find(a => a.startsWith(it.q)) || aliasList[i].find(a => a.includes(it.q)) || '別名').slice(0, 30));
        via.style.cssText = 'color:#99a;font-size:10px;';
        line1.append(via);
      }
      const cnt = document.createElement('span');
      cnt.textContent = counts[i] >= 1000 ? Math.round(counts[i] / 100) / 10 + 'k' : String(counts[i]);
      cnt.title = 'Danbooru の「' + names[i] + '」の説明ページを開く';
      cnt.style.cssText = 'margin-left:auto;color:#8a93c8;font-size:10px;text-decoration:underline;text-decoration-style:dotted;cursor:pointer;';
      cnt.addEventListener('mousedown', (e) => {
        e.preventDefault(); // 入力欄のカーソルを動かさない
        e.stopPropagation(); // 候補を入れる動きにはしない
        window.open(danbooruUrl(names[i]), '_blank', 'noopener');
      });
      line1.append(cnt);
      row.append(line1);
      // 2 行目: 日本語訳(機械翻訳のことがあり、不正確な場合がある)
      if (jaShown[i]) {
        const ja = document.createElement('div');
        ja.textContent = jaShown[i];
        ja.style.cssText = 'color:#9aa3c8;font-size:10px;line-height:1.3;';
        row.append(ja);
      }
      row.addEventListener('mousedown', (e) => { e.preventDefault(); accept(k); });
      box.append(row);
    });
    const sel = box.children[active + (showFilter ? 1 : 0)];
    if (sel && sel.scrollIntoView && items.length) sel.scrollIntoView({ block: 'nearest' });
  }

  function place(tok) {
    const sel = window.getSelection();
    let rect = null;
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0).cloneRange();
      const list = r.getClientRects();
      rect = list.length ? list[list.length - 1] : r.getBoundingClientRect();
    }
    if (!rect || (!rect.width && !rect.height && !rect.top)) rect = tok.block.getBoundingClientRect();
    box.style.display = 'block';
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    let left = Math.min(rect.left, window.innerWidth - w - 8);
    let top = rect.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 4); // 下に入らなければ上に出す
    box.style.left = Math.max(8, left) + 'px';
    box.style.top = top + 'px';
  }

  function update(mode) {
    openMode = mode === 'caret' ? 'caret' : 'input';
    if (!settings.enabled) return close();
    const tok = currentToken();
    if (!tok || !tok.query.trim()) return close();
    items = search(tok.query);
    showFilter = true;
    if (!items.length) {
      // 絞り込みを外せば候補があるときは、ボタンだけは残す(でないと、全部 OFF にしたとき、戻せなくなる)
      if (catOff.size && search(tok.query, true).length) { active = 0; render(); place(tok); return; }
      return close();
    }
    active = 0;
    render();
    place(tok);
  }

  function accept(k) {
    const it = items[k];
    const tok = currentToken();
    if (!it || !tok) return close();
    const range = rangeAt(tok.block, tok.start, tok.end);
    if (!range) return close();
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    // 後ろがすでにカンマで続いているとき(途中のタグを置き換えるとき)は、カンマを足さない
    const commaFollows = /^\s*[,、]/.test(tok.afterText || '');
    document.execCommand('insertText', false, display(names[it.i]) + (settings.comma && !commaFollows ? ', ' : ''));
    addRecent(names[it.i]);
    close();
  }

  // Ctrl+Space: 何も打っていないとき、お気に入りと最近使ったタグを出す
  let nameIndex = null; // タグ名 → 番号(最初に使うときに作る)
  const ensureIndex = () => (nameIndex || (nameIndex = new Map(names.map((n, i) => [n, i]))));
  function showFavorites() {
    const tok = currentToken();
    if (!tok || tok.query.trim()) return false;
    ensureIndex();
    const list = [...favList, ...recentList.filter(n => !favs.has(n))].filter(n => nameIndex.has(n)).slice(0, 30);
    if (!list.length) return false;
    items = list.map(n => ({ i: nameIndex.get(n), g: -1, q: '' }));
    active = 0;
    openMode = 'input';
    showFilter = false;
    render();
    place(tok);
    return true;
  }

  // ---- イベント ----
  const onInput = (e) => {
    if (!isEditor(e.target) && !editorOf(e.target)) return;
    clearTimeout(timer);
    timer = setTimeout(update, 60);
  };
  const onKeydown = (e) => {
    if (e.isComposing || e.keyCode === 229 || composing) return; // 日本語入力の変換中は、キーを横取りしない
    if (settings.enabled && (e.ctrlKey || e.metaKey) && e.code === 'Space' && !isOpen() && editorOf(document.activeElement)) {
      if (showFavorites()) { e.preventDefault(); e.stopImmediatePropagation(); }
      return;
    }
    if (!isOpen()) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { // 選んでいる候補を、お気に入りに入れる / 外す
      e.preventDefault(); e.stopImmediatePropagation();
      if (items[active]) { toggleFav(names[items[active].i]); render(); }
      return;
    }
    if (e.ctrlKey || e.metaKey) return; // Ctrl+↑↓ は、強調の補助が使う(候補の選択には使わない)
    if (openMode === 'caret') { // カーソルを動かしただけで開いた候補は、↑↓ Enter を横取りしない(入力欄の移動・改行に使う)
      if (e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); accept(active); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); active = (active + 1) % items.length; render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); active = (active - 1 + items.length) % items.length; render(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); accept(active); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
  };
  // 文字の途中にカーソルを置いた(クリック・矢印キーで動かした)ときも、そのタグの候補を出す
  const CARET_KEYS = ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
  const onCaretMove = (e) => {
    if (!settings.enabled || !settings.onCaret) return;
    if (!editorOf(e.target) && !isEditor(e.target)) return;
    if (e.type === 'keyup') {
      if (e.isComposing || composing || e.ctrlKey || e.metaKey || e.altKey) return;
      const vertical = (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !(isOpen() && openMode === 'input'); // 文字を打って開いた候補の ↑↓ は、候補の選択に使われたあと
      if (!CARET_KEYS.includes(e.key) && !vertical) return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => update('caret'), 60);
  };
  const onCompStart = () => { composing = true; };
  const onCompEnd = () => { composing = false; clearTimeout(timer); timer = setTimeout(update, 0); };
  const onBlur = () => setTimeout(() => { if (!editorOf(document.activeElement)) close(); }, 150);
  const onScroll = (e) => { if (e.target !== box && !box.contains(e.target)) close(); };

  document.addEventListener('input', onInput, true);
  document.addEventListener('click', onCaretMove, true);
  document.addEventListener('keyup', onCaretMove, true);
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('compositionstart', onCompStart, true);
  document.addEventListener('compositionend', onCompEnd, true);
  document.addEventListener('focusout', onBlur, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', close);

  window.__naiSuggest = {
    dispose() {
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('click', onCaretMove, true);
      document.removeEventListener('keyup', onCaretMove, true);
      document.removeEventListener('keydown', onKeydown, true);
      document.removeEventListener('compositionstart', onCompStart, true);
      document.removeEventListener('compositionend', onCompEnd, true);
      document.removeEventListener('focusout', onBlur, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
      clearTimeout(timer);
      box.remove();
      delete window.__naiSuggest;
    },
    configure(next) { Object.assign(settings, next || {}); close(); },
    clearUserData() { favList = []; recentList = []; favs = new Set(); recentSet = new Set(); writeList(FAV_KEY, []); writeList(RECENT_KEY, []); userVersion++; close(); },
    // 以下は、パネル(panel-client.js)が使う
    version: () => userVersion,
    getUserData: () => ({ favs: [...favList], recents: [...recentList] }),
    toggleFav,
    display,
    // タグの分類({ label, color })。辞書にないタグは null。候補リストと同じ色(CAT_COLORS)
    tagInfo(name) {
      const i = ensureIndex().get(name);
      return i === undefined ? null : { label: CAT_NAMES[cats[i]] || '', color: CAT_COLORS[cats[i]] || DEFAULT_COLOR };
    },
    // タグの日本語訳(なければ空)
    ja(name) { const i = ensureIndex().get(name); return i === undefined ? '' : jaShown[i] || ''; },
    categories: () => Object.keys(CAT_NAMES).map(k => ({ label: CAT_NAMES[k], color: CAT_COLORS[k] })),
    // 入力欄にカーソルがあれば、そこにタグを入れる(入れたら true)
    insert(name) {
      const sel = window.getSelection();
      // 入力欄にフォーカスがあるときだけ入れる(フォーカスが外れたあとも、選択の跡は残るので、それだけでは判断しない)
      if (!sel || !sel.rangeCount || !sel.anchorNode || !editorOf(sel.anchorNode) || !editorOf(document.activeElement)) return false;
      document.execCommand('insertText', false, display(name) + (settings.comma ? ', ' : ''));
      addRecent(name);
      return true;
    },
  };
})
