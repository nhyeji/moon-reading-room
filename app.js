/* MOON's Reading Room — app.js
 * 기록은 브라우저(localStorage)에 저장하고, 서버(/api/records)에도 백업한다.
 * 도서관 대출상태는 서버(/api/holdings)가 실시간으로 조회한 값만 표시하고
 * 확인하지 못한 값은 '조회'/'미확인'으로 남긴다.
 */
(() => {
  'use strict';

  const LS_RECORDS = 'moon-reading-room:records:v1';
  const LS_STATUS = 'moon-reading-room:status:v1';
  const STATUS_TTL = 30 * 60 * 1000; // 30분

  const state = {
    catalog: [],
    favorites: [],
    pickup: null,
    gwangjinLibs: [],
    seoulOther: [],
    school: null,
    status: {},          // isbn -> { gb, gj, at }
    records: {},         // isbn -> record
    filter: { q: '', source: '', field: '', lib: '' },
    sort: 'sources',
    view: 'shelf',
    modalBook: null,
    modalFav: 'all',
    draftStars: 0,
    aStars: 0,
    addMode: 'scan',
    draft: null,
    queue: [],
    active: 0,
    purchased: null,     // 예스24·알라딘 구매도서 (data/purchased_books.json)
    own: { q: '', store: '' },
    ownSort: 'recent',
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------- util ---------------- */
  function toast(msg, ms = 2200) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, ms);
  }

  const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
  function fmtDate(d) { return `${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEK[d.getDay()]}요일`; }
  function ymd(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function parseYmd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function agoLabel(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60 * 1000) return '방금';
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)}분 전`;
    if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)}시간 전`;
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const stars = (n) => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
  const isbnKey = (s) => String(s || '').replace(/[^0-9Xx]/g, '');
  // 기록 키: ISBN이 있으면 ISBN, 없으면 own-<id> 같은 문자열 키를 그대로 쓴다.
  function recKey(x) {
    const isbn = typeof x === 'string' ? x : (x && x.isbn) || '';
    const ik = isbnKey(isbn);
    if (ik) return ik;
    return typeof x === 'string' ? x : String((x && (x.key || x.isbn)) || '');
  }

  /* ---------------- storage ---------------- */
  function loadLocal() {
    try { state.records = JSON.parse(localStorage.getItem(LS_RECORDS) || '{}') || {}; } catch (e) { state.records = {}; }
    try { state.status = JSON.parse(localStorage.getItem(LS_STATUS) || '{}') || {}; } catch (e) { state.status = {}; }
  }
  function saveRecords() {
    localStorage.setItem(LS_RECORDS, JSON.stringify(state.records));
    syncRecords();
  }
  let syncTimer = null;
  function syncRecords() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      fetch('/api/records', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: 'moon', records: state.records }),
      }).catch(() => {});
    }, 800);
  }
  function saveStatus() {
    const now = Date.now();
    const pruned = {};
    Object.keys(state.status).forEach((k) => {
      if (now - (state.status[k].at || 0) < 24 * 60 * 60 * 1000) pruned[k] = state.status[k];
    });
    state.status = pruned;
    localStorage.setItem(LS_STATUS, JSON.stringify(pruned));
  }

  /* ---------------- api ---------------- */
  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  /* ---------------- boot ---------------- */
  async function probeServer() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const r = await fetch('/api/health', { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(t);
      return r.ok;
    } catch (e) { return false; }
  }

  const DEFAULT_FAVORITES = [
    { name: '학교 도서관', primary: true }, { name: '구의역 스마트도서관', primary: true },
    { name: '광진정보도서관' }, { name: '자양한강도서관' }, { name: '구의제3동도서관' },
  ];
  const DEFAULT_GWANGJIN = [
    { name: '광진정보도서관', kind: '공공' }, { name: '중곡도서관', kind: '공공' },
    { name: '자양한강도서관', kind: '공공' }, { name: '구의3동도서관', kind: '공공' },
    { name: '자양제4동도서관', kind: '공공' }, { name: '군자동도서관', kind: '공공' },
    { name: '아차산숲속도서관', kind: '공공' }, { name: '광진어린이영어도서관', kind: '공공' },
    { name: '구의역 스마트도서관', kind: '스마트' }, { name: '군자역 스마트도서관', kind: '스마트' },
    { name: '중곡 스마트도서관', kind: '스마트' }, { name: '광진문화예술회관 스마트도서관', kind: '스마트' },
  ];

  function applyCatalog(cat) {
    state.catalog = cat.books || [];
    state.favorites = (cat.favorites && cat.favorites.length) ? cat.favorites : DEFAULT_FAVORITES;
    state.pickup = cat.pickupLibrary || { name: '구의역 스마트도서관' };
    state.gwangjinLibs = (cat.gwangjinLibraries && cat.gwangjinLibraries.length) ? cat.gwangjinLibraries : DEFAULT_GWANGJIN;
    state.seoulOther = cat.seoulOtherLibraries || [];
    state.school = cat.school || null;
  }

  /* ---------------- 구매도서 (예스24·알라딘) ---------------- */
  function ownedBooks() { return (state.purchased && state.purchased.books) || []; }
  function ownKey(b) { return recKey({ isbn: (b && b.isbn) || '', key: 'own-' + ((b && b.id) || 'x') }); }
  function ownedByKey(key) {
    const k = String(key || '');
    return ownedBooks().find((b) => ownKey(b) === k) || null;
  }
  // 모달·기록에서 쓰는 책 객체(구매 정보를 '출처' 자리에 넣어 재사용)
  function ownedBook(b) {
    const price = b.price ? b.price.toLocaleString('ko-KR') + '원' : '';
    const info = [b.boughtAt, b.kind, price, b.qty > 1 ? b.qty + '권' : ''].filter(Boolean).join(' · ');
    return {
      isbn: b.isbn || ownKey(b), key: ownKey(b),
      title: b.title, author: b.author, publisher: b.publisher, year: b.year,
      cover: b.cover, field: b.category, kdc: b.kdc || '', summary: b.summary || '',
      owned: true, store: b.store, boughtAt: b.boughtAt, kind: b.kind,
      orderNo: b.orderNo, price: b.price, note: b.note || '',
      sources: [{ name: b.store + ' 구매', note: info }],
      reason: b.note || '',
    };
  }

  async function loadPurchased(force) {
    if (!force && window.__PURCHASED__) { state.purchased = window.__PURCHASED__; return; }
    try {
      const url = './data/purchased_books.json' + (force ? '?t=' + Date.now() : '');
      state.purchased = await getJSON(url);
    } catch (e) {
      if (!state.purchased && window.__PURCHASED__) state.purchased = window.__PURCHASED__;
    }
  }

  function buildOwnStore() {
    const sel = $('#ownStore');
    if (!sel) return;
    const names = [];
    ownedBooks().forEach((b) => { if (b.store && !names.includes(b.store)) names.push(b.store); });
    sel.innerHTML = '<option value="">구매처 전체</option>' +
      names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    sel.value = state.own.store || '';
  }

  function ownFiltered() {
    const q = state.own.q.trim().toLowerCase();
    const isDone = (b) => { const r = state.records[ownKey(b)]; return r && r.status === 'done'; };
    let list = ownedBooks().filter((b) => {
      if (state.own.store && b.store !== state.own.store) return false;
      if (q) {
        const hay = `${b.title} ${b.author} ${b.publisher} ${b.category || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    list = list.slice();
    if (state.ownSort === 'title') {
      list.sort((a, b) => String(a.title).localeCompare(String(b.title), 'ko'));
    } else if (state.ownSort === 'store') {
      list.sort((a, b) => String(a.store).localeCompare(String(b.store), 'ko') ||
        String(b.boughtAt).localeCompare(String(a.boughtAt)));
    } else if (state.ownSort === 'unread') {
      list.sort((a, b) => (isDone(a) ? 1 : 0) - (isDone(b) ? 1 : 0) ||
        String(b.boughtAt).localeCompare(String(a.boughtAt)));
    } else {
      list.sort((a, b) => String(b.boughtAt).localeCompare(String(a.boughtAt)));
    }
    return list;
  }

  function renderOwned() {
    const box = $('#ownList');
    if (!box) return;
    const all = ownedBooks();
    const P = state.purchased;
    $('#ownCount').textContent = `${all.length}권`;
    if (!all.length) {
      $('#ownSummary').innerHTML = '';
      box.innerHTML = '';
      const em = $('#ownEmpty');
      em.hidden = false;
      em.textContent = P ? '아직 저장된 구매도서가 없어요.'
        : '구매도서 목록을 불러오지 못했어요. 서버(python3 server.py)로 열면 data/purchased_books.json 을 읽어요.';
      return;
    }
    const doneN = all.filter((b) => { const r = state.records[ownKey(b)]; return r && r.status === 'done'; }).length;
    const wantN = all.filter((b) => { const r = state.records[ownKey(b)]; return r && r.status === 'want'; }).length;
    const storeStats = (P.stores || []).map((s) => {
      const n = all.filter((b) => b.store === s.name).length;
      const url = s.orderUrl || s.url;
      return `<a class="own-stat" href="${esc(url)}" target="_blank" rel="noopener">${esc(s.name)} <b>${n}</b>권 ↗</a>`;
    }).join('');
    $('#ownSummary').innerHTML = storeStats +
      `<span class="own-stat">읽은 책 <b>${doneN}</b>권</span>` +
      `<span class="own-stat">읽을 책 <b>${wantN}</b>권</span>`;
    if (P.verifiedAt) {
      $('#ownSource').textContent = `${P.verifiedAt} 확인 · 예스24(최근 5년) + 알라딘(전체 기간) 주문내역. ` +
        '어린이도서·동화·그림책·원서만 담았어요.';
    }

    const list = ownFiltered();
    $('#ownEmpty').hidden = list.length > 0;
    if (!list.length) $('#ownEmpty').textContent = '조건에 맞는 구매도서가 없어요.';
    box.innerHTML = list.map((b) => {
      const key = ownKey(b);
      const rec = state.records[key];
      const isWanted = rec && rec.status === 'want';
      const isDone = rec && rec.status === 'done';
      const storeCls = /예스24/.test(b.store) ? 'store-yes24' : 'store-aladin';
      const tags = [`<span class="own-tag">${esc(b.boughtAt)}</span>`];
      if (b.kind) tags.push(`<span class="own-tag">${esc(b.kind)}</span>`);
      if (isDone) tags.push(`<span class="own-tag done">✓ 읽음${rec.finishedAt ? ' ' + esc(rec.finishedAt) : ''}</span>`);
      else if (isWanted) tags.push('<span class="own-tag want">읽을래요</span>');
      if (isDone && rec.stars) tags.push(`<span class="own-tag stars">${stars(rec.stars)}</span>`);
      const price = b.price ? `${b.price.toLocaleString('ko-KR')}원` + (b.qty > 1 ? ` · ${b.qty}권` : '') : '';
      return `<article class="own-card" data-ownkey="${esc(key)}">
        <div class="own-cover" data-open="${esc(key)}">${coverHTML(b.cover, b.title)}</div>
        <div class="own-body">
          <div class="own-top">
            <span class="store-badge ${storeCls}">${esc(b.store)}</span>
            ${tags.join('')}
          </div>
          <p class="own-title" data-open="${esc(key)}">${esc(b.title)}</p>
          <p class="own-sub">${esc(b.author || '')}${b.publisher ? ' · ' + esc(b.publisher) : ''}${b.year ? ' · ' + esc(b.year) : ''}</p>
          <div class="own-meta">
            ${b.category ? `<span class="own-tag">${esc(b.category)}</span>` : ''}
            ${price ? `<span class="own-tag">${esc(price)}</span>` : ''}
          </div>
          <div class="own-actions">
            <button class="own-btn ${isDone || isWanted ? 'is-on' : ''}" data-act="want" data-isbn="${esc(key)}">${isDone ? '✓ 읽음' : isWanted ? '✓ 읽을래요' : '＋ 읽을래요'}</button>
            <button class="own-btn ${isDone ? 'is-done' : ''}" data-act="done" data-isbn="${esc(key)}">${isDone ? '✓ 다 읽었어요' : '다 읽었어요'}</button>
            <button class="own-btn" data-act="detail" data-isbn="${esc(key)}">상세 · 도서관 조회</button>
          </div>
        </div>
      </article>`;
    }).join('');

    const ex = (P && P.excluded) || [];
    const exBox = $('#ownExcluded');
    if (exBox) {
      exBox.hidden = !ex.length;
      $('#ownExcludedCount').textContent = ex.length ? `(${ex.length}건)` : '';
      $('#ownExcludedList').innerHTML = ex.map((x) =>
        `<div class="excluded-row"><b>${esc(x.store)}</b><span>${esc(x.boughtAt)}</span>` +
        `<span>${esc(x.title)}</span><span>— ${esc(x.reason)}</span></div>`).join('');
    }
  }

  async function init() {
    loadLocal();
    $('#todayText').textContent = fmtDate(new Date());
    wireEvents();
    buildStars($('#mStars'), (n) => { state.draftStars = n; });
    buildStars($('#aStars'), (n) => { state.aStars = n; });

    state.serverless = !(await probeServer());
    let cat = null;
    if (!state.serverless) {
      try { cat = await getJSON('/api/catalog'); } catch (e) { cat = null; }
    }
    if (!cat && window.__CATALOG__) cat = window.__CATALOG__;
    if (!cat) {
      try { cat = await getJSON('./data/books.json'); } catch (e) { cat = null; }
    }
    if (cat) applyCatalog(cat);
    else toast('책 목록을 불러오지 못했어요. 서버가 실행 중인지 확인해 주세요.');

    if (state.serverless) {
      $('#liveNote').textContent =
        '지금은 서버 없이 열린 화면이라 실시간 대출 조회는 표시되지 않아요. ' +
        '도서관 대출상태·계정 현황은 Pickle에 요청하시면 확인해 반영해 드려요. ' +
        '(PC에서 python3 server.py 로 열면 실시간 조회도 됩니다.)';
    } else {
      $('#liveNote').textContent =
        '도서관 대출상태는 조회 시각 기준 실시간 결과예요. ' +
        '단골 학교 도서관(독서로) · 광진구립도서관 통합검색에서 직접 확인합니다.';
    }

    buildFilters();
    renderLibraryDir();
    await loadPurchased();
    buildOwnStore();
    renderAll();
    loadAccounts();
    mergeServerRecords();
  }

  async function mergeServerRecords() {
    if (Object.keys(state.records).length) return;
    try {
      const r = await getJSON('/api/records?user=moon');
      if (r && r.records && typeof r.records === 'object' && Object.keys(r.records).length) {
        state.records = r.records;
        localStorage.setItem(LS_RECORDS, JSON.stringify(state.records));
        renderAll();
        toast('저장해 둔 기록을 서버에서 불러왔어요');
      }
    } catch (e) { /* 서버 백업은 선택 사항 */ }
  }

  /* ---------------- filters ---------------- */
  function buildFilters() {
    const sources = new Set();
    const fields = new Set();
    state.catalog.forEach((b) => {
      (b.sources || []).forEach((s) => sources.add(s.name));
      if (b.field) fields.add(b.field);
    });
    const fS = $('#fSource');
    fS.innerHTML = '<option value="">출처 전체</option>' +
      [...sources].map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    const fF = $('#fField');
    fF.innerHTML = '<option value="">분야 전체</option>' +
      [...fields].sort().map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    const fL = $('#fLibrary');
    fL.innerHTML = '<option value="">도서관 전체</option>' +
      state.favorites.map((f) => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join('');
  }


  function renderLibraryDir() {
    const gj = (state.gwangjinLibs || []).filter((l) => l.kind === '공공');
    const smart = (state.gwangjinLibs || []).filter((l) => l.kind === '스마트');
    const chip = (name, cls = '') => `<span class="dir-chip ${cls}">${esc(name)}</span>`;
    $('#dirGwangjin').innerHTML = gj.map((l) => {
      const fav = state.favorites.find((f) => f.name === l.name);
      return chip(l.name, fav && fav.primary ? 'primary' : '');
    }).join('');
    $('#dirSmart').innerHTML = smart.map((l) => {
      const isPickup = state.pickup && state.pickup.name === l.name;
      return chip(l.name + (isPickup ? ' · 상호대차 수령 기본' : ''), isPickup ? 'pickup' : '');
    }).join('');
    $('#dirSeoul').innerHTML = (state.seoulOther || []).map((l) =>
      `<a class="dir-chip link" href="${esc(l.site)}" target="_blank" rel="noopener">${esc(l.gu)} ${esc(l.name)}</a>`).join('');
  }

  /* ---------------- render: all ---------------- */
  function renderAll() {
    renderCounters();
    renderToday();
    renderRead();
    renderGrid();
    renderOwned();
    $('#totalRec').textContent = state.catalog.length;
    $('#totalDone').textContent = Object.values(state.records).filter((r) => r.status === 'done').length;
  }

  function renderCounters() {
    const now = new Date();
    const done = Object.values(state.records).filter((r) => r.status === 'done');
    const inDay = (d) => d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    const inMonth = (d) => d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    const inYear = (d) => d && d.getFullYear() === now.getFullYear();
    const dates = done.map((r) => parseYmd(r.finishedAt)).filter(Boolean);
    $('#cntToday').textContent = dates.filter(inDay).length;
    $('#cntMonth').textContent = dates.filter(inMonth).length;
    $('#cntYear').textContent = dates.filter(inYear).length;
  }

  /* ---------------- books helpers ---------------- */
  function bookByIsbn(isbn) {
    const k = isbnKey(isbn);
    return state.catalog.find((b) => isbnKey(b.isbn) === k) ||
      state.catalog.find((b) => b.isbn === isbn);
  }

  function coverHTML(src, title, cls = '') {
    const fb = `<div class="cover-fallback" style="display:none"><span>📕</span>${esc(title)}</div>`;
    if (!src) return `<div class="cover-fallback"><span>📕</span>${esc(title)}</div>`;
    return `<img src="${esc(src)}" alt="${esc(title)} 표지" loading="lazy" class="${cls}"
      onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">${fb}`;
  }

  /* ---------------- favorite status mapping ---------------- */
  function statusFor(isbn) {
    const st = state.status[recKey(isbn)];
    if (!st) return null;
    return st;
  }

  function favState(isbn, favName) {
    const st = statusFor(isbn);
    if (!st) return { kind: 'unknown', label: '조회', text: '눌러서 실시간 조회' };
    if (favName === '학교 도서관') {
      const gb = st.gb;
      if (!gb) return { kind: 'unknown', label: '조회', text: '확인 실패' };
      if (!gb.ok) return { kind: 'unknown', label: '조회', text: gb.error || '확인 실패' };
      const hs = gb.holdings || [];
      if (!hs.length) return { kind: 'none', label: '미소장', text: '학교 미소장' };
      const avail = hs.filter((h) => h.available);
      return avail.length
        ? { kind: 'ok', label: '대출가능', text: `대출가능 ${avail.length}/${hs.length}` }
        : { kind: 'no', label: '대출중', text: `대출중 ${hs.length}권` };
    }
    const gj = st.gj;
    if (!gj) return { kind: 'unknown', label: '조회', text: '확인 실패' };
    if (!gj.ok) return { kind: 'unknown', label: '조회', text: gj.error || '확인 실패' };
    const hs = (gj.holdings || []).filter((h) => h.library === favName ||
      (favName === '구의역 스마트도서관' && h.library.indexOf('구의역') === 0));
    if (!hs.length) {
      if (favName === '구의역 스마트도서관') return { kind: 'pickup', label: '수령관', text: '상호대차 수령 기본' };
      return { kind: 'none', label: '미소장', text: '미소장' };
    }
    const avail = hs.filter((h) => h.available);
    return avail.length
      ? { kind: 'ok', label: '대출가능', text: `대출가능 · ${hs[0].callNo || ''}`.trim() }
      : { kind: 'no', label: '대출중', text: `대출중 · ${hs[0].callNo || ''}`.trim() };
  }

  /* ---------------- render: 오늘 읽을 책 ---------------- */
  function renderToday() {
    const box = $('#todayList');
    const wants = Object.values(state.records).filter((r) => r.status === 'want');
    if (!wants.length) {
      box.innerHTML = `<div class="empty-box">
        <span class="em">아직 고른 책이 없어요.</span>
        ✨ 추천 서가에서 마음에 드는 책을 골라 <b>읽을래요</b>를 눌러 봐! 🐰
      </div>`;
      return;
    }
    box.innerHTML = wants.map((r) => {
      const book = bookByIsbn(r.isbn) || {};
      const st = statusFor(r.isbn);
      let chips = '';
      if (st) {
        const gb = favState(r.isbn, '학교 도서관');
        const gj = favState(r.isbn, '구의역 스마트도서관');
        chips = `<span class="chip-lib ${gb.kind}"><i class="dot"></i>학교 ${gb.label}</span>
                 <span class="chip-lib ${gj.kind}"><i class="dot"></i>구의역 ${gj.label}</span>`;
      }
      return `<div class="today-item" data-isbn="${esc(r.isbn)}">
        ${coverHTML(book.cover || r.cover, r.title)}
        <div class="ti-body">
          <p class="ti-title">${esc(r.title)}</p>
          <p class="ti-sub">${esc(r.author || book.author || '')}</p>
          <div class="ti-chips">${chips}</div>
        </div>
        <div class="ti-actions">
          <button class="ti-done" data-act="done" data-isbn="${esc(r.isbn)}">다 읽었어요</button>
          <button class="ti-remove" data-act="unwant" data-isbn="${esc(r.isbn)}">빼기</button>
        </div>
      </div>`;
    }).join('');
  }

  /* ---------------- render: 읽은 책 서재 ---------------- */
  function renderRead() {
    const box = $('#readList');
    const done = Object.values(state.records)
      .filter((r) => r.status === 'done')
      .sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')));
    if (!done.length) {
      box.innerHTML = `<div class="read-empty">
        첫 책을 기다리고 있어요 🌱<br>오늘 읽을 책에서 <b>다 읽었어요!</b>를 누르면 여기에 꽂혀요.
      </div>`;
      return;
    }
    box.innerHTML = done.map((r) => {
      const book = bookByIsbn(r.isbn) || {};
      return `<div class="read-card" data-isbn="${esc(r.isbn)}">
        ${coverHTML(book.cover || r.cover, r.title)}
        <div class="rc-body">
          <p class="rc-title">${esc(r.title)}</p>
          <p class="rc-sub">${esc(r.author || book.author || '')}${r.finishedAt ? ' · ' + esc(r.finishedAt) : ''}</p>
          ${r.review ? `<p class="rc-review">${esc(r.review)}</p>` : ''}
          <div class="rc-foot">
            <span class="stars-line">${stars(r.stars || 0)}</span>
            <span class="rc-btns">
              <button data-act="edit" data-isbn="${esc(r.isbn)}">수정</button>
              <button data-act="del" data-isbn="${esc(r.isbn)}">삭제</button>
            </span>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  /* ---------------- render: 추천 서가 그리드 ---------------- */
  function sortedFiltered() {
    const q = state.filter.q.trim().toLowerCase();
    let list = state.catalog.filter((b) => {
      if (q) {
        const hay = `${b.title} ${b.author} ${b.publisher}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (state.filter.source && !(b.sources || []).some((s) => s.name === state.filter.source)) return false;
      if (state.filter.field && b.field !== state.filter.field) return false;
      if (state.filter.lib) {
        const fs = favState(b.isbn, state.filter.lib);
        if (fs.kind !== 'ok') return false;
      }
      return true;
    });
    if (state.sort === 'sources') {
      list = list.slice().sort((a, b) => (b.sources || []).length - (a.sources || []).length ||
        String(b.year || '').localeCompare(String(a.year || '')));
    } else if (state.sort === 'recent') {
      list = list.slice().sort((a, b) => String(b.year || '').localeCompare(String(a.year || '')));
    } else {
      list = list.slice().sort((a, b) => a.title.localeCompare(b.title, 'ko'));
    }
    return list;
  }

  function renderGrid() {
    const grid = $('#grid');
    const list = sortedFiltered();
    $('#recCount').textContent = `${list.length}권`;
    $('#gridEmpty').hidden = list.length > 0;
    grid.innerHTML = list.map((b) => {
      const rec = state.records[isbnKey(b.isbn)];
      const wanted = rec && rec.status === 'want';
      const chips = (state.favorites.length ? state.favorites : [
        { name: '학교 도서관' }, { name: '구의역 스마트도서관' },
        { name: '광진정보도서관' }, { name: '자양한강도서관' },
      ]).slice(0, 4).map((f) => {
        const fs = state.serverless
          ? { kind: 'unknown', label: '미확인', text: '서버를 켜면 실시간 조회돼요' }
          : favState(b.isbn, f.name);
        const short = f.name.replace('학교 도서관', '학교').replace(' 스마트도서관', ' 스마트')
          .replace('도서관', '');
        return `<button class="chip-lib ${fs.kind}" data-chip="1" data-isbn="${esc(b.isbn)}"
          data-lib="${esc(f.name)}" title="${esc(f.name)} · ${esc(fs.text)}">
          <i class="dot"></i>${esc(short)} ${esc(fs.kind === 'unknown' ? '' : fs.label)}
        </button>`;
      }).join('');
      return `<article class="card" data-isbn="${esc(b.isbn)}">
        <div class="card-cover" data-open="${esc(b.isbn)}">${coverHTML(b.cover, b.title)}</div>
        <h4 class="card-title" data-open="${esc(b.isbn)}">${esc(b.title)}</h4>
        <span class="badge">🏆 ${esc((b.sources || []).length)}곳 추천</span>
        <div class="chips-2x2">${chips}</div>
        <button class="want-btn ${wanted ? 'is-wanted' : ''}" data-act="want" data-isbn="${esc(b.isbn)}">
          ${wanted ? '✓ 읽을래요' : '＋ 읽을래요'}
        </button>
      </article>`;
    }).join('');
    observeCards();
  }

  /* ---------------- 대출상태 실시간 조회 큐 ---------------- */
  let io = null;
  function observeCards() {
    if (io) io.disconnect();
    if (!('IntersectionObserver' in window)) return;
    io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        const isbn = en.target.getAttribute('data-isbn');
        const st = statusFor(isbn);
        if (st && Date.now() - (st.at || 0) < STATUS_TTL) return;
        if (!en.target.getAttribute('data-queued')) {
          en.target.setAttribute('data-queued', '1');
          enqueue(isbn);
        }
      });
    }, { rootMargin: '120px' });
    $$('#grid .card').forEach((c) => io.observe(c));
  }

  function enqueue(isbn) {
    if (state.queue.includes(isbn)) return;
    state.queue.push(isbn);
    pump();
  }
  function pump() {
    const MAX = 2;
    while (state.active < MAX && state.queue.length) {
      const isbn = state.queue.shift();
      state.active++;
      checkBook(isbn).finally(() => { state.active--; pump(); });
    }
  }
  const inflight = new Set();
  async function checkBook(isbn, force) {
    const k = isbnKey(isbn) || String(isbn || '');
    if (inflight.has(k)) return;
    const st = state.status[k];
    if (!force && st && Date.now() - (st.at || 0) < STATUS_TTL) return;
    if (state.serverless) {
      state.status[k] = {
        gb: { ok: false, error: '서버 없이 열려 실시간 조회를 쓸 수 없어요' },
        gj: { ok: false, error: '서버 없이 열려 실시간 조회를 쓸 수 없어요' },
        at: Date.now(),
      };
      saveStatus();
      renderGrid();
      return state.status[k];
    }
    inflight.add(k);
    const ownRaw = ownedByKey(k);
    const book = bookByIsbn(isbn) || (ownRaw ? ownedBook(ownRaw) : null) || state.records[k] || {};
    const params = new URLSearchParams({ isbn: isbnKey(isbn), title: book.title || '' });
    markCardChecking(k);
    try {
      const r = await getJSON('/api/holdings?' + params.toString());
      state.status[k] = { gb: r.school, gj: r.gwangjin, at: Date.now() };
      saveStatus();
      renderGrid();
      renderToday();
      return state.status[k];
    } catch (e) {
      state.status[k] = { gb: { ok: false, error: '연결 실패' }, gj: { ok: false, error: '연결 실패' }, at: Date.now() };
      saveStatus();
      renderGrid();
      return state.status[k];
    } finally {
      inflight.delete(k);
    }
  }

  function markCardChecking(k) {
    $$(`.card[data-isbn="${CSS.escape(k)}"] .chip-lib`).forEach((el) => {
      el.classList.remove('ok', 'no', 'none', 'pickup', 'unknown');
      el.classList.add('checking');
    });
  }

  /* ---------------- modal ---------------- */
  function openModal(book, opts = {}) {
    state.modalBook = book;
    state.modalFav = 'all';
    const rec = state.records[recKey(book)] || {};
    state.draftStars = rec.stars || 0;
    setStars($('#mStars'), state.draftStars);

    $('#mCover').src = book.cover || '';
    $('#mCover').alt = (book.title || '') + ' 표지';
    $('#mCover').style.display = book.cover ? '' : 'none';
    $('#mTitle').textContent = book.title || '(제목 없음)';
    const sub = [book.author, book.publisher, book.year].filter(Boolean).join(' · ');
    $('#mSub').textContent = sub;
    $('#mField').textContent = book.field || '분야 미확인';
    $('#mKdc').textContent = book.kdc ? `KDC ${book.kdc}` : '';
    $('#mReview').value = rec.review || '';
    $('#mWant').textContent = rec.status === 'want' ? '✓ 읽을래요' : '읽을래요';
    $('#mWant').classList.toggle('is-on', rec.status === 'want');
    const isRecorded = rec.status === 'done';
    $('#mEdit').hidden = !isRecorded;
    $('#mDelete').hidden = !(rec.status === 'done' || rec.status === 'want');

    // 추천 출처 / 구매 정보
    const srcs = book.sources || [];
    const headEl = $('#mSourceSection h4');
    if (headEl) headEl.textContent = book.owned ? '구매 정보 · 메모' : '추천 출처 · 추천 이유';
    $('#mSourceCount').textContent = book.owned
      ? `${book.store} 구매` : `🏆 ${srcs.length}곳 추천`;
    $('#mSources').innerHTML = book.owned
      ? `<div class="source-item"><b>${esc(book.store)}</b><span>${esc((srcs[0] && srcs[0].note) || '')}</span></div>`
      : (srcs.length
        ? srcs.map((s) => `<div class="source-item"><b>${esc(s.name)}</b><span>${esc(s.note || '')}</span></div>`).join('')
        : `<div class="source-item"><b>출처 미확인</b><span>직접 등록한 책이에요.</span></div>`);
    $('#mReason').textContent = book.reason || '';

    buildFavTabs();
    renderModalHoldings();
    renderLinks();
    $('#modal').hidden = false;
    document.body.style.overflow = 'hidden';

    checkBook(book.isbn, true).then(() => { if (state.modalBook === book) renderModalHoldings(); });
  }

  function buildFavTabs() {
    const favs = state.favorites.length ? state.favorites : [{ name: '학교 도서관' }, { name: '구의역 스마트도서관' }];
    $('#mFavTabs').innerHTML = `<button class="fav-tab is-active" data-fav="all">전체</button>` +
      favs.map((f) => `<button class="fav-tab" data-fav="${esc(f.name)}">${esc(f.name.replace(' 도서관', ''))}</button>`).join('');
  }

  function renderModalHoldings() {
    const book = state.modalBook;
    if (!book) return;
    const st = statusFor(book.isbn);
    const favs = state.favorites.length ? state.favorites : [{ name: '학교 도서관' }, { name: '구의역 스마트도서관' }];
    const picked = state.modalFav === 'all' ? favs : favs.filter((f) => f.name === state.modalFav);

    // 단골 도서관 요약
    let okCount = 0, total = 0;
    favs.forEach((f) => {
      const s = favState(book.isbn, f.name);
      if (f.name !== '구의역 스마트도서관') { total++; if (s.kind === 'ok') okCount++; }
    });
    const when = st ? agoLabel(st.at) : '아직 조회 전';
    $('#mFavCount').textContent = `${okCount}/${total}곳 대출가능 · ${when} 조회`;
    $('#mGwSummary').textContent = st && st.gj && st.gj.ok
      ? `${st.gj.summary.total}곳 소장 / 대출가능 ${st.gj.summary.available}곳 · ${agoLabel(st.at)} 조회`
      : (st && st.gj && st.gj.error ? st.gj.error : '조회 전');

    const rows = [];
    picked.forEach((f) => {
      const s = favState(book.isbn, f.name);
      let call = '';
      if (st && st.gj && st.gj.ok) {
        const hit = (st.gj.holdings || []).find((h) => h.library === f.name ||
          (f.name === '구의역 스마트도서관' && h.library.indexOf('구의역') === 0));
        if (hit) call = hit.callNo || '';
      }
      if (st && st.gb && st.gb.ok && f.name === '학교 도서관') {
        const hit = (st.gb.holdings || [])[0];
        if (hit) call = hit.callNo || '';
      }
      const isPickup = f.name === '구의역 스마트도서관';
      rows.push(`<div class="hold-row ${s.kind === 'ok' ? 'ok' : s.kind === 'no' ? 'no' : ''}">
        <i class="dot ${s.kind === 'ok' ? 'ok' : s.kind === 'no' ? 'no' : 'none'}"></i>
        <span class="lib">${esc(f.name)}</span>
        <span>· ${esc(s.label)}</span>
        ${call ? `<span class="callno">${esc(call)}</span>` : ''}
        ${isPickup ? `<span class="tag-pickup">상호대차 수령 기본</span>` : ''}
        <span class="hold-note">${esc(s.text)}</span>
      </div>`);
    });
    if (st && st.gb && st.gb.ok && st.gb.holdings && st.gb.holdings.length) {
      const h = st.gb.holdings[0];
      rows.push(`<div class="hold-row ${h.available ? 'ok' : 'no'}">
        <i class="dot ${h.available ? 'ok' : 'no'}"></i>
        <span class="lib">학교 소장 ${st.gb.holdings.length}권</span>
        ${h.callNo ? `<span class="callno">${esc(h.callNo)}</span>` : ''}
        <span class="hold-note">${esc(h.location || '')}${h.returnPlanDate ? ' · 반납예정 ' + esc(h.returnPlanDate) : ''}</span>
      </div>`);
    }
    $('#mFavRows').innerHTML = rows.join('');

    // 광진구립도서관 전체 소장
    const gwRows = [];
    if (st && st.gj && st.gj.ok) {
      (st.gj.holdings || []).forEach((h) => {
        gwRows.push(`<div class="hold-row ${h.available ? 'ok' : 'no'}">
          <i class="dot ${h.available ? 'ok' : 'no'}"></i>
          <span class="lib">${esc(h.library)}</span>
          <span>· ${esc(h.status)}</span>
          ${h.callNo ? `<span class="callno">${esc(h.callNo)}</span>` : ''}
          <span class="hold-note">${h.copies > 1 ? `${h.availableCopies}/${h.copies}권` : ''}${h.interloan ? ' · 상호대차 가능' : ''}</span>
        </div>`);
      });
      if (!gwRows.length) {
        gwRows.push(`<div class="hold-row"><span class="hold-note">광진구립도서관에는 소장본이 없어요.</span></div>`);
      }
    } else if (st && st.gj && !st.gj.ok) {
      gwRows.push(`<div class="hold-row"><span class="hold-note">조회하지 못했어요: ${esc(st.gj.error || '')}</span></div>`);
    } else {
      gwRows.push(`<div class="hold-row"><span class="hold-note">조회 중…</span></div>`);
    }
    $('#mGwRows').innerHTML = gwRows.join('');
  }

  function renderLinks() {
    const book = state.modalBook;
    if (!book) return;
    const q = encodeURIComponent(book.title || '');
    $('#mLinks').innerHTML = `
      <a href="https://read365.edunet.net/SchoolSearchResult?searchKeyword=${q}&searchType=&provCode=B10" target="_blank" rel="noopener">🔗 독서로에서 보기</a>
      <a href="https://gwangjinlib.seoul.kr/gjinfo/plusSearchResultList.do?searchType=SIMPLE&searchLibrary=ALL&searchKey=TITLE&searchKeyword=${q}" target="_blank" rel="noopener">🔗 광진구립도서관에서 보기</a>`;
    $('#mGwLinks').innerHTML = `
      <a href="https://gwangjinlib.seoul.kr/gjinfo/plusSearchResultList.do?searchType=SIMPLE&searchLibrary=ALL&searchKey=TITLE&searchKeyword=${q}" target="_blank" rel="noopener">🔗 통합검색 열기</a>
      <a href="https://gwangjinlib.seoul.kr/gjinfo/dooraeStatusList.do" target="_blank" rel="noopener">🚚 상호대차 신청조회 (로그인)</a>
      <button type="button" id="mRecheck">🔄 실시간 다시 조회</button>`;
    const btn = $('#mRecheck');
    if (btn) btn.onclick = () => { checkBook(book.isbn, true); toast('다시 조회하고 있어요…'); };
  }

  function closeModal() {
    $('#modal').hidden = true;
    state.modalBook = null;
    document.body.style.overflow = '';
  }

  /* ---------------- record actions ---------------- */
  function recordOf(isbn) { return state.records[recKey(isbn)] || null; }

  function upsertRecord(book, patch) {
    const k = recKey(book);
    const prev = state.records[k] || {};
    state.records[k] = {
      isbn: book.isbn || k,
      title: book.title || prev.title || '',
      author: book.author || prev.author || '',
      cover: book.cover || prev.cover || '',
      stars: prev.stars || 0,
      review: prev.review || '',
      finishedAt: prev.finishedAt || null,
      status: prev.status || 'want',
      updatedAt: new Date().toISOString(),
      ...patch,
    };
    saveRecords();
    renderAll();
    return state.records[k];
  }

  function handleAction(act, key) {
    const ownRaw = ownedByKey(key);
    const book = bookByIsbn(key) || (ownRaw ? ownedBook(ownRaw) : null) || recordOf(key) || { isbn: key };
    const rec = recordOf(key);
    if (act === 'detail') {
      openModal(book, {});
      return;
    }
    if (act === 'want') {
      if (rec && rec.status === 'done') {
        toast('이미 읽은 책이에요. 별점·감상은 [다 읽었어요]에서 고칠 수 있어요.');
        return;
      }
      if (rec && rec.status === 'want') {
        delete state.records[recKey(key)];
        saveRecords(); renderAll(); renderOwned();
        toast('읽을래요에서 뺐어요');
      } else {
        upsertRecord(book, { status: 'want' });
        toast('오늘 읽을 책에 담았어요 🌞');
      }
      return;
    }
    if (act === 'done') {
      openModal(book, {});
      state.draftStars = 0;
      setStars($('#mStars'), 0);
      toast('별점과 감상을 남기고 [다 읽었어요!]를 눌러 주세요');
      setTimeout(() => $('#mReview').focus(), 250);
      return;
    }
    if (act === 'unwant') {
      delete state.records[recKey(key)];
      saveRecords(); renderAll();
      return;
    }
    if (act === 'edit') { openModal(book, {}); return; }
    if (act === 'del') {
      if (!confirm(`'${book.title}' 기록을 지울까요?`)) return;
      delete state.records[recKey(key)];
      saveRecords(); renderAll();
      toast('기록을 지웠어요');
    }
  }

  /* ---------------- 별점 ---------------- */
  function buildStars(el, onChange) {
    el.innerHTML = [1, 2, 3, 4, 5].map((n) => `<button class="star" data-star="${n}" aria-label="${n}점">★</button>`).join('');
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-star]');
      if (!b) return;
      const n = +b.dataset.star;
      setStars(el, n);
      onChange(n);
    });
  }
  function setStars(el, n) {
    $$('.star', el).forEach((s) => s.classList.toggle('on', +s.dataset.star <= n));
  }

  /* ---------------- 도서관 계정 패널 ---------------- */
  async function loadAccounts() {
    const box = $('#accounts');
    box.innerHTML = `<div class="acc-card"><div class="acc-top">
      <span class="acc-name">도서관 계정 연동 현황</span><span class="acc-state off">불러오는 중</span>
    </div><p class="acc-body">대출중 도서·반납예정일·예약 현황을 확인하고 있어요.</p></div>`;
    // 서버가 없어도(정적 호스팅) 확인해 둔 대출·예약 스냅숏을 읽어 표시한다.
    if (state.serverless) {
      try {
        const acc = await getJSON('./data/accounts_status.json');
        renderAccounts(acc);
      } catch (e) {
        box.innerHTML = `<div class="acc-card"><div class="acc-top">
          <span class="acc-name">도서관 계정 현황</span><span class="acc-state off">불러오기 실패</span>
        </div><p class="acc-body">대출중 도서·반납예정일·예약 현황을 불러오지 못했어요. Pickle에 요청하시면 확인해 반영해 드려요.</p></div>`;
      }
      return;
    }
    try {
      const acc = await getJSON('/api/accounts');
      renderAccounts(acc);
    } catch (e) {
      box.innerHTML = `<div class="acc-card"><div class="acc-top">
        <span class="acc-name">도서관 계정 연동 현황</span><span class="acc-state off">연결 실패</span>
      </div><p class="acc-body">서버에 연결하지 못해 계정 현황을 표시할 수 없어요.</p></div>`;
    }
  }

  function renderAccounts(acc) {
    const libs = acc.libraries || [];
    const html = libs.map((lib) => {
      const stateTxt = lib.connected ? '연동됨' : (lib.noticeLevel === 'pending' ? '재인증 중' : '연동 전');
      const cls = lib.connected ? 'on' : 'off';
      const loans = (lib.loans || []).map((l) => `<li>📕 ${esc(l.title)}
        <br><span class="muted">${esc(l.library || '')} · 대출 ${esc(l.loanedAt || '')} · 반납 <b>${esc(l.dueAt || '')}</b>
        ${l.status ? ' · ' + esc(l.status) : ''}${l.pickup ? ' · 수령 ' + esc(l.pickup) : ''}</span></li>`).join('');
      const res = (lib.reservations || []).map((r) => `<li>🔖 예약 ${esc(r.title)}
        <br><span class="muted">${esc(r.library || '')} · ${esc(r.reservedAt || '')} · 순위 ${esc(r.queue || '')}${r.until ? ' · ~' + esc(r.until) : ''}</span></li>`).join('');
      const stats = lib.stats && Object.keys(lib.stats).length
        ? `<p class="acc-body">${Object.entries(lib.stats).map(([k, v]) => `${esc(k)} <b>${esc(v)}</b>`).join(' · ')}</p>` : '';
      return `<div class="acc-card">
        <div class="acc-top">
          <span>
            <span class="acc-name">${esc(lib.label)} · ${esc(lib.name)}</span>
            <span class="acc-label">${esc(lib.login || '')}${lib.verifiedAt ? ' · ' + esc(lib.verifiedAt) + ' 확인' : ''}</span>
          </span>
          <span class="acc-state ${cls}">${esc(stateTxt)}</span>
        </div>
        ${lib.notice ? `<p class="acc-body">${lib.noticeLevel === 'warn' ? '⚠️ ' : ''}${esc(lib.notice)}</p>` : ''}
        ${loans || res ? `<ul class="acc-loans">${loans}${res}</ul>` : ''}
        ${stats}
        ${!loans && !res ? `<p class="acc-body">${esc(lib.notice || '대출·예약 내역을 확인하지 못했어요.')}</p>` : ''}
      </div>`;
    }).join('');

    const pickup = state.pickup
      ? `<p class="live-note" style="margin-top:10px">상호대차 수령 도서관 기본값: <b>${esc(state.pickup.name)}</b></p>`
      : '';
    const snapNote = acc.updatedAt
      ? `<p class="live-note" style="margin-top:10px">${esc(acc.updatedAt)} 확인 기준이에요. ` +
        '실시간 갱신은 Pickle에 요청하시면 확인해 반영해 드려요.</p>'
      : '';
    $('#accounts').innerHTML = html + pickup + snapNote;
    $('#liveNote').dataset.accountsAt = acc.updatedAt || '';
  }

  /* ---------------- 도서 추가 (바코드/직접 입력) ---------------- */
  let scanStream = null;
  let scanTimer = null;
  let detector = null;

  function openAdd(prefillIsbn) {
    state.addMode = 'scan';
    state.aStars = 0;
    state.draft = null;
    setStars($('#aStars'), 0);
    $('#aReview').value = '';
    $('#aDate').value = ymd(new Date());
    $('#aIsbn').value = prefillIsbn || '';
    $('#aTitle').value = '';
    $('#aAuthor').value = '';
    $('#aPublisher').value = '';
    $('#aResult').hidden = true;
    switchAddMode('scan');
    $('#addModal').hidden = false;
    document.body.style.overflow = 'hidden';
    const support = $('#scanSupport');
    if (!('BarcodeDetector' in window)) {
      support.textContent = '이 브라우저는 바코드 자동 인식을 지원하지 않아요. 사진을 찍거나 ISBN을 직접 입력해 주세요.';
    } else {
      support.textContent = '카메라 또는 사진으로 ISBN 바코드를 읽을 수 있어요. (HTTPS/localhost에서 카메라 허용 필요)';
    }
  }

  function closeAdd() {
    stopScan();
    $('#addModal').hidden = true;
    document.body.style.overflow = '';
  }

  function switchAddMode(mode) {
    state.addMode = mode;
    $$('.seg', $('#addModal')).forEach((b) => b.classList.toggle('is-active', b.dataset.addmode === mode));
    $('#scanPane').hidden = mode !== 'scan';
    $('#manualPane').hidden = mode !== 'manual';
    if (mode !== 'scan') stopScan();
  }

  async function startScan() {
    if (!('BarcodeDetector' in window)) {
      toast('이 브라우저에서는 자동 인식이 안 돼요. ISBN을 직접 입력해 주세요.');
      switchAddMode('manual');
      return;
    }
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
      });
      const v = $('#scanVideo');
      v.srcObject = scanStream;
      v.hidden = false;
      await v.play();
      $('#scanStart').hidden = true;
      $('#scanStop').hidden = false;
      $('#scanMsg').textContent = '바코드를 화면 가운데에 맞춰 주세요…';
      const formats = await window.BarcodeDetector.getSupportedFormats();
      const use = ['ean_13', 'ean_8', 'code_128', 'upc_a'].filter((f) => formats.includes(f));
      detector = new window.BarcodeDetector({ formats: use.length ? use : undefined });
      const tick = async () => {
        if (!scanStream) return;
        try {
          const codes = await detector.detect(v);
          const hit = codes.find((c) => /^97[89]/.test(c.rawValue.replace(/\D/g, '')) ||
            /^\d{13}$/.test(c.rawValue.replace(/\D/g, '')) || /^\d{9}[\dX]$/i.test(c.rawValue.replace(/\D/g, '')));
          if (hit) {
            const code = hit.rawValue.replace(/[^0-9Xx]/g, '');
            stopScan();
            toast('바코드를 읽었어요: ' + code);
            await lookupIsbn(code);
            return;
          }
        } catch (e) { /* 한 프레임 실패는 무시 */ }
        scanTimer = setTimeout(tick, 420);
      };
      tick();
    } catch (e) {
      $('#scanMsg').textContent = '카메라를 열 수 없어요. 권한을 허용하거나 ISBN을 직접 입력해 주세요.';
      toast('카메라를 열지 못했어요: ' + (e.message || e.name));
    }
  }

  function stopScan() {
    clearTimeout(scanTimer);
    scanTimer = null;
    if (scanStream) {
      scanStream.getTracks().forEach((t) => t.stop());
      scanStream = null;
    }
    const v = $('#scanVideo');
    if (v) { v.srcObject = null; v.hidden = true; }
    const s = $('#scanStart'); if (s) s.hidden = false;
    const t = $('#scanStop'); if (t) t.hidden = true;
  }

  async function scanFromFile(file) {
    if (!('BarcodeDetector' in window)) {
      toast('이 브라우저는 사진 바코드 인식을 지원하지 않아요. ISBN을 직접 입력해 주세요.');
      switchAddMode('manual');
      return;
    }
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      const use = ['ean_13', 'ean_8', 'code_128', 'upc_a'].filter((f) => formats.includes(f));
      const det = new window.BarcodeDetector({ formats: use.length ? use : undefined });
      const bmp = await createImageBitmap(file);
      const codes = await det.detect(bmp);
      if (!codes.length) { toast('사진에서 바코드를 찾지 못했어요. 다시 찍어 주세요.'); return; }
      const code = codes[0].rawValue.replace(/[^0-9Xx]/g, '');
      toast('바코드를 읽었어요: ' + code);
      await lookupIsbn(code);
    } catch (e) {
      toast('사진을 읽지 못했어요: ' + (e.message || e.name));
    }
  }

  async function lookupIsbn(isbn) {
    const code = isbn.replace(/[^0-9Xx]/g, '');
    if (!(code.length === 13 || code.length === 10)) {
      toast('ISBN은 10자리 또는 13자리예요. 다시 확인해 주세요.');
      return;
    }
    $('#aIsbn').value = code;
    const box = $('#aResult');
    box.hidden = false;
    box.innerHTML = '서지 정보를 불러오는 중…';
    try {
      const r = await getJSON('/api/book/lookup?isbn=' + encodeURIComponent(code));
      if (r.ok && r.book) {
        state.draft = r.book;
        $('#aTitle').value = r.book.title || '';
        $('#aAuthor').value = r.book.author || '';
        $('#aPublisher').value = r.book.publisher || '';
        box.innerHTML = `${r.book.cover ? `<img src="${esc(r.book.cover)}" alt="">` : ''}
          <div><b>${esc(r.book.title)}</b>
          ${esc(r.book.author || '')}<br>${esc(r.book.publisher || '')} ${esc(r.book.year || '')}
          <br><span class="muted">${esc(r.book.field || '')} ${r.book.kdc ? '· KDC ' + esc(r.book.kdc) : ''}</span></div>`;
      } else {
        box.innerHTML = `<div><b>서지 정보를 찾지 못했어요</b>
          <span class="muted">${esc(r.error || '')}<br>제목·저자를 직접 입력해 주세요.</span></div>`;
        state.draft = { isbn: code };
        switchAddMode('manual');
      }
    } catch (e) {
      box.innerHTML = `<div><b>서버에 연결하지 못했어요</b><span class="muted">제목을 직접 입력해 주세요.</span></div>`;
      state.draft = { isbn: code };
      switchAddMode('manual');
    }
  }

  function saveAdd() {
    const isbn = ($('#aIsbn').value || '').replace(/[^0-9Xx]/g, '');
    const title = ($('#aTitle').value || '').trim();
    if (!title) { toast('제목을 입력해 주세요.'); return; }
    const book = {
      isbn: isbn || 'manual-' + Date.now(),
      title,
      author: ($('#aAuthor').value || '').trim(),
      publisher: ($('#aPublisher').value || '').trim(),
      cover: (state.draft && state.draft.cover) || '',
      field: (state.draft && state.draft.field) || '직접 등록',
      kdc: (state.draft && state.draft.kdc) || '',
    };
    // 카탈로그에 없는 책이면 목록에 추가해 이후에도 보이게 한다.
    if (isbn && !bookByIsbn(isbn)) state.catalog.push({ ...book, sources: [], addedByUser: true });
    const date = $('#aDate').value || ymd(new Date());
    const k = isbnKey(book.isbn);
    state.records[k] = {
      isbn: book.isbn, title: book.title, author: book.author, cover: book.cover,
      status: 'done', stars: state.aStars, review: ($('#aReview').value || '').trim(),
      finishedAt: date, updatedAt: new Date().toISOString(),
    };
    saveRecords();
    renderAll();
    closeAdd();
    toast('서재에 꽂았어요 📖');
  }

  /* ---------------- 백업 / 복원 / 초기화 ---------------- */
  function backup() {
    const payload = {
      app: "MOON's Reading Room",
      version: 1,
      exportedAt: new Date().toISOString(),
      records: state.records,
      status: state.status,
      catalogCount: state.catalog.length,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `moon-reading-room-backup-${ymd(new Date())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    toast('기록을 JSON 파일로 내려받았어요');
  }

  function restore(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        const recs = data.records || data;
        if (!recs || typeof recs !== 'object') throw new Error('형식이 올바르지 않아요');
        const count = Object.keys(recs).length;
        if (!confirm(`기록 ${count}건을 불러올까요? 지금 기록 ${Object.keys(state.records).length}건을 덮어씁니다.`)) return;
        state.records = recs;
        if (data.status && typeof data.status === 'object') state.status = data.status;
        saveRecords();
        localStorage.setItem(LS_STATUS, JSON.stringify(state.status));
        renderAll();
        toast(`기록 ${count}건을 복원했어요`);
      } catch (e) {
        toast('복원하지 못했어요: ' + e.message);
      }
    };
    reader.readAsText(file);
  }

  function resetAll() {
    const n = Object.keys(state.records).length;
    if (!confirm(`기록 ${n}건과 조회 캐시를 모두 지울까요? 되돌릴 수 없어요.`)) return;
    if (!confirm('정말 초기화할까요? 필요하면 먼저 [기록 백업]을 눌러 파일로 저장해 주세요.')) return;
    state.records = {};
    state.status = {};
    localStorage.removeItem(LS_RECORDS);
    localStorage.removeItem(LS_STATUS);
    fetch('/api/reset-records', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'moon' }),
    }).catch(() => {});
    renderAll();
    toast('기록을 초기화했어요');
  }

  /* ---------------- events ---------------- */
  function wireEvents() {
    $$('.tab').forEach((t) => t.addEventListener('click', () => {
      state.view = t.dataset.view;
      $$('.tab').forEach((x) => {
        const on = x === t;
        x.classList.toggle('is-active', on);
        x.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      const viewIds = ['shelf', 'rec', 'owned'];
      viewIds.forEach((v) => {
        const el = $('#view-' + v);
        if (el) el.classList.toggle('is-active', state.view === v);
      });
      if (state.view === 'rec') observeCards();
      if (state.view === 'owned') renderOwned();
    }));

    $('#goPickBtn').addEventListener('click', () => $$('.tab')[1].click());

    $('#refreshBtn').addEventListener('click', async () => {
      const btn = $('#refreshBtn');
      btn.classList.add('is-loading');
      const visible = sortedFiltered().slice(0, 12).map((b) => b.isbn);
      await Promise.all(visible.map((i) => checkBook(i, true).catch(() => {})));
      await loadAccounts();
      btn.classList.remove('is-loading');
      toast('도서관 상태를 새로 확인했어요');
    });

    $('#checkAllBtn').addEventListener('click', async () => {
      const list = sortedFiltered().slice(0, 15);
      toast(`${list.length}권을 조회하고 있어요…`);
      $('#checkAllBtn').classList.add('is-loading');
      await Promise.all(list.map((b) => checkBook(b.isbn, true).catch(() => {})));
      $('#checkAllBtn').classList.remove('is-loading');
    });

    $('#searchInput').addEventListener('input', (e) => {
      state.filter.q = e.target.value;
      renderGrid();
    });
    $('#fSource').addEventListener('change', (e) => { state.filter.source = e.target.value; renderGrid(); });
    $('#fField').addEventListener('change', (e) => { state.filter.field = e.target.value; renderGrid(); });
    $('#fLibrary').addEventListener('change', (e) => {
      state.filter.lib = e.target.value;
      renderGrid();
      if (state.filter.lib) toast('실시간 조회된 책만 표시해요. [실시간 조회]를 눌러 주세요.');
    });
    $('#sortBy').addEventListener('change', (e) => { state.sort = e.target.value; renderGrid(); });

    // 구매도서 탭
    const ownSearch = $('#ownSearch');
    if (ownSearch) ownSearch.addEventListener('input', (e) => { state.own.q = e.target.value; renderOwned(); });
    const ownStore = $('#ownStore');
    if (ownStore) ownStore.addEventListener('change', (e) => { state.own.store = e.target.value; renderOwned(); });
    const ownSortSel = $('#ownSort');
    if (ownSortSel) ownSortSel.addEventListener('change', (e) => { state.ownSort = e.target.value; renderOwned(); });
    const ownRefresh = $('#ownRefreshBtn');
    if (ownRefresh) ownRefresh.addEventListener('click', async () => {
      ownRefresh.classList.add('is-loading');
      await loadPurchased(true);
      buildOwnStore();
      renderOwned();
      ownRefresh.classList.remove('is-loading');
      toast('구매도서 목록을 다시 불러왔어요');
    });

    // 그리드 / 오늘 목록 / 서재 클릭 위임
    document.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip-lib');
      if (chip && chip.dataset.chip) {
        e.stopPropagation();
        const book = bookByIsbn(chip.dataset.isbn);
        if (book) openModal(book);
        return;
      }
      const openEl = e.target.closest('[data-open]');
      if (openEl) {
        const k = openEl.dataset.open;
        const book = bookByIsbn(k);
        if (book) { openModal(book); return; }
        const ownRaw = ownedByKey(k);
        if (ownRaw) { openModal(ownedBook(ownRaw)); return; }
        return;
      }
      const actEl = e.target.closest('[data-act]');
      if (actEl) {
        e.stopPropagation();
        handleAction(actEl.dataset.act, actEl.dataset.isbn);
        return;
      }
      const favTab = e.target.closest('[data-fav]');
      if (favTab) {
        state.modalFav = favTab.dataset.fav;
        $$('.fav-tab').forEach((b) => b.classList.toggle('is-active', b === favTab));
        renderModalHoldings();
      }
    });

    $('#mClose').addEventListener('click', closeModal);
    $('#mClose2').addEventListener('click', closeModal);
    $('#modal .modal-backdrop').addEventListener('click', closeModal);

    $('#mWant').addEventListener('click', () => {
      const b = state.modalBook;
      if (!b) return;
      const rec = recordOf(b.isbn);
      if (rec && rec.status === 'done') {
        toast('이미 읽은 책이에요. 별점·감상은 [다 읽었어요!]로 저장돼요.');
        return;
      }
      if (rec && rec.status === 'want') {
        delete state.records[recKey(b)];
        saveRecords(); renderAll();
        $('#mWant').textContent = '읽을래요';
        toast('읽을래요에서 뺐어요');
      } else {
        upsertRecord(b, { status: rec && rec.status === 'done' ? 'done' : 'want' });
        $('#mWant').textContent = '✓ 읽을래요';
        toast('오늘 읽을 책에 담았어요 🌞');
      }
    });

    $('#mDone').addEventListener('click', () => {
      const b = state.modalBook;
      if (!b) return;
      const review = $('#mReview').value.trim();
      upsertRecord(b, {
        status: 'done',
        stars: state.draftStars,
        review,
        finishedAt: (recordOf(b.isbn) && recordOf(b.isbn).finishedAt) || ymd(new Date()),
      });
      closeModal();
      toast('서재에 꽂았어요 📖');
    });

    $('#mDelete').addEventListener('click', () => {
      const b = state.modalBook;
      if (!b) return;
      if (!confirm(`'${b.title}' 기록을 지울까요?`)) return;
      delete state.records[recKey(b)];
      saveRecords(); renderAll();
      closeModal();
      toast('기록을 지웠어요');
    });

    $('#mEdit').addEventListener('click', () => {
      const b = state.modalBook;
      if (!b) return;
      const rec = recordOf(b.isbn);
      if (!rec) return;
      $('#mReview').value = rec.review || '';
      state.draftStars = rec.stars || 0;
      setStars($('#mStars'), state.draftStars);
      $('#mReview').focus();
      toast('별점·감상을 고친 뒤 [다 읽었어요!]를 눌러 주세요');
    });

    $('#addRecordBtn').addEventListener('click', () => openAdd());
    $('#addBookBtn').addEventListener('click', () => openAdd());
    $('#aClose').addEventListener('click', closeAdd);
    $('#aCancel').addEventListener('click', closeAdd);
    $('#addModal .modal-backdrop').addEventListener('click', closeAdd);
    $$('.seg', $('#addModal')).forEach((b) => b.addEventListener('click', () => switchAddMode(b.dataset.addmode)));
    $('#scanStart').addEventListener('click', startScan);
    $('#scanStop').addEventListener('click', stopScan);
    $('#scanFile').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) scanFromFile(f);
    });
    $('#aLookup').addEventListener('click', () => {
      const v = ($('#aIsbn').value || '').trim();
      if (!v) { toast('ISBN을 입력해 주세요.'); return; }
      lookupIsbn(v);
    });
    $('#aSave').addEventListener('click', saveAdd);

    $('#backupBtn').addEventListener('click', backup);
    $('#restoreBtn').addEventListener('click', () => $('#restoreFile').click());
    $('#restoreFile').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) restore(f);
      e.target.value = '';
    });
    $('#resetBtn').addEventListener('click', resetAll);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('#modal').hidden) closeModal();
        if (!$('#addModal').hidden) closeAdd();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
