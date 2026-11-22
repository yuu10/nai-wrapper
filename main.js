const { app, BrowserWindow, shell, Menu, session, dialog, clipboard, Notification, screen, nativeTheme, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');

const START_URL = 'https://novelai.net/image'; // 起動時に開くページ(画像生成)
// アプリ内で開くことを許可するホスト(それ以外は既定のブラウザで開く)
const ALLOWED_HOSTS = ['novelai.net', 'image.novelai.net', 'api.novelai.net', 'text.novelai.net'];

function isAllowed(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && ALLOWED_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

const APP_NAME = 'NAI Wrapper';
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('dev.nai-wrapper.app'); // Windows の通知の見出し(「electron.app.…」になるのを避ける)。package.json の appId と同じ

// 窓が他の窓に完全に隠れても、ページの処理(自動生成など)が遅くならないようにする
// (Chromium は、隠れた窓の描画・タイマーを止めたり遅くしたりする。少しでも見えていれば止まらない)
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// ---- 確認・お知らせのダイアログ(自前の窓) ----
// OS 標準のメッセージボックスは、Windows ではダークモードに対応していない(配色の設定で暗くならない)ので、自前の小さな窓で出す。
// sandbox のまま(preload / IPC は使わない)、ボタンを押したときの移動先(MESSAGE_HOST)を見て、押されたボタンを受け取る(ファイル名のルールの窓と同じ方法)。
// 配色は、ページの prefers-color-scheme(= メニュー「View → 配色」の設定)に従う。ファイルを選ぶダイアログは、OS 標準のまま
const MESSAGE_HOST = 'nai-wrapper-message.invalid';
const MESSAGE_ICONS = { info: 'i', question: '?', warning: '!', error: '×' };

function messageHtml({ type, buttons, defaultId, cancelId, message, detail }) {
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const kind = MESSAGE_ICONS[type] ? type : 'info';
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>${esc(APP_NAME)}</title>
<style>
  :root { color-scheme: light dark; --bg: #f3f3f7; --fg: #1c1c28; --sub: #4a4c60; --btn: #e1e2ec; --primary: #3b5bdb; }
  @media (prefers-color-scheme: dark) { :root { --bg: #16172b; --fg: #ececf5; --sub: #b4b6cc; --btn: #2a2c47; --primary: #4f6bed; } }
  html, body { margin: 0; background: var(--bg); color: var(--fg); font: 14px 'Segoe UI', 'Yu Gothic UI', sans-serif; }
  .wrap { display: flex; gap: 16px; padding: 22px 24px 16px; }
  .icon { flex: none; width: 36px; height: 36px; border-radius: 50%; background: var(--primary); color: #fff; font: 700 20px/36px sans-serif; text-align: center; }
  .icon.error { background: #d64545; }
  .icon.warning { background: #d9822b; }
  .text { flex: 1; min-width: 0; }
  .msg { margin: 4px 0 0; font-size: 15px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
  .detail { margin: 10px 0 0; max-height: 360px; overflow: auto; color: var(--sub); line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; padding: 0 24px 20px; }
  button { min-width: 92px; padding: 7px 16px; border: 0; border-radius: 5px; background: var(--btn); color: var(--fg); font: inherit; cursor: pointer; }
  button.default { background: var(--primary); color: #fff; }
  button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
</style>
<div class="wrap">
  <div class="icon ${kind}">${MESSAGE_ICONS[kind]}</div>
  <div class="text">
    <p class="msg">${esc(message || '')}</p>
    ${detail ? `<p class="detail">${esc(detail)}</p>` : ''}
  </div>
</div>
<div class="buttons">${buttons.map((b, i) => `<button type="button" data-i="${i}"${i === defaultId ? ' class="default" autofocus' : ''}>${esc(b)}</button>`).join('')}</div>
<script>
  const go = (i) => { location.href = 'https://${MESSAGE_HOST}/' + i; };
  document.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => go(b.dataset.i)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ${cancelId} >= 0) go(${cancelId}); });
</script></html>`;
}

// 押されたボタンの番号(0 から)を返す。窓の×・Esc は cancelId(なければ 0)。parent があれば、その窓の上に重ねて(モーダルで)出す。
// options は、Electron の dialog.showMessageBox と同じ形(type / buttons / defaultId / cancelId / message / detail)
function showMessage(parent, options = {}) {
  const buttons = Array.isArray(options.buttons) && options.buttons.length ? options.buttons : ['OK'];
  const cancelId = Number.isInteger(options.cancelId) && options.cancelId < buttons.length ? options.cancelId : (buttons.length === 1 ? 0 : -1);
  const defaultId = Number.isInteger(options.defaultId) ? options.defaultId : 0;
  const html = messageHtml({ ...options, buttons, defaultId, cancelId });
  return new Promise((resolve) => {
    const modal = !!(parent && !parent.isDestroyed());
    const win = new BrowserWindow({
      title: APP_NAME,
      icon: path.join(__dirname, 'build', 'icon.png'),
      width: 520,
      height: 240,
      useContentSize: true,
      parent: modal ? parent : undefined,
      modal,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#16172b' : '#f3f3f7',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.removeMenu();
    let answer = null;
    win.on('closed', () => resolve(answer === null ? Math.max(cancelId, 0) : answer));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => {
      e.preventDefault();
      let u;
      try { u = new URL(url); } catch { return; }
      if (u.hostname !== MESSAGE_HOST) return;
      const i = parseInt(u.pathname.slice(1), 10);
      if (Number.isInteger(i) && i >= 0 && i < buttons.length) {
        answer = i;
        win.close();
      }
    });
    win.webContents.once('did-finish-load', async () => {
      try {
        const h = await win.webContents.executeJavaScript('document.documentElement.scrollHeight');
        if (!win.isDestroyed()) win.setContentSize(520, Math.min(Math.max(h, 120), 700));
      } catch { /* 大きさはそのまま */ }
      if (win.isDestroyed()) return;
      if (modal && !parent.isDestroyed()) {
        const pb = parent.getBounds();
        const b = win.getBounds();
        win.setPosition(Math.round(pb.x + (pb.width - b.width) / 2), Math.round(pb.y + (pb.height - b.height) / 2));
      } else {
        win.center();
      }
      win.show();
    });
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
}

// ---- アプリの設定(保存方法) ----
// autoSave: true なら、ダウンロード(画像の保存など)を saveDir に自動で保存する。false なら毎回「名前を付けて保存」
const DEFAULT_NAME_RULE = '{元の名前}';
const SUGGEST_MAX_CHOICES = [50, 100, 200, 500]; // 候補の最大数の選択肢
const SIMPLE_MAX_COUNT = 9999; // 連続生成の、最大回数の上限
const SIMPLE_MAX_MINUTES = 180; // 連続生成の、連続上限(分)の上限
const THEMES = ['dark', 'light', 'system']; // 配色の選択肢(Electron の nativeTheme.themeSource と同じ名前)
const settings = {
  autoSave: false,
  saveDir: '',
  nameRule: DEFAULT_NAME_RULE,
  seq: 0,
  tagLength: 20, // {tag} {characters} の各タグの先頭から使う文字数(0 = 制限なし)
  tagSeparator: '+', // {characters} で、複数のキャラクターをつなぐ文字
  noTagName: 'NoChara', // キャラクターのタグが見つからないときの名前
  suggest: true, // タグのサジェストを使う(辞書を取り込んでいるとき)
  suggestComma: true, // 確定したとき「, 」を付ける
  suggestSpace: true, // アンダーバーを空白にして入れる
  suggestJa: true, // 日本語名で検索する(日本語訳を取り込んでいるとき)
  suggestMigemo: true, // ローマ字で日本語を検索する(migemo)
  suggestMax: 200, // 候補の最大数
  suggestOnCaret: true, // 文字の途中にカーソルを置いたときも、そのタグの候補を出す
  emphasis: true, // Ctrl+↑↓ で、選んだ文字・カーソルのタグの重みを 0.1 ずつ上げ下げする
  showTimePanel: true, // 画面に「生成時間」のパネルを出す
  showBatchPanel: true, // 画面に「自動生成」のパネルを出す
  showAssistPanel: true, // 画面に「入力補助」(強調・お気に入り・最近使ったタグ)のパネルを出す
  showAssistSettingsPanel: true, // 画面に「入力補助の設定」のパネルを出す
  showSetsPanel: true, // 画面に「タグセット」のパネルを出す
  showCheckPanel: true, // 画面に「プロンプト点検」のパネルを出す
  markDuplicates: true, // 入力欄の中で、重複しているタグに色を付ける(点検パネルが動いているとき)
  showChips: true, // カーソルのある入力欄のそばに、強弱・お気に入り・履歴のチップを出す
  chipsAlways: false, // チップを、入力欄のフォーカスに関係なく常に出す(ドラッグで動かせる)
  showViewBox: true, // 画面に「表示」のツールチップ(再読み込み・拡大縮小・全画面と、今の拡大率)を出す
  notifySaved: true, // 画像を保存したとき、画面に「○○ を △△ に保存しました」と出す
  simpleMax: 10, // 連続生成: 最大回数(1〜9999)
  simpleMinutes: 60, // 連続生成: 連続上限(分。1〜180)
  stopOnError: true, // 自動生成中に、画面にエラーが表示されたら止める
  notifyDone: true, // 自動生成が終わったとき、窓が裏にあれば通知を出す
  alwaysOnTop: false, // 窓を常に最前面にする
  theme: 'dark', // タイトルバー・メニュー・ダイアログの配色('dark' = ダーク / 'light' = ライト / 'system' = OS に合わせる)
  zoom: 1, // ページの拡大率
  window: null, // 窓の位置・大きさ({ x, y, width, height, maximized })。前回の状態で開くために覚える
};
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'));
    settings.autoSave = saved.autoSave === true;
    settings.saveDir = typeof saved.saveDir === 'string' ? saved.saveDir : '';
    settings.nameRule = typeof saved.nameRule === 'string' && saved.nameRule.trim() ? saved.nameRule : DEFAULT_NAME_RULE;
    settings.seq = Number.isInteger(saved.seq) && saved.seq >= 0 ? saved.seq : 0;
    if (Number.isInteger(saved.tagLength) && saved.tagLength >= 0) settings.tagLength = saved.tagLength;
    if (typeof saved.tagSeparator === 'string') settings.tagSeparator = saved.tagSeparator;
    if (typeof saved.noTagName === 'string' && saved.noTagName.trim()) settings.noTagName = saved.noTagName;
    for (const key of ['suggest', 'suggestComma', 'suggestSpace', 'suggestJa', 'suggestMigemo', 'suggestOnCaret', 'emphasis']) settings[key] = saved[key] !== false;
    if (SUGGEST_MAX_CHOICES.includes(saved.suggestMax)) settings.suggestMax = saved.suggestMax;
    for (const key of ['showTimePanel', 'showBatchPanel', 'showAssistPanel', 'showAssistSettingsPanel', 'showSetsPanel', 'showCheckPanel', 'markDuplicates', 'showChips', 'showViewBox', 'stopOnError', 'notifyDone']) settings[key] = saved[key] !== false;
    settings.alwaysOnTop = saved.alwaysOnTop === true;
    if (THEMES.includes(saved.theme)) settings.theme = saved.theme;
    settings.chipsAlways = saved.chipsAlways === true;
    settings.notifySaved = saved.notifySaved !== false;
    if (Number.isInteger(saved.simpleMax) && saved.simpleMax >= 1 && saved.simpleMax <= SIMPLE_MAX_COUNT) settings.simpleMax = saved.simpleMax;
    if (Number.isInteger(saved.simpleMinutes) && saved.simpleMinutes >= 1 && saved.simpleMinutes <= SIMPLE_MAX_MINUTES) settings.simpleMinutes = saved.simpleMinutes;
    if (typeof saved.zoom === 'number' && saved.zoom >= 0.25 && saved.zoom <= 5) settings.zoom = saved.zoom;
    const w = saved.window;
    if (w && [w.x, w.y, w.width, w.height].every(Number.isFinite) && w.width >= 400 && w.height >= 300) {
      settings.window = { x: w.x, y: w.y, width: w.width, height: w.height, maximized: w.maximized === true };
    }
  } catch {
    // 設定ファイルがない・壊れているときは、既定値(毎回選ぶ)のまま
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error(`設定を保存できませんでした: ${err.message}`);
  }
}

// 同じ名前のファイルがあれば「名前 (1).png」のように別名にする(上書きしない。フォルダ名などは取り除く)
function uniquePath(dir, name) {
  const base = path.basename(name || '') || 'image.png';
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  let target = path.join(dir, base);
  for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${stem} (${i})${ext}`);
  return target;
}

// ---- 辞書(タグのサジェストと、キャラクターの判定に使う) ----
// アプリには付属しない。「danbooru.csv」の形式(1 行が「タグ名,種別,件数,別名」の 4 列。種別 4 がキャラクター)の CSV を、
// メニューから取り込む。取り込んだ内容は userData の tag-dictionary.json に、日本語訳(「英語のタグ,日本語」の 2 列の CSV)は
// tag-translations.json に保存する
const userFile = (name) => path.join(app.getPath('userData'), name);
const tagDictionaryFile = () => userFile('tag-dictionary.json');
const translationsFile = () => userFile('tag-translations.json');
const legacyDictionaryFile = () => userFile('character-dictionary.json'); // 以前の形式(キャラクターだけ)
let tagList = null; // [[タグ名, 種別, 件数, 別名(カンマ区切り)]…] / 未取り込みのとき null
let translations = null; // { タグ名: 日本語名 } / 未取り込みのとき null
let translationCount = 0;
let dictionary = null; // キャラクターの判定用 { names: Set, aliases: Map(別名 → 正式名) } / 未取り込みのとき null

// タグを比べやすい形にする: 前後の空白・強調の記号({} [] と「1.2::」「::」)を取り、小文字にして、空白を _ にする
function normalizeTag(text) {
  return String(text || '').trim().replace(/^-?\d*\.?\d+::/, '').replace(/::$/, '').replace(/[{}\[\]]/g, '').trim().toLowerCase().replace(/\s+/g, '_');
}

// CSV の行から、タグの一覧を作る(件数順に並んでいる前提)。キャラクター(種別 4)が少なすぎれば、形式が違うとしてエラーにする
function buildTagList(rows) {
  const tags = [];
  let characters = 0;
  for (const r of rows) {
    const name = normalizeTag(r[0]);
    const kind = String(r[1] || '').trim();
    if (!name || !/^\d+$/.test(kind)) continue; // 見出しなどの行は飛ばす
    if (kind === '4') characters++;
    // 「/hm」のような略記の別名は使わない
    const aliases = String(r[3] || '').split(',').map(normalizeTag).filter(a => a && !a.startsWith('/')).join(',');
    tags.push([name, Number(kind), Number(r[2]) || 0, aliases]);
  }
  if (characters < 100) throw new Error('キャラクター(種別が 4 の行)が見つかりません。「タグ名,種別,件数,別名」の 4 列の CSV(danbooru.csv)を選んでください。');
  return tags;
}

// タグの一覧から、キャラクターの判定用の索引を作る。他の種類のタグの正式名と同じ別名は使わない(一般的な言葉をキャラクターと誤認しないため)
function buildCharacterIndex(tags) {
  const kind = new Map(tags.map(t => [t[0], t[1]]));
  const names = new Set();
  const aliases = new Map();
  for (const [name, cat, , aliasText] of tags) {
    if (cat !== 4) continue;
    names.add(name);
    for (const alias of aliasText ? aliasText.split(',') : []) {
      if (kind.has(alias) && kind.get(alias) !== 4) continue;
      aliases.set(alias, name);
    }
  }
  return { names, aliases };
}

// 「英語のタグ,日本語」の CSV から、日本語訳を作る(3 列の古い形式で、2 列目が数字のときは 3 列目を使う)
function buildTranslations(rows) {
  const out = {};
  let count = 0;
  for (const r of rows) {
    const name = normalizeTag(r[0]);
    const ja = String((r.length >= 3 && /^\d+$/.test(String(r[1]).trim()) ? r[2] : r[1]) || '').trim();
    if (!name || !ja) continue;
    out[name] = ja;
    count++;
  }
  if (count < 100) throw new Error('日本語訳が見つかりません。「英語のタグ,日本語」の 2 列の CSV を選んでください。');
  return out;
}

function loadDictionary() {
  tagList = null;
  translations = null;
  translationCount = 0;
  dictionary = null;
  try {
    const d = JSON.parse(fs.readFileSync(tagDictionaryFile(), 'utf-8'));
    if (Array.isArray(d.tags)) { tagList = d.tags; dictionary = buildCharacterIndex(tagList); }
  } catch { /* 未取り込み */ }
  if (!dictionary) {
    try {
      const d = JSON.parse(fs.readFileSync(legacyDictionaryFile(), 'utf-8'));
      dictionary = { names: new Set(d.names), aliases: new Map(Object.entries(d.aliases || {})) };
    } catch { /* 未取り込み */ }
  }
  try {
    const t = JSON.parse(fs.readFileSync(translationsFile(), 'utf-8'));
    if (t && typeof t === 'object') { translations = t; translationCount = Object.keys(t).length; }
  } catch { /* 未取り込み */ }
}

async function importCsv(title, build, save, message) {
  const win = getMainWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win || undefined, {
    title,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return;
  try {
    const built = build(parseCsv(fs.readFileSync(filePaths[0], 'utf-8')));
    save(built);
    loadDictionary();
    refreshMenu();
    injectSuggest();
    showMessage(win || undefined, { type: 'info', title: APP_NAME, message: message(built) });
  } catch (err) {
    showMessage(win || undefined, { type: 'error', title: APP_NAME, message: '取り込めませんでした。', detail: err.message });
  }
}

const importDictionary = () => importCsv(
  '辞書(danbooru.csv)を選択',
  buildTagList,
  (tags) => {
    fs.writeFileSync(tagDictionaryFile(), JSON.stringify({ version: 1, tags }));
    fs.rmSync(legacyDictionaryFile(), { force: true });
  },
  (tags) => `辞書を取り込みました(全タグ ${tags.length} 件、うちキャラクター ${tags.filter(t => t[1] === 4).length} 件)。`,
);

const importTranslations = () => importCsv(
  '日本語訳(英語のタグ,日本語)を選択',
  buildTranslations,
  (t) => fs.writeFileSync(translationsFile(), JSON.stringify(t)),
  (t) => `日本語訳を取り込みました(${Object.keys(t).length} 件)。`,
);

function removeDictionary() {
  for (const file of [tagDictionaryFile(), translationsFile(), legacyDictionaryFile()]) {
    try { fs.rmSync(file, { force: true }); } catch { /* 無視 */ }
  }
  loadDictionary();
  refreshMenu();
  injectSuggest();
}

// ---- 辞書を作る(Danbooru から取得) ----
// ユーザーのパソコンが Danbooru の公開 API に接続して、タグ一覧(名前・種別・投稿数)・別名・Wiki の日本語名を取得し、辞書と日本語訳を作る。
// 辞書は同梱しない(他の人が作った素材のため)。取得の前に確認を出し、控えめな速度(DICT_INTERVAL_MS)で、途中で止められるようにする。
// 作り終えるまで、いまの辞書は変えない(途中で止めても、失敗しても、そのまま)
const DANBOORU_BASE = 'https://danbooru.donmai.us';
const DICT_USER_AGENT = 'NAI-Wrapper-DictionaryBuilder'; // 汎用の名前(個人情報は入れない)
const DICT_MIN_POSTS = 20; // 投稿数がこれ以上のタグだけを辞書に入れる
const DICT_INTERVAL_MS = 600; // 問い合わせの間隔(1 秒に 2 回以下)
const DICT_EST_PAGES = { tags: 330, aliases: 45, wiki: 190 }; // 進み具合・残り時間の見積もりに使う、おおよその問い合わせ回数(2026-11 時点)
const KANA_RE = /[぀-ゟ゠-ヿ]/; // かなを含む名前だけを日本語名にする(漢字だけの別名は、中国語が混ざるため使わない)

const abortError = () => Object.assign(new Error('中止しました'), { name: 'AbortError' });

function sleepMs(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(abortError()); return; }
    let onAbort = null;
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => { clearTimeout(timer); reject(abortError()); };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// Danbooru から、辞書(tags: [[名前, 種別, 投稿数, 別名(カンマ区切り)]…。投稿数の多い順)と、日本語名(translations: { タグ名: 'A,B' })を作って返す。
// fetchFn は fetch と同じ形(テストで差し替えられるように、引数で受け取る)。onProgress({ stage, page, requests }) で進み具合を知らせる
async function fetchDanbooruDictionary({
  fetchFn, signal, onProgress, base = DANBOORU_BASE, minPosts = DICT_MIN_POSTS, interval = DICT_INTERVAL_MS,
  maxPages = { tags: 700, aliases: 120, wiki: 450 }, retryWaits = [3000, 10000, 30000], sleep = sleepMs,
}) {
  let requests = 0;
  let lastAt = 0;

  async function getJson(endpoint, query) {
    const url = `${base}/${endpoint}.json?${new URLSearchParams(query).toString()}`;
    for (let attempt = 0; ; attempt++) {
      const wait = lastAt + interval - Date.now();
      if (wait > 0) await sleep(wait, signal);
      if (signal && signal.aborted) throw abortError();
      lastAt = Date.now();
      let res;
      try {
        res = await fetchFn(url, { headers: { 'User-Agent': DICT_USER_AGENT, Accept: 'application/json' }, signal });
      } catch (err) {
        if (err.name === 'AbortError' || (signal && signal.aborted)) throw abortError();
        if (attempt >= retryWaits.length) throw new Error(`Danbooru に接続できませんでした(${err.message})。`);
        await sleep(retryWaits[attempt], signal);
        continue;
      }
      requests++;
      if (res.ok) {
        try { return await res.json(); } catch { throw new Error('Danbooru の応答を読み取れませんでした。'); }
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retryWaits.length) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : retryWaits[attempt], signal);
        continue;
      }
      throw new Error(`Danbooru が、エラー(${res.status})を返しました。しばらくしてから、もう一度試してください。`);
    }
  }

  // 1000 件ずつのページを、空のページ(または 1000 件に満たないページ)まで読む
  async function eachPage(stage, endpoint, query, max, onItems) {
    for (let page = 1; page <= max; page++) {
      const data = await getJson(endpoint, { ...query, limit: '1000', page: String(page) });
      if (!Array.isArray(data)) throw new Error('Danbooru の応答の形式が、想定と違います。');
      if (data.length === 0) return;
      onItems(data);
      if (onProgress) onProgress({ stage, page, requests });
      if (data.length < 1000) return;
    }
  }

  // 1. タグ一覧
  const tagMap = new Map(); // タグ名 → [名前, 種別, 投稿数, 別名]
  await eachPage('tags', 'tags', {
    'search[order]': 'count', 'search[post_count]': `>=${minPosts}`, only: 'name,category,post_count',
  }, maxPages.tags, (items) => {
    for (const t of items) {
      const name = normalizeTag(t && t.name);
      if (!name || !Number.isInteger(t.category) || !Number.isFinite(t.post_count) || tagMap.has(name)) continue;
      tagMap.set(name, [name, t.category, t.post_count, '']);
    }
  });
  if (tagMap.size < 1000) throw new Error(`取得できたタグが少なすぎます(${tagMap.size} 件)。Danbooru の仕様が変わったかもしれません。`);

  // 2. 別名(古い名前 → いまの名前)。いまの名前が辞書にあるものだけ使う
  const aliasMap = new Map(); // いまの名前 → [古い名前…]
  await eachPage('aliases', 'tag_aliases', { 'search[status]': 'active', only: 'antecedent_name,consequent_name' }, maxPages.aliases, (items) => {
    for (const a of items) {
      const to = normalizeTag(a && a.consequent_name);
      const from = normalizeTag(a && a.antecedent_name);
      if (!from || !to || from === to || from.startsWith('/') || !tagMap.has(to)) continue; // 「/hm」のような略記は使わない
      const list = aliasMap.get(to) || [];
      if (list.length < 30 && !list.includes(from)) list.push(from);
      aliasMap.set(to, list);
    }
  });
  for (const [name, list] of aliasMap) tagMap.get(name)[3] = list.join(',');

  // 3. Wiki の日本語名(other_names のうち、かなを含むもの。複数あれば「A,B,C」の形で、最大 5 つ)
  const translations = {};
  await eachPage('wiki', 'wiki_pages', {
    only: 'title,other_names', 'search[other_names_present]': 'true', 'search[order]': 'title',
  }, maxPages.wiki, (items) => {
    for (const w of items) {
      const name = normalizeTag(w && w.title);
      if (!name || !tagMap.has(name) || !Array.isArray(w.other_names)) continue;
      const names = [];
      for (const n of w.other_names) {
        const text = String(n || '').trim();
        if (text && KANA_RE.test(text) && !names.includes(text)) names.push(text);
      }
      if (names.length) translations[name] = names.slice(0, 5).join(',');
    }
  });

  const tags = [...tagMap.values()].sort((a, b) => b[2] - a[2]);
  return { tags, translations, requests };
}

// 作った辞書を保存する(いまのファイルは .bak にコピー。日本語訳は、取り込み済みのものを優先して、ない分だけ Wiki の日本語名で補う)
function writeFileAtomic(file, text) {
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

function saveBuiltDictionary(result) {
  for (const file of [tagDictionaryFile(), translationsFile()]) {
    try { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`); } catch { /* バックアップできなくても続ける */ }
  }
  const merged = { ...result.translations, ...(translations || {}) };
  writeFileAtomic(tagDictionaryFile(), JSON.stringify({ version: 1, tags: result.tags }));
  writeFileAtomic(translationsFile(), JSON.stringify(merged));
}

// 進み具合のウィンドウ(sandbox のまま、「停止」のボタンの移動先を見て受け取る。ファイル名のルールの窓と同じ方法)
const DICT_UI_HOST = 'nai-wrapper-dictionary.invalid';

function dictProgressHtml() {
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>辞書を作る</title>
<style>
  :root { color-scheme: light dark; --bg: #f3f3f7; --fg: #1c1c28; --sub: #4a4c60; --track: #dcdde8; --primary: #3b5bdb; --btn: #e1e2ec; }
  @media (prefers-color-scheme: dark) { :root { --bg: #16172b; --fg: #ececf5; --sub: #b4b6cc; --track: #2a2c47; --primary: #4f6bed; --btn: #2a2c47; } }
  html, body { margin: 0; background: var(--bg); color: var(--fg); font: 14px 'Segoe UI', 'Yu Gothic UI', sans-serif; }
  .wrap { padding: 20px 24px; }
  h1 { margin: 0 0 12px; font-size: 16px; }
  .bar { height: 10px; border-radius: 5px; background: var(--track); overflow: hidden; margin: 10px 0 8px; }
  #fill { height: 100%; width: 0; background: var(--primary); transition: width .3s; }
  p { margin: 6px 0; line-height: 1.6; }
  .sub { color: var(--sub); font-size: 12px; }
  .buttons { display: flex; justify-content: flex-end; margin-top: 14px; }
  button { min-width: 92px; padding: 7px 16px; border: 0; border-radius: 5px; background: var(--btn); color: var(--fg); font: inherit; cursor: pointer; }
</style>
<div class="wrap">
  <h1>辞書を作っています</h1>
  <p id="stage">準備中…</p>
  <div class="bar"><div id="fill"></div></div>
  <p id="detail" class="sub"></p>
  <p class="sub">Danbooru(danbooru.donmai.us)に接続しています。「停止」を押すか、この窓を閉じると、中止します。作り終えるまで、いまの辞書は変わりません。</p>
  <div class="buttons"><button id="stop" type="button">停止</button></div>
</div>
<script>
  window.__update = (s) => {
    document.getElementById('stage').textContent = s.stage;
    document.getElementById('fill').style.width = Math.round(s.fraction * 100) + '%';
    document.getElementById('detail').textContent = s.detail;
  };
  document.getElementById('stop').addEventListener('click', () => { location.href = 'https://${DICT_UI_HOST}/stop'; });
</script></html>`;
}

let dictBuild = null; // 作っている間だけ { controller, win }

function formatMinutes(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  return `約 ${minutes} 分`;
}

async function buildDictionary() {
  if (dictBuild) {
    if (dictBuild.win && !dictBuild.win.isDestroyed()) dictBuild.win.focus();
    return;
  }
  const parent = getMainWindow();
  const choice = await showMessage(parent || undefined, {
    type: 'question',
    buttons: ['開始', 'キャンセル'],
    defaultId: 1,
    cancelId: 1,
    title: APP_NAME,
    message: 'Danbooru に接続して、辞書を作ります。よろしいですか?',
    detail: 'Danbooru(danbooru.donmai.us)の公開 API に接続して、タグの一覧(投稿数が ' + DICT_MIN_POSTS + ' 件以上)・別名・Wiki の日本語名を取得します。\n' +
      '・時間: 約 10 分(接続の状況によって変わります)\n' +
      '・通信量: 約 30MB\n' +
      '・控えめな速度(1 秒に 2 回以下)で取得し、途中で止められます。\n' +
      '・作り終えるまで、いまの辞書は変わりません。作り終えたら、いまの辞書は、バックアップ(.bak)に残します。\n' +
      '・取り込み済みの日本語訳は、そのまま残します(Wiki の日本語名は、ない分だけ補います)。\n\n' +
      '辞書の内容は、Danbooru のデータです(日本語名は、Danbooru Wiki の CC BY-SA のデータを含みます)。',
  });
  if (choice !== 0 || dictBuild) return;

  const controller = new AbortController();
  dictBuild = { controller, win: null };
  const startedAt = Date.now();
  const estTotal = DICT_EST_PAGES.tags + DICT_EST_PAGES.aliases + DICT_EST_PAGES.wiki;
  const stageLabels = { tags: 'タグの一覧を取得しています', aliases: '別名を取得しています', wiki: '日本語名(Wiki)を取得しています', saving: '保存しています' };

  const win = new BrowserWindow({
    title: '辞書を作る',
    icon: path.join(__dirname, 'build', 'icon.png'),
    width: 480,
    height: 250,
    useContentSize: true,
    parent: parent || undefined,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16172b' : '#f3f3f7',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  dictBuild.win = win;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    try { if (new URL(url).hostname === DICT_UI_HOST) controller.abort(); } catch { /* 無視 */ }
  });
  win.on('close', () => controller.abort()); // 閉じたら中止(作り終わって、こちらから閉じたときは、すでに終わっている)
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(dictProgressHtml()));
  refreshMenu();

  const show = (stage, fraction, detail) => {
    if (win.isDestroyed()) return;
    const main = getMainWindow();
    if (main && !main.isDestroyed()) main.setProgressBar(fraction >= 1 ? -1 : fraction);
    win.webContents.executeJavaScript(`window.__update && window.__update(${JSON.stringify({ stage, fraction, detail })})`).catch(() => {});
  };
  show(stageLabels.tags, 0, '接続しています…');

  let outcome;
  try {
    const result = await fetchDanbooruDictionary({
      fetchFn: (url, init) => net.fetch(url, init),
      signal: controller.signal,
      onProgress: ({ stage, page, requests }) => {
        const total = Math.max(estTotal, requests + 10);
        const elapsed = Date.now() - startedAt;
        const remain = requests > 0 ? (elapsed / requests) * (total - requests) : 0;
        show(stageLabels[stage], Math.min(0.99, requests / total),
          `${stage === 'tags' ? 'タグ一覧' : stage === 'aliases' ? '別名' : '日本語名'}: ${page} ページ目(問い合わせ ${requests} 回)/ 残り ${formatMinutes(remain)}`);
      },
    });
    show(stageLabels.saving, 1, `タグ ${result.tags.length} 件`);
    saveBuiltDictionary(result);
    loadDictionary();
    refreshMenu();
    injectSuggest();
    const characters = result.tags.filter(t => t[1] === 4).length;
    outcome = { type: 'info', message: `辞書を作りました(全タグ ${result.tags.length} 件、うちキャラクター ${characters} 件)。`, detail: `日本語名(Wiki)を ${Object.keys(result.translations).length} 件取得しました。日本語訳は、いま ${translationCount} 件です。\n前の辞書は、${path.basename(tagDictionaryFile())}.bak に残してあります。` };
  } catch (err) {
    outcome = err && err.name === 'AbortError'
      ? { type: 'info', message: '辞書を作るのを、中止しました。', detail: 'いまの辞書は、変わっていません。' }
      : { type: 'error', message: '辞書を作れませんでした。', detail: `${err.message}\nいまの辞書は、変わっていません。` };
  } finally {
    dictBuild = null;
    const main = getMainWindow();
    if (main && !main.isDestroyed()) main.setProgressBar(-1);
    if (!win.isDestroyed()) win.destroy();
    refreshMenu();
  }
  showMessage(getMainWindow() || undefined, { title: APP_NAME, ...outcome });
}

// ---- タグのサジェスト ----
// NovelAI のページの中で、suggest-client.js を実行する。辞書と日本語訳は、ページの中の変数に渡す
let migemoFiles; // { script, dictBase64 } / 使えないとき null / まだ調べていないとき undefined
function loadMigemo() {
  if (migemoFiles !== undefined) return migemoFiles;
  try {
    const dist = path.dirname(require.resolve('jsmigemo'));
    migemoFiles = {
      script: fs.readFileSync(path.join(dist, 'jsmigemo.min.iife.js'), 'utf-8'),
      dictBase64: fs.readFileSync(path.join(dist, '..', 'migemo-compact-dict')).toString('base64'),
    };
  } catch {
    migemoFiles = null;
  }
  return migemoFiles;
}

async function injectSuggest(target) {
  const win = target || getMainWindow();
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  try {
    if (!tagList || !settings.suggest) {
      await wc.executeJavaScript('window.__naiSuggest && window.__naiSuggest.dispose()');
      return;
    }
    const migemoOn = settings.suggestJa && settings.suggestMigemo && translations && loadMigemo();
    if (migemoOn) await wc.executeJavaScript(loadMigemo().script); // jsmigemo(ページの変数 jsmigemo ができる。使ったあとに消える)
    const tags = tagList.map(t => [t[0], t[1], t[2], t[3], translations ? translations[t[0]] || '' : '']);
    const code = fs.readFileSync(path.join(__dirname, 'suggest-client.js'), 'utf-8');
    const payload = {
      tags,
      migemoDict: migemoOn ? loadMigemo().dictBase64 : '',
      settings: { enabled: true, comma: settings.suggestComma, space: settings.suggestSpace, ja: settings.suggestJa, migemo: settings.suggestMigemo, max: settings.suggestMax, onCaret: settings.suggestOnCaret },
    };
    await wc.executeJavaScript(`(${code})(${JSON.stringify(payload)})`);
  } catch (err) {
    console.error(`サジェストを読み込めませんでした: ${err.message}`);
  }
}

function setSuggestOption(key, value) {
  settings[key] = value;
  saveSettings();
  injectSuggest();
  pushAssist();
}

// ---- 画面のパネル(生成時間・自動生成) ----
// NovelAI のページの中に、panel-client.js でパネルを重ねる。ページからの操作は、console.log の特別な文字列で受け取る
// (preload や IPC は使わない。トークンは起動ごとにランダムで、ページの中に渡す)
const PANEL_TOKEN = crypto.randomBytes(12).toString('hex');
const PANEL_PREFIX = `__naiwrapper__:${PANEL_TOKEN}:`;
let batchState = null; // 自動生成パネルに出す状態(runBatch が更新する)。まだ一度も実行していなければ null

async function injectPanels(target) {
  const win = target || getMainWindow();
  if (!win || win.isDestroyed()) return;
  try {
    const code = fs.readFileSync(path.join(__dirname, 'panel-client.js'), 'utf-8');
    const payload = { token: PANEL_TOKEN, showTime: settings.showTimePanel, showBatch: settings.showBatchPanel,
      showAssist: settings.showAssistPanel, showAssistSettings: settings.showAssistSettingsPanel,
      showSets: settings.showSetsPanel, showCheck: settings.showCheckPanel, markDuplicates: settings.markDuplicates, showChips: settings.showChips, chipsAlways: settings.chipsAlways, emphasis: settings.emphasis, assist: assistState(), batch: batchState,
      showViewBox: settings.showViewBox, zoom: win.webContents.getZoomFactor(), simple: { max: settings.simpleMax, minutes: settings.simpleMinutes } };
    await win.webContents.executeJavaScript(`(${code})(${JSON.stringify(payload)})`);
  } catch (err) {
    console.error(`パネルを表示できませんでした: ${err.message}`);
  }
}

function configurePanels() {
  const win = getMainWindow();
  if (!win) return;
  const opts = JSON.stringify({ showTime: settings.showTimePanel, showBatch: settings.showBatchPanel,
    showAssist: settings.showAssistPanel, showAssistSettings: settings.showAssistSettingsPanel,
    showSets: settings.showSetsPanel, showCheck: settings.showCheckPanel, markDuplicates: settings.markDuplicates, showChips: settings.showChips, chipsAlways: settings.chipsAlways, emphasis: settings.emphasis,
    showViewBox: settings.showViewBox });
  win.webContents.executeJavaScript(`window.__naiPanels && window.__naiPanels.configure(${opts})`).catch(() => {});
}

// 「入力補助の設定」パネルに出す状態(設定と、辞書の取り込み状況)
function assistState() {
  return {
    suggest: settings.suggest, suggestComma: settings.suggestComma, suggestSpace: settings.suggestSpace,
    suggestJa: settings.suggestJa, suggestMigemo: settings.suggestMigemo, suggestOnCaret: settings.suggestOnCaret, markDuplicates: settings.markDuplicates, showChips: settings.showChips, chipsAlways: settings.chipsAlways, emphasis: settings.emphasis,
    suggestMax: settings.suggestMax, maxChoices: SUGGEST_MAX_CHOICES,
    dict: [
      tagList ? `辞書: 取り込み済み(${tagList.length} 件)`
        : dictionary ? `辞書: キャラクターのみ(${dictionary.names.size} 件。取り込み直してください)` : '辞書: 未取り込み',
      translations ? `日本語訳: 取り込み済み(${translationCount} 件)` : '日本語訳: 未取り込み',
      '取り込みは、メニュー「入力補助」から。',
    ].join('\n'),
  };
}

function pushAssist() {
  const win = getMainWindow();
  if (!win) return;
  win.webContents.executeJavaScript(`window.__naiPanels && window.__naiPanels.setAssist(${JSON.stringify(assistState())})`).catch(() => {});
}

// タグのお気に入り・最近使ったタグ(ページの localStorage にある)を消す
function clearTagUserData() {
  const win = getMainWindow();
  if (win) win.webContents.executeJavaScript('window.__naiSuggest && window.__naiSuggest.clearUserData()').catch(() => {});
}

function setPanelOption(key, value) {
  settings[key] = value;
  saveSettings();
  configurePanels();
  pushAssist();
}

// 自動生成パネルの状態を更新して、画面に送る
function pushBatchState(patch) {
  batchState = Object.assign({ stopIfCost }, batchState, patch);
  const win = getMainWindow();
  if (!win) return;
  win.webContents.executeJavaScript(`window.__naiPanels && window.__naiPanels.setBatch(${JSON.stringify(batchState)})`).catch(() => {});
}

function setStopIfCost(on) {
  stopIfCost = on;
  pushBatchState({ stopIfCost });
  refreshMenu();
}

function requestStop() {
  if (!batchRunning) return;
  batchCancel = true;
  pushBatchState({ stopping: true });
}

// 一時停止・再開(CSV 自動生成・連続生成のどちらにも効く)。
// 押したとき生成中なら、その 1 枚が終わってから止まる(pausing)。次の回に進む前に待つ(paused)。
function togglePause() {
  if (!batchRunning || batchCancel) return;
  batchPause = !batchPause;
  pushBatchState(batchPause ? { pausing: true } : { pausing: false });
  refreshMenu();
}

// 次の回に進む前に呼ぶ。一時停止中なら、再開か停止まで待つ。待った時間(ミリ秒)を返す
// (経過時間と連続上限の時間に、一時停止の間を数えないため。呼び出し側が開始時刻をその分ずらす)
async function waitIfPaused() {
  if (!batchPause || batchCancel) return 0;
  const from = Date.now();
  pushBatchState({ pausing: false, paused: true, pausedAt: from, stage: '一時停止中' });
  while (batchPause && !batchCancel) await sleep(300);
  const ms = Date.now() - from;
  pushBatchState({ paused: false, pausedAt: 0, startedAt: (batchState.startedAt || from) + ms });
  return ms;
}

// パネルからの操作(ページが console.log で送ってくる)
// 「表示」ツールチップのボタン(メニュー「View」と同じ動き)
function doViewAction(action) {
  const win = getMainWindow();
  if (!win) return;
  const wc = win.webContents;
  if (action === 'reload') wc.reload();
  else if (action === 'forceReload') wc.reloadIgnoringCache();
  else if (action === 'zoomIn') wc.setZoomLevel(wc.getZoomLevel() + 0.5);
  else if (action === 'zoomOut') wc.setZoomLevel(wc.getZoomLevel() - 0.5);
  else if (action === 'zoomReset') wc.setZoomLevel(0);
  else if (action === 'fullscreen') win.setFullScreen(!win.isFullScreen());
}

function handlePanelMessage(message) {
  if (typeof message !== 'string' || !message.startsWith(PANEL_PREFIX)) return;
  const cmd = message.slice(PANEL_PREFIX.length);
  if (cmd === 'start') startBatch();
  else if (cmd === 'stop') requestStop();
  else if (cmd === 'pause') togglePause();
  else if (cmd === 'cost:1') setStopIfCost(true);
  else if (cmd === 'cost:0') setStopIfCost(false);
  else if (cmd.startsWith('view:')) doViewAction(cmd.slice(5));
  else if (cmd === 'reveal') { if (lastSavedPath && fs.existsSync(lastSavedPath)) shell.showItemInFolder(lastSavedPath); } // 保存のお知らせを押したとき
  else if (cmd === 'simple:start') startSimple();
  else if (cmd.startsWith('simple:max:')) setSimpleOption('simpleMax', cmd.slice(11), SIMPLE_MAX_COUNT);
  else if (cmd.startsWith('simple:min:')) setSimpleOption('simpleMinutes', cmd.slice(11), SIMPLE_MAX_MINUTES);
  else if (cmd.startsWith('opt:')) { // 入力補助の設定パネルからの変更(「opt:設定名:値」)
    const [, key, value] = cmd.split(':');
    if (['suggest', 'suggestComma', 'suggestSpace', 'suggestJa', 'suggestMigemo', 'suggestOnCaret'].includes(key)) setSuggestOption(key, value === '1');
    else if (key === 'emphasis') setPanelOption('emphasis', value === '1');
    else if (key === 'markDuplicates') setPanelOption('markDuplicates', value === '1');
    else if (key === 'showChips') setPanelOption('showChips', value === '1');
    else if (key === 'chipsAlways') setPanelOption('chipsAlways', value === '1');
    else if (key === 'suggestMax' && SUGGEST_MAX_CHOICES.includes(Number(value))) setSuggestOption('suggestMax', Number(value));
  } else if (cmd.startsWith('from:')) {
    const n = Math.floor(Number(cmd.slice(5)));
    startFrom = Number.isFinite(n) && n >= 1 ? Math.min(n, 100000) : 1;
    pushBatchState({ startFrom });
  } else if (cmd.startsWith('error:')) {
    // パネルが、画面にエラーの通知(トースト)が出たのを見つけた。実行中で、設定がオンのときだけ受け付ける(最初の 1 件だけ覚える)
    if (batchRunning && settings.stopOnError && !batchError) batchError = cmd.slice(6).replace(/\s+/g, ' ').trim().slice(0, 120) || '(文言なし)';
  }
}

// PNG の tEXt(テキスト情報)を読み、NovelAI の「Comment」(JSON)から、シード・プロンプト・キャラクター欄のプロンプトを取り出す
// 読めない・PNG でないときは null
function readPngMetadata(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  if (buf.length < 8 || buf.toString('latin1', 1, 4) !== 'PNG') return null;
  let comment = null;
  for (let i = 8; i + 12 <= buf.length;) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    if (type === 'tEXt' || type === 'iTXt') { // 新しい NovelAI の画像は iTXt(UTF-8。圧縮の印つき)で書く
      const body = buf.subarray(i + 8, i + 8 + len);
      const zero = body.indexOf(0);
      if (zero > 0 && body.toString('latin1', 0, zero) === 'Comment') {
        if (type === 'tEXt') comment = body.toString('utf-8', zero + 1);
        else {
          // iTXt: キーワード 0 / 圧縮の印 1 バイト / 圧縮方式 1 バイト / 言語タグ 0 / 翻訳キーワード 0 / 本文
          const langEnd = body.indexOf(0, zero + 3);
          const transEnd = langEnd < 0 ? -1 : body.indexOf(0, langEnd + 1);
          if (transEnd >= 0) {
            const text = body.subarray(transEnd + 1);
            try { comment = (body[zero + 1] === 1 ? zlib.inflateSync(text) : text).toString('utf-8'); } catch { /* 読めない */ }
          }
        }
      }
    }
    if (type === 'IEND' || comment) break;
    i += 12 + len;
  }
  if (!comment) return null;
  try {
    const j = JSON.parse(comment);
    const caption = j.v4_prompt && j.v4_prompt.caption;
    return {
      seed: j.seed === undefined || j.seed === null ? '' : String(j.seed),
      base: String((caption && caption.base_caption) || j.prompt || ''),
      chars: ((caption && caption.char_captions) || []).map(c => String((c && c.char_caption) || '')),
    };
  } catch {
    return null;
  }
}

// プロンプト(ベース → キャラクター欄の順)のタグのうち、辞書でキャラクターと分かるものを、重複なしで順に返す。辞書がなければ空
function findCharacterTags(meta) {
  if (!dictionary || !meta) return [];
  const tags = [meta.base, ...meta.chars].flatMap(text => text.split(/[,\n]/)).map(normalizeTag).filter(Boolean);
  return [...new Set(tags)].filter(tag => dictionary.names.has(tag) || dictionary.aliases.has(tag));
}

// ---- ファイル名のルール ----
// 書式の中の {日時} {日付} {時刻} {連番} {元の名前} {行} {キャラ1} {キャラ2}… を、保存のたびに置き換える
// (拡張子は元のものを付ける)。{行} {キャラ◯} は、自動生成中の保存のときだけ値が入る(それ以外は空)
const FILE_NAME_PARTS = '{日時} {日付} {時刻} {連番} {元の名前} {行} {キャラ1} {tag} {characters} {seed}';

// ファイル名に使えない文字を「_」にして、前後の空白・ピリオドを取り、長さを抑える
function cleanName(text, max = 150) {
  return String(text || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').slice(0, max).trim();
}

// ctx: { now: Date, seq: number, orig: 元の名前(拡張子なし), row: 行番号, chars: [CSV のキャラクターのタグ…],
//        seed: シード, tag: 最初のキャラクタータグ(整形済み), characters: 全キャラクターのタグ(整形済み) }
function expandName(rule, ctx) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const d = ctx.now;
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; // 例: 20261112
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const parts = { 日時: `${date}_${time}`, 日付: date, 時刻: time, 連番: pad(ctx.seq, 3), 元の名前: cleanName(ctx.orig), 行: ctx.row || '' };
  parts.tag = parts.タグ = ctx.tag || '';
  parts.characters = parts.全キャラ = ctx.characters || '';
  parts.seed = parts.シード = ctx.seed || '';
  const out = rule.replace(/\{([^{}]+)\}/g, (whole, key) => {
    if (key in parts) return parts[key];
    // {日時:YYYYMMDD-HHmmss} のように、「:」のあとに日付の書式を書ける(YYYY YY MM DD HH mm ss)
    const df = key.match(/^(?:日時|日付|時刻):(.+)$/);
    if (df) {
      const map = { YYYY: d.getFullYear(), YY: pad(d.getFullYear() % 100), MM: pad(d.getMonth() + 1), DD: pad(d.getDate()), HH: pad(d.getHours()), mm: pad(d.getMinutes()), ss: pad(d.getSeconds()) };
      return df[1].replace(/YYYY|YY|MM|DD|HH|mm|ss/g, (t) => map[t]);
    }
    const m = key.match(/^キャラ(\d+)$/);
    return m ? cleanName((ctx.chars || [])[Number(m[1]) - 1], 40) : whole; // 知らない {…} はそのまま
  });
  return cleanName(out);
}

// キャラクターのタグを、保存名に入れる形にする(各タグを tagLength 文字までにして、区切り文字でつなぐ)。なければ noTagName
function formatTags(tags) {
  const cut = (t) => (settings.tagLength > 0 ? t.slice(0, settings.tagLength) : t);
  const text = tags.map(cut).join(settings.tagSeparator);
  return text || settings.noTagName;
}

// ルールに、画像の中身(シード・キャラクタータグ)が必要な部品が入っているか
const usesImageInfo = () => /\{(seed|シード|tag|タグ|characters|全キャラ)\}/.test(settings.nameRule);

// 保存する 1 件分の、保存名(拡張子つき)を決める。meta は画像から読んだ情報(readPngMetadata)。なければ null
// ルールが既定のとき・結果が空のときは、元の名前のまま。画像を読めないとき、シードは元の名前の「s-数字」から取る
function savedFileName(originalName, meta = null) {
  const base = path.basename(originalName || '') || 'image.png';
  if (settings.nameRule === DEFAULT_NAME_RULE) return base;
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  if (settings.nameRule.includes('{連番}')) { settings.seq += 1; saveSettings(); }
  const tags = findCharacterTags(meta);
  const seedInName = (stem.match(/\bs-(\d+)$/) || [])[1] || '';
  const name = expandName(settings.nameRule, {
    now: new Date(),
    seq: settings.seq,
    orig: stem,
    row: batchContext ? String(batchContext.row) : '',
    chars: batchContext ? batchContext.chars : [],
    seed: (meta && meta.seed) || seedInName,
    tag: formatTags(tags.slice(0, 1)),
    characters: formatTags(tags),
  });
  return name ? name + ext : base;
}

// ルールを入力するウィンドウ(sandbox のまま、フォームの送信先を見て受け取る)
const NAMING_HOST = 'nai-wrapper.invalid';
let namingWindow = null;

function namingHtml() {
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const chips = ['{日時}', '{日付}', '{時刻}', '{連番}', '{元の名前}', '{tag}', '{characters}', '{seed}', '{行}', '{キャラ1}', '{キャラ2}'];
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>ファイル名のルール</title>
<style>
  body { margin: 0; padding: 20px; background: #0e0f21; color: #e8e8f0; font: 14px sans-serif; }
  h1 { font-size: 16px; margin: 0 0 12px; }
  input[type=text], input[type=number] { box-sizing: border-box; padding: 8px; font: 14px monospace; background: #fff; color: #000; border: 1px solid #888; border-radius: 4px; }
  #rule { width: 100%; }
  .box { margin: 12px 0; padding: 10px; background: #1b1d3a; border-radius: 6px; line-height: 1.7; }
  .row { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
  .row label { width: 12em; }
  code { color: #9fb4ff; }
  button { padding: 7px 18px; margin-right: 8px; border: 0; border-radius: 4px; background: #4f6bed; color: #fff; cursor: pointer; }
  button.sub { background: #333648; }
  button.chip { padding: 4px 10px; margin: 3px 4px 3px 0; border: 1px solid #4a5aa8; background: transparent; color: #9fb4ff; border-radius: 14px; font: 12px monospace; }
  small { color: #aab; }
</style>
<h1>保存するファイル名のルール</h1>
<form method="get" action="https://${NAMING_HOST}/save">
  <input type="text" name="rule" id="rule" value="${esc(settings.nameRule)}" autofocus>
  <div>${chips.map(c => `<button type="button" class="chip" data-part="${esc(c)}">${esc(c)}</button>`).join('')}</div>
  <div class="box">保存名の例: <b id="preview"></b></div>
  <div class="row"><label>各タグの先頭の文字数</label><input type="number" name="len" id="len" min="0" max="100" value="${settings.tagLength}" style="width:6em"> <small>0 = 制限なし</small></div>
  <div class="row"><label>複数キャラの区切り文字</label><input type="text" name="sep" id="sep" value="${esc(settings.tagSeparator)}" style="width:6em"></div>
  <div class="row"><label>タグがないときの名前</label><input type="text" name="none" id="none" value="${esc(settings.noTagName)}" style="width:12em"></div>
  <div class="box"><small>
    <code>{日時}</code> <code>{日付}</code> <code>{時刻}</code> 保存した日時 / <code>{連番}</code> 001, 002… / <code>{元の名前}</code><br>
    日時の書式を変えるときは <code>{日時:YYYY-MM-DD_HHmmss}</code> のように、「:」のあとに書く(YYYY 年 / MM 月 / DD 日 / HH 時 / mm 分 / ss 秒)<br>
    <code>{tag}</code> 最初のキャラクタータグ / <code>{characters}</code> 全キャラクターのタグ / <code>{seed}</code> シード値<br>
    (<code>{tag}</code> <code>{characters}</code> は、取り込んだ辞書で探します。自動保存のときだけ画像の中身を読みます。詳しくはマニュアルを見てください)<br>
    <code>{行}</code> <code>{キャラ1}</code>… 自動生成中の、CSV の行番号とキャラクターのタグ
  </small></div>
  <button type="submit">保存</button>
  <button type="submit" class="sub" formaction="https://${NAMING_HOST}/reset" formnovalidate>既定に戻す</button>
  <button type="submit" class="sub" formaction="https://${NAMING_HOST}/cancel" formnovalidate>キャンセル</button>
</form>
<script>
  const sample = { '日時': '20261112_153045', '日付': '20261112', '時刻': '153045', '連番': '001', '元の名前': 'image', '行': '3', 'キャラ1': 'girl, red hair', 'seed': '1979642406', 'シード': '1979642406' };
  const input = document.getElementById('rule');
  const fmt = (tags) => {
    const len = Number(document.getElementById('len').value) || 0;
    return tags.map(t => (len > 0 ? t.slice(0, len) : t)).join(document.getElementById('sep').value);
  };
  const show = () => {
    const tags = ['kagamine_ren', 'uzumaki_naruto'];
    const text = input.value.replace(/\{([^{}]+)\}/g, (w, k) => {
      if (k in sample) return sample[k];
      const df = k.match(/^(?:日時|日付|時刻):(.+)$/);
      if (df) return df[1].replace(/YYYY|YY|MM|DD|HH|mm|ss/g, (t) => ({ YYYY: '2026', YY: '26', MM: '11', DD: '12', HH: '15', mm: '30', ss: '45' })[t]);
      if (k === 'tag' || k === 'タグ') return fmt(tags.slice(0, 1));
      if (k === 'characters' || k === '全キャラ') return fmt(tags);
      return /^キャラ\d+$/.test(k) ? '' : w;
    });
    document.getElementById('preview').textContent = (text.replace(/[\\\\/:*?"<>|]/g, '_').trim() || '(空: 元の名前になります)') + '.png';
  };
  document.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
    const at = input.selectionStart === null ? input.value.length : input.selectionStart;
    input.value = input.value.slice(0, at) + b.dataset.part + input.value.slice(input.selectionEnd === null ? at : input.selectionEnd);
    input.focus(); input.setSelectionRange(at + b.dataset.part.length, at + b.dataset.part.length); show();
  }));
  ['rule', 'len', 'sep', 'none'].forEach(id => document.getElementById(id).addEventListener('input', show));
  show();
</script></html>`;
}

function openNamingWindow() {
  if (namingWindow && !namingWindow.isDestroyed()) {
    namingWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    title: 'ファイル名のルール',
    icon: path.join(__dirname, 'build', 'icon.png'),
    width: 560,
    height: 560,
    backgroundColor: '#0e0f21',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  namingWindow = win;
  win.on('closed', () => { namingWindow = null; });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    let u;
    try { u = new URL(url); } catch { return; }
    if (u.hostname !== NAMING_HOST) return;
    if (u.pathname === '/save') {
      settings.nameRule = (u.searchParams.get('rule') || '').trim() || DEFAULT_NAME_RULE;
      const len = parseInt(u.searchParams.get('len'), 10);
      settings.tagLength = Number.isInteger(len) && len >= 0 ? Math.min(len, 100) : settings.tagLength;
      settings.tagSeparator = cleanName(u.searchParams.get('sep') || '', 10);
      settings.noTagName = cleanName(u.searchParams.get('none') || '', 40) || 'NoChara';
    } else if (u.pathname === '/reset') {
      settings.nameRule = DEFAULT_NAME_RULE;
      settings.tagLength = 20;
      settings.tagSeparator = '+';
      settings.noTagName = 'NoChara';
    } else {
      win.close();
      return;
    }
    saveSettings();
    refreshMenu();
    win.close();
  });
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(namingHtml()));
}

// ダウンロードの扱い: 自動保存がオンで、保存先が使えるときだけ、保存先を決めてしまう
// (それ以外は何もしない。Electron 標準の「名前を付けて保存」が出る)
// 保存したとき、画面に「○○ を △△ に保存しました」と出す(押すと、保存したフォルダを開く)
let lastSavedPath = null;
function announceSaved(filePath) {
  if (!filePath) return;
  lastSavedPath = filePath;
  if (!settings.notifySaved) return;
  const win = getMainWindow();
  if (!win) return;
  const text = `${path.basename(filePath)} を ${path.dirname(filePath)} に保存しました`;
  win.webContents.executeJavaScript(`window.__naiPanels && window.__naiPanels.toast(${JSON.stringify(text)})`).catch(() => {});
}

function registerDownloads() {
  const ses = session.fromPartition('persist:novelai');
  ses.on('will-download', (_e, item) => {
    const original = path.basename(item.getFilename() || '');
    const folderOk = settings.autoSave && settings.saveDir && fs.existsSync(settings.saveDir);
    let target = null; // 自動保存で、いま保存するファイル
    let renameAfter = false; // 保存したあとに、画像の中身を読んで名前を付け替えるか
    if (folderOk) {
      renameAfter = settings.nameRule !== DEFAULT_NAME_RULE && usesImageInfo();
      // 画像の中身が必要なときは、いったん元の名前で保存して、終わってから付け替える
      target = uniquePath(settings.saveDir, renameAfter ? original : savedFileName(original));
      item.setSavePath(target);
    } else {
      // 毎回選ぶとき(画像の中身は読めない)も、「名前を付けて保存」の最初の名前にルールを使う
      const name = savedFileName(original);
      if (name !== original) item.setSaveDialogOptions({ defaultPath: path.join(settings.saveDir || app.getPath('downloads'), name) });
    }
    item.once('done', (_ev, state) => {
      let savedPath = target; // 保存したファイル(名前を付け替えたら、付け替えたあとの名前)
      if (state === 'completed' && renameAfter && target) {
        try {
          const dest = uniquePath(settings.saveDir, savedFileName(original, readPngMetadata(target)));
          if (dest !== target) { fs.renameSync(target, dest); savedPath = dest; }
        } catch (err) {
          console.error(`名前を付け替えられませんでした: ${err.message}`);
        }
      }
      if (state === 'completed') { // 完了: 「名前を付けて保存」で選んだ場所のときは、item から取る
        let finalPath = savedPath;
        if (!finalPath) { try { finalPath = item.getSavePath(); } catch (_) { finalPath = null; } }
        announceSaved(finalPath);
        return;
      }
      if (state !== 'interrupted') return; // キャンセルのときは何も出さない
      const win = getMainWindow();
      showMessage(win || undefined, { type: 'error', title: APP_NAME, message: '保存できませんでした。', detail: item.getFilename() });
    });
  });
}

async function chooseSaveDir() {
  const win = getMainWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win || undefined, {
    title: '保存先のフォルダを選択',
    defaultPath: settings.saveDir || app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths[0]) return false;
  settings.saveDir = filePaths[0];
  saveSettings();
  return true;
}

async function setAutoSave(on) {
  // 自動保存をオンにするとき、保存先が未設定(または消えている)なら、先に選んでもらう。選ばなければオンにしない
  if (on && (!settings.saveDir || !fs.existsSync(settings.saveDir)) && !(await chooseSaveDir())) {
    refreshMenu();
    return;
  }
  settings.autoSave = on;
  saveSettings();
  refreshMenu();
}

// メニューを作り直す(設定の表示を反映するため)
function refreshMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate()));
  pushAssist(); // 辞書の取り込み状況などが変わったときも、ここを通る
}

// パッケージ化されていない拡張機能(展開済みフォルダ)の置き場所
function extensionsDir() {
  return path.join(app.getPath('userData'), 'extensions');
}

// 読み込めた拡張機能(設定画面を開くメニュー用)
let loadedExtensions = [];

// 置き場所の直下にある、manifest.json を持つフォルダを拡張機能として読み込む
async function loadExtensions() {
  loadedExtensions = [];
  const dir = extensionsDir();
  fs.mkdirSync(dir, { recursive: true });
  const ses = session.fromPartition('persist:novelai');
  const loader = ses.extensions || ses; // Electron 35 以降は session.extensions
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const extPath = path.join(dir, entry.name);
    if (!entry.isDirectory() || !fs.existsSync(path.join(extPath, 'manifest.json'))) continue;
    try {
      const ext = await loader.loadExtension(extPath);
      console.log(`拡張機能を読み込みました: ${ext.name}`);
      loadedExtensions.push({
        name: ext.name,
        url: ext.url,
        optionsPage: ext.manifest?.options_ui?.page || ext.manifest?.options_page || null,
      });
    } catch (err) {
      console.error(`拡張機能の読み込みに失敗しました(${entry.name}): ${err.message}`);
    }
  }
}

// 拡張機能の設定画面を、アプリ内の別ウィンドウで開く
// (Electron は chrome.runtime.openOptionsPage / chrome.tabs.create に対応していないため、拡張機能自身では開けない)
const settingsWindows = new Map();

function openExtensionSettings(ext) {
  const existing = settingsWindows.get(ext.url);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }
  const win = new BrowserWindow({
    title: `${ext.name} - 設定`,
    icon: path.join(__dirname, 'build', 'icon.png'),
    width: 1000,
    height: 800,
    backgroundColor: '#0e0f21',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:novelai', // 拡張機能を読み込んだセッションと同じ
    },
  });
  // 設定画面内のリンクは、既定のブラウザで開く
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => settingsWindows.delete(ext.url));
  settingsWindows.set(ext.url, win);
  win.loadURL(new URL(ext.optionsPage, ext.url).href);
}

// マニュアル(manual.html)・ライセンス(licenses.html)を別ウィンドウで開く
let manualWindow = null;
let licensesWindow = null;

function openManual() {
  openHelpWindow('manual.html', 'マニュアル', manualWindow, (w) => { manualWindow = w; });
}

function openLicenses() {
  openHelpWindow('licenses.html', 'ライセンスと権利表記', licensesWindow, (w) => { licensesWindow = w; });
}

function openHelpWindow(file, label, current, setCurrent) {
  if (current && !current.isDestroyed()) {
    current.focus();
    return;
  }
  const win = new BrowserWindow({
    title: `${APP_NAME} ${label}`,
    icon: path.join(__dirname, 'build', 'icon.png'),
    width: 960,
    height: 860,
    backgroundColor: '#0e0f21',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  setCurrent(win);
  win.on('closed', () => setCurrent(null));
  // 外部リンクは、既定のブラウザで開く(ページ内の移動はそのまま)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (/^https?:/i.test(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  win.loadFile(path.join(__dirname, file));
}

// ---- CSV から読み込んで自動生成 ----
// CSV の 1 行目は見出し。列は prompt / negative / character1, character2 ...(すべて省略可)。1 行 = 1 回の生成。
const GENERATE_TIMEOUT_MS = 5 * 60 * 1000; // 1 回の生成を待つ上限
// メインのウィンドウ(設定ウィンドウなどと区別する)
let mainWin = null;
const getMainWindow = () => (mainWin && !mainWin.isDestroyed() ? mainWin : null);
let batchRunning = false;
let batchCancel = false;
let batchPause = false; // 一時停止を頼まれている(次の回に進む前に待つ)
let batchError = null; // 自動生成中に、画面に表示されたエラーの文言(見つけたら止める)
let startFrom = 1; // 自動生成を、CSV の何件目から始めるか(1 = 最初から。開始のたびに 1 に戻る)
let batchContext = null; // 自動生成中の、今の行の情報({ row, chars })。ファイル名のルールで使う
let stopIfCost = true; // 生成ボタンに Anlas の消費が表示されたら止める

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 簡易 CSV パーサ(ダブルクォート・クォート内の改行/カンマ・BOM に対応)
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

// CSV を { prompt, negative, characters } の配列にする
// prompt / negative の空欄(列がない場合も含む)は null = 「画面に今入力されている内容をそのまま使う」
// character の空欄は「そのキャラクターは使わない」(列自体がなければ、キャラクターには触らない)。character+ の空欄は「固定部分だけ」
function readJobs(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf-8'));
  if (rows.length < 2) throw new Error('データ行がありません(1 行目は見出しにしてください)。');
  const header = rows[0].map(h => h.trim().toLowerCase());
  const pi = header.findIndex(h => h === 'prompt' || h === 'プロンプト');
  const ni = header.findIndex(h => h === 'negative' || h === 'ネガティブ');
  // キャラクタープロンプト: character1, character2 ...(キャラ1、キャラクター1 も可)
  // 末尾に + を付けた列(character1+)は「置き換え」ではなく、今の画面のキャラクター欄の内容を固定部分として、その後ろに足す
  const chars = [];
  header.forEach((h, col) => {
    const m = h.match(/^(?:character|キャラクター|キャラ)\s*(\d+)\s*([+＋]?)$/);
    if (!m) return;
    const n = Number(m[1]);
    if (n < 1) throw new Error(`見出し「${h}」の番号は 1 以上にしてください。`);
    if (chars.some(c => c.n === n)) throw new Error(`キャラクター${n}の列が重複しています(「character${n}」と「character${n}+」は、どちらか一方にしてください)。`);
    chars.push({ n, col, append: m[2] !== '' });
  });
  chars.sort((x, y) => x.n - y.n);
  // 見出しが空の列(見出しより長い行の右側も含む)は、すぐ左の「認識した列」の続きとして扱う
  // (キャラクターの列なら、同じキャラクターのタグとして足す)。認識できない見出しの列は無視する
  const width = Math.max(header.length, ...rows.slice(1).map(r => r.length));
  const recognized = (j) => j === pi || j === ni || chars.some(c => c.col === j);
  const owner = [];
  for (let j = 0; j < width; j++) {
    if (header[j] === undefined || header[j] === '') owner[j] = j > 0 ? owner[j - 1] : -1;
    else owner[j] = recognized(j) ? j : -1;
  }
  chars.forEach(c => { c.cols = owner.flatMap((o, j) => (o === c.col ? [j] : [])); });
  if (pi < 0 && ni < 0 && chars.length === 0) throw new Error('見出しに「prompt」「negative」「character1」などの列がありません。');
  const cell = (r, col) => {
    const v = col >= 0 ? (r[col] || '').trim() : '';
    return v === '' ? null : v;
  };
  return rows.slice(1).map(r => ({
    prompt: cell(r, pi),
    negative: cell(r, ni),
    // characters[k] は k+1 人目の指定({ text, append })。列がない人は null(画面には触らない)
    // text の空欄は、置き換えの列では「そのキャラクターなし(プロンプトとキャラクターの UC を空にする)」、足す列では「固定部分だけ」
    characters: Array.from({ length: chars.length ? chars[chars.length - 1].n : 0 }, (_, k) => {
      const c = chars.find(x => x.n === k + 1);
      // 同じキャラクターの列(右隣の見出しなしの列を含む)の空でない値を、「, 」でつなぐ
      return c ? { text: c.cols.map(j => (r[j] || '').trim()).filter(Boolean).join(', '), append: c.append } : null;
    }),
  }));
}

// ボタンに Anlas のコスト(0 より大きい数字)が表示されているか(「1 Image」「1枚」などの枚数表示は除く)
function hasCost(text) {
  const nums = text.replace(/\d+\s*(images?|枚)/gi, '').replace(/generate|生成/gi, '').match(/\d+/g) || [];
  return nums.some(n => Number(n) > 0); // 0 は無料生成なので消費とはみなさない
}

// ページ内で実行するスクリプト(novelai.net の画面の作りに依存します)
// 入力欄: 画面内の編集欄(ProseMirror または textarea)を上から順に、
// 1 つ目=プロンプト、2 つ目=ネガティブ。キャラクターは画面上で「カード」になっていて、
// 開いているカードだけに編集欄(プロンプト・除外したい要素)が出る(charParts を参照)
const PAGE_HELPERS = `
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const editors = () => [...document.querySelectorAll('.ProseMirror[contenteditable="true"], textarea')].filter(visible);
  // キャラクター欄: 見出し「キャラクタープロンプト」の近くにある追加ボタン(文字なしのボタン)と、キャラクターのカード一覧
  const charParts = () => {
    const h = [...document.querySelectorAll('div')].find(e => visible(e) && !e.children.length &&
      /^(キャラクタープロンプト|character prompts?)$/i.test((e.textContent || '').trim()));
    if (!h) return null;
    for (let a = h.parentElement; a; a = a.parentElement) {
      const add = a.querySelector('span > div > button');
      if (!add) continue;
      const top = a.parentElement;
      const section = top && top.parentElement;
      if (!section) return null;
      return { add, cards: [...section.children].filter(c => c !== top && c.querySelector('input')) };
    }
    return null;
  };
  // 生成ボタン: 文字のどこかに「generate」「生成」を含むボタン(英語・日本語 UI 両対応)
  const genButton = () => [...document.querySelectorAll('button')].find(b => /generate|生成/i.test(b.textContent || ''));
  const isBusy = (b) => b.disabled || b.getAttribute('aria-disabled') === 'true';
  const setText = (el, text) => {
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand(text ? 'insertText' : 'delete', false, text);
  };
`;

async function runInPage(win, body) {
  return win.webContents.executeJavaScript(`(() => { ${PAGE_HELPERS} ${body} })()`);
}

// キャラクター追加メニューの項目名(日本語・英語)。プロンプトが girl/woman/female で始まれば女性、boy/man/male なら男性、他は「その他」
function genderLabels(text) {
  if (/^\s*\d*\s*(girl|woman|female)\b/i.test(text)) return ['女性', 'female', 'woman'];
  if (/^\s*\d*\s*(boy|man|male)\b/i.test(text)) return ['男性', 'male', 'man'];
  return ['その他', 'other'];
}

// 閉じているカードは、プレビューのボタンを押して開く
async function openCharacterCard(win, k) {
  await runInPage(win, `
    const c = charParts();
    const card = c && c.cards[${k}];
    if (card && !editors().some(e => card.contains(e))) {
      const b = card.querySelector(':scope > button');
      if (b) b.click();
    }
  `);
  await sleep(600); // カードが開くのを待つ
}

// k 番目のキャラクターの今のプロンプト(固定部分)を読む。カードがなければ空文字
async function readCharacterPrompt(win, k) {
  const n = await runInPage(win, `const c = charParts(); return c ? c.cards.length : -1;`);
  if (n < 0) throw new Error('キャラクター欄が見つかりません。');
  if (n <= k) return '';
  await openCharacterCard(win, k);
  return runInPage(win, `
    const c = charParts();
    const card = c && c.cards[${k}];
    const ed = card ? editors().filter(e => card.contains(e)) : [];
    return ed[0] ? ed[0].innerText.replace(/\\s+/g, ' ').trim() : '';
  `);
}

// 固定部分とタグを「, 」でつなぐ(固定部分の末尾のカンマは重ねない)
function joinTags(base, tag) {
  const head = base.replace(/[,\s]+$/, '');
  return head && tag ? `${head}, ${tag}` : head || tag;
}

// k 番目(0 始まり)のキャラクターのプロンプトを書き換える。clearUc が true なら、そのキャラクターの UC(除外したい要素)も空にする。
// カードが足りなければ追加ボタンで増やし、閉じているカードは(プレビューのボタンを押して)開く
async function fillCharacter(win, k, text, clearUc = false) {
  if (text === '') {
    // 「使わない」指定: カードがなければ何もしない(増やさない)。あればプロンプトを空にする(UC は clearUc のとき)
    const n = await runInPage(win, `const c = charParts(); return c ? c.cards.length : -1;`);
    if (n <= k) return '';
  }
  for (let t = 0; t <= k; t++) {
    const n = await runInPage(win, `const c = charParts(); return c ? c.cards.length : -1;`);
    if (n < 0) return 'キャラクター欄が見つかりません。';
    if (n > k) break;
    // 追加ボタンを押すと「女性 / 男性 / その他」の選択メニューが出るので、プロンプトの書き出しから選ぶ
    await runInPage(win, `window.__naiBefore = new Set([...document.querySelectorAll('body *')].filter(visible)); charParts().add.click();`);
    const labels = genderLabels(text);
    // メニューの項目は「♀ 女性」のように記号やアイコンが付くので、項目名を含む短い文字の要素のうち、いちばん内側のものを押す
    const finder = `
      const labels = ${JSON.stringify(labels)};
      const old = window.__naiBefore || new Set();
      const norm = (e) => (e.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const fresh = [...document.querySelectorAll('body *')].filter(e => visible(e) && !old.has(e));
      const hit = (e) => { const t = norm(e); return t.length <= 12 && labels.some(l => new RegExp('(^|[^a-z])' + l + '$').test(t)); }; // 「female」の末尾の「male」には当たらない
      const item = fresh.filter(hit).find(e => ![...e.children].some(c => visible(c) && hit(c)));
      if (item) { item.click(); return true; }
      return fresh.map(norm).filter(t => t && t.length <= 20).slice(0, 12).join(' / ');
    `;
    let seen = '';
    for (let w = 0; w < 6; w++) {
      await sleep(500); // メニューが開くのを待つ
      seen = await runInPage(win, finder);
      if (seen === true) break;
    }
    if (seen !== true) return `キャラクターを追加する選択メニュー(${labels[0]})が見つかりません。新しく出た表示: ${seen || '(なし)'}`;
    await sleep(800);
  }
  await openCharacterCard(win, k);
  return runInPage(win, `
    const c = charParts();
    const card = c && c.cards[${k}];
    if (!card) return 'キャラクター${k + 1}が見つかりません(追加できませんでした)。';
    const ed = editors().filter(e => card.contains(e));
    if (!ed[0]) return 'キャラクター${k + 1}の入力欄が見つかりません(カードを開けませんでした)。';
    setText(ed[0], ${JSON.stringify(text)});
    if (${clearUc} && ed[1]) setText(ed[1], '');
    return '';
  `);
}

// offset: 先頭から何件を飛ばして始めるか(開始行の指定。行番号の表示と {行} は、元の CSV の行のまま)
async function runBatch(win, jobs, offset = 0) {
  batchRunning = true;
  batchCancel = false;
  batchPause = false;
  batchError = null;
  refreshMenu(); // メニューの「一時停止」を押せるようにする
  let done = 0;
  let result = { kind: '', message: '' }; // パネルに出す結果
  const bases = {}; // 「+」の列の固定部分(開始時の、キャラクター欄の内容)
  pushBatchState({ running: true, stopping: false, done: 0, total: jobs.length, row: 0, stage: '準備中', startedAt: Date.now(), endedAt: 0, message: '', kind: '' });
  try {
    // 「+」の列は、開始時の内容を固定部分として覚えておく(終わったら、この内容に戻す)
    for (const [k, ch] of jobs[0].characters.entries()) {
      if (ch && ch.append) bases[k] = await readCharacterPrompt(win, k);
    }
    for (const [i, job] of jobs.entries()) {
      if (batchCancel) break;
      await waitIfPaused(); // 一時停止中なら、再開か停止まで待つ
      if (batchCancel) break;
      win.setTitle(`${APP_NAME} - CSV 自動生成 ${i + 1}/${jobs.length}`);
      const csvRow = i + 2 + offset; // 元の CSV の行番号(1 行目が見出しなので +2)
      batchContext = { row: i + 1 + offset, chars: job.characters.map(c => (c ? c.text : '')) };
      pushBatchState({ row: csvRow, stage: '入力中' }); // 行番号は CSV の行(1 行目が見出しなので +2)
      const err = await runInPage(win, `
        const job = ${JSON.stringify(job)};
        const ed = editors();
        if (!ed[0]) return '入力欄が見つかりません。';
        if (job.prompt !== null) setText(ed[0], job.prompt);
        if (job.negative !== null) {
          if (!ed[1]) return 'ネガティブプロンプトの入力欄が見つかりません。';
          setText(ed[1], job.negative);
        }
        return '';
      `);
      if (err) throw new Error(`${csvRow} 行目: ${err}`);
      for (const [k, ch] of job.characters.entries()) {
        if (!ch) continue;
        // 空欄(= そのキャラクターは使わない)のときは、プロンプトもキャラクターの UC も空にする
        const text = ch.append ? joinTags(bases[k], ch.text) : ch.text;
        const cerr = await fillCharacter(win, k, text, text === '');
        if (cerr) throw new Error(`${csvRow} 行目: ${cerr}`);
      }
      await sleep(500); // 入力が反映されるのを待つ
      if (stopIfCost) {
        const label = await runInPage(win, `const b = genButton(); return b ? b.textContent.replace(/\\s+/g, ' ').trim() : '';`);
        if (hasCost(label)) throw new Error(`${csvRow} 行目: Anlas を消費する設定になっています。ボタン表示「${label}」`);
      }
      const clicked = await runInPage(win, `
        const b = genButton();
        if (!b || isBusy(b)) return false;
        b.click();
        return true;
      `);
      if (!clicked) throw new Error(`${csvRow} 行目: 生成ボタンが見つからないか、押せない状態です。`);
      // 生成が終わる(ボタンが「生成」に戻って押せるようになる)まで待つ
      pushBatchState({ stage: '生成中' });
      await sleep(2000);
      const start = Date.now();
      while (!batchCancel) {
        // 画面にエラーが表示されたら止める(パネルが見つけて知らせてくる)。この行は完了に数えない
        if (batchError) throw new Error(`${csvRow} 行目: 画面にエラーが表示されました「${batchError}」`);
        const ready = await runInPage(win, `const b = genButton(); return !!b && !isBusy(b);`);
        if (ready) break;
        if (Date.now() - start > GENERATE_TIMEOUT_MS) throw new Error(`${csvRow} 行目: 生成が終わりませんでした(時間切れ)。`);
        await sleep(1000);
      }
      if (batchError) throw new Error(`${csvRow} 行目: 画面にエラーが表示されました「${batchError}」`);
      done++;
      pushBatchState({ done });
    }
    const stopped = batchCancel && done < jobs.length;
    const text = stopped ? `停止しました(${done}/${jobs.length} 件)。` : `CSV 自動生成が終わりました(${done} 件)。`;
    result = { kind: stopped ? 'info' : 'ok', message: text };
    showMessage(win, { type: 'info', title: APP_NAME, message: text });
  } catch (err) {
    result = { kind: 'error', message: `中断しました: ${err.message}` };
    showMessage(win, {
      type: 'error', title: APP_NAME,
      message: `CSV 自動生成を中断しました(${done}/${jobs.length} 件まで完了)。`,
      detail: err.message,
    });
  } finally {
    // 「+」の列は、次回の固定部分が変わらないよう、開始時の内容に戻す(戻せなくても、そのまま終える)
    for (const [k, base] of Object.entries(bases)) {
      try { await fillCharacter(win, Number(k), base); } catch (_) { /* 無視 */ }
    }
    batchRunning = false;
    batchPause = false;
    batchContext = null;
    pushBatchState({ running: false, stopping: false, pausing: false, paused: false, pausedAt: 0, stage: '', endedAt: Date.now(), ...result });
    refreshMenu();
    batchError = null;
    if (!win.isDestroyed() && !win.isFocused()) { // 別の窓を見ているときは、終わったことをタスクバー・通知で知らせる(窓を選ぶと点滅は止める)
      win.flashFrame(true);
      win.once('focus', () => win.flashFrame(false));
      if (process.platform === 'darwin' && app.dock) app.dock.bounce('informational'); // macOS は Dock のアイコンを跳ねさせる
      if (settings.notifyDone && Notification.isSupported()) {
        const n = new Notification({ title: APP_NAME, body: result.message || '自動生成が終わりました。' });
        n.on('click', () => { if (!win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
        n.show();
      }
    }
    win.setTitle(APP_NAME);
  }
}

// 入力欄・ボタンの一覧を文字列にする(自動生成が画面に合わないときの調査用)
function describeEditors(win) {
  return runInPage(win, `
    const short = (t, n) => (t || '').replace(/\\s+/g, ' ').trim().slice(0, n);
    const lines = editors().map((el, i) => {
      // 近くの文字: 編集欄の外側へたどり、自分以外の文字が見つかった所までの内容と、たどった階層の数
      let near = '';
      let depth = 0;
      for (let a = el.parentElement; a && depth < 8 && !near; a = a.parentElement) {
        depth++;
        near = short(a.textContent.replace(el.textContent, ''), 40);
      }
      return i + ': <' + el.tagName.toLowerCase() + '> label=' + (el.getAttribute('aria-label') || '') +
        ' placeholder=' + (el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '') +
        ' 近くの文字=' + near + ' (階層' + depth + ')';
    });
    // 「キャラクター」を含む短い文字の要素(ボタン以外も含む。いちばん内側のものだけ)
    const charEls = [...document.querySelectorAll('body *')]
      .filter(e => visible(e) && /character|キャラ/i.test(e.textContent || '') && short(e.textContent, 60).length < 30 &&
        ![...e.children].some(c => /character|キャラ/i.test(c.textContent || '')))
      .map(e => '<' + e.tagName.toLowerCase() + (e.getAttribute('role') ? ' role=' + e.getAttribute('role') : '') + '> 「' + short(e.textContent, 30) + '」');
    const btns = [...document.querySelectorAll('button')]
      .filter(b => /generate|生成/i.test(b.textContent || ''))
      .map(b => '「' + short(b.textContent, 40) + '」' + (b.disabled ? ' (無効)' : ''));
    return '[入力欄 ' + lines.length + ' 個]\\n' + lines.join('\\n') + '\\n\\n[「キャラクター」を含む要素]\\n' + charEls.join('\\n') + '\\n\\n[生成ボタン]\\n' + btns.join('\\n');
  `);
}

// キャラクター欄の周りの構造(要素の入れ子)を文字列にする。編集欄の中身(入力した文字)は出さない
function describeCharacters(win) {
  return runInPage(win, `
    const short = (t, n) => (t || '').replace(/\\s+/g, ' ').trim().slice(0, n);
    const ownText = (e) => short([...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' '), 20);
    const eds = editors();
    const header = [...document.querySelectorAll('body *')].find(e => visible(e) && /^(キャラクタープロンプト|character prompts?)$/i.test(short(e.textContent, 40)) && !e.children.length);
    if (!header) return 'キャラクタープロンプトの見出しが見つかりません。';
    let root = header;
    while (root.parentElement && !(eds[2] ? root.contains(eds[2]) : root !== header)) root = root.parentElement;
    if (root.parentElement) root = root.parentElement; // 1 つ外側も含める
    const out = [];
    const walk = (e, d) => {
      if (out.length >= 220 || d > 12 || !visible(e)) return;
      const isEd = eds.includes(e);
      const tags = [
        e.tagName.toLowerCase(),
        e.getAttribute('role') ? 'role=' + e.getAttribute('role') : '',
        e.getAttribute('aria-label') ? 'aria=' + short(e.getAttribute('aria-label'), 20) : '',
        e.getAttribute('title') ? 'title=' + short(e.getAttribute('title'), 20) : '',
        e.getAttribute('aria-expanded') ? 'expanded=' + e.getAttribute('aria-expanded') : '',
        getComputedStyle(e).cursor === 'pointer' ? 'クリック可' : '',
        isEd ? '[編集欄 ' + eds.indexOf(e) + ']' : '',
      ].filter(Boolean).join(' ');
      const t = isEd ? '' : ownText(e);
      out.push('  '.repeat(d) + tags + (t ? ' 「' + t + '」' : ''));
      if (!isEd) [...e.children].forEach(c => walk(c, d + 1));
    };
    walk(root, 0);
    return out.join('\\n');
  `);
}

// 画面の構造をまとめて調べて、表示とクリップボードへのコピーをする(調査用。入力した文字は含まない)
async function inspectScreen() {
  const win = getMainWindow();
  if (!win) return;
  const info = `${await describeEditors(win)}\n\n[キャラクター欄の構造]\n${await describeCharacters(win)}`;
  clipboard.writeText(info);
  showMessage(win, { type: 'info', title: APP_NAME, message: '画面の構造を調べました(クリップボードにコピー済み)。', detail: info.slice(0, 3000) });
}

// ---- 連続生成 ----
// CSV を使わず、いまの画面の設定のまま、「生成」を繰り返す。最大回数(1〜9999)と連続上限(分。1〜180)のどちらかに先に達したら止まる
// (時間の上限は、生成中の 1 枚が終わってから止まる)。Anlas を消費するとき・画面にエラーが出たときも止まる(メニュー「自動生成」のチェックがオンのとき)。
// 終わったとき・止まったときは、デスクトップ通知を出す
function clampInt(value, max) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(1, n)) : 1;
}

function setSimpleOption(key, value, max) {
  settings[key] = clampInt(value, max);
  saveSettings();
  pushBatchState(key === 'simpleMax' ? { simpleMax: settings.simpleMax } : { simpleMinutes: settings.simpleMinutes });
}

// 終わったことを知らせる(通知。窓が裏にあるときは、タスクバーの点滅・macOS の Dock の跳ねも)
function notifyEnd(win, body) {
  if (win && !win.isDestroyed() && !win.isFocused()) {
    win.flashFrame(true);
    win.once('focus', () => win.flashFrame(false));
    if (process.platform === 'darwin' && app.dock) app.dock.bounce('informational');
  }
  if (settings.notifyDone && Notification.isSupported()) {
    const n = new Notification({ title: APP_NAME, body });
    n.on('click', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
    n.show();
  }
}

async function runSimple(win, maxCount, minutes) {
  batchRunning = true;
  batchCancel = false;
  batchPause = false;
  batchError = null;
  batchContext = null;
  refreshMenu(); // メニューの「一時停止」を押せるようにする
  let startedAt = Date.now(); // 一時停止の間は数えないよう、再開のたびにずらす
  const limitMs = minutes * 60 * 1000;
  let done = 0;
  let result = { kind: '', message: '' };
  pushBatchState({ mode: 'simple', running: true, stopping: false, done: 0, total: maxCount, row: 0, stage: '準備中', startedAt, endedAt: 0, message: '', kind: '', limitMs, simpleMax: settings.simpleMax, simpleMinutes: settings.simpleMinutes });
  try {
    while (done < maxCount) {
      if (batchCancel) break;
      startedAt += await waitIfPaused(); // 一時停止中なら、再開か停止まで待つ(待った間は上限の時間に数えない)
      if (batchCancel) break;
      if (Date.now() - startedAt >= limitMs) break; // 連続上限に達した(次の回は始めない)
      win.setTitle(`${APP_NAME} - 連続生成 ${done}/${maxCount}`);
      pushBatchState({ row: done + 1, stage: '確認中' });
      if (stopIfCost) {
        const label = await runInPage(win, `const b = genButton(); return b ? b.textContent.replace(/\\s+/g, ' ').trim() : '';`);
        if (hasCost(label)) throw new Error(`Anlas を消費する設定になっています。ボタン表示「${label}」`);
      }
      const clicked = await runInPage(win, `
        const b = genButton();
        if (!b || isBusy(b)) return false;
        b.click();
        return true;
      `);
      if (!clicked) throw new Error('生成ボタンが見つからないか、押せない状態です。');
      pushBatchState({ stage: '生成中' });
      await sleep(2000);
      const start = Date.now();
      while (!batchCancel) {
        if (batchError) throw new Error(`画面にエラーが表示されました「${batchError}」`);
        const ready = await runInPage(win, `const b = genButton(); return !!b && !isBusy(b);`);
        if (ready) break;
        if (Date.now() - start > GENERATE_TIMEOUT_MS) throw new Error('生成が終わりませんでした(時間切れ)。');
        await sleep(1000);
      }
      if (batchCancel) break; // 停止: この回は数えない
      if (batchError) throw new Error(`画面にエラーが表示されました「${batchError}」`);
      done++;
      pushBatchState({ done });
      await sleep(500);
    }
    if (batchCancel) result = { kind: 'info', message: `停止しました(${done} 回生成。最大 ${maxCount} 回)。` };
    else if (done >= maxCount) result = { kind: 'ok', message: `最大回数(${maxCount} 回)に達したため、完了しました。` };
    else result = { kind: 'info', message: `連続上限(${minutes} 分)に達したため、停止しました(${done} 回生成)。` };
  } catch (err) {
    result = { kind: 'error', message: `中断しました: ${err.message}(${done} 回生成)` };
  } finally {
    batchRunning = false;
    batchPause = false;
    batchContext = null;
    batchError = null;
    pushBatchState({ running: false, stopping: false, pausing: false, paused: false, pausedAt: 0, stage: '', endedAt: Date.now(), ...result });
    refreshMenu();
    if (!win.isDestroyed()) win.setTitle(APP_NAME);
    notifyEnd(win, result.message);
  }
}

async function startSimple() {
  const win = getMainWindow();
  if (!win) return;
  if (batchRunning) {
    showMessage(win, { type: 'info', title: APP_NAME, message: '自動生成はすでに実行中です。' });
    return;
  }
  const max = settings.simpleMax;
  const minutes = settings.simpleMinutes;
  const choice = await showMessage(win, {
    type: 'question',
    buttons: ['開始', 'キャンセル'],
    defaultId: 1,
    cancelId: 1,
    title: APP_NAME,
    message: `最大 ${max} 回、または ${minutes} 分のどちらか早いほうまで、生成を繰り返します。よろしいですか?`,
    detail: '現在の画面の設定(プロンプト・サイズ・モデルなど)のまま、「生成」を繰り返します。Anlas を消費する場合があります。\n' +
      `・Anlas を消費する表示になったとき: ${stopIfCost ? '止まります' : '止まりません(メニュー「自動生成」でオフ)'}\n` +
      `・画面にエラーが表示されたとき: ${settings.stopOnError ? '止まります' : '止まりません(メニュー「自動生成」でオフ)'}\n` +
      '・時間の上限に達したときは、生成中の 1 枚が終わってから止まります。\n' +
      '・終わったときと止まったときは、通知を出します。\n\nメニューの「自動生成 → 停止」か、パネルの「停止」で、いつでも止められます。',
  });
  if (choice !== 0) return;
  runSimple(win, max, minutes);
}

async function startBatch() {
  const win = getMainWindow();
  if (!win) return;
  if (batchRunning) {
    showMessage(win, { type: 'info', title: APP_NAME, message: '自動生成はすでに実行中です。' });
    return;
  }
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'CSV ファイルを選択',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return;
  let jobs;
  try {
    jobs = readJobs(filePaths[0]);
  } catch (err) {
    showMessage(win, { type: 'error', title: APP_NAME, message: 'CSV を読み込めませんでした。', detail: err.message });
    return;
  }
  if (jobs.length === 0) {
    showMessage(win, { type: 'error', title: APP_NAME, message: '生成する行がありません。' });
    return;
  }
  // 開始位置(パネルの「何件目から」)。CSV 全体の件数を超えていたら、始めない
  const total = jobs.length;
  const offset = startFrom - 1;
  if (offset >= total) {
    showMessage(win, { type: 'error', title: APP_NAME, message: `開始位置(${startFrom} 件目)が、CSV の件数(${total} 件)を超えています。`, detail: 'パネルの「何件目から」を直してください。' });
    return;
  }
  jobs = jobs.slice(offset);
  const choice = await showMessage(win, {
    type: 'question',
    buttons: ['開始', 'キャンセル'],
    defaultId: 1,
    cancelId: 1,
    title: APP_NAME,
    message: offset > 0
      ? `${startFrom} 件目から、残りの ${jobs.length} 件(全 ${total} 件中)を順番に生成します。よろしいですか?`
      : `${jobs.length} 件を順番に生成します。よろしいですか?`,
    detail: '現在の画面の設定(サイズ・モデルなど)で、1 行ごとに生成します。Anlas を消費する場合があります。メニューの「自動生成 → 停止」でいつでも止められます。' +
      (jobs[0].characters.some(c => c && c.append)
        ? '\n\n「character◯+」の列は、今のキャラクター欄の内容を固定部分として、その後ろにタグを足します。終わったら、固定部分だけに戻します。'
        : ''),
  });
  if (choice !== 0) return;
  startFrom = 1; // 次回は、また最初から(開始位置を覚えたままにして、うっかり途中から始めないため)
  pushBatchState({ startFrom });
  runBatch(win, jobs, offset);
}

// 前回の窓の位置・大きさ。どの画面にも(100px 以上)かからないとき(画面の構成が変わった)は、使わない
function savedWindowBounds() {
  const w = settings.window;
  if (!w) return null;
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    Math.min(w.x + w.width, a.x + a.width) - Math.max(w.x, a.x) >= 100 && Math.min(w.y + w.height, a.y + a.height) - Math.max(w.y, a.y) >= 100);
  return visible ? { x: w.x, y: w.y, width: w.width, height: w.height } : null;
}

// 窓の位置・大きさ・最大化と、拡大率を覚える(次に開くとき、同じ状態にするため)
function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds(); // 最大化・最小化中でも、元の大きさが取れる
  settings.window = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
  settings.zoom = win.webContents.getZoomFactor();
  saveSettings();
}

// タイトルバー・メニュー・ダイアログの配色を変える(NovelAI の画面の中身は変わらない)
function setTheme(theme) {
  if (!THEMES.includes(theme)) return;
  settings.theme = theme;
  saveSettings();
  nativeTheme.themeSource = theme;
  refreshMenu();
}

function setAlwaysOnTop(on) {
  settings.alwaysOnTop = on;
  saveSettings();
  const win = getMainWindow();
  if (win) win.setAlwaysOnTop(on);
}

// パネルの位置を、右下(既定)に戻す
function resetPanelPosition() {
  const win = getMainWindow();
  if (win) win.webContents.executeJavaScript('window.__naiPanels && window.__naiPanels.resetPosition()').catch(() => {});
}

// Alt だけを押して離したときに、メニューを「手前に」ポップアップで開く(メニューバーは常に隠しておく)。
// メニューバーを出すと、窓の中身の領域が縮んで画面が動くため。Alt と別のキー(Alt+Tab など)を一緒に押したときは、開かない
function createAltMenuHandler(openMenu) {
  let altAlone = false;
  return (event, input) => {
    if (input.key === 'Alt') {
      if (input.type === 'keyDown') { if (!input.isAutoRepeat) altAlone = true; }
      else if (input.type === 'keyUp') { if (altAlone) openMenu(); altAlone = false; }
    } else if (input.type === 'keyDown') {
      altAlone = false;
    }
  };
}

function createWindow() {
  const restored = savedWindowBounds();
  const win = new BrowserWindow({
    title: APP_NAME,
    icon: path.join(__dirname, 'build', 'icon.png'),
    width: 1280,
    height: 860,
    ...(restored || {}),
    backgroundColor: '#0e0f21',
    autoHideMenuBar: false, // 自動で隠すとメニューバーが場所を取って画面が動くので、常に隠して、Alt でポップアップを開く(下の createAltMenuHandler)
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:novelai', // ログイン状態を保持
      backgroundThrottling: false, // 裏に回っても、タイマーなどを遅くしない(自動生成を進めるため)
    },
  });

  // ページの題名(「Image Generation - NovelAI」など)をウィンドウ名に反映しない
  win.on('page-title-updated', (e) => e.preventDefault());

  // ページが「閉じようとすると警告」を出す場合(生成後など)、確認して閉じられるようにする
  // (何もしないと、×を押しても閉じられなくなる)
  // (確認の窓は自前で、同期では待てない。いったん閉じるのを止めて確認し、「閉じる」なら、確認済みの印を付けて、もう一度閉じる。
  //  2 度目の will-prevent-unload では、すぐに preventDefault して、ページの警告を無視して閉じる)
  let closeConfirmed = false;
  let askingClose = false;
  win.webContents.on('will-prevent-unload', (e) => {
    if (closeConfirmed) {
      e.preventDefault();
      return;
    }
    if (askingClose) return;
    askingClose = true;
    showMessage(win, {
      type: 'question',
      buttons: ['閉じる', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      title: APP_NAME,
      message: 'このページを閉じますか?',
      detail: '保存されていない内容は失われる可能性があります。',
    }).then((choice) => {
      askingClose = false;
      if (choice !== 0 || win.isDestroyed()) return;
      closeConfirmed = true;
      setTimeout(() => { closeConfirmed = false; }, 3000); // 閉じられなかったときに、印が残らないように
      win.close();
    });
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowed(url)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAllowed(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWin = win;
  if (process.platform !== 'darwin') { // macOS のメニューは、画面の上のバーにあるので、そのまま
    win.setMenuBarVisibility(false);
    win.webContents.on('before-input-event', createAltMenuHandler(() => {
      const menu = Menu.getApplicationMenu();
      if (menu && !win.isDestroyed()) menu.popup({ window: win, x: 8, y: 8 });
    }));
  }
  if (restored && settings.window.maximized) win.maximize();
  if (settings.alwaysOnTop) win.setAlwaysOnTop(true);
  win.on('close', () => saveWindowState(win));
  // 今の拡大率を、「表示」ツールチップに出す。メニュー・キー・ホイールのどれで変えても追いかけるため、0.5 秒ごとに見て、変わったときだけ送る
  let lastZoom = 0;
  const zoomTimer = setInterval(() => {
    if (win.isDestroyed()) return;
    const z = win.webContents.getZoomFactor();
    if (Math.abs(z - lastZoom) < 0.001) return;
    lastZoom = z;
    win.webContents.executeJavaScript(`window.__naiPanels && window.__naiPanels.setZoom(${z})`).catch(() => {});
  }, 500);
  win.on('closed', () => clearInterval(zoomTimer));
  let zoomRestored = false;
  win.webContents.on('dom-ready', () => { // ページを読み込むたびに、サジェストとパネルを入れ直す
    lastZoom = 0;
    if (!zoomRestored) { // 拡大率は、最初の 1 回だけ戻す(あとで変えた拡大率を、再読み込みで戻さないため)
      zoomRestored = true;
      win.webContents.setZoomFactor(settings.zoom);
    }
    injectSuggest(win);
    injectPanels(win);
  });
  win.webContents.on('console-message', (...args) => { // Electron 33 は (event, level, message, ...)、35 以降は event.message
    handlePanelMessage(typeof args[2] === 'string' ? args[2] : args[0] && args[0].message);
  });
  win.loadURL(START_URL);
}

const buildTemplate = () => [
  ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
  { role: 'editMenu' },
  {
    label: 'View',
    submenu: [
      { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { role: 'togglefullscreen' }, { type: 'separator' },
      { label: '「生成時間」パネルを表示', type: 'checkbox', checked: settings.showTimePanel, click: (item) => setPanelOption('showTimePanel', item.checked) },
      { label: '「自動生成」パネルを表示', type: 'checkbox', checked: settings.showBatchPanel, click: (item) => setPanelOption('showBatchPanel', item.checked) },
      { label: '「入力補助」パネルを表示', type: 'checkbox', checked: settings.showAssistPanel, click: (item) => setPanelOption('showAssistPanel', item.checked) },
      { label: '「入力補助の設定」パネルを表示', type: 'checkbox', checked: settings.showAssistSettingsPanel, click: (item) => setPanelOption('showAssistSettingsPanel', item.checked) },
      { label: '「タグセット」パネルを表示', type: 'checkbox', checked: settings.showSetsPanel, click: (item) => setPanelOption('showSetsPanel', item.checked) },
      { label: '「表示」ツールチップを表示(再読み込み・拡大縮小・全画面)', type: 'checkbox', checked: settings.showViewBox, click: (item) => setPanelOption('showViewBox', item.checked) },
      { label: '「プロンプト点検」パネルを表示', type: 'checkbox', checked: settings.showCheckPanel, click: (item) => setPanelOption('showCheckPanel', item.checked) },
      { label: 'パネルを右下にまとめ直す', click: () => resetPanelPosition() },
      { type: 'separator' },
      { label: '常に最前面に表示', type: 'checkbox', checked: settings.alwaysOnTop, click: (item) => setAlwaysOnTop(item.checked) },
      {
        label: '配色(タイトルバー・メニュー)',
        submenu: [
          { label: 'ダーク', type: 'radio', checked: settings.theme === 'dark', click: () => setTheme('dark') },
          { label: 'ライト', type: 'radio', checked: settings.theme === 'light', click: () => setTheme('light') },
          { label: 'システムに合わせる', type: 'radio', checked: settings.theme === 'system', click: () => setTheme('system') },
        ],
      },
      { type: 'separator' }, { role: 'toggleDevTools' },
    ],
  },
  {
    label: '保存',
    submenu: [
      { label: '毎回、保存先を選ぶ', type: 'radio', checked: !settings.autoSave, click: () => setAutoSave(false) },
      { label: '決めたフォルダに自動で保存する', type: 'radio', checked: settings.autoSave, click: () => setAutoSave(true) },
      { type: 'separator' },
      { label: settings.saveDir ? `保存先: ${settings.saveDir}` : '保存先: (未設定)', enabled: false },
      { label: '保存先フォルダを選ぶ…', click: async () => { if (await chooseSaveDir()) refreshMenu(); } },
      { label: '保存先フォルダを開く', enabled: !!settings.saveDir, click: () => shell.openPath(settings.saveDir) },
      { type: 'separator' },
      { label: `ファイル名のルール: ${settings.nameRule.length > 40 ? settings.nameRule.slice(0, 40) + '…' : settings.nameRule}`, enabled: false },
      { label: 'ファイル名のルールを設定…', click: () => openNamingWindow() },
      { label: '保存したとき、画面にお知らせを出す', type: 'checkbox', checked: settings.notifySaved, click: (item) => { settings.notifySaved = item.checked; saveSettings(); } },
      { label: '連番を 1 に戻す', click: () => { settings.seq = 0; saveSettings(); } },
    ],
  },
  {
    label: '入力補助',
    submenu: [
      { label: '設定の切り替えは、画面の「入力補助の設定」パネルにあります', enabled: false },
      { type: 'separator' },
      {
        label: tagList ? `辞書: 取り込み済み(${tagList.length} 件)`
          : dictionary ? `辞書: キャラクターのみ(${dictionary.names.size} 件。取り込み直してください)` : '辞書: 未取り込み',
        enabled: false,
      },
      { label: 'お気に入りと最近使ったタグを消す', click: () => clearTagUserData() },
      { type: 'separator' },
      { label: dictBuild ? '辞書を作っています…(進み具合の窓を開く)' : '辞書を作る(Danbooru から取得)…', click: () => buildDictionary() },
      { label: '辞書を取り込む…', click: () => importDictionary() },
      { label: translations ? `日本語訳: 取り込み済み(${translationCount} 件)` : '日本語訳: 未取り込み', enabled: false },
      { label: '日本語訳を取り込む…', click: () => importTranslations() },
      { label: '辞書と日本語訳を削除', enabled: !!(tagList || dictionary || translations), click: () => removeDictionary() },
    ],
  },
  {
    label: 'Extensions',
    submenu: [
      { label: '拡張機能フォルダを開く', click: () => shell.openPath(extensionsDir()) },
      { type: 'separator' },
      ...(loadedExtensions.some(e => e.optionsPage)
        ? loadedExtensions.filter(e => e.optionsPage).map(e => ({ label: `設定を開く: ${e.name}`, click: () => openExtensionSettings(e) }))
        : [{ label: '設定を開ける拡張機能はありません', enabled: false }]),
    ],
  },
  {
    label: '自動生成',
    submenu: [
      { label: 'CSV を読み込んで生成…', click: () => startBatch() },
      { label: '連続生成を開始(パネルの回数・上限で)', click: () => startSimple() },
      { label: batchPause ? '再開' : '一時停止', enabled: batchRunning, click: () => togglePause() },
      { label: '停止', click: () => requestStop() },
      { type: 'separator' },
      { label: 'Anlas を消費するときは止める', type: 'checkbox', checked: stopIfCost, click: (item) => setStopIfCost(item.checked) },
      { label: '画面にエラーが表示されたら止める', type: 'checkbox', checked: settings.stopOnError, click: (item) => { settings.stopOnError = item.checked; saveSettings(); } },
      { label: '終わったとき、窓が裏にあれば通知する', type: 'checkbox', checked: settings.notifyDone, click: (item) => { settings.notifyDone = item.checked; saveSettings(); } },
      { label: '画面の構造を調べる(調査用)', click: () => inspectScreen() },
    ],
  },
  { role: 'windowMenu' },
  {
    label: 'ヘルプ',
    submenu: [
      { label: 'マニュアルを開く', click: () => openManual() },
      { label: 'ライセンスと権利表記を開く', click: () => openLicenses() },
    ],
  },
];

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    loadSettings();
    nativeTheme.themeSource = settings.theme; // 窓を作る前に配色を決める
    loadDictionary();
    registerDownloads();
    await loadExtensions();
    refreshMenu(); // 読み込んだ拡張機能の一覧を反映するため、読み込みの後に作る
    createWindow();
    app.on('activate', () => {
      if (!getMainWindow()) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
