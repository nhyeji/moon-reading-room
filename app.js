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
    filter: { q: '', source: '', field: '', lib: '', taste: false },
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
    accounts: null,      // 도서관 계정 대출·예약 (data/accounts_status.json)
    loan: { status: '', acct: '', sort: 'due' },
    pool: null,          // 취향 맞춤 후보 풀 (data/similar_pool.json)
    similar: { items: [], catalog: {}, basis: null, level: 0, ratedCount: 0 },
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
  /* ---------------- 3단계 평가: 👍 좋음(3) · 🙂 보통(2) · 😕 별로(1) ---------------- */
  const FEELS = {
    1: { icon: '😕', label: '별로', cls: 'feel-bad' },
    2: { icon: '🙂', label: '보통', cls: 'feel-soso' },
    3: { icon: '👍', label: '좋음', cls: 'feel-good' },
  };
  const FEEL_ORDER = [3, 2, 1];   // 화면에 놓이는 순서(좋음 → 보통 → 별로)
  const FEEL_TOP = 3;
  // 예전 5단계 별점(4·5점)은 새 3단계(👍 좋음)로 정리한다.
  function clampRating(n) {
    const v = Number(n) || 0;
    if (v <= 0) return 0;
    return v > FEEL_TOP ? FEEL_TOP : Math.max(1, Math.round(v));
  }
  function feelOf(n) { return FEELS[clampRating(n)] || null; }
  function feelLabel(n) { const f = feelOf(n); return f ? `${f.icon} ${f.label}` : ''; }
  function feelChip(n, extra = '') {
    const f = feelOf(n);
    return f ? `<span class="feel ${f.cls}${extra ? ' ' + extra : ''}">${f.icon} ${f.label}</span>` : '';
  }
  // 받침에 따라 '과/와'를 고른다.
  function joParticle(w) {
    const s = String(w || '');
    const ch = s.charCodeAt(s.length - 1);
    if (ch >= 0xAC00 && ch <= 0xD7A3) return ((ch - 0xAC00) % 28) ? '과' : '와';
    return '와';
  }
  const isbnKey = (s) => String(s || '').replace(/[^0-9Xx]/g, '');
  // 기록 키: ISBN이 있으면 ISBN, 없으면 own-<id> 같은 문자열 키를 그대로 쓴다.
  function recKey(x) {
    const isbn = typeof x === 'string' ? x : (x && x.isbn) || '';
    const ik = isbnKey(isbn);
    if (ik) return ik;
    return typeof x === 'string' ? x : String((x && (x.key || x.isbn)) || '');
  }

  /* ---------------- storage ---------------- */
  // 예전 5단계 별점(4~5점)을 3단계 평가로 옮겨 저장한다.
  function normalizeRatings() {
    let changed = false;
    Object.keys(state.records).forEach((k) => {
      const r = state.records[k];
      if (!r || typeof r !== 'object') return;
      const v = Number(r.stars) || 0;
      const c = clampRating(v);
      if (v !== c) { r.stars = c; changed = true; }
    });
    if (changed) {
      try { localStorage.setItem(LS_RECORDS, JSON.stringify(state.records)); } catch (e) { /* 저장 실패는 무시 */ }
    }
    return changed;
  }

  function loadLocal() {
    try { state.records = JSON.parse(localStorage.getItem(LS_RECORDS) || '{}') || {}; } catch (e) { state.records = {}; }
    try { state.status = JSON.parse(localStorage.getItem(LS_STATUS) || '{}') || {}; } catch (e) { state.status = {}; }
    normalizeRatings();
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

  /* ---------------- 취향 맞춤 후보 풀 (data/similar_pool.json) ---------------- */
  function poolBooks() { return (state.pool && state.pool.books) || []; }
  function poolByIsbn(isbn) {
    const k = isbnKey(isbn);
    if (!k) return null;
    return poolBooks().find((b) => isbnKey(b.isbn) === k) || null;
  }
  async function loadPool(force) {
    if (!force && window.__SIMILAR_POOL__) { state.pool = window.__SIMILAR_POOL__; return; }
    try {
      state.pool = await getJSON('./data/similar_pool.json' + (force ? '?t=' + Date.now() : ''));
    } catch (e) {
      if (!state.pool && window.__SIMILAR_POOL__) state.pool = window.__SIMILAR_POOL__;
    }
  }
  // 모달·기록에서 쓰는 취향 맞춤 책 객체(추천 이유를 '추천 출처' 자리에 넣는다)
  function enrichedPoolBook(b) {
    if (!b) return null;
    const it = (state.similar.items || []).find((x) => isbnKey(x.book.isbn) === isbnKey(b.isbn));
    const reason = it ? matchReason(it) : '';
    return Object.assign({}, b, {
      sources: reason ? [{ name: '💖 취향 맞춤', note: reason }] : [],
      reason,
    });
  }

  /* ---------------- 취향 유사도 추천 엔진 ---------------- */
  // 제목·작가에서 알아보는 시리즈/주제 (책마다 태그를 일일이 적지 않아도 되도록)
  const TAG_RULES = [
    [/수상한\s*(도서관|식당|아파트|우리\s*반|친구\s*집|편의점|학원|운동장|고물상|지하실|놀이터|휴게소)/, ['추리', '미스터리', '시리즈', '한국창작동화'], '수상한 시리즈'],
    [/푸른 사자 와니니/, ['동물', '성장', '모험', '시리즈', '한국창작동화'], '푸른 사자 와니니'],
    [/구덩이|Holes/i, ['성장', '모험', '영미동화'], ''],
    [/Frank and Joe Hardy|Hardy Boys/i, ['추리', '미스터리', '원서', '챕터북', '시리즈'], 'Hardy Boys'],
    [/A to Z Mysteries/i, ['추리', '미스터리', '원서', '챕터북', '시리즈'], 'A to Z Mysteries'],
    [/마법의 시간여행|Magic Tree House/i, ['판타지', '모험', '역사', '시리즈', '챕터북'], '마법의 시간여행'],
    [/지대넓얕/, ['인문', '교양', '경제', '시리즈'], '지대넓얕'],
    [/K탐정/, ['사회', '법', '경제', '교양', '시리즈'], 'K탐정'],
    [/별똥별 아줌마/, ['과학', '우주', '천문', '시리즈'], '별똥별 아줌마'],
    [/제돌이|해오리|바다로 돌아간/, ['바다', '동물', '자연', '환경'], ''],
    [/전천당|이상한 과자/, ['판타지', '동화', '시리즈'], '이상한 과자 가게 전천당'],
    [/만복이네 떡집|소원 떡집/, ['판타지', '동화', '시리즈', '한국창작동화'], '만복이네 떡집'],
    [/설민석|한국사 대모험/, ['역사', '한국사', '인물', '시리즈'], ''],
    [/용선생/, ['역사', '한국사', '시리즈'], '용선생'],
    [/시끌벅적 한국사/, ['역사', '한국사'], ''],
    [/아홉 살 (마음|느낌) 사전/, ['철학', '감정', '언어', '시리즈'], '아홉 살 사전'],
    [/읽으면서 바로 써먹는/, ['언어', '어휘', '시리즈'], '읽으면서 바로 써먹는'],
    [/다른그림찾기|숨은그림찾기|스도쿠/, ['놀이', '집중력', '예술'], ''],
    [/사흘만 볼 수 있다면|헬렌 켈러/, ['인물', '감동'], ''],
    [/샬롯의 거미줄|스튜어트 리틀|Stuart Little/i, ['동물', '판타지', '고전', '영미동화'], ''],
    [/내 친구 윈딕시|에드워드 툴레인/, ['성장', '감동', '영미동화', '동물'], ''],
    [/마당을 나온 암탉|나쁜 어린이 표/, ['성장', '한국창작동화'], ''],
    [/5번 레인|축제는 언제나|오백 년째/, ['성장', '청소년', '한국창작동화'], ''],
    [/웨이사이드|Wayside/i, ['학교', '유머', '원서', '챕터북', '시리즈'], '웨이사이드 스쿨'],
    [/윔피\s*키드/, ['학교', '유머', '챕터북', '시리즈'], '윔피 키드'],
    [/신기한 스쿨버스/, ['과학', '자연', '시리즈'], '신기한 스쿨버스'],
    [/셜록 홈즈/, ['추리', '미스터리', '시리즈'], '명탐정 셜록 홈즈'],
  ];
  const FIELD_TAGS = {
    '동화·이야기': ['동화'], '과학': ['과학'], '역사·인물': ['역사', '인물'],
    '사회·경제': ['사회', '경제'], '철학·가치': ['철학'], '언어': ['언어'],
    '예술': ['예술'], '지식·교양': ['지식·교양'],
    '어린이·청소년 소설': ['동화'], '초등 창작동화': ['한국창작동화', '동화'],
    '어린이 과학동화': ['과학'], '어린이 그림책': ['동화'],
    '어린이 인성·대화법': ['철학', '언어'], '어린이 놀이·두뇌게임': ['놀이', '집중력'],
    '원서(영한대역)': ['원서', '챕터북'], '원서(영아 보드북)': ['원서'],
  };
  // 같은 작가인데 한글·영문 표기가 다른 경우
  const AUTH_ALIAS = [
    [/루이스\s*(새커|섀커)|louis\s+sachar/i, 'louis sachar'],
    [/메리\s*폽\s*어즈번|mary\s+pope\s+osborne/i, 'mary pope osborne'],
    [/케이트\s*디카밀로|kate\s+dicamillo/i, 'kate dicamillo'],
    [/e\.?\s*b\.?\s*white|엘윈\s*브룩스\s*화이트/i, 'e b white'],
    [/제프\s*키니|jeff\s+kinney/i, 'jeff kinney'],
    [/아서\s*코난\s*도일|conan\s+doyle/i, 'conan doyle'],
    [/론\s*로이|ron\s+roy/i, 'ron roy'],
    [/조애너\s*콜|joanna\s+cole/i, 'joanna cole'],
  ];
  // 이유 문구에 쓸 분야 이름
  const KDC_LABEL = {
    '813': '한국 창작동화', '808': '한국 창작동화', '843': '영미 창작동화', '833': '일본 창작동화',
    '408': '과학', '443': '천문·우주', '445': '지구과학', '511': '인체',
    '911': '한국사', '909': '세계사', '001': '인문·교양', '082': '지식·교양',
    '375': '사회·경제', '308': '사회·경제', '181': '철학·감정', '691': '예술·놀이',
    '714': '언어', '710': '언어', '388': '언어', '747': '영어 원서',
  };
  function kdcLabel(k) { return KDC_LABEL[String(k || '').slice(0, 3)] || ''; }
  const GENERIC_TAGS = ['시리즈', '동화', '한국창작동화', '영미동화', '원서', '챕터북',
    '학습만화', '고전', '교양', '지식·교양', '인물'];

  function authorKeys(a) {
    return String(a || '')
      .split(/[·;,/]/)
      .map((raw) => {
        const hit = AUTH_ALIAS.find(([re]) => re.test(raw));
        if (hit) return hit[1];
        return raw.replace(/\s*(지음|지은이|글|그림|옮김|저|편|감수|원작|공저|by|ill\.?)\s*/gi, ' ').trim().toLowerCase();
      })
      .filter((x) => x.length >= 2);
  }

  function prof(b) {
    if (!b) return { tags: [], series: '', lang: 'ko', type: 'chapter', kdc: '', author: '', field: '' };
    if (b.__prof) return b.__prof;
    const hay = `${b.title || ''} ${b.author || ''}`;
    const tags = new Set();
    let series = b.series || '';
    TAG_RULES.forEach(([re, tg, se]) => {
      if (!re.test(hay)) return;
      tg.forEach((t) => tags.add(t));
      if (se && !series) series = se;
    });
    (b.tags || []).forEach((t) => tags.add(t));
    (FIELD_TAGS[b.field] || []).forEach((t) => tags.add(t));
    const kdc = String(b.kdc || '').replace(/[^0-9]/g, '').slice(0, 3);
    if (/^8/.test(kdc)) tags.add('동화');
    if (/^[45]/.test(kdc)) tags.add('과학');
    if (/^9/.test(kdc)) tags.add('역사');
    if (/^3/.test(kdc)) tags.add('사회');
    if (/^0/.test(kdc)) tags.add('지식·교양');
    if (/^7/.test(kdc)) tags.add('언어');
    if (/^69/.test(kdc)) tags.add('예술');
    const lang = b.lang || (/[가-힣]/.test(b.title || '') ? 'ko' : 'en');
    const type = b.type || (/^8/.test(kdc) || !kdc ? 'chapter' : 'nonfiction');
    const p = { tags: Array.from(tags), series, lang, type, kdc, author: b.author || '', field: b.field || '' };
    b.__prof = p;
    return p;
  }

  // 가장 높은 평가를 받은 책(seed)과 후보(cand)의 유사도 점수
  function simScore(seed, cand) {
    const a = prof(seed), b = prof(cand);
    let score = 0;
    const why = [];
    if (a.kdc && b.kdc) {
      if (a.kdc === b.kdc) score += 34;
      else if (a.kdc.slice(0, 2) === b.kdc.slice(0, 2)) score += 22;
      else if (a.kdc[0] === b.kdc[0]) score += 12;
    }
    const shared = a.tags.filter((t) => b.tags.includes(t));
    score += Math.min(shared.length, 4) * 9;
    const topic = shared.filter((t) => !GENERIC_TAGS.includes(t));
    const sameSeries = !!(a.series && b.series && a.series === b.series);
    if (sameSeries) score += 30;
    const ak = authorKeys(a.author), bk = authorKeys(b.author);
    const sameAuthor = !!(ak.length && bk.length && ak.some((x) => bk.includes(x) ||
      (x.length >= 3 && bk.some((y) => y.includes(x) || x.includes(y)))));
    if (sameAuthor) score += 22;
    if (a.lang === b.lang) score += 7;
    if (a.type === b.type) score += 7;
    if (a.field && b.field && a.field === b.field) score += 8;
    if (topic.length) why.push(topic.slice(0, 2).join('·'));
    if (sameAuthor) why.unshift('같은 작가');
    else if (sameSeries) why.unshift('「' + a.series + '」 시리즈');
    if (!why.length) why.push(kdcLabel(a.kdc) || a.field || '같은 분야');
    return { score, why };
  }

  function matchReason(it) {
    const t = (it.seed && it.seed.title) || '';
    const why = (it.why || []).slice();
    const sameAuthor = why.indexOf('같은 작가') >= 0;
    const rest = why.filter((w) => w !== '같은 작가').slice(0, 2).join('·');
    const feel = feelLabel(it.seedLevel);
    if (sameAuthor && !rest) return `${feel} · '${t}'${joParticle(t)} 같은 작가의 책`;
    if (sameAuthor) return `${feel} · '${t}'${joParticle(t)} 같은 작가의 ${rest} 책`;
    const tail = rest || kdcLabel(it.seed && it.seed.kdc) || (it.seed && it.seed.field) || '같은 분야';
    return `${feel} · '${t}'${joParticle(t)} 비슷한 ${tail} 책`;
  }

  function bookForRecord(r) {
    const own = ownedByKey(r.isbn);
    const loan = loanByKey(r.isbn);
    return bookByIsbn(r.isbn) || poolByIsbn(r.isbn) ||
      (own ? ownedBook(own) : null) || (loan ? loanBook(loan) : null) || r;
  }

  function ratedEntries() {
    return Object.values(state.records)
      .filter((r) => r && r.status === 'done' && clampRating(r.stars) > 0)
      .map((r) => ({ rec: r, book: bookForRecord(r), level: clampRating(r.stars) }))
      .sort((x, y) => y.level - x.level ||
        String(y.rec.finishedAt || '').localeCompare(String(x.rec.finishedAt || '')));
  }

  // 가장 높은 평가(👍 좋음 → 없으면 🙂 보통)를 기준으로 비슷한 책을 고른다.
  function buildSimilar() {
    const rated = ratedEntries();
    const topLevel = rated.length ? Math.max.apply(null, rated.map((x) => x.level)) : 0;
    const res = { items: [], catalog: {}, basis: null, level: topLevel, ratedCount: rated.length };
    if (topLevel < 2) { state.similar = res; return; }
    const seeds = rated.filter((x) => x.level === topLevel).slice(0, 3);
    const doneKeys = new Set(Object.values(state.records)
      .filter((r) => r.status === 'done').map((r) => isbnKey(r.isbn)));
    const ownKeys = new Set(ownedBooks().map((b) => isbnKey(b.isbn)));
    const loanKeys = new Set(loanItems().map((it) => isbnKey(it.isbn)).filter(Boolean));

    const picked = [];
    poolBooks().forEach((b) => {
      const k = isbnKey(b.isbn);
      if (!k || doneKeys.has(k)) return;
      let best = null;
      seeds.forEach((s) => {
        const r = simScore(s.book, b);
        if (!best || r.score > best.score) best = { score: r.score, why: r.why, seed: s };
      });
      if (!best || best.score < 26) return;
      picked.push({
        book: b, score: best.score, why: best.why, seed: best.seed.book,
        seedLevel: best.seed.level, owned: ownKeys.has(k), loaned: loanKeys.has(k),
      });
    });
    picked.sort((x, y) => y.score - x.score || (x.owned ? 1 : 0) - (y.owned ? 1 : 0) ||
      String(x.book.title).localeCompare(String(y.book.title), 'ko'));
    res.items = picked.slice(0, 8);
    res.basis = {
      title: seeds[0].book.title || seeds[0].rec.title || '',
      level: seeds[0].level, n: seeds.length,
    };

    // 기본 추천 서가(52권)에 이미 있는 책은 카드 안에 표시만 붙인다(상위 6권).
    const catPicked = [];
    state.catalog.forEach((b) => {
      const k = isbnKey(b.isbn);
      if (!k || doneKeys.has(k)) return;
      let best = null;
      seeds.forEach((s) => {
        const r = simScore(s.book, b);
        if (!best || r.score > best.score) best = { score: r.score, why: r.why, seed: s };
      });
      if (best && best.score >= 26) {
        catPicked.push({ k, best });
      }
    });
    catPicked.sort((x, y) => y.best.score - x.best.score);
    catPicked.slice(0, 6).forEach((x) => {
      res.catalog[x.k] = {
        score: x.best.score, why: x.best.why, seed: x.best.seed.book, seedLevel: x.best.seed.level,
      };
    });
    state.similar = res;
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
      if (isDone && rec.stars) tags.push(feelChip(rec.stars, 'own-tag'));
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

  /* ---------------- 대출도서 (도서관 계정 대출·예약) ---------------- */
  function loanItems() {
    const out = [];
    ((state.accounts && state.accounts.libraries) || []).forEach((lib) => {
      const base = {
        libKey: lib.key || lib.label || '', libLabel: lib.label || '',
        libName: lib.name || '', login: lib.login || '', member: lib.member || '',
      };
      (lib.loans || []).forEach((l, i) => out.push(Object.assign({}, base, l, { kind: 'loan', ref: (lib.key || 'lib') + ':L' + i })));
      (lib.reservations || []).forEach((r, i) => out.push(Object.assign({}, base, r, { kind: 'reserve', ref: (lib.key || 'lib') + ':R' + i })));
    });
    return out;
  }

  function loanDueOf(it) { return it.kind === 'reserve' ? (it.until || '') : (it.dueAt || ''); }
  function loanRecKey(it) { return it.isbn ? isbnKey(it.isbn) : 'loan-' + it.ref; }

  function loanByKey(key) {
    const k = String(key || '');
    return loanItems().find((x) => loanRecKey(x) === k || ('loan-' + x.ref) === k || x.ref === k) || null;
  }

  function loanBook(it) {
    if (!it) return null;
    const kindTxt = it.kind === 'reserve'
      ? `예약 ${it.reservedAt || ''}`.trim() + (it.queue ? ` · 순위 ${it.queue}` : '')
      : `대출 ${it.loanedAt || ''}`.trim();
    const tail = it.kind === 'reserve'
      ? (it.until ? `수령기한 ~${it.until}` : '')
      : [(it.dueAt ? `반납 ${it.dueAt}` : ''), (it.pickup ? `수령 ${it.pickup}` : '')].filter(Boolean).join(' · ');
    const note = [it.library || '', kindTxt, tail, it.status || ''].filter(Boolean).join(' · ');
    return {
      isbn: it.isbn || ('loan-' + it.ref), key: loanRecKey(it),
      title: it.title, author: it.author || '', publisher: it.publisher || '',
      year: it.year || '', cover: it.cover || '', kdc: it.kdc || '',
      field: it.kind === 'reserve' ? '예약도서' : '대출도서',
      loaned: true, loanKind: it.kind,
      sources: [{ name: it.libName || '도서관', note }],
      reason: '',
    };
  }

  function daysLeft(ymdStr) {
    const d = parseYmd(ymdStr);
    if (!d) return null;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((d - today) / 86400000);
  }

  function loanDueTag(it) {
    const s = loanDueOf(it);
    if (!s) return '';
    const label = it.kind === 'reserve' ? '수령기한' : '반납';
    const n = daysLeft(s);
    if (n == null) return `<span class="loan-tag">${label} ${esc(s)}</span>`;
    if (n < 0) return `<span class="loan-tag urgent">${label} ${esc(s)} · ${-n}일 지남</span>`;
    if (n === 0) return `<span class="loan-tag urgent">${label} ${esc(s)} · 오늘까지</span>`;
    if (n <= 3) return `<span class="loan-tag urgent">${label} ${esc(s)} · D-${n}</span>`;
    return `<span class="loan-tag">${label} ${esc(s)} · D-${n}</span>`;
  }

  function loanFiltered() {
    let list = loanItems();
    if (state.loan.status) list = list.filter((x) => x.kind === state.loan.status);
    if (state.loan.acct) list = list.filter((x) => x.libKey === state.loan.acct);
    list = list.slice();
    if (state.loan.sort === 'title') {
      list.sort((a, b) => String(a.title).localeCompare(String(b.title), 'ko'));
    } else if (state.loan.sort === 'loaned') {
      list.sort((a, b) => String(b.loanedAt || b.reservedAt || '').localeCompare(String(a.loanedAt || a.reservedAt || '')));
    } else {
      list.sort((a, b) => String(loanDueOf(a) || '9999-99-99').localeCompare(String(loanDueOf(b) || '9999-99-99')));
    }
    return list;
  }

  function renderLoans() {
    const box = $('#loanList');
    if (!box) return;
    const acc = state.accounts;
    const all = loanItems();
    const badge = $('#loanTabCount');
    if (badge) badge.textContent = all.length ? String(all.length) : '0';
    $('#loanCount').textContent = `${all.length}권`;

    // 계정 필터 (책이 있는 계정만)
    const sel = $('#loanAcct');
    if (sel) {
      const accts = [];
      all.forEach((x) => {
        if (!accts.some((a) => a.key === x.libKey)) {
          accts.push({ key: x.libKey, name: x.login || x.libLabel || x.libName || '도서관' });
        }
      });
      sel.innerHTML = '<option value="">계정 전체</option>' +
        accts.map((a) => `<option value="${esc(a.key)}">${esc(a.name)}</option>`).join('');
      sel.value = state.loan.acct || '';
    }

    if (acc) {
      $('#loanSource').textContent = (acc.updatedAt ? `${acc.updatedAt} 확인 기준 · ` : '') +
        '광진구립도서관 계정의 대출·예약 현황이에요. [새로고침]을 누르거나 Pickle에 요청하면 확인해 반영해 드려요.';
    } else {
      $('#loanSource').textContent = '대출·예약 현황을 아직 불러오지 못했어요. [새로고침]을 눌러 주세요.';
    }

    const loanN = all.filter((x) => x.kind === 'loan').length;
    const resN = all.filter((x) => x.kind === 'reserve').length;
    const soon = all.filter((x) => x.kind === 'loan')
      .map((x) => daysLeft(x.dueAt)).filter((n) => n != null && n <= 3).length;
    const notices = ((acc && acc.libraries) || [])
      .filter((l) => l.notice && l.noticeLevel === 'warn')
      .map((l) => `<span class="loan-stat warn">⚠️ ${esc((l.login || l.label) + ' · ' + l.notice)}</span>`).join('');
    $('#loanSummary').innerHTML =
      `<span class="loan-stat">📕 대출중 <b>${loanN}</b>권</span>` +
      `<span class="loan-stat">🔖 예약 <b>${resN}</b>권</span>` +
      (soon ? `<span class="loan-stat warn">⏰ 반납 임박 <b>${soon}</b>권</span>` : '') + notices;

    const list = loanFiltered();
    $('#loanEmpty').hidden = list.length > 0;
    if (!list.length) {
      $('#loanEmpty').textContent = !acc ? '대출·예약 현황을 불러오지 못했어요.'
        : (all.length ? '조건에 맞는 대출·예약 도서가 없어요.' : '지금 대출·예약 중인 책이 없어요.');
    }

    box.innerHTML = list.map((it) => {
      const rk = loanRecKey(it);
      const rec = state.records[rk];
      const isWanted = rec && rec.status === 'want';
      const isDone = rec && rec.status === 'done';
      const tags = [];
      if (it.pickup) tags.push(`<span class="loan-tag">📦 수령 ${esc(it.pickup)}</span>`);
      if (it.kind === 'loan' && it.status) tags.push(`<span class="loan-tag">${esc(it.status)}</span>`);
      if (it.kind === 'reserve') {
        if (it.queue) tags.push(`<span class="loan-tag">예약 ${esc(it.queue)}</span>`);
        if (it.reservedAt) tags.push(`<span class="loan-tag">예약일 ${esc(it.reservedAt)}</span>`);
      }
      if (isDone) tags.push(`<span class="loan-tag done">✓ 읽음${rec.finishedAt ? ' ' + esc(rec.finishedAt) : ''}</span>`);
      else if (isWanted) tags.push('<span class="loan-tag want">읽을래요</span>');
      if (isDone && rec.stars) tags.push(feelChip(rec.stars, 'loan-tag'));
      return `<article class="loan-card" data-ref="${esc(it.ref)}">
        <div class="loan-cover" data-act="detail" data-isbn="${esc(rk)}">${coverHTML(it.cover, it.title)}</div>
        <div class="loan-body">
          <div class="loan-top">
            <span class="loan-kind ${it.kind === 'reserve' ? 'resv' : 'loan'}">${it.kind === 'reserve' ? '🔖 예약중' : '📕 대출중'}</span>
            <span class="acct-badge">${esc(it.login || it.libLabel || '')}</span>
            ${loanDueTag(it)}
          </div>
          <p class="loan-title" data-act="detail" data-isbn="${esc(rk)}">${esc(it.title)}</p>
          <p class="loan-sub">${esc([it.author, it.publisher, it.year].filter(Boolean).join(' · '))}</p>
          <div class="loan-meta"><span class="loan-tag">🏛️ ${esc(it.library || '')}</span>${tags.join('')}</div>
          <div class="loan-actions">
            <button class="own-btn ${isDone || isWanted ? 'is-on' : ''}" data-act="want" data-isbn="${esc(rk)}">${isDone ? '✓ 읽음' : isWanted ? '✓ 읽을래요' : '＋ 읽을래요'}</button>
            <button class="own-btn ${isDone ? 'is-done' : ''}" data-act="done" data-isbn="${esc(rk)}">${isDone ? '✓ 다 읽었어요' : '다 읽었어요'}</button>
            <button class="own-btn" data-act="detail" data-isbn="${esc(rk)}">상세 · 한줄감상</button>
          </div>
        </div>
      </article>`;
    }).join('');
  }

  async function loadLoanData(force) {
    if (!force && window.__ACCOUNTS__) { state.accounts = window.__ACCOUNTS__; renderLoans(); return; }
    const snap = './data/accounts_status.json' + (force ? '?t=' + Date.now() : '');
    try {
      state.accounts = await getJSON(state.serverless ? snap : '/api/accounts');
    } catch (e) {
      try { state.accounts = await getJSON(snap); }
      catch (e2) {
        if (!state.accounts && window.__ACCOUNTS__) state.accounts = window.__ACCOUNTS__;
        if (!state.accounts) state.accounts = null;
      }
    }
    renderLoans();
  }

  async function init() {
    loadLocal();
    $('#todayText').textContent = fmtDate(new Date());
    wireEvents();
    buildFeel($('#mStars'), (n) => { state.draftStars = n; setFeelHint('#mFeelHint', n); });
    buildFeel($('#aStars'), (n) => { state.aStars = n; setFeelHint('#aFeelHint', n); });

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
        '지금은 서버 없이 열린 화면이라 실시간 대출 조회는 되지 않아요. ' +
        '아래 도서관 계정 현황은 확인해 둔 시점의 스냅숏이고, 갱신이 필요하면 Pickle에 요청하시면 확인해 반영해 드려요. ' +
        '(PC에서 python3 server.py 로 열면 실시간 조회도 됩니다.)';
    } else {
      $('#liveNote').textContent =
        '도서관 대출상태는 조회 시각 기준 실시간 결과예요. ' +
        '단골 학교 도서관(독서로) · 광진구립도서관 통합검색에서 직접 확인합니다.';
    }

    buildFilters();
    renderLibraryDir();
    await loadPurchased();
    await loadPool();
    buildOwnStore();
    renderAll();
    loadAccounts();
    loadLoanData();
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
    buildSimilar();
    renderGrid();
    renderTaste();
    renderOwned();
    renderLoans();
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
            <div class="feel-pick" data-rate="${esc(r.isbn)}">
              ${FEEL_ORDER.map((n) => `<button class="mini-feel ${FEELS[n].cls} ${clampRating(r.stars) === n ? 'on' : ''}"
                data-act="rate" data-isbn="${esc(r.isbn)}" data-val="${n}">${FEELS[n].icon} ${FEELS[n].label}</button>`).join('')}
            </div>
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

  function shortLibName(n) {
    return String(n).replace(/ 스마트도서관$/, ' 스마트').replace(/ 도서관$/, '').replace(/도서관$/, '');
  }

  function cardHTML(b, taste) {
    const k = isbnKey(b.isbn) || b.isbn;
    const rec = state.records[k];
    const wanted = rec && rec.status === 'want';
    const isDone = rec && rec.status === 'done';
    const favs = (state.favorites.length ? state.favorites : DEFAULT_FAVORITES).slice(0, 4);
    const chips = favs.map((f) => {
      const fs = state.serverless
        ? { kind: 'unknown', label: '미확인', text: '서버를 켜면 실시간 조회돼요' }
        : favState(b.isbn, f.name);
      return `<button class="chip-lib ${fs.kind}" data-chip="1" data-isbn="${esc(b.isbn)}"
        data-lib="${esc(f.name)}" title="${esc(f.name)} · ${esc(fs.text)}">
        <i class="dot"></i>${esc(shortLibName(f.name))} ${esc(fs.kind === 'unknown' ? '' : fs.label)}
      </button>`;
    }).join('');
    const badge = taste
      ? '<span class="badge badge-taste">💖 취향 맞춤</span>'
      : `<span class="badge">🏆 ${esc((b.sources || []).length)}곳 추천</span>`;
    const reason = taste && taste.reason
      ? `<p class="card-reason">${esc(taste.reason)}</p>` : '';
    const flag = taste && taste.owned ? '<span class="card-flag">🛍️ 갖고 있는 책</span>'
      : taste && taste.loaned ? '<span class="card-flag">🏛️ 대출중인 책</span>' : '';
    return `<article class="card ${taste ? 'card-taste' : ''}" data-isbn="${esc(b.isbn)}">
        <div class="card-cover" data-open="${esc(b.isbn)}">${coverHTML(b.cover, b.title)}</div>
        <h4 class="card-title" data-open="${esc(b.isbn)}">${esc(b.title)}</h4>
        ${badge}
        ${flag}
        ${reason}
        <div class="chips-2x2">${chips}</div>
        <button class="want-btn ${wanted ? 'is-wanted' : ''}" data-act="want" data-isbn="${esc(b.isbn)}">
          ${isDone ? '✓ 읽었어요' : wanted ? '✓ 읽을래요' : '＋ 읽을래요'}
        </button>
      </article>`;
  }

  function tasteItems() {
    const s = state.similar;
    const out = (s.items || []).map((it) => ({
      book: it.book, taste: { reason: matchReason(it), owned: it.owned, loaned: it.loaned },
    }));
    // '내 별점 맞춤'으로 볼 때는 기본 추천 서가의 비슷한 책도 함께 보여 준다.
    if (state.filter.taste) {
      Object.keys(s.catalog || {}).forEach((k) => {
        const b = state.catalog.find((x) => isbnKey(x.isbn) === k);
        if (b) out.push({ book: b, taste: { reason: matchReason(s.catalog[k]) } });
      });
    }
    return out;
  }

  function renderGrid() {
    const grid = $('#grid');
    let list;
    if (state.filter.taste) {
      list = tasteItems();
      $('#recCount').textContent = `취향 맞춤 ${list.length}권`;
    } else {
      list = sortedFiltered();
      $('#recCount').textContent = `${list.length}권` +
        (state.similar.items.length ? ` + 취향 맞춤 ${state.similar.items.length}권` : '');
    }
    $('#gridEmpty').hidden = list.length > 0;
    if (!list.length) {
      $('#gridEmpty').textContent = state.filter.taste
        ? '아직 취향 맞춤 도서가 없어요. 읽은 책에 👍 좋음을 주면 여기에 담아 드려요.'
        : '조건에 맞는 책이 없어요.';
    }
    grid.innerHTML = list.map((x) => (x.book ? cardHTML(x.book, x.taste) : cardHTML(x, null))).join('');
    observeCards();
  }

  /* ---------------- render: 취향 맞춤 줄 ---------------- */
  function renderTaste() {
    const panel = $('#tastePanel');
    if (!panel) return;
    const s = state.similar;
    const items = s.items || [];
    const prompt = $('#tastePrompt');
    panel.hidden = !items.length || state.filter.taste;
    if (prompt) {
      prompt.hidden = !!items.length || state.filter.taste;
      if (!prompt.hidden) {
        prompt.innerHTML = s.level === 1
          ? '읽은 책에 <b>🙂 보통</b>이나 <b>👍 좋음</b>을 주시면 취향에 맞는 유사 도서가 추천서가에 추가됩니다.'
          : '읽은 책에 <b>👍 좋음</b>을 주시면 취향에 맞는 유사 도서가 추천서가에 추가됩니다.';
      }
    }
    if (!items.length) { const row0 = $('#tasteRow'); if (row0) row0.innerHTML = ''; return; }
    const basis = s.basis;
    $('#tasteCount').textContent = `${items.length}권`;
    $('#tasteNote').textContent = basis
      ? `${feelLabel(basis.level)}을 준 '${basis.title}'${joParticle(basis.title)} 비슷한 책을 골랐어요.`
      : '';
    $('#tasteRow').innerHTML = items.map((it) => cardHTML(it.book, {
      reason: matchReason(it), owned: it.owned, loaned: it.loaned,
    })).join('');
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
    state.draftStars = clampRating(rec.stars);
    setFeel($('#mStars'), state.draftStars);
    setFeelHint('#mFeelHint', state.draftStars);

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
    if (headEl) headEl.textContent = book.owned ? '구매 정보 · 메모'
      : book.loaned ? '도서관 대출·예약 정보' : '추천 출처 · 추천 이유';
    $('#mSourceCount').textContent = book.owned
      ? `${book.store} 구매`
      : book.loaned ? (book.loanKind === 'reserve' ? '🔖 예약도서' : '📕 대출도서')
      : `🏆 ${srcs.length}곳 추천`;
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
      stars: clampRating(prev.stars),
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

  function handleAction(act, key, val) {
    const ownRaw = ownedByKey(key);
    const poolRaw = poolByIsbn(key);
    const book = bookByIsbn(key) || (poolRaw ? enrichedPoolBook(poolRaw) : null) ||
      (ownRaw ? ownedBook(ownRaw) : null) || loanBook(loanByKey(key)) ||
      recordOf(key) || { isbn: key };
    const rec = recordOf(key);
    if (act === 'rate') {
      if (!rec || rec.status !== 'done') return;
      const n = clampRating(val);
      const next = clampRating(rec.stars) === n ? 0 : n;   // 같은 버튼을 다시 누르면 해제
      upsertRecord(book, { stars: next });
      if (next === 3) {
        const added = (state.similar.items || []).length;
        toast(added ? `👍 좋음! 취향 맞춤 ${added}권을 추천 서가에 담았어요` : '👍 좋음으로 저장했어요');
      } else if (next) {
        toast(`${feelLabel(next)}으로 저장했어요`);
      } else {
        toast('평가를 지웠어요');
      }
      return;
    }
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
      setFeel($('#mStars'), 0);
      setFeelHint('#mFeelHint', 0);
      toast('이 책은 어땠나요? 👍 좋음 · 🙂 보통 · 😕 별로 중에 고르고 [다 읽었어요!]를 눌러 주세요');
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

  /* ---------------- 3단계 평가 버튼 (👍 좋음 · 🙂 보통 · 😕 별로) ---------------- */
  function buildFeel(el, onChange) {
    if (!el) return;
    el.innerHTML = FEEL_ORDER.map((n) => {
      const f = FEELS[n];
      return `<button type="button" class="feel-btn ${f.cls}" data-feel="${n}" aria-label="${f.label}">
        <span class="fb-icon">${f.icon}</span><span class="fb-label">${f.label}</span></button>`;
    }).join('');
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-feel]');
      if (!b) return;
      const n = clampRating(+b.dataset.feel);
      setFeel(el, n);
      onChange(n);
    });
  }
  function setFeel(el, n) {
    if (!el) return;
    const v = clampRating(n);
    el.setAttribute('data-val', String(v));
    $$('.feel-btn', el).forEach((b) => {
      b.classList.toggle('on', +b.dataset.feel === v);
      b.setAttribute('aria-pressed', +b.dataset.feel === v ? 'true' : 'false');
    });
  }
  function setFeelHint(sel, n) {
    const el = $(sel);
    if (!el) return;
    const v = clampRating(n);
    el.textContent = v === 3 ? '👍 좋음 — 이 책과 비슷한 책을 추천 서가에 담아 드려요.'
      : v === 2 ? '🙂 보통 — 평가가 쌓이면 취향 맞춤 추천이 더 정확해져요.'
      : v === 1 ? '😕 별로 — 다음엔 다른 분야 책을 보여 드릴게요.'
      : '이 책은 어땠나요? 하나만 골라 주세요.';
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
        ${!loans && !res && lib.connected ? '<p class="acc-body">지금 대출·예약 중인 책이 없어요.</p>' : ''}
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
    setFeel($('#aStars'), 0);
    setFeelHint('#aFeelHint', 0);
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
      status: 'done', stars: clampRating(state.aStars), review: ($('#aReview').value || '').trim(),
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
        normalizeRatings();
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
      const viewIds = ['shelf', 'rec', 'loans', 'owned'];
      viewIds.forEach((v) => {
        const el = $('#view-' + v);
        if (el) el.classList.toggle('is-active', state.view === v);
      });
      if (state.view === 'rec') observeCards();
      if (state.view === 'loans') renderLoans();
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

    // 취향 맞춤 보기
    const tasteBtn = $('#tasteFilterBtn');
    if (tasteBtn) tasteBtn.addEventListener('click', () => {
      state.filter.taste = !state.filter.taste;
      state.filter.q = '';
      const q = $('#searchInput');
      if (q) q.value = '';
      tasteBtn.classList.toggle('is-on', state.filter.taste);
      tasteBtn.setAttribute('aria-pressed', state.filter.taste ? 'true' : 'false');
      renderGrid();
      renderTaste();
      if (state.filter.taste) observeCards();
    });
    const goShelf = $('#goShelfBtn');
    if (goShelf) goShelf.addEventListener('click', () => { const t = $$('.tab')[0]; if (t) t.click(); });

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

    // 대출도서 탭
    const loanStatus = $('#loanStatus');
    if (loanStatus) loanStatus.addEventListener('change', (e) => { state.loan.status = e.target.value; renderLoans(); });
    const loanAcct = $('#loanAcct');
    if (loanAcct) loanAcct.addEventListener('change', (e) => { state.loan.acct = e.target.value; renderLoans(); });
    const loanSort = $('#loanSort');
    if (loanSort) loanSort.addEventListener('change', (e) => { state.loan.sort = e.target.value; renderLoans(); });
    const loanRefresh = $('#loanRefreshBtn');
    if (loanRefresh) loanRefresh.addEventListener('click', async () => {
      loanRefresh.classList.add('is-loading');
      await loadLoanData(true);
      loanRefresh.classList.remove('is-loading');
      toast('대출·예약 현황을 다시 불러왔어요');
    });

    // 그리드 / 오늘 목록 / 서재 클릭 위임
    document.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip-lib');
      if (chip && chip.dataset.chip) {
        e.stopPropagation();
        const book = bookByIsbn(chip.dataset.isbn);
        if (book) openModal(book);
        else {
          const poolRaw = poolByIsbn(chip.dataset.isbn);
          if (poolRaw) openModal(enrichedPoolBook(poolRaw));
        }
        return;
      }
      const openEl = e.target.closest('[data-open]');
      if (openEl) {
        const k = openEl.dataset.open;
        const book = bookByIsbn(k);
        if (book) { openModal(book); return; }
        const poolRaw = poolByIsbn(k);
        if (poolRaw) { openModal(enrichedPoolBook(poolRaw)); return; }
        const ownRaw = ownedByKey(k);
        if (ownRaw) { openModal(ownedBook(ownRaw)); return; }
        const loanRaw = loanByKey(k);
        if (loanRaw) { openModal(loanBook(loanRaw)); return; }
        return;
      }
      const actEl = e.target.closest('[data-act]');
      if (actEl) {
        e.stopPropagation();
        handleAction(actEl.dataset.act, actEl.dataset.isbn, actEl.dataset.val);
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
      const stars = clampRating(state.draftStars);
      upsertRecord(b, {
        status: 'done',
        stars,
        review,
        finishedAt: (recordOf(b.isbn) && recordOf(b.isbn).finishedAt) || ymd(new Date()),
      });
      closeModal();
      if (stars === 3) {
        const added = (state.similar.items || []).length;
        toast(added ? `👍 좋음! 이 책과 비슷한 ${added}권을 추천 서가에 담았어요` : '서재에 꽂았어요 📖');
      } else {
        toast('서재에 꽂았어요 📖');
      }
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
      state.draftStars = clampRating(rec.stars);
      setFeel($('#mStars'), state.draftStars);
      setFeelHint('#mFeelHint', state.draftStars);
      $('#mReview').focus();
      toast('평가·감상을 고친 뒤 [다 읽었어요!]를 눌러 주세요');
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
