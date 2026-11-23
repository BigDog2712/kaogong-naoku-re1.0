/* 考公脑库 · 间隔重复学习系统 - 前端 SPA (vanilla) */

/* ---------- 版本自愈 ----------
   旧版页面被浏览器 / CDN 边缘节点用 max-age=86400 强缓存，导致"改了代码但打开还是旧界面"。
   这里让脚本核对页面里的版本标记：不一致就一次性跳到带版本号的新地址，
   绕过浏览器与边缘节点的两层缓存。kg_healed 防止极端情况下死循环。 */
const APP_VER = '20261123a';
let HEALING = false;
(function selfHeal() {
  try {
    const meta = document.querySelector('meta[name="kg-app-ver"]');
    if ((meta && meta.getAttribute('content')) === APP_VER) return;
    if (sessionStorage.getItem('kg_healed') === APP_VER) return;
    sessionStorage.setItem('kg_healed', APP_VER);
    HEALING = true;
    location.replace('/index.html?v=' + APP_VER + (location.hash || ''));
  } catch (e) { }
})();

/* 注册 Service Worker：让页面导航与 js/css 一律重新校验网络，
   彻底摆脱本机 HTTP 缓存里的旧版本（仅 https 下生效，失败不影响正常使用）。 */
(function regSW() {
  try {
    if (!('serviceWorker' in navigator) || location.protocol !== 'https:') return;
    navigator.serviceWorker.register('/sw.js').catch(() => { });
  } catch (e) { }
})();

/* ---------- 账号：用户名 + 密码登录，token 鉴权（服务端按账号隔离数据） ---------- */
let TOKEN = '';
let ME = null;   // 当前登录账号 {id,name,username}
try { TOKEN = localStorage.getItem('kg_token') || ''; } catch (e) { }
function tok() { return TOKEN || ''; }
function setTok(t) {
  TOKEN = t || '';
  try { if (t) localStorage.setItem('kg_token', t); else localStorage.removeItem('kg_token'); } catch (e) { }
}
function withU(p) { return p + (p.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(tok()); }

/* 统一的失败语义：接口不通就抛异常，交给 nav() 的 catch 显示"重试"。
   以前这里返回 {}，调用方直接取字段就抛 TypeError，而异常没人接，
   页面永远停在"加载中…"——这正是线上偶发空白的真实原因。 */
class ApiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}
async function API(p) {
  let r;
  try { r = await fetch(withU(p)); }
  catch (e) { throw new ApiError('网络连接失败，请检查网络后重试', 0); }
  if (r.status === 401) { onExpired(); throw new ApiError('登录已失效', 401); }
  if (!r.ok) throw new ApiError('服务器返回 ' + r.status + '，请稍后重试', r.status);
  try { return await r.json(); }
  catch (e) { throw new ApiError('服务器返回数据异常，请重试', r.status); }
}
async function POST(p, b) {
  let r;
  try {
    r = await fetch(p, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, b, { token: tok() })),
    });
  } catch (e) { throw new ApiError('网络连接失败，请检查网络后重试', 0); }
  if (r.status === 401) { onExpired(); throw new ApiError('登录已失效', 401); }
  if (!r.ok) throw new ApiError('服务器返回 ' + r.status + '，请稍后重试', r.status);
  try { return await r.json(); }
  catch (e) { throw new ApiError('服务器返回数据异常，请重试', r.status); }
}
function onExpired() { setTok(''); showLogin('登录已失效，请重新登录'); }
const esc = (s) => (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const app = document.getElementById('app');
let BOOT = null;

const state = { session: null, exam: null, ink: Object.create(null), inkRef: null, ul: Object.create(null), gradeCtx: null };

/* ---------- 功能2：限时模式配置 ---------- */
const LIMIT_DEFAULT = {
  '言语理解与表达': 45, '判断推理': 40, '数量关系': 90,
  '资料分析': 60, '常识判断': 30, '政治理论': 45,
};
function loadLimits() {
  try { return Object.assign({}, LIMIT_DEFAULT, JSON.parse(localStorage.getItem('kg_limits') || '{}')); }
  catch (e) { return Object.assign({}, LIMIT_DEFAULT); }
}
function saveLimits(o) { try { localStorage.setItem('kg_limits', JSON.stringify(o)); } catch (e) { } cloudSchedule(); }
let LIMIT_ON = false;
try { LIMIT_ON = localStorage.getItem('kg_limit_on') === '1'; } catch (e) { }

/* ---------- 每次做题数（与「每日目标」分开设置） ---------- */
const SESSION_SIZE_KEY = 'kg_session_size';
const SESSION_SIZE_DEFAULT = 15;      // 每组题量默认 15 题
const GOAL_DEFAULT = 120;             // 每日目标默认 120 题
function clampSessionSize(v) { return Math.max(1, Math.min(200, Math.round(+v || SESSION_SIZE_DEFAULT))); }
function loadSessionSize() {
  try { const v = +localStorage.getItem(SESSION_SIZE_KEY); return clampSessionSize(v || SESSION_SIZE_DEFAULT); }
  catch (e) { return SESSION_SIZE_DEFAULT; }
}
function saveSessionSize(v) {
  const n = clampSessionSize(v);
  try { localStorage.setItem(SESSION_SIZE_KEY, String(n)); } catch (e) { }
  cloudSchedule(); return n;
}

/* ---------- 答题区宽度（PC 可调：窄 / 标准 / 宽 / 满屏） ---------- */
const READW_KEY = 'kg_readw';
const READW_ORDER = ['narrow', 'normal', 'wide', 'full'];
const READW_LABEL = { narrow: '窄', normal: '标准', wide: '宽', full: '满屏' };
function getReadW() {
  try { const v = localStorage.getItem(READW_KEY); return READW_ORDER.indexOf(v) >= 0 ? v : 'normal'; }
  catch (e) { return 'normal'; }
}
function setReadW(v) {
  const w = READW_ORDER.indexOf(v) >= 0 ? v : 'normal';
  try { localStorage.setItem(READW_KEY, w); } catch (e) { }
  document.documentElement.setAttribute('data-readw', w);
  cloudSchedule();
  return w;
}

/* ---------- PC 端右键快捷画笔（右键切画笔 / 双击切橡皮 / 滚轮调粗细） ---------- */
const RMOUSE_KEY = 'kg_rmouse';
const RMOUSE_DEFAULT = true;
function getRmouse() {
  try { const v = localStorage.getItem(RMOUSE_KEY); return v === null ? RMOUSE_DEFAULT : v === '1'; }
  catch (e) { return RMOUSE_DEFAULT; }
}
function setRmouse(on) {
  try { localStorage.setItem(RMOUSE_KEY, on ? '1' : '0'); } catch (e) { }
  cloudSchedule();
  return !!on;
}
/* 设置页控件回显（云端恢复后也要跟着变） */
function syncRmouseBtn() {
  const b = document.getElementById('st-rmouse'); if (!b) return;
  const on = getRmouse();
  b.textContent = on ? '已开启 · 点击关闭' : '已关闭 · 点击开启';
  b.className = 'btn ' + (on ? 'ok' : 'ghost');
  const tip = document.getElementById('st-rmouse-tip');
  if (tip) tip.textContent = on ? '右键手势已启用：右键切画笔、双击切橡皮、滚轮调粗细' : '右键为浏览器默认菜单，不启用手势';
}
function syncReadWSeg() {
  document.querySelectorAll('#st-readw .seg-btn').forEach(b => {
    const on = b.dataset.w === getReadW();
    b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
  });
}

/* ---------- 功能4：搜索历史（最近 5 条） ---------- */
function loadSearchHist() {
  try { const a = JSON.parse(localStorage.getItem('kg_search_hist') || '[]'); return Array.isArray(a) ? a.slice(0, 5) : []; }
  catch (e) { return []; }
}
function pushSearchHist(kw) {
  try {
    const a = loadSearchHist().filter(x => x !== kw); a.unshift(kw);
    localStorage.setItem('kg_search_hist', JSON.stringify(a.slice(0, 5)));
  } catch (e) { }
}

/* ---------- 功能5：下载 Markdown ---------- */
function downloadMd(filename, text) {
  const blob = new Blob([text || ''], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

const MODE_LABEL = { new: '新题', mix: '智能复习', review: '复习', wrong: '错题重练', wrongredo: '错题重练', fav: '收藏练习', material: '材料组题' };
/* 记忆曲线四档：值对应 SM2 评分（1 again / 3 hard / 4 good / 5 easy），顺序对应键盘 1/2/3/4 */
const GRADE_DEF = [{ v: 1, n: '忘记' }, { v: 3, n: '困难' }, { v: 4, n: '一般' }, { v: 5, n: '熟悉' }];
const GRADE_BY_KEY = { '1': 1, '2': 3, '3': 4, '4': 5 };

/* ---------- 练习 session 本地快照（继续上次刷题） ---------- */
const SS_KEY = 'kg_session_v1';
/* 答题模式：instant = 边答边对（选完立即显示答案与解析）；deferred = 先答后对（整组做完统一判分出报告） */
const ANSWER_MODE_KEY = 'kg_answer_mode';
function getAnswerMode() { try { return localStorage.getItem(ANSWER_MODE_KEY) === 'deferred' ? 'deferred' : 'instant'; } catch (e) { return 'instant'; } }
function setAnswerMode(m) {
  const mode = m === 'deferred' ? 'deferred' : 'instant';
  try { localStorage.setItem(ANSWER_MODE_KEY, mode); } catch (e) { }
  cloudSchedule();
  prefsPushNow().catch(e => console.warn('答题模式偏好同步失败：', e));
}
function isDeferred(S) { return !!(S && S.answerMode === 'deferred' && !isRev(S)); }
/* 复习态：mode=review，或通过「再复习今天做过的题」等入口进入的 ids 组 —— 无选项作答、自评驱动 */
function isRev(S) { return !!S && (S.mode === 'review' || !!S.revMode); }
const ANSWER_MODE_TIP = {
  instant: '边答边对：选完选项立即显示对错与解析，再按记忆强度自评。',
  deferred: '先答后对：作答时不提示对错，整组做完交卷后给出正确率报告，可查看错题解析或全部解析。',
};
function saveSession() {
  try {
    const S = state.session; if (!S || !S.queue || !S.queue.length || S.submitted) return;
    localStorage.setItem(SS_KEY, JSON.stringify({
      mode: S.mode, cfg: S.cfg, queue: S.queue, idx: S.idx,
      tally: S.tally, marked: Array.from(S.marked || []),
      answerMode: S.answerMode, answers: S.answers || {}, spent: S.spent || {},
      gid: S.gid || '',
      kind: 'study', savedAt: Date.now(), cAcc: allElapsed(S), qAcc: qElapsed(S), qQid: S.qQid || null,
      qTimes: S.qTimes || {},
    }));
  } catch (e) { /* localStorage 不可用（隐私模式等）时静默降级 */ }
}
function loadSession() {
  try {
    const s = localStorage.getItem(SS_KEY); if (!s) return null;
    const o = JSON.parse(s);
    if (!o || o.kind !== 'study' || !o.queue || !o.queue.length) return null;
    if (o.idx >= o.queue.length) return null; // 已全部做完
    return o;
  } catch (e) { return null; }
}
function loadSeen() {
  try { const a = JSON.parse(localStorage.getItem('kg_seen') || '[]'); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function addSeen(qids) {
  try {
    const s = new Set(loadSeen());
    qids.forEach(q => s.add(String(q)));
    localStorage.setItem('kg_seen', JSON.stringify(Array.from(s).slice(-800))); // 仅保留近期 800 个
    cloudSchedule();
  } catch (e) { /* 隐私模式降级 */ }
}

function clearSession() { try { localStorage.removeItem(SS_KEY); } catch (e) { } }
function resumeSession() {
  const o = loadSession();
  if (!o) { clearSession(); return; }
  // 修复「继续上次刷题」按了没反应：恢复路径必须补齐 session 全部字段，
  // 否则 renderCard 里 S.marked.has() / S.times.push() 抛 TypeError，页面停在原地。
  state.session = {
    mode: o.mode, cfg: o.cfg || {}, queue: o.queue, idx: o.idx,
    phase: 'question', chosen: null, full: null,
    tally: o.tally || { done: 0, right: 0, wrong: 0 },
    marked: new Set(o.marked || []),
    limitOn: !!(o.cfg && o.cfg.limitOn),
    limits: (o.cfg && o.cfg.limits) || loadLimits(),
    ids: (o.cfg && o.cfg.ids) || null,
    cAcc: +o.cAcc || 0, cRun: 0, qAcc: +o.qAcc || 0, qRun: 0, qQid: o.qQid || null, qTimes: o.qTimes || {}, times: [], timeoutN: 0,
    answerMode: o.answerMode === 'deferred' ? 'deferred' : 'instant',
    answers: o.answers || {}, spent: o.spent || {}, fulls: {}, submitted: false,
    gid: o.gid || '',
  };
  try {
    loadInkStore();                 // 同一标签页刷新后，本次答题已画的笔迹接回来
    loadUlStore();                  // 划线一起接回来
    renderCard();
    ensureGid(state.session);        // 老快照没有组号：补建一组，回溯才接得上
  } catch (e) {
    // 快照损坏 / 结构不兼容：清理后回总览，保证按钮永远不会「没反应」
    console.error('恢复练习失败，已清理本地快照', e);
    state.session = null;
    clearSession();
    try { viewDashboard(); } catch (e2) { location.hash = '#/'; }
  }
}
function resumeAgo(ts) {
  if (!ts) return '—';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return '刚刚';
  if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
  if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- router ---------- */
/* 任何视图抛错都不能让页面停在"加载中…"：统一兜住并给重试入口。 */
async function nav() {
  try {
    return await route();
  } catch (e) {
    if (e && e.status === 401) return;          // 已跳登录，无需重复提示
    console.error('[nav]', e);
    fatal((e && e.message) || e);
  }
}
function route() {
  if (state.tpoll) { clearInterval(state.tpoll); state.tpoll = null; }   // 离开陪伴者页：停掉轮询
  let h = (location.hash || '#/').split('?')[0];
  // 旧「老师/陪伴者」链接兼容：统一跳到新的陪伴者模块
  if (h === '#/teacher') { location.hash = '#/coach'; return; }
  if (h === '#/teacher/student') { location.hash = '#/coach/peer' + (location.hash.split('?')[1] ? '?' + location.hash.split('?')[1] : ''); return; }
  if (h === '#/teacher/encourage') { location.hash = '#/coach/encourage'; return; }
  stSync();              // 学习时长：离开学习页立刻停表并把零头落库
  pauseClock();          // 离开练习页：结算并暂停计时，回来时从暂停处继续
  captureInk();          // 离开练习页：本题笔迹留在本次答题里，回来还能看到
  try { flushReportGrades(); } catch (e) { }   // 离开报告：没自评的题按默认强度补写
  state.gradeCtx = null;
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href').split('?')[0] === h));
  if (h === '#/coach') return viewCoach();
  if (h === '#/coach/peer') return viewTeacherStudent(new URLSearchParams(location.hash.split('?')[1] || '').get('uid'));
  if (h === '#/coach/encourage') return viewTeacherEncourage();
  if (h === '#/') return viewDashboard();
  if (h === '#/study') return viewStudy();
  if (h === '#/review') return startSession({ mode: 'review' });
  if (h === '#/browse') return viewBrowse();
  if (h === '#/kadian') return viewKadian();
  if (h === '#/wrongbook') return viewWrongbook();
  if (h === '#/favorites') return viewFavorites();
  if (h === '#/exam') return viewExam();
  if (h === '#/materials') return viewMaterials();
  if (h === '#/doubts') return viewDoubts();
  if (h === '#/stats') return viewStats();
  if (h === '#/today') return viewToday();
  if (h === '#/settings') return viewSettings();
  if (h === '#/detail') {
    const qd = new URLSearchParams(location.hash.split('?')[1] || '');
    return viewDetail(+qd.get('id'), qd.get('from') || '');
  }
  viewDashboard();
}
window.addEventListener('hashchange', () => { nav(); });

/* ---------- side stats ---------- */
async function refreshSide() {
  try {
    const s = await API('/api/stats');
    document.getElementById('side-stats').innerHTML = `
      <div class="stat-chip"><span>待复习</span><b style="color:var(--warn)">${s.due_review}</b></div>
      <div class="stat-chip"><span>未学新题</span><b style="color:var(--brand)">${s.new}</b></div>
      <div class="stat-chip"><span>已学</span><b>${s.learned}</b></div>
      <div class="stat-chip"><span>今日已练</span><b style="color:var(--ok)">${s.studied_today}</b></div>
      <div class="stat-chip"><span>错题本</span><b style="color:var(--bad)">${s.wrong}</b></div>
      <div class="stat-chip"><span>收藏</span><b style="color:var(--purple)">${s.fav}</b></div>`;
    return s;
  } catch (e) { return null; }
}

function loading(t = '加载中…') { app.innerHTML = `<div class="loading">${t}</div>`; }
function fatal(e) { app.innerHTML = `<div class="card" style="border-color:var(--bad)">出错了：${esc(String(e))}
  <div class="row" style="margin-top:14px"><button class="btn ghost" onclick="location.reload()">重试</button></div></div>`; }

/* ---------- dashboard ---------- */
async function viewDashboard() {
  loading();
  await stSettle();                 // 先把未上报的学习时长落库，卡片数字才是当下的
  const [s, planD] = await Promise.all([API('/api/stats'), API('/api/review/plan').catch(() => null)]);
  const enc = await API('/api/encourage').catch(() => ({ items: [] }));   // 陪伴者寄语：取不到不影响总览
  await refreshSide();
  const resumeBtn = (() => {
    try {
      const o = loadSession();
      if (!o || o.idx >= o.queue.length) return '';
      const left = o.queue.length - o.idx;
      const label = MODE_LABEL[o.mode] || '练习';
      const t = resumeAgo(o.savedAt);
      return `<a class="btn big resume" href="#" onclick="try{resumeSession()}catch(e){console.error(e)};return false;">⏯ 继续上次刷题（${label} · 剩 ${left} 题）· 上次 ${t}</a>`;
    } catch (e) { return ''; }
  })();
  const dueMod = {}; (s.due_by_module || []).forEach(d => dueMod[d.m] = d.n);
  const mastery = s.mastery || {}; const mkeys = ['学习中', '初记', '短期', '长期', '稳固'];
  const maxM = Math.max(1, ...mkeys.map(k => mastery[k] || 0));
  // 复习计划：未来逐日到期题数（服务端按 srs.due 统计）
  const PLAN_PACE = { tight: '紧凑 ×0.7', std: '标准 ×1.0', loose: '舒缓 ×1.6' };
  let planCard = '';
  if (planD) {
    const plan = planD.plan || {};
    const fmtLocal = ts => { const x = new Date(ts); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
    const d14 = [...Array(14)].map((_, i) => fmtLocal(Date.now() + i * 86400000));
    const d30 = [...Array(30)].map((_, i) => fmtLocal(Date.now() + i * 86400000));
    const sum = arr => arr.reduce((a, k) => a + (plan[k] || 0), 0);
    const total = Object.values(plan).reduce((a, b) => a + b, 0);
    const wk = sum(d14.slice(1, 8)), mo = sum(d30.slice(1, 31));
    const rest = Math.max(0, total - mo);
    const maxN = Math.max(1, ...d30.map(k => plan[k] || 0));
    const dayLabel = k => { const p = k.split('-'); return +p[1] + '/' + +p[2]; };
    planCard = `
  <h2>📅 复习计划（按记忆曲线排期）</h2>
  <div class="card">
    <div class="row plan-chips">
      <span class="tag learning">今天 ${planD.today} 题</span>
      <span class="tag">明天 ${plan[d14[1]] || 0} 题</span>
      <span class="tag">后天 ${plan[d14[2]] || 0} 题</span>
      <span class="tag">7 天内合计 ${wk} 题</span>
      <span class="tag">30 天内合计 ${mo} 题</span>
      ${rest ? `<span class="tag">30 天后还有 ${rest} 题</span>` : ''}
    </div>
    <p class="sub" style="margin:0 0 8px">每日预计复习量（未来 30 天逐日分开，悬停看具体日期）</p>
    <div class="plan-bars">
      ${d30.map((k, i) => {
      const n = plan[k] || 0;
      const h = n ? Math.max(i === 0 ? 8 : 12, Math.round(n / maxN * 76)) : 3;
      return `<div class="plan-col" title="${k}：${n} 题"><b>${n || ''}</b><i style="height:${h}%" class="${i === 0 ? 'today' : ''}"></i><span>${i === 0 ? '今' : i === 1 ? '明' : i === 2 ? '后' : dayLabel(k)}</span></div>`;
    }).join('')}
    </div>
    <p class="sub" style="margin:10px 0 0">复习节奏：${PLAN_PACE[planD.pacing] || '标准 ×1.0'} · 可在「设置 → 复习节奏」调整；掌握越牢间隔拉得越长</p>
  </div>`;
  }
  app.innerHTML = `
  <h1>总览面板</h1><p class="sub">共 ${BOOT.total.toLocaleString()} 道行测真题 · 逐题深度标注 · 按记忆曲线安排复习</p>
  ${encHtml(enc.items)}
  <div class="grid g4">
    <div class="card kpi warn"><div class="n">${s.due_review}</div><div class="l">🔔 今日待复习</div></div>
    <div class="card kpi brand"><div class="n">${s.new.toLocaleString()}</div><div class="l">✨ 未学新题</div></div>
    <a class="card kpi ok kpi-link" href="#/today" title="点开按组回看今天练过的每一道题，含先答后对交卷时的选择"><div class="n">${s.studied_today}</div><div class="l">✅ 今日已练习</div><div class="kpi-more">按组回溯 →</div></a>
    <div class="card kpi purple"><div class="n">${s.learned.toLocaleString()}</div><div class="l">📈 已纳入复习</div></div>
  </div>
  <div class="grid g4" style="margin-top:16px">
    <a class="card kpi" href="#/wrongbook" style="text-decoration:none"><div class="n" style="color:var(--bad)">${s.wrong}</div><div class="l">📕 错题本</div></a>
    <a class="card kpi" href="#/favorites" style="text-decoration:none"><div class="n" style="color:var(--purple)">${s.fav}</div><div class="l">⭐ 我的收藏</div></a>
    <div class="card kpi brand time" title="今日学习时长（答题 + 看解析）：${durText(s.today_ms)}"><div class="n">${durHtml(s.today_ms)}</div><div class="l">⏱️ 今日学习时长</div></div>
    <a class="card kpi purple time" href="#/stats" style="text-decoration:none" title="累计学习时长（答题 + 看解析）：${durText(s.total_ms)}"><div class="n">${durHtml(s.total_ms)}</div><div class="l">⏳ 总学习时长</div></a>
  </div>
  <div class="center" style="padding:24px">
    ${resumeBtn}
    <div class="row">
      <a class="btn big ok" href="#/review">开始复习到期 (${s.due_review})</a>
      <a class="btn big" href="#/study">练习新题</a>
      <a class="btn big ghost" href="#/browse">浏览真题库</a>
      <a class="btn big ghost" href="#/kadian">考点导航</a>
      <a class="btn big ghost" href="#/materials">材料组题</a>
      <a class="btn big ghost" href="#/doubts">疑点复核</a>
    </div>
  </div>
  <h2>各模块进度</h2>
  <div class="grid g2">
    ${s.by_module.map(m => {
      const pct = Math.round(m.learned / m.total * 100);
      return `<div class="card"><div class="row" style="justify-content:space-between">
        <b>${esc(m.m)}</b><span class="tag">已学 ${m.learned}/${m.total} (${pct}%)</span></div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="sub" style="margin:8px 0 0">今日待复习：${dueMod[m.m] || 0}</div>
        <div class="row" style="margin-top:12px">
          <a class="btn ghost" href="#/study?module=${encodeURIComponent(m.m)}">练习该模块</a></div>
      </div>`;
    }).join('')}
  </div>
  ${planCard}
  <h2>掌握度分布（按复习间隔）</h2>
  <div class="card">
    ${mkeys.map(k => `<div class="row" style="justify-content:space-between;margin:6px 0">
      <span>${k}</span><span><b>${(mastery[k] || 0).toLocaleString()}</b>
      <span style="display:inline-block;vertical-align:middle;width:180px;height:8px;background:var(--panel2);border-radius:9px;margin-left:10px">
      <span style="display:block;height:100%;width:${(mastery[k] || 0) / maxM * 100}%;background:linear-gradient(90deg,var(--brand),var(--purple));border-radius:9px"></span></span></span>
    </div>`).join('')}
  </div>
  <div class="footer">SM-2 间隔重复 · 忘记/困难/一般/熟悉 四档自评 · 图片全程离线</div>`;
}

/* ---------- study setup ---------- */
function viewStudy() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const msel = q.get('module') || '';
  const csel = q.get('category') || '';
  const ksel = q.get('kadian') || '';
  const moduleLabel = msel ? (BOOT.modules.find(m=>m.module===msel)?.module || msel) : '全部';
  const categoryLabel = csel || '全部大类';
  app.innerHTML = `
  <h1>练习新题</h1><p class="sub">选择范围后开始，系统按记忆曲线自动排入复习计划</p>
  ${ksel ? `<div class="askmodel" style="margin-bottom:14px">🎯 锁定考点：<b>${esc(ksel.split('/').pop())}</b> · <a class="linkback" href="#/study">清除筛选</a></div>` : ''}
  <div class="card" style="max-width:640px">
    <div class="filters">
      <div class="fld">模块<div class="study-picker" id="module-picker">
        <button class="study-picker-trigger" type="button" aria-expanded="false">${esc(moduleLabel)} <span>▾</span></button>
        <div class="study-picker-menu" role="listbox"><button type="button" class="study-picker-option ${!msel?'selected':''}" data-value="">全部</button>${BOOT.modules.map(m=>`<button type="button" class="study-picker-option ${m.module===msel?'selected':''}" data-value="${esc(m.module)}">${esc(m.module)} (${m.n})</button>`).join('')}</div>
      </div></div>
      <div class="fld">大类<div class="study-picker" id="category-picker">
        <button class="study-picker-trigger" type="button" aria-expanded="false">${esc(categoryLabel)} <span>▾</span></button>
        <div class="study-picker-menu" role="listbox"></div>
      </div></div>
      <label class="fld">考点关键字<input id="s-kd" placeholder="如 增长率 / 图形推理" size="18" value="${esc(ksel)}"></label>
    </div>
    <div class="fld" style="margin-bottom:14px">答题模式
      <div class="seg" id="s-amode" role="radiogroup" aria-label="答题模式">
        <button type="button" class="seg-btn ${getAnswerMode() === 'instant' ? 'on' : ''}" data-m="instant" role="radio" aria-checked="${getAnswerMode() === 'instant'}">边答边对</button>
        <button type="button" class="seg-btn ${getAnswerMode() === 'deferred' ? 'on' : ''}" data-m="deferred" role="radio" aria-checked="${getAnswerMode() === 'deferred'}">先答后对</button>
      </div>
      <span class="sub" id="s-amode-tip" style="margin:4px 0 0">${ANSWER_MODE_TIP[getAnswerMode()]}</span>
    </div>
    <div class="fld" style="margin-bottom:14px">本次做题数
      <div class="row" style="align-items:center;gap:10px">
        <input id="s-size" type="number" min="1" max="200" value="${loadSessionSize()}" style="width:110px">
        <span class="sub" style="margin:0">题 · 每组抽题数量，与「每日目标」分开设置</span>
      </div>
    </div>
    <div class="row"><button class="btn big ok" id="s-go">开始练习 →</button></div>
    <p class="sub" style="margin:14px 0 0">答错/忘记的题目会按记忆曲线更频繁地回来。答题模式也可在「设置」中修改，复习到期模式始终为回忆自评。</p>
  </div>
  <div class="card" style="max-width:640px;margin-top:16px">
    <h2 style="margin-top:0">⏱ 单题限时训练（可选）</h2>
    <div class="row" style="justify-content:space-between;margin-bottom:10px">
      <span>开启后每题倒计时，超时自动记为「超时答错」并进入错题本</span>
      <label class="switch"><input type="checkbox" id="s-limit" ${LIMIT_ON ? 'checked' : ''}><span class="slider"></span></label>
    </div>
    <div id="s-limit-box" style="${LIMIT_ON ? '' : 'display:none'}">
      <div class="grid g3">
        ${Object.entries(loadLimits()).map(([m, sec]) => `<label class="fld">${esc(m)}<input type="number" min="5" max="600" value="${sec}" data-mod="${esc(m)}" class="s-lim"></label>`).join('')}
      </div>
      <p class="sub" style="margin:10px 0 0">单位：秒。建议：言语45 / 判断40 / 数量90 / 资料60 / 常识30。</p>
    </div>
  </div>`;
  let selectedModule = msel, selectedCategory = csel;
  const renderCategoryPicker = () => {
    const picker=document.getElementById('category-picker');
    const menu=picker.querySelector('.study-picker-menu');
    const options=catsFor(selectedModule);
    menu.innerHTML='<button type="button" class="study-picker-option '+(!selectedCategory?'selected':'')+'" data-value="">全部大类</button>'+options.map(x=>`<button type="button" class="study-picker-option ${x.category===selectedCategory?'selected':''}" data-value="${esc(x.category)}">${esc(x.category)} (${x.n})</button>`).join('');
    picker.querySelector('.study-picker-trigger').innerHTML=`${esc(selectedCategory||'全部大类')} <span>▾</span>`;
    menu.querySelectorAll('.study-picker-option').forEach(b=>b.onclick=()=>{selectedCategory=b.dataset.value;renderCategoryPicker();picker.classList.remove('open');picker.querySelector('.study-picker-trigger').setAttribute('aria-expanded','false');});
  };
  const catsFor = module => BOOT.categories.filter(x=>!module||x.module===module);
  const modulePicker=document.getElementById('module-picker');
  modulePicker.querySelectorAll('.study-picker-option').forEach(b=>b.onclick=()=>{
    selectedModule=b.dataset.value;selectedCategory='';
    modulePicker.querySelector('.study-picker-trigger').innerHTML=`${esc(selectedModule||'全部')} <span>▾</span>`;
    modulePicker.classList.remove('open');modulePicker.querySelector('.study-picker-trigger').setAttribute('aria-expanded','false');
    renderCategoryPicker();
  });
  renderCategoryPicker();
  document.querySelectorAll('.study-picker').forEach(picker=>{
    const trigger=picker.querySelector('.study-picker-trigger');
    trigger.onclick=()=>{const open=!picker.classList.contains('open');document.querySelectorAll('.study-picker.open').forEach(x=>{x.classList.remove('open');x.querySelector('.study-picker-trigger').setAttribute('aria-expanded','false');});picker.classList.toggle('open',open);trigger.setAttribute('aria-expanded',String(open));};
  });
  document.querySelectorAll('.study-picker-trigger').forEach(btn=>btn.onkeydown=e=>{if(e.key==='Escape'){const p=btn.closest('.study-picker');p.classList.remove('open');btn.setAttribute('aria-expanded','false');btn.focus();}});
  if (!window.__kgPickerOutside) {
    window.__kgPickerOutside = true;
    document.addEventListener('click', e => {
      if (e.target.closest('.study-picker')) return;
      document.querySelectorAll('.study-picker.open').forEach(x => { x.classList.remove('open'); x.querySelector('.study-picker-trigger').setAttribute('aria-expanded','false'); });
    });
  }
  document.querySelectorAll('#s-amode .seg-btn').forEach(b => b.onclick = () => {
    setAnswerMode(b.dataset.m);
    document.querySelectorAll('#s-amode .seg-btn').forEach(x => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
    const tip = document.getElementById('s-amode-tip'); if (tip) tip.textContent = ANSWER_MODE_TIP[getAnswerMode()];
  });
  const sLimit = document.getElementById('s-limit');
  if (sLimit) sLimit.onchange = () => {
    const box = document.getElementById('s-limit-box');
    if (box) box.style.display = sLimit.checked ? '' : 'none';
  };
  document.getElementById('s-go').onclick = () => {
    const on = sLimit ? sLimit.checked : false;
    const limits = {};
    document.querySelectorAll('.s-lim').forEach(i => { limits[i.dataset.mod] = Math.max(5, +i.value || 30); });
    saveLimits(limits); LIMIT_ON = on;
    try { localStorage.setItem('kg_limit_on', on ? '1' : '0'); } catch (e) { }
    const sizeEl = document.getElementById('s-size');
    const size = saveSessionSize(sizeEl ? sizeEl.value : loadSessionSize());
    if (sizeEl) sizeEl.value = size;
    startSession({
      mode: 'mix', module: selectedModule, category: selectedCategory,
      kadian: document.getElementById('s-kd').value.trim(),
      limitOn: on, limits, answerMode: getAnswerMode(), size,
    });
  };
}

/* ---------- 今日回溯：一组 = 一次 startSession ----------
   建组只写「组 + 题目骨架」，作答状态在每题对答案时补写。
   先答后对的选择一直是本地暂存，直到交卷判分才写入，所以回溯里存的正是「对答案那一刻」的状态。 */
function practiceScope(cfg) {
  cfg = cfg || {};
  const parts = [];
  if (cfg.kadian) parts.push(String(cfg.kadian).split('/').pop());
  else {
    if (cfg.module) parts.push(cfg.module);
    if (cfg.category) parts.push(cfg.category);
  }
  if (cfg.ref) parts.push('材料组题');
  return parts.join(' / ') || '全部模块';
}
function ensureGid(S) {
  if (!S) return Promise.resolve('');
  if (S.gid) return Promise.resolve(S.gid);
  if (S.gidPending) return S.gidPending;
  S.gidPending = (async () => {
    try {
      const r = await POST('/api/practice/start', {
        mode: S.mode,
        answer_mode: isDeferred(S) ? 'deferred' : 'instant',
        title: (S.cfg && S.cfg.title) || PRACTICE_TITLE[S.mode] || MODE_LABEL[S.mode] || '练习',
        scope: practiceScope(S.cfg),
        qids: (S.queue || []).map(c => c.qid).filter(Boolean),
      });
      if (r && r.gid) { S.gid = r.gid; try { saveSession(); } catch (e) { } }
      return S.gid || '';
    } catch (e) {
      S.gidPending = null;          // 网络问题：下次对答案时再试
      return '';
    }
  })();
  return S.gidPending;
}
function markPractice(S, items, opt) {
  if (!S || !items || !items.length) return Promise.resolve();
  return ensureGid(S).then(gid => {
    if (!gid) return;
    return POST('/api/practice/mark', Object.assign({ gid, items }, opt || {}));
  }).catch(() => { });
}
function endPractice(S) {
  if (!S || !S.gid) return Promise.resolve();
  return POST('/api/practice/end', { gid: S.gid, total_ms: Math.round(allElapsed(S) || 0) }).catch(() => { });
}

/* ---------- session ---------- */
// 仅这些模式需要「别抽刚做过的题」；其余（错题重练/复习到期/收藏/材料）必须允许重复
const EXCL_MODES = new Set(['new', 'study', 'mix']);
// 空池兜底：今天已经复习/做错过的题，愿意的话可以立刻再过一遍（不做就等记忆曲线）
const TODAY_REDO = {
  review: ['today_review', '↻ 再复习今天做过的题'],
  wrong: ['today_wrong', '↻ 再练今天答错的题'],
  wrongredo: ['today_wrong', '↻ 再练今天答错的题'],
};
async function startSession(cfg) {
  loading('拉取题目…');
  const p = new URLSearchParams();
  p.set('mode', cfg.mode); p.set('size', String(cfg.size || loadSessionSize()));
  // 「已做过的题」这个缓存只用来避免新题重复；错题重练 / 复习到期 / 收藏练习本来就是「再做一遍」，
  // 带上它会把刚练过的题全部排除掉，表现为「今天做过的错题/复习一题都抽不到」。
  if (EXCL_MODES.has(cfg.mode)) p.set('exclude', loadSeen().join(','));
  if (cfg.module) p.set('module', cfg.module);
  if (cfg.category) p.set('category', cfg.category);
  if (cfg.kadian) p.set('kadian', cfg.kadian);
  if (cfg.year) p.set('year', cfg.year);
  if (cfg.ref) p.set('ref', cfg.ref);
  if (cfg.ids && cfg.ids.length) p.set('ids', cfg.ids.join(','));
  let res;
  try { res = await API('/api/next?' + p); } catch (e) { return fatal(e); }
  if (!res.cards.length) {
    const emptyMsg = {
      review: ['没有到期需要复习的题目', '今天做过的题已经按记忆曲线排到后面了。想现在再过一遍，点下面的按钮。'],
      wrong: ['错题本里没有待重练的题', '答错或自评「忘记/困难」的题会回到待重练；也可以把今天答错的再练一遍。'],
      wrongredo: ['错题本里没有待重练的题', '答错或自评「忘记/困难」的题会回到待重练；都掌握了的题不再重复。'],
      fav: ['还没有收藏任何题目', '练习时在答案页点「⭐ 收藏」即可加入。'],
      material: ['这组材料没有更多题目了', '回到材料组题页选别的材料。'],
    }[cfg.mode] || ['这个范围的题都学过啦', '换个模块/大类试试。'];
    app.innerHTML = `<div class="empty"><div class="big">🎉</div>
      <h2>${emptyMsg[0]}</h2><p>${emptyMsg[1]}</p>
      <div class="row">
        ${TODAY_REDO[cfg.mode] ? `<button class="btn ok" id="redo-today" data-kind="${TODAY_REDO[cfg.mode][0]}">${TODAY_REDO[cfg.mode][1]}</button>` : ''}
        <a class="btn ${TODAY_REDO[cfg.mode] ? 'ghost' : ''}" href="#/study">练习新题</a>
        <a class="btn ghost" href="#/">返回总览</a>
      </div>
      <p class="sub" id="redo-today-tip" style="margin:14px 0 0"></p></div>`;
    const rt = document.getElementById('redo-today');
    if (rt) rt.onclick = async () => {
      rt.disabled = true;
      try {
        const sq = await API('/api/idseq?only=' + rt.dataset.kind);
        const ids = sq.ids || [];
        if (!ids.length) { document.getElementById('redo-today-tip').textContent = '今天还没有这类记录。'; rt.disabled = false; return; }
        startSession({ mode: 'ids', ids, size: ids.length, revMode: rt.dataset.kind === 'today_review', title: rt.dataset.kind === 'today_review' ? '再复习今天做过的题' : '再练今天答错的题' });
      } catch (e) { rt.disabled = false; alert('加载失败：' + (e.message || e)); }
    };
    return;
  }
  clearInkStore();                    // 新开一组：上一组的笔迹到此为止
  clearUlStore();                     // 划线同理
  state.session = {
    mode: cfg.mode, cfg, queue: res.cards, idx: 0,
    revMode: !!cfg.revMode,
    phase: 'question', chosen: null, full: null,
    tally: { done: 0, right: 0, wrong: 0 },
    marked: new Set(), limitOn: !!cfg.limitOn, limits: cfg.limits || loadLimits(),
    ids: cfg.ids || null, cAcc: 0, cRun: Date.now(), qAcc: 0, qRun: Date.now(), qTimes: {}, qQid: null, times: [], timeoutN: 0,
    answerMode: cfg.answerMode || getAnswerMode(),
    answers: {}, spent: {}, fulls: {}, submitted: false,
    gid: cfg.gid || '',
  };
  addSeen(res.cards.map(c => c.qid));
  renderCard();
  saveSession();
  ensureGid(state.session);        // 后台建组（失败只是这组不进回溯，不影响答题）
}

function renderCard() {
  captureInk();                       // 换题前先把上一题的笔迹收进本次答题的笔迹表
  const S = state.session; const c = S.queue[S.idx];
  if (!c) { clearSession(); return finishSession(); }
  S.phase = 'question'; S.chosen = null; S.full = null; S.graded = 0; S.ansShown = false;
  // 只有真的换了题才把「本题用时」归零；同一题重渲染 / 从快照恢复都保留已用时间
  if (S.qQid !== c.id) clockStartQ(S, c.id);
  const hasMat = !!c.material; window.__curMatRaw = c.material;
  const deferred = isDeferred(S);
  const doneN = deferred ? S.queue.filter(x => S.answers[x.id]).length : S.idx;
  const ppStat = deferred
    ? `<span class="mode-badge deferred">先答后对</span> 已答 <b>${doneN}</b> / ${S.queue.length}`
    : `<span class="mode-badge">边答边对</span> 本次对 <b style="color:var(--ok)">${S.tally.right}</b> 错 <b style="color:var(--bad)">${S.tally.wrong}</b>${S.timeoutN ? ` &nbsp;·&nbsp; <b style="color:var(--warn)">超时 ${S.timeoutN}</b>` : ''}`;
  app.innerHTML = `
  <div class="progress"><div class="pp-main"><span id="pp-txt">第 ${S.idx + 1} / ${S.queue.length} 题 &nbsp;·&nbsp; ${MODE_LABEL[S.mode] || '练习'} &nbsp;·&nbsp; ${ppStat}</span>
    <div class="pbar"><i style="width:${doneN / S.queue.length * 100}%"></i></div></div>
    <div class="pp-side">
      <button class="pp-home" id="pp-home" type="button" title="返回总览：本组进度已保存，回来可继续">⌂ 总览</button>
      <button class="qtimer" id="qtimer" type="button" title="左键单击这里可暂停计时"><span id="qt-icon" aria-hidden="true">⏱</span><b id="qt-now">0:00</b><small>/ <span id="qt-all">0:00</span></small><span class="qt-hint" id="qt-hint"></span></button>
      <div id="ctime-box"></div>
    </div></div>
  <div class="draw-toolbar" id="draw-toolbar" aria-label="答题画笔工具">
    <button class="btn sm ghost" id="draw-toggle" type="button" aria-pressed="false">✎ 画笔</button>
    <label class="draw-setting" title="画笔粗细">粗细<input id="draw-size" type="range" min="1" max="8" value="2"><output id="draw-size-value">2</output></label>
    <span class="draw-setting">颜色</span><div class="draw-colors" role="group" aria-label="画笔颜色">
      ${INK_COLORS.map(([c, n]) => `<button class="draw-color-swatch${c.toLowerCase() === loadInk().c.toLowerCase() ? ' selected' : ''}" type="button" data-color="${c}" style="background:${c}" aria-label="${n}" title="${n}"></button>`).join('')}
    </div>
    <button class="btn sm ghost" id="draw-eraser" type="button" aria-pressed="false">橡皮</button>
    <label class="draw-setting" title="橡皮大小（与画笔粗细分开记录）">橡皮大小<input id="draw-erase-size" type="range" min="8" max="72" step="2" value="24"><output id="draw-erase-size-value">24</output></label>
    <button class="btn sm ghost" id="draw-undo" type="button" title="撤销">↶</button>
    <button class="btn sm ghost" id="draw-redo" type="button" title="恢复">↷</button>
    <span class="draw-zoom" id="draw-zoom">100%</span>
    <label class="draw-mini" title="PC 端答题区宽度">宽度<select id="draw-width">
      ${READW_ORDER.map(w => `<option value="${w}"${getReadW() === w ? ' selected' : ''}>${READW_LABEL[w]}</option>`).join('')}
    </select></label>
    <span class="draw-hint" id="draw-hint">框选文字自动划线 · 双击清除 · 右键 画笔/鼠标 · 滚轮 调粗细</span>
  </div>
  <div class="draw-fab" id="draw-fab" aria-label="答题画笔">
    <div class="fab-panel" id="fab-panel" hidden></div>
    <button class="fab-btn" id="fab-pen" type="button" aria-pressed="false" aria-label="画笔：点按切换，长按调整颜色和粗细">
      <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20l4.6-1.1 9.8-9.8a2.4 2.4 0 0 0-3.4-3.4L5.2 15.5 4 20z"/><path d="M14.2 6.4l3.4 3.4"/></svg>
    </button>
    <button class="fab-btn" id="fab-eraser" type="button" aria-pressed="false" aria-label="橡皮：点按切换，长按撤销和回退">
      <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 19.5H20"/><path d="M13.8 4.5l5.7 5.7a1.6 1.6 0 0 1 0 2.3l-5.1 5.1a1.6 1.6 0 0 1-2.3 0L6.4 11.9a1.6 1.6 0 0 1 0-2.3l5.1-5.1a1.6 1.6 0 0 1 2.3 0z"/><path d="M9.6 8.7l5.7 5.7"/></svg>
    </button>
  </div>
  <div class="answer-viewport" id="answer-viewport"><div class="answer-sheet" id="answer-sheet">
  <div class="qhead">
    <span class="tag">${esc(c.module)}/${esc(c.category)}</span>
    <span class="tag">${esc(c.region || '?')} ${esc(c.year || '')}</span>
    <span class="tag" title="${esc(c.kadian)}">${esc((c.kadian || '').split('/').pop().slice(0, 22))}</span>
    <button class="qtool ${S.marked.has(c.id) ? 'on' : ''}" id="t-mark" title="临时标记本题（仅本组有效，便于复盘）">⚑ ${S.marked.has(c.id) ? '已标记' : '标记'}</button>
    <button class="qtool qtool-drop" id="t-drop" title="丢弃本题：不再出现在练习中，可在「真题浏览 → 已丢弃」里找回">🚫 丢弃</button>
    <a class="linkback" href="#/detail?id=${c.id}">查看完整标注</a>
    ${c.verified ? `<span class="tag vbadge" title="该题答案已经过联网权威来源核实，可信">✅ 已联网复核</span>` : ''}
  </div>
  ${c.module === '资料分析' && !hasMat ? `<div class="material-wrap mat-missing">⚠️ 本题材料缺失（原始数据未收录），可到「材料组题」模式换其他材料组练习</div>` : ''}
  ${hasMat ? `<details class="material-wrap" open><summary style="cursor:pointer;color:var(--brand);margin-bottom:8px">📄 给定材料 <span class="m-hint">（疑点提示将在作答后显示）</span></summary><div class="material" id="mat-stripped">${stripCallouts(c.material)}</div></details>` : ''}
  ${c.ask_model ? `<div class="askmodel">💡 问法模型：${esc(c.ask_model)}</div>` : ''}
  <div class="answer-sheet-content">
    <div class="stem">${c.stem || '<i>（题干为图片，见下方选项）</i>'}</div>
    <div id="opts"></div>
    <div id="act"></div>
  </div>
  <canvas class="answer-ink" id="answer-ink" aria-label="答题手写标注"></canvas>
  </div></div>`;
  const qb = document.getElementById('qtimer');
  if (qb) qb.onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggleClockPause(); };
  // 功能：返回总览（本组进度已随 saveSession 落盘，总览页可「继续上次刷题」）
  const homeB = document.getElementById('pp-home');
  if (homeB) homeB.onclick = () => { try { saveSession(); } catch (e) { } location.hash = '#/'; };
  // 功能：丢弃本题
  const dropB = document.getElementById('t-drop');
  if (dropB) dropB.onclick = () => dropCurrent();
  initAnswerDrawing();
  initUnderline();                    // 框选划线：容器就位后把本次答题里的划线复原
  renderOptions();
  // 功能3：临时标记按钮（就地切换，不重渲染以免丢失已揭示答案）
  const mb = document.getElementById('t-mark');
  if (mb) mb.onclick = (e) => {
    const on = S.marked.has(c.id);
    if (on) S.marked.delete(c.id); else S.marked.add(c.id);
    e.currentTarget.classList.toggle('on', !on);
    e.currentTarget.textContent = on ? '⚑ 标记' : '⚑ 已标记';
    if (isDeferred(S)) renderDeferredAct();   // 答题卡上的「⚑ 已标记 n」要跟着变
    else ulToast(on ? '已取消标记' : '已标记 · 本组结束后可在报告里复盘');
  };
  // 功能2：单题限时倒计时
  const answerable = !isRev(S);
  // 先答后对：已作答的题回看时不再倒计时
  if (S.limitOn && answerable && S.phase === 'question' && !(deferred && S.answers[c.id])) {
    const sec = (S.limits && S.limits[c.module]) || LIMIT_DEFAULT[c.module] || 45;
    startLimitTimer(sec, c.id);
  } else {
    const cb = document.getElementById('ctime-box'); if (cb) cb.innerHTML = '';
    stopLimitTimer();
  }
  startClock();
}

/* ---------- 答题画笔：颜色可调 / 大号橡皮 / 撤销回退 / 移动端悬浮钮 ---------- */
const INK_KEY = 'kg_ink';
const INK_COLORS = [['#d73535', '红色'], ['#2563eb', '蓝色'], ['#198754', '绿色']];
const PEN_MIN = 1, PEN_MAX = 8, PEN_DEFAULT = 2;
const ERASE_MIN = 8, ERASE_MAX = 72, ERASE_DEFAULT = 24;   // 橡皮默认 24px ≈ 旧版的 3 倍
const clampPen = v => Math.min(PEN_MAX, Math.max(PEN_MIN, Math.round(+v || PEN_DEFAULT)));
const clampErase = v => Math.min(ERASE_MAX, Math.max(ERASE_MIN, Math.round((+v || ERASE_DEFAULT) / 2) * 2));
function loadInk() {
  try {
    const o = JSON.parse(localStorage.getItem(INK_KEY) || '{}');
    const c = String(o.c || '').toLowerCase();
    return {
      // 已下线的黑色会自动回落到红色
      c: INK_COLORS.some(x => x[0].toLowerCase() === c) ? o.c : '#d73535',
      s: clampPen(o.s),
      e: clampErase(o.e),
    };
  } catch (e) { return { c: '#d73535', s: PEN_DEFAULT, e: ERASE_DEFAULT }; }
}
function saveInk(o) { try { localStorage.setItem(INK_KEY, JSON.stringify(o)); } catch (e) { } }

/* ---------- 笔迹保留：本次答题内按题目保存 ----------
   以前每换一题就重绘整个答题页，画布被整体丢弃，回看上一题/答题卡跳题时笔迹全没了。
   现在每题的笔迹按题目 id 存一份（本次答题期间有效），回看或刷新回来都能原样复原，
   本组结束（交卷 / 完成 / 清空数据 / 开新一组）时统一清除，不占长期存储。 */
const INK_SS_KEY = 'kg_ink_sess';
function inkSig() {
  const S = state.session;
  if (!S || !S.queue || !S.queue.length) return '';
  return [S.mode, S.queue.length, S.queue[0].id, S.queue[S.queue.length - 1].id].join(':');
}
function inkStore() {
  if (!state.ink) state.ink = Object.create(null);
  return state.ink;
}
function clearInkStore() {
  state.ink = Object.create(null);
  try { sessionStorage.removeItem(INK_SS_KEY); } catch (e) { }
}
/* 刷新页面后「继续上次刷题」：把这次答题已画的笔迹接回来 */
function loadInkStore() {
  const sig = inkSig();
  if (!sig) return;
  try {
    const o = JSON.parse(sessionStorage.getItem(INK_SS_KEY) || 'null');
    if (o && o.sig === sig && o.map && typeof o.map === 'object') {
      const m = Object.create(null);
      Object.keys(o.map).forEach(k => { if (typeof o.map[k] === 'string') m[k] = o.map[k]; });
      state.ink = m;
    }
  } catch (e) { }
}
function saveInkStore() {
  const sig = inkSig();
  if (!sig) return;
  try {
    const map = inkStore(), keys = Object.keys(map);
    const keep = Object.create(null);
    let total = 0, n = 0;
    // 体积保护：最多保留 24 题 / 约 3.2M 字符，超出丢最早的
    for (let i = keys.length - 1; i >= 0 && n < 24; i--) {
      const v = map[keys[i]];
      if (!v || typeof v !== 'string') continue;
      if (total + v.length > 3.2e6) break;
      keep[keys[i]] = v; total += v.length; n++;
    }
    sessionStorage.setItem(INK_SS_KEY, JSON.stringify({ sig, map: keep }));
  } catch (e) { }
}
/* 把当前画布存进本题的笔迹位（题目切换 / 离开答题页 / 刷新前调用） */
function captureInk() {
  const ref = state.inkRef, cv = document.getElementById('answer-ink');
  if (!ref || !cv || ref.canvas !== cv || !ref.qid) return;
  if (ref.S !== state.session) return;      // 已经换了一组，旧画布不要再写进新一组
  try {
    const m = inkStore();
    if (!ref.hasInk()) delete m[ref.qid];
    else m[ref.qid] = cv.toDataURL('image/png');
    saveInkStore();
  } catch (e) { }
}

/* ---------- 框选划线：左键拖选文字 → 自动划线（颜色/粗细跟随画笔），双击划线处清除 ----------
   划线不是画在画布上，而是用 <span> 直接包住选中的文字，所以它天生「附着在文字上」：
   材料窗口内部滚动、窗口缩放、换设备宽度都不会错位，文字滚到哪线就跟到哪。
   本次答题内按容器保存（材料按材料 id、题干按题目 id），切题回来仍在。 */
const UL_SS_KEY = 'kg_ul_sess';
const UL_HOSTS = '.material, .stem';          // 允许框选划线的区域
function ulHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36) + '-' + s.length; }
function ulStore() { if (!state.ul) state.ul = Object.create(null); return state.ul; }
function clearUlStore() { state.ul = Object.create(null); try { sessionStorage.removeItem(UL_SS_KEY); } catch (e) { } }
function saveUlStore() {
  const sig = inkSig(); if (!sig) return;
  try {
    const map = ulStore(), keep = Object.create(null);
    let total = 0;
    Object.keys(map).forEach(k => {
      const a = map[k];
      if (!Array.isArray(a) || !a.length || total >= 800) return;
      keep[k] = a; total += a.length;
    });
    sessionStorage.setItem(UL_SS_KEY, JSON.stringify({ sig, map: keep }));
  } catch (e) { }
}
function loadUlStore() {
  const sig = inkSig(); if (!sig) return;
  try {
    const o = JSON.parse(sessionStorage.getItem(UL_SS_KEY) || 'null');
    if (!o || o.sig !== sig || !o.map || typeof o.map !== 'object') return;
    const m = Object.create(null);
    Object.keys(o.map).forEach(k => {
      if (!Array.isArray(o.map[k])) return;
      const ok = o.map[k].filter(x => x && typeof x.s === 'number' && typeof x.e === 'number' && x.e > x.s);
      if (ok.length) m[k] = ok;
    });
    state.ul = m;
  } catch (e) { }
}
/* 容器内字符偏移 ⇄ Range（只用文本节点，避免 HTML 结构干扰） */
function ulPos(host, container, offset) {
  try {
    const r = document.createRange();
    r.selectNodeContents(host);
    r.setEnd(container, offset);
    return r.toString().length;
  } catch (e) { return -1; }
}
function ulRange(host, s, e) {
  const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let pos = 0, t, sn = null, so = 0, en = null, eo = 0;
  while ((t = w.nextNode())) {
    const len = t.nodeValue.length;
    if (!sn && len && pos + len > s) { sn = t; so = s - pos; }
    if (en === null && len && pos + len >= e) { en = t; eo = e - pos; break; }
    pos += len;
  }
  if (!sn || !en) return null;
  if (so < 0) so = 0; if (eo > en.nodeValue.length) eo = en.nodeValue.length;
  const r = document.createRange(); r.setStart(sn, so); r.setEnd(en, eo);
  return r;
}
function ulStrip(host) {
  host.querySelectorAll('span.kg-ul').forEach(el => {
    const p = el.parentNode; if (!p) return;
    while (el.firstChild) p.insertBefore(el.firstChild, el);
    p.removeChild(el);
  });
  try { host.normalize(); } catch (e) { }
}
function ulPaint(host, marks) {
  ulStrip(host);
  (marks || []).forEach((m, i) => {
    const r = ulRange(host, m.s, m.e);
    if (r) ulWrapRange(r, m, i);
  });
}
function ulWrapRange(range, m, idx) {
  const parts = [];
  const w = document.createTreeWalker(range.commonAncestorContainer.nodeType === 3
    ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  let t, started = false;
  const sc = range.startContainer, ec = range.endContainer;
  while ((t = w.nextNode())) {
    const len = t.nodeValue.length;
    if (!started) {
      if (t !== sc) continue;
      started = true;
      parts.push([t, range.startOffset, t === ec ? range.endOffset : len]);
      if (t === ec) break;
      continue;
    }
    if (t === ec) { parts.push([t, 0, range.endOffset]); break; }
    parts.push([t, 0, len]);
  }
  parts.forEach(([node, a, b]) => {
    if (!node || !node.isConnected || !node.nodeValue || b <= a) return;
    let t = node;
    if (a > 0) t = t.splitText(Math.min(a, t.nodeValue.length));
    const rest = b - a;
    if (rest < t.nodeValue.length) t.splitText(rest);
    if (!t.nodeValue) return;
    const sp = document.createElement('span');
    sp.className = 'kg-ul';
    sp.dataset.i = String(idx);
    sp.style.setProperty('--ulc', m.c || '#d73535');
    sp.style.setProperty('--ulw', Math.max(1, +m.w || 2) + 'px');
    t.parentNode.insertBefore(sp, t);
    sp.appendChild(t);
  });
}
let UL_TOAST_T = null;
function ulToast(msg) {
  let el = document.getElementById('ul-toast');
  if (!el) { el = document.createElement('div'); el.id = 'ul-toast'; el.className = 'ul-toast'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('show');
  clearTimeout(UL_TOAST_T);
  UL_TOAST_T = setTimeout(() => el.classList.remove('show'), 1500);
}
function ulAdd(host, s, e) {
  const ink = loadInk();
  kgMarkInk();                           // 划线刚结束：紧随其后的点击不当作答
  const key = host.dataset.ulkey, store = ulStore();
  const arr = store[key] || (store[key] = []);
  const next = [];
  let ns = s, ne = e, hit = false;
  arr.forEach(m => {                     // 与已有划线重叠/相邻就合并，避免层层嵌套
    if (m.e >= ns - 2 && m.s <= ne + 2) { ns = Math.min(ns, m.s); ne = Math.max(ne, m.e); hit = true; }
    else next.push(m);
  });
  next.push({ s: ns, e: ne, c: ink.c, w: ink.s });
  next.sort((a, b) => a.s - b.s);
  store[key] = next;
  ulPaint(host, next);
  saveUlStore();
  if (!hit) ulToast('已划线 · 双击划线处可清除');
}
function ulDel(host, i) {
  const key = host.dataset.ulkey, store = ulStore();
  kgMarkInk();                           // 双击清除划线也算一次划线动作
  const arr = store[key] || [];
  if (!(i >= 0 && i < arr.length)) return;
  arr.splice(i, 1);
  if (arr.length) store[key] = arr; else delete store[key];
  ulPaint(host, arr);
  saveUlStore();
}
function initUnderline() {
  const sheet = document.getElementById('answer-sheet');
  const S = state.session;
  if (!sheet || !S) return;
  const card = S.queue[S.idx]; if (!card) return;
  const store = ulStore();
  const hosts = [];
  const mat = sheet.querySelector('.material');
  if (mat) {
    // 材料按材料 id 记账：同一材料组下换题，材料上的划线不会丢
    mat.dataset.ulkey = 'm:' + (card.material_ref ? String(card.material_ref) : ulHash(mat.textContent || ''));
    hosts.push(mat);
  }
  const stem = sheet.querySelector('.stem');
  if (stem) { stem.dataset.ulkey = 'q:' + String(card.id); hosts.push(stem); }
  hosts.forEach(h => ulPaint(h, store[h.dataset.ulkey] || []));

  let dx = 0, dy = 0;
  sheet.addEventListener('pointerdown', e => { dx = e.clientX; dy = e.clientY; }, true);
  sheet.addEventListener('pointerup', e => {
    const vp = document.getElementById('answer-viewport');
    if (vp && vp.classList.contains('drawing')) return;              // 画笔/橡皮模式不抢框选
    if (Math.hypot(e.clientX - dx, e.clientY - dy) < 8) return;      // 单击 / 双击不算框选
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    if (!String(sel).trim()) return;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node.nodeType === 3 ? node.parentNode : node;
    const host = el && el.closest ? el.closest(UL_HOSTS) : null;
    if (!host || !sheet.contains(host) || !host.dataset.ulkey) return;
    let s = ulPos(host, range.startContainer, range.startOffset);
    let t = ulPos(host, range.endContainer, range.endOffset);
    if (s < 0 || t <= s) return;
    const all = host.textContent || '';
    while (s < t && /\s/.test(all[s] || ' ')) s++;
    while (t > s && /\s/.test(all[t - 1] || ' ')) t--;
    if (t - s < 1) return;
    ulAdd(host, s, t);
    // 划线成功后由程序清掉选区：这一次「选字」已经被划线消费掉了，
    // 紧随其后的点击应当正常作答（而不是被当成"选字后的误触"拦掉）
    KG_GEST.selClearedTs = Date.now(); KG_GEST.selTs = 0;
    try { sel.removeAllRanges(); } catch (x) { }
  });
  sheet.addEventListener('dblclick', e => {
    const sp = e.target && e.target.closest ? e.target.closest('span.kg-ul') : null;
    if (!sp) return;                                                 // 双击空白处仍是选词
    const host = sp.closest(UL_HOSTS);
    if (!host || !host.dataset.ulkey) return;
    e.preventDefault(); e.stopPropagation();
    ulDel(host, +sp.dataset.i);
    KG_GEST.selClearedTs = Date.now(); KG_GEST.selTs = 0;
    const sel = window.getSelection(); if (sel) { try { sel.removeAllRanges(); } catch (x) { } }
  });
}

function initAnswerDrawing() {
  const viewport = document.getElementById('answer-viewport');
  const sheet = document.getElementById('answer-sheet');
  const canvas = document.getElementById('answer-ink');
  if (!viewport || !sheet || !canvas) return;
  const ctx = canvas.getContext('2d');
  const undo = [], redo = [], pointers = new Map();
  let scale = 1, drawing = false, pinch = null, panPoint = null;
  const toggle = document.getElementById('draw-toggle');
  const eraser = document.getElementById('draw-eraser');
  const size = document.getElementById('draw-size');
  const sizeVal = document.getElementById('draw-size-value');
  const esize = document.getElementById('draw-erase-size');
  const esizeVal = document.getElementById('draw-erase-size-value');
  const undoBtn = document.getElementById('draw-undo');
  const redoBtn = document.getElementById('draw-redo');
  const zoomLabel = document.getElementById('draw-zoom');
  const widthSel = document.getElementById('draw-width');
  const fabPen = document.getElementById('fab-pen');
  const fabEraser = document.getElementById('fab-eraser');
  const panel = document.getElementById('fab-panel');

  // 画笔状态：颜色 / 粗细 / 当前工具（persist 到本地，下次打开保持）
  const ink = loadInk();
  let penColor = ink.c, penSize = ink.s, eraseSize = ink.e, tool = 'pen';
  const eraseW = () => eraseSize;                      // 橡皮尺寸独立记录，与画笔粗细互不影响
  const strokeW = () => (tool === 'eraser' ? eraseW() : penSize);
  const saveInkState = () => saveInk({ c: penColor, s: penSize, e: eraseSize });

  const setPressed = (el, on) => { if (el) el.setAttribute('aria-pressed', String(!!on)); };
  const syncUi = () => {
    const on = viewport.classList.contains('drawing');
    if (toggle) { setPressed(toggle, on && tool === 'pen'); toggle.textContent = on && tool === 'pen' ? '✓ 绘制中' : '✎ 画笔'; }
    setPressed(eraser, on && tool === 'eraser');
    setPressed(fabPen, on && tool === 'pen');
    setPressed(fabEraser, on && tool === 'eraser');
    if (size && +size.value !== penSize) size.value = penSize;
    if (sizeVal) sizeVal.value = penSize;
    if (esize && +esize.value !== eraseSize) esize.value = eraseSize;
    if (esizeVal) esizeVal.value = eraseSize;
  };
  const setDrawing = (on, nextTool) => {
    if (nextTool) tool = nextTool;
    viewport.classList.toggle('drawing', on);
    viewport.classList.toggle('zoom-enabled', on);
    if (!on) { pointers.clear(); drawing = false; pinch = null; panPoint = null; ctx.globalCompositeOperation = 'source-over'; }
    syncUi();
  };

  const setZoom = (next, x, y) => {
    const old = scale; scale = Math.min(3, Math.max(.5, next));
    sheet.style.transform = `scale(${scale})`;
    if (zoomLabel) zoomLabel.textContent = Math.round(scale * 100) + '%';
    if (x != null) { viewport.scrollLeft = (viewport.scrollLeft + x) * scale / old - x; viewport.scrollTop = (viewport.scrollTop + y) * scale / old - y; }
  };
  const resize = () => {
    const w = Math.max(1, sheet.clientWidth), h = Math.max(1, sheet.scrollHeight);
    if (canvas.width === w && canvas.height === h) return;
    const old = document.createElement('canvas'); old.width = canvas.width; old.height = canvas.height;
    old.getContext('2d').drawImage(canvas, 0, 0);
    canvas.width = w; canvas.height = h; ctx.drawImage(old, 0, 0);
  };
  const observer = new ResizeObserver(resize); observer.observe(sheet); resize();

  /* 本题笔迹：先登记当前题目，再把本次答题里已画的内容复原 */
  const S0 = state.session;
  const card0 = S0 && S0.queue ? S0.queue[S0.idx] : null;
  const qid0 = card0 ? String(card0.id) : '';
  let inked = false;
  state.inkRef = { S: S0, qid: qid0, canvas, hasInk: () => inked };
  const restoreInk = () => {
    const data = qid0 ? inkStore()[qid0] : null;
    if (!data) return;
    const img = new Image();
    img.onload = () => {
      if (!canvas.isConnected) return;
      const k = img.width ? Math.min(1, canvas.width / img.width) : 1;
      ctx.save(); ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(img, 0, 0, img.width * k, img.height * k);
      ctx.restore();
      inked = true;
    };
    img.src = data;
  };
  restoreInk();

  /* 主工具条（PC） */
  if (toggle) toggle.onclick = () => {
    if (!viewport.classList.contains('drawing')) setDrawing(true, 'pen');
    else if (tool === 'eraser') setDrawing(true, 'pen');   // 从橡皮切回画笔
    else setDrawing(false);
  };
  if (eraser) eraser.onclick = () => {
    if (viewport.classList.contains('drawing') && tool === 'eraser') setDrawing(false);
    else setDrawing(true, 'eraser');
  };
  if (widthSel) {
    widthSel.value = getReadW();
    widthSel.onchange = () => setReadW(widthSel.value);
  }

  const paintSwatches = () => {
    document.querySelectorAll('.draw-color-swatch').forEach(b => {
      b.classList.toggle('selected', String(b.dataset.color).toLowerCase() === penColor.toLowerCase());
    });
  };
  const bindSwatches = root => {
    (root || document).querySelectorAll('.draw-color-swatch').forEach(btn => {
      btn.onclick = () => {
        penColor = btn.dataset.color; saveInkState();
        paintSwatches();
        if (!viewport.classList.contains('drawing') || tool === 'eraser') setDrawing(true, 'pen');
      };
    });
  };
  bindSwatches(document);
  paintSwatches();

  const applySize = v => {
    penSize = clampPen(v);
    if (size) size.value = penSize;
    if (sizeVal) sizeVal.value = penSize;
    saveInkState();
  };
  const applyErase = v => {
    eraseSize = clampErase(v);
    if (esize) esize.value = eraseSize;
    if (esizeVal) esizeVal.value = eraseSize;
    saveInkState();
  };
  if (size) size.oninput = () => { applySize(size.value); syncUi(); };
  if (esize) esize.oninput = () => { applyErase(esize.value); syncUi(); };

  /* 撤销 / 回退 */
  const doUndo = () => {
    if (!undo.length) return;
    redo.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    ctx.putImageData(undo.pop(), 0, 0); inked = true; refreshUndoBtns();
  };
  const doRedo = () => {
    if (!redo.length) return;
    undo.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    ctx.putImageData(redo.pop(), 0, 0); inked = true; refreshUndoBtns();
  };
  const refreshUndoBtns = () => {
    if (undoBtn) undoBtn.disabled = !undo.length;
    if (redoBtn) redoBtn.disabled = !redo.length;
    const u = document.getElementById('fab-undo'), r = document.getElementById('fab-redo');
    if (u) u.disabled = !undo.length;
    if (r) r.disabled = !redo.length;
  };
  if (undoBtn) undoBtn.onclick = doUndo;
  if (redoBtn) redoBtn.onclick = doRedo;
  refreshUndoBtns();

  /* 移动端长按浮层：画笔 → 颜色/粗细；橡皮 → 撤销/回退 */
  let panelKind = '';
  const panelHtml = kind => kind === 'pen'
    ? `<div class="fab-title">画笔 · 颜色与粗细</div>
       <div class="draw-colors" role="group" aria-label="画笔颜色">
         ${INK_COLORS.map(([c, n]) => `<button class="draw-color-swatch${c.toLowerCase() === penColor.toLowerCase() ? ' selected' : ''}" type="button" data-color="${c}" style="background:${c}" aria-label="${n}" title="${n}"></button>`).join('')}
       </div>
       <label class="draw-setting">粗细<input id="fab-size" type="range" min="${PEN_MIN}" max="${PEN_MAX}" value="${penSize}"><output id="fab-size-v">${penSize}</output></label>`
    : `<div class="fab-title">橡皮 · 大小与笔迹操作</div>
       <label class="draw-setting">橡皮大小<input id="fab-erase" type="range" min="${ERASE_MIN}" max="${ERASE_MAX}" step="2" value="${eraseSize}"><output id="fab-erase-v">${eraseSize}</output></label>
       <div class="fab-row">
         <button class="btn sm ghost" id="fab-undo" type="button">↶ 撤销</button>
         <button class="btn sm ghost" id="fab-redo" type="button">↷ 回退</button>
       </div>
       <p class="sub" style="margin:0">橡皮与画笔尺寸分开记录，互不影响</p>`;
  const closePanel = () => {
    if (!panel) return;
    panel.hidden = true; panel.innerHTML = ''; panelKind = '';
    if (window.__kgFabOutside) { document.removeEventListener('pointerdown', window.__kgFabOutside, true); window.__kgFabOutside = null; }
  };
  const openPanel = kind => {
    if (!panel) return;
    if (panelKind === kind && !panel.hidden) { closePanel(); return; }
    if (window.__kgFabOutside) { document.removeEventListener('pointerdown', window.__kgFabOutside, true); window.__kgFabOutside = null; }
    panelKind = kind;
    panel.innerHTML = panelHtml(kind);
    panel.hidden = false;
    if (kind === 'pen') {
      bindSwatches(panel); paintSwatches();
      const fs = document.getElementById('fab-size'), fv = document.getElementById('fab-size-v');
      if (fs) fs.oninput = () => { applySize(fs.value); if (fv) fv.value = penSize; };
    } else {
      const u = document.getElementById('fab-undo'), r = document.getElementById('fab-redo');
      if (u) u.onclick = doUndo;
      if (r) r.onclick = doRedo;
      const fe = document.getElementById('fab-erase'), fv = document.getElementById('fab-erase-v');
      if (fe) fe.oninput = () => { applyErase(fe.value); if (fv) fv.value = eraseSize; };
      refreshUndoBtns();
    }
    setTimeout(() => {
      const h = e => { if (e.target && e.target.closest && e.target.closest('#draw-fab')) return; closePanel(); };
      window.__kgFabOutside = h;
      document.addEventListener('pointerdown', h, true);
    }, 0);
  };
  const bindHold = (btn, onTap, onHold) => {
    if (!btn) return;
    let timer = null, fired = false;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    btn.addEventListener('pointerdown', e => {
      e.preventDefault(); fired = false;
      try { btn.setPointerCapture(e.pointerId); } catch (x) { }
      timer = setTimeout(() => {
        timer = null; fired = true;
        try { if (navigator.vibrate) navigator.vibrate(15); } catch (x) { }
        onHold();
      }, 360);
    });
    btn.addEventListener('pointerup', () => { cancel(); if (!fired) onTap(); });
    btn.addEventListener('pointercancel', cancel);
    btn.addEventListener('contextmenu', e => e.preventDefault());
  };
  bindHold(fabPen,
    () => { if (viewport.classList.contains('drawing') && tool === 'pen') setDrawing(false); else setDrawing(true, 'pen'); },
    () => { setDrawing(true, 'pen'); openPanel('pen'); });
  bindHold(fabEraser,
    () => { if (viewport.classList.contains('drawing') && tool === 'eraser') setDrawing(false); else setDrawing(true, 'eraser'); },
    () => { setDrawing(true, 'eraser'); openPanel('eraser'); });

  /* 绘制 */
  const point = e => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height }; };
  const snapshot = () => {
    undo.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (undo.length > 30) undo.shift();
    redo.length = 0; refreshUndoBtns();
  };
  const paint = p => { ctx.lineTo(p.x, p.y); ctx.stroke(); };

  /* 工具条提示条：右键快捷操作后短暂反馈 */
  const hintEl = document.getElementById('draw-hint');
  const HINT_DEFAULT = '框选文字自动划线 · 双击清除 · 右键 画笔/鼠标 · 滚轮 调粗细';
  let hintTimer = null;
  const flashHint = txt => {
    if (!hintEl) return;
    hintEl.textContent = txt; hintEl.classList.add('flash');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hintEl.textContent = HINT_DEFAULT; hintEl.classList.remove('flash'); }, 1600);
  };

  viewport.addEventListener('wheel', e => {
    if (!viewport.classList.contains('zoom-enabled')) return;
    e.preventDefault();
    // 右键快捷开启时，滚轮用于调整当前工具尺寸；按住 Ctrl/⌘ 才缩放画布
    if (getRmouse() && !e.ctrlKey && !e.metaKey) {
      if (tool === 'eraser') { applyErase(eraseSize + (e.deltaY < 0 ? 4 : -4)); flashHint(`橡皮 ${eraseSize}px`); }
      else { applySize(penSize + (e.deltaY < 0 ? 1 : -1)); flashHint(`画笔 ${penSize}px`); }
      syncUi(); return;
    }
    const r = viewport.getBoundingClientRect(); setZoom(scale * (e.deltaY < 0 ? 1.1 : .9), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  /* PC 右键快捷：单击 画笔↔鼠标，双击 橡皮，滚轮 调粗细 */
  let rTimer = null, rLastDown = 0;
  const rmouseOn = () => getRmouse() && window.matchMedia('(pointer: fine)').matches;
  viewport.addEventListener('contextmenu', e => { if (rmouseOn()) e.preventDefault(); });
  viewport.addEventListener('pointerdown', e => {
    if (e.button !== 2 || !rmouseOn()) return;
    e.preventDefault();
    const now = Date.now();
    if (rTimer && now - rLastDown < 340) {              // 右键双击 → 切到橡皮
      clearTimeout(rTimer); rTimer = null; rLastDown = 0;
      setDrawing(true, 'eraser'); flashHint(`橡皮 ${eraseSize}px · 滚轮调大小`);
      return;
    }
    rLastDown = now;
    if (rTimer) clearTimeout(rTimer);
    rTimer = setTimeout(() => {                          // 右键单击 → 画笔 / 鼠标 来回切
      rTimer = null; rLastDown = 0;
      if (viewport.classList.contains('drawing') && tool === 'pen') { setDrawing(false); flashHint('已切回鼠标（可正常选字）'); }
      else { setDrawing(true, 'pen'); flashHint(`画笔 ${penSize}px · 滚轮调粗细`); }
    }, 300);
  });

  viewport.addEventListener('pointerdown', e => {
    if (!viewport.classList.contains('zoom-enabled')) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;   // 右键/中键不落笔
    if (panel && !panel.hidden) closePanel();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { drawing = false; const a = [...pointers.values()]; pinch = { dist: Math.hypot(a[1].x - a[0].x, a[1].y - a[0].y), scale }; return; }
    // 鼠标在非画笔模式下拖动 = 框选文字（用于自动划线），不要顺带滚动页面
    if (!viewport.classList.contains('drawing')) { if (e.pointerType !== 'mouse') panPoint = { x: e.clientX, y: e.clientY, left: viewport.scrollLeft, top: viewport.scrollTop }; return; }
    e.preventDefault(); snapshot(); const p = point(e); ctx.beginPath(); ctx.moveTo(p.x, p.y);
    ctx.lineWidth = strokeW(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = penColor;
    drawing = true; inked = true;
    kgMarkInk();                          // 落笔 / 擦除也是一次划线动作，随后的点击不当作答
  });
  viewport.addEventListener('pointermove', e => {
    if (!viewport.classList.contains('zoom-enabled') || !pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { const a = [...pointers.values()], d = Math.hypot(a[1].x - a[0].x, a[1].y - a[0].y); if (pinch) { const r = viewport.getBoundingClientRect(); setZoom(pinch.scale * d / pinch.dist, (a[0].x + a[1].x) / 2 - r.left, (a[0].y + a[1].y) / 2 - r.top); } return; }
    if (panPoint && !drawing) { viewport.scrollLeft = panPoint.left - (e.clientX - panPoint.x); viewport.scrollTop = panPoint.top - (e.clientY - panPoint.y); return; }
    if (drawing) { e.preventDefault(); paint(point(e)); }
  });
  const end = e => {
    pointers.delete(e.pointerId);
    if (drawing) { ctx.closePath(); ctx.globalCompositeOperation = 'source-over'; drawing = false; kgMarkInk(); }
    if (!pointers.size) panPoint = null;
    if (pointers.size < 2) pinch = null;
  };
  viewport.addEventListener('pointerup', end);
  viewport.addEventListener('pointercancel', end);

  syncUi();
}

/* ---------- 作答手势守卫 ----------
   划线（框选自动划线 / 画笔 / 双击清除）本质都是「拖拽或选中文字」。只有干净的一次点按
   才允许作答：否则先答后对模式会在 220ms 后自动跳到下一题，看起来就像程序自己选了答案。
   判定放在 document 捕获阶段，并用 pointer + touch 双轨记录，
   避免个别浏览器在拖动选字时不派发 pointermove 而漏判。 */
const KG_GEST = { x: 0, y: 0, downTs: 0, maxDist: 0, inked: false, selTs: 0, selClearedTs: 0, upTs: 0, active: false, hadSel: false };
window.__kgGest = KG_GEST;

/* 划线动作统一打点：划线、清除划线、画笔落笔/抬笔都算 */
function kgMarkInk() {
  KG_GEST.inked = true;
  window.__kgInkTs = Date.now();
}

/* 本次手势是否「不可信」（拖拽过 / 选过字 / 划过线） */
function kgSuspect() {
  const g = KG_GEST;
  if (g.maxDist > 6) return true;                      // 拖拽过，含拖出去又拖回原位
  if (g.inked) return true;                             // 本次按下期间划过线
  if (g.hadSel) return true;                            // 按下时页面上还端着选区：这一下只是把选区收掉
  if (g.selTs && g.selTs >= g.downTs) return true;       // 本次按下期间选过字（划线失败也拦）
  // 手机长按选字后点别处关闭选择浮层：这次点击会先把选区折叠掉，
  // 看着像「没选中文字的正常点击」，实则是选字手势的收尾，拦一次。
  if (g.selTs > (g.selClearedTs || 0) && Date.now() - g.selTs < 900) return true;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && String(sel).trim()) return true;   // 选区还端着
  return false;
}

let _kgGestStartTs = 0;
function initGestureGuard() {
  if (window.__kgGestReady) return;
  window.__kgGestReady = true;
  const start = (x, y) => {
    const now = Date.now();
    // 同一次按下会先后派发 pointerdown / touchstart，别把中间打好的划线标记冲掉
    if (KG_GEST.active && now - _kgGestStartTs < 60) return;
    _kgGestStartTs = now;
    KG_GEST.x = x; KG_GEST.y = y; KG_GEST.downTs = now;
    KG_GEST.maxDist = 0; KG_GEST.inked = false; KG_GEST.active = true;
    // 按下瞬间先看一眼选区：浏览器会在 mousedown 的默认动作里把选区折叠掉，
    // 等 click 阶段再查就查不到了，于是「划完线点一下选项」会被误当成作答。
    const s0 = window.getSelection();
    KG_GEST.hadSel = !!(s0 && !s0.isCollapsed && String(s0).trim());
  };
  const move = (x, y) => {
    if (!KG_GEST.active) return;
    const d = Math.hypot(x - KG_GEST.x, y - KG_GEST.y);
    if (d > KG_GEST.maxDist) KG_GEST.maxDist = d;
  };
  const end = () => { KG_GEST.active = false; KG_GEST.upTs = Date.now(); };
  document.addEventListener('pointerdown', e => start(e.clientX, e.clientY), true);
  document.addEventListener('pointermove', e => move(e.clientX, e.clientY), true);
  document.addEventListener('pointerup', end, true);
  document.addEventListener('pointercancel', end, true);
  document.addEventListener('touchstart', e => { if (e.touches.length === 1) start(e.touches[0].clientX, e.touches[0].clientY); }, true);
  document.addEventListener('touchmove', e => { if (e.touches.length === 1) move(e.touches[0].clientX, e.touches[0].clientY); }, true);
  // 选区一旦变成「非空」，立刻记时间：这是划线的第一信号，比划线上屏更早
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && String(sel).trim()) KG_GEST.selTs = Date.now();
  });
}

/* 选项点击守卫：拖拽选字 / 划线之后的「点击」都不触发作答，避免误选答案 */
function bindPick(el, fn) {
  el.addEventListener('click', e => {
    // 以前 detail===0 直接放行（为了保住键盘 Enter/Space 作答），
    // 但个别环境下拖拽选字后补发的 click 也是 detail=0，等于给误选留了后门；
    // 键盘触发时手势字段都是干净的，kgSuspect 自然返回 false，无障碍操作不受影响。
    if (kgSuspect()) { e.preventDefault(); e.stopPropagation(); return; }
    fn(e);
  });
}

function renderOptions() {
  const S = state.session, c = S.queue[S.idx], box = document.getElementById('opts');
  const rev = S.full;
  const opts = rev ? rev.options : c.options;
  const answerable = !isRev(S);
  if (isDeferred(S)) {
    // 先答后对：只标记所选项，不显示对错；可随时改选
    const picked = S.answers[c.id] || '';
    box.innerHTML = (c.options && c.options.length) ? `<div class="opts">` + c.options.map(o => `
      <div class="opt ${picked === o.key ? 'sel' : ''}" data-key="${o.key}" role="button" tabindex="0" aria-pressed="${picked === o.key}">
        <span class="k">${o.key}</span><span class="body">${o.html || esc(o.label)}</span>
        ${picked === o.key ? '<span class="opt-picked">已选</span>' : ''}
      </div>`).join('') + `</div>` : '';
    box.querySelectorAll('.opt').forEach(el => bindPick(el, () => deferredChoose(el.dataset.key)));
    renderDeferredAct();
    return;
  }
  if (!opts || !opts.length) { box.innerHTML = ''; }
  else if (!answerable && S.phase === 'question') {
    box.innerHTML = `<div class="row"><button class="btn" id="btn-reveal">🧠 先回忆，然后点击显示选项与答案</button></div>`;
    document.getElementById('btn-reveal').onclick = doReveal;
  } else if (!answerable && S.phase === 'answer') {
    // 复习模式：先自己回忆，答案默认不点亮；悬停答案行 / 按 0 / 点按钮才揭示
    box.innerHTML = `<div class="opts">` + opts.map(o => `<div class="opt${o.is_answer ? ' ans-key' : ''}">
        <span class="k">${o.key}</span><span class="body">${o.html || esc(o.label)}</span>
        ${o.is_answer ? '<span class="ans-badge" style="color:var(--ok);font-weight:800">✔ 正确</span>' : ''}
      </div>`).join('') + `</div>`;
  } else {
    box.innerHTML = `<div class="opts">` + opts.map(o => {
      let cls = 'opt';
      if (S.phase === 'answer') {
        if (o.is_answer) cls += ' show-ans';
        if (S.chosen === o.key && !o.is_answer) cls += ' wrong';
        if (S.chosen === o.key && o.is_answer) cls += ' correct';
      }
      const clickable = (answerable && S.phase === 'question');
      return `<div class="${cls}" ${clickable ? `data-key="${o.key}"` : ''}>
        <span class="k">${o.key}</span><span class="body">${o.html || esc(o.label)}</span>
        ${S.phase === 'answer' && o.is_answer ? '<span style="color:var(--ok);font-weight:800">✔ 正确</span>' : ''}
      </div>`;
    }).join('') + `</div>`;
    if (answerable && S.phase === 'question') {
      box.querySelectorAll('.opt').forEach(el => bindPick(el, () => { S.chosen = el.dataset.key; doReveal(); }));
    }
  }
  renderAct();
}

function renderAct() {
  const S = state.session; const act = document.getElementById('act'); if (!act) return;
  const answerable = !isRev(S);
  if (S.phase === 'question') {
    if (answerable) { act.innerHTML = `<p class="sub" style="margin-top:14px">👆 点击上方选项作答</p>`; return; }
    // 复习模式：掌握程度直接给出来，不用先揭示选项与解析——凭回忆自评完立刻进下一题。
    // 想核对答案的，再点上面的「🧠 先回忆…」按钮，自评区仍保留（自评以自评为准）。
    act.innerHTML = `
      <div class="rev-rate">
        <div class="rev-rate-head">
          <b>这道题现在掌握得怎么样？</b>
          <span class="sub" style="margin:0">不看选项和解析，凭回忆直接自评，选完自动进入下一题</span>
        </div>
        <div class="grade">
          <button class="g-again" data-g="1">忘记<small>1 · again 完全没印象</small></button>
          <button class="g-hard" data-g="3">困难<small>2 · hard 想起来一点</small></button>
          <button class="g-good" data-g="4">一般<small>3 · good 基本记得</small></button>
          <button class="g-easy" data-g="5">熟悉<small>4 · easy 很稳</small></button>
        </div>
        <p class="sub rev-rate-tip">也可以按键盘 1 / 2 / 3 / 4 直接自评。要核对答案，点上方「🧠 先回忆，然后点击显示选项与答案」。</p>
      </div>`;
    act.querySelectorAll('.grade button').forEach(b => b.onclick = () => doGrade(+b.dataset.g));
    return;
  }
  const f = S.full;
  const isRight = answerable ? (S.chosen === f.answer) : null;
  if (answerable) { S.tally.done++; if (isRight) S.tally.right++; else S.tally.wrong++; }
  // 复习模式：解析直接展开可见，正确答案放在解析末尾且默认打码——看解析不影响先自评
  const ansBlock = answerable
    ? `<div class="answer-line ${isRight ? 'right' : 'wrong'}">${isRight ? '✓ 答对了，正确答案 ' + esc(f.answer) : '✗ 答错了，正确答案是 ' + esc(f.answer) + '，你选了 ' + esc(S.chosen || '—')}</div>`
    : `<div class="ans-open">
        ${revealHtml(f)}
        <div class="answer-line ans-line" id="ans-line" title="悬停核对答案 · 点击揭晓">
          <span>正确答案：</span><b class="ans-secret">${esc(f.answer)}</b>
          <span class="ans-peek-tip"><span class="tip-hover">🙈 悬停核对 · 按 0 揭晓</span><span class="tip-touch">🙈 点这一行揭晓答案</span></span>
        </div>
      </div>`;
  act.innerHTML = `
    <div class="qtools">
      <button class="qtool ${f.fav ? 'on' : ''}" id="t-fav">${f.fav ? '★ 已收藏' : '☆ 收藏'}</button>
      <button class="qtool" id="t-note">📝 笔记</button>
      <button class="qtool" id="t-detail">🔍 完整标注</button>
      <button class="qtool" id="t-push">📤 推题</button>
    </div>
    ${ansBlock}
    <div id="note-area"></div>
    ${answerable ? revealHtml(f) : ''}
    <div class="grade">
      <button class="g-again" data-g="1">忘记<small>1 · again 马上重来</small></button>
      <button class="g-hard" data-g="3">困难<small>2 · hard 有点卡</small></button>
      <button class="g-good" data-g="4">一般<small>3 · good 记住了</small></button>
      <button class="g-easy" data-g="5">熟悉<small>4 · easy 轻松</small></button>
    </div>
    <p class="sub" style="margin-top:10px">${answerable
      ? '按你的真实记忆强度自评（直接按键盘 1 / 2 / 3 / 4）。系统将据此计算下次复习间隔。'
      : '解析已展开，核对后再自评（键盘 1 / 2 / 3 / 4）；自评后自动进入下一题。'}</p>`;
  act.querySelectorAll('.grade button').forEach(b => b.onclick = () => doGrade(+b.dataset.g));
  if (!answerable) bindAnsToggle();
  document.getElementById('t-fav').onclick = async (e) => {
    const on = !f.fav;
    await POST('/api/fav', { id: c2id(), on });
    f.fav = on ? 1 : 0;
    const btn = document.getElementById('t-fav');
    btn.classList.toggle('on', !!on); btn.textContent = on ? '★ 已收藏' : '☆ 收藏';
    refreshSide();
  };
  document.getElementById('t-note').onclick = () => toggleNote();
  document.getElementById('t-detail').onclick = () => { location.hash = '#/detail?id=' + c2id(); };
  document.getElementById('t-push').onclick = () => openPushDialog(c.id, c.qid, (c.module || '') + (c.category ? ' · ' + c.category : ''));
}

/* 复习模式：正确答案打码开关（V 键 / 点答案行共用），悬停由 CSS 临时揭开 */
function toggleAns(force) {
  const S = state.session; if (!S) return;
  S.ansShown = (force === undefined) ? !S.ansShown : !!force;
  const wrap = document.getElementById('ans-line');
  if (wrap) wrap.classList.toggle('ans-visible', !!S.ansShown);
}
function bindAnsToggle() {
  // 触屏没有 hover：点答案行也能展开/收起（PC 上悬停仍只是临时看一眼答案）
  const line = document.getElementById('ans-line');
  if (line) { line.onclick = () => toggleAns(); pickPeekTip(line); }
  toggleAns(!!state.session.ansShown);   // 重渲染时按当前状态复原（必须传布尔，undefined 会被当成「切换」）
}
/* 提示文案随输入方式切换：触屏/窄屏说「点这一行」，精确指针才说「悬停」。
   不单靠 CSS @media(hover)：无头模拟和部分安卓平板会把 hover 能力报错，导致手机上显示「悬停看答案」。 */
function pickPeekTip(line) {
  const hov = line.querySelector('.tip-hover'), tch = line.querySelector('.tip-touch');
  if (!hov || !tch) return;
  const touch = matchMedia('(hover:none)').matches || matchMedia('(pointer:coarse)').matches || innerWidth <= 640;
  hov.style.display = touch ? 'none' : '';
  tch.style.display = touch ? 'inline' : 'none';
}
function c2id() { return state.session.queue[state.session.idx].id; }

/* 解析区块：答题页与练习报告共用，保证两处展示一致 */
function revealHtml(f) {
  if (!f) return '';
  return `<div class="reveal">
      ${f.mother ? `<div class="sec mother"><h4>🧩 母题抽象</h4>${inlineMd(f.mother)}</div>` : ''}
      ${f.reasoning ? `<div class="sec"><h4>🔗 推理链</h4>${inlineMd(f.reasoning)}</div>` : ''}
      ${f.fastest ? `<div class="sec fastest"><h4>⚡ 最快解法</h4>${inlineMd(f.fastest)}</div>` : ''}
      ${f.pitfalls ? `<div class="sec pitfalls"><h4>⚠ 易错点</h4>${inlineMd(f.pitfalls)}</div>` : ''}
      ${f.analysis ? `<div class="sec"><h4>📘 官方解析</h4>${f.analysis}</div>` : ''}
      ${f.doubt ? `<div class="sec doubt"><h4>❓ 疑点待复核</h4>${inlineMd(f.doubt)}</div>` : ''}
      ${f.verified ? `<div class="sec verified">
        <h4>✅ 联网复核结论${f.verified.status === 'confirmed' ? '（官方答案确认无误）' : ''}</h4>
        <p>经权威来源核实，本题正确答案为 <b>${esc(f.verified.answer || '')}</b>。</p>
        ${f.verified.supplement ? `<p><b>补全的数据链</b>：${esc(f.verified.supplement)}</p>` : ''}
        ${f.verified.reasoning ? `<p>${esc(f.verified.reasoning)}</p>` : ''}
        ${f.verified.source_url ? `<p class="vsrc">来源：<a href="${esc(f.verified.source_url)}" target="_blank" rel="noopener">${esc(f.verified.source_name || '查看来源')}</a></p>` : ''}
      </div>` : ''}
    </div>`;
}

/* ---------- 先答后对模式：作答只记录，不揭示 ---------- */
function deferredChoose(key) {
  const S = state.session, c = S.queue[S.idx];
  if (!S || S.submitted) return;
  stopLimitTimer();
  const firstPick = !S.answers[c.id];
  S.answers[c.id] = key;
  S.spent[c.id] = qElapsed(S);     // 本题用时是「累计值」，直接覆盖而不是累加（回看不会重复计数）
  clockStartQ(S);
  saveSession();
  renderOptions();
  // 选择即落库：中途退出也能在「今日回溯」里看到做到哪一题、选了什么。
  // 交卷时再整组写一次（含未改选的题与最终判定），以那时的状态为准。
  markPractice(S, [{ qid: c.qid, choice: key, correct: 0, timeout: 0, ms: Math.round(S.spent[c.id] || 0), pos: S.idx + 1 }]);
  // 首次作答自动进入下一题（改选不跳题；最后一题停留，等待交卷）
  if (firstPick && S.idx < S.queue.length - 1) setTimeout(() => {
    if (state.session !== S || S.submitted) return;
    if (kgSuspect()) return;      // 这 220ms 内用户又开始划字了：留在本题，别莫名其妙跳走
    deferredGoto(S.idx + 1);
  }, 220);
}
function deferredGoto(i) {
  const S = state.session; if (!S || i < 0 || i >= S.queue.length) return;
  const cur = S.queue[S.idx];
  if (cur) S.spent[cur.id] = Math.max(S.spent[cur.id] || 0, qElapsed(S));
  S.idx = i; renderCard(); saveSession();
}
function deferredTimeout() {
  const S = state.session, c = S.queue[S.idx];
  if (!S || !c) return;
  S.spent[c.id] = qElapsed(S);
  S.timeouts = S.timeouts || {}; S.timeouts[c.id] = 1;
  if (S.idx < S.queue.length - 1) deferredGoto(S.idx + 1); else renderOptions();
}
function renderDeferredAct() {
  const S = state.session, act = document.getElementById('act'); if (!act) return;
  const n = S.queue.length, done = S.queue.filter(c => S.answers[c.id]).length;
  const last = S.idx >= n - 1;
  const mk = S.marked ? Array.from(S.marked) : [];
  act.innerHTML = `
    <div class="sheet-card">
      <div class="sheet-card-head"><b>答题卡</b><span class="sub" style="margin:0">已答 ${done} / ${n} · 交卷前不显示对错</span>
        ${mk.length ? `<button type="button" class="btn sm ghost" id="mk-list">⚑ 已标记 ${mk.length}</button>` : ''}</div>
      <div class="exam-nav">${S.queue.map((c, i) => `<button type="button" class="exam-dot ${S.answers[c.id] ? 'answered' : ''} ${i === S.idx ? 'cur' : ''}" data-i="${i}">${i + 1}</button>`).join('')}</div>
      <div id="mk-box" hidden></div>
    </div>
    <div class="row deferred-nav">
      <button class="btn ghost" id="dq-prev" ${S.idx === 0 ? 'disabled' : ''}>← 上一题</button>
      <div class="row">
        ${last ? '' : `<button class="btn" id="dq-next">下一题 →</button>`}
        <button class="btn ok" id="dq-submit">✅ 交卷并查看报告</button>
      </div>
    </div>`;
  act.querySelectorAll('.exam-dot').forEach(b => b.onclick = () => deferredGoto(+b.dataset.i));
  document.getElementById('dq-prev').onclick = () => deferredGoto(S.idx - 1);
  const nx = document.getElementById('dq-next'); if (nx) nx.onclick = () => deferredGoto(S.idx + 1);
  document.getElementById('dq-submit').onclick = () => deferredSubmit(false);
  // 本组临时标记：随时可看，点一条直接跳到那题（标记只在本次练习内有效）
  const mkb = document.getElementById('mk-list');
  if (mkb) mkb.onclick = () => {
    const box = document.getElementById('mk-box');
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<p class="sub" style="margin:8px 0 4px">本组已标记 ${mk.length} 题 · 仅本次练习有效，交卷后清空</p>` +
      mk.map(id => {
        const i = S.queue.findIndex(x => String(x.id) === String(id));
        if (i < 0) return '';
        const c = S.queue[i];
        const stem = String(c.stem || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 34);
        return `<button type="button" class="mk-row" data-i="${i}">第 ${i + 1} 题 · ${esc(stem)}${stem.length >= 34 ? '…' : ''}</button>`;
      }).join('');
    box.querySelectorAll('.mk-row').forEach(b => b.onclick = () => deferredGoto(+b.dataset.i));
  };
}

/* 交卷：批量取答案判分 → 写入记忆曲线（对→一般 / 错或未答→忘记）→ 生成报告 */
async function deferredSubmit(force) {
  const S = state.session; if (!S || S.submitted) return;
  const unanswered = S.queue.filter(c => !S.answers[c.id]).length;
  if (!force && unanswered && !confirm(`还有 ${unanswered} 题未作答，未答题将按答错计入。确定交卷吗？`)) return;
  stopLimitTimer();
  const cur = S.queue[S.idx];
  if (cur) S.spent[cur.id] = Math.max(S.spent[cur.id] || 0, qElapsed(S));
  S.submitted = true;
  captureInk();                       // 交卷即本组结束，笔迹随之清除
  loading('判分中…');
  try {
    const fulls = await Promise.all(S.queue.map(c => S.fulls[c.id]
      ? Promise.resolve(S.fulls[c.id])
      : API('/api/question?id=' + c.id).then(d => d.card)));
    S.queue.forEach((c, i) => { S.fulls[c.id] = fulls[i]; });
  } catch (e) { S.submitted = false; return fatal('判分失败，请检查网络后重试：' + e); }
  const results = S.queue.map(c => {
    const f = S.fulls[c.id], chosen = S.answers[c.id] || '';
    const right = !!(chosen && chosen === f.answer);
    return {
      card: c, full: f, chosen, right, ms: S.spent[c.id] || 0,
      grade: right ? 4 : 1,          // 默认强度：答对=一般，答错/未答=忘记
      rated: false,
    };
  });
  // 先答后对也有记忆曲线了：交卷时不写死分数，复盘页用 1/2/3/4 自评记忆强度后写入复习计划；
  // 一直没自评的题，在离开报告/关页面时按默认强度补写，保证智能复习与错题本不漏记。
  // 回溯：交卷这一刻的选择就是「对答案时的状态」，一次性落库，之后再自评也不会改它。
  await markPractice(S, results.map((r, i) => ({
    qid: r.card.qid, choice: r.chosen || '', correct: r.right ? 1 : 0,
    timeout: (S.timeouts && S.timeouts[r.card.id]) ? 1 : 0,
    ms: r.ms || 0, pos: i + 1,
  })), { finish: 1, total_ms: Math.round(allElapsed(S) || 0) });
  S.tally = { done: results.length, right: results.filter(r => r.right).length, wrong: results.filter(r => !r.right).length };
  S.report = { results, gradeFail: 0, submittedAt: new Date(), totalMs: allElapsed(S) };
  clearSession();
  clearInkStore();
  clearUlStore();
  refreshSide();
  renderReport();
}

/* 复盘自评：把记忆强度写进复习计划（先答后对）。每题只写一次，写完即锁定，避免重复计入记忆曲线 */
async function rateReportItem(r, g, box) {
  if (!r || r.rated) return;
  r.grade = g;
  if (box) box.querySelectorAll('.gbtn').forEach(b => { b.classList.toggle('on', +b.dataset.g === g); b.disabled = true; });
  const tip = document.getElementById('ra-grade-tip');
  if (tip) tip.textContent = '写入中…';
  if (state.gradeCtx) state.gradeCtx = null;
  const S = state.session;
  try {
    const d = await POST('/api/grade', {
      id: r.card.id, grade: g, choice: r.chosen || '',
      timeout: (S && S.timeouts && S.timeouts[r.card.id]) ? 1 : 0,
    });
    r.rated = true;
    if (tip) tip.textContent = d && d.interval ? `已写入复习计划 · 下次 ${d.interval} 天后` : '已写入复习计划';
    refreshSide();
  } catch (e) {
    r.rated = false;
    if (box) box.querySelectorAll('.gbtn').forEach(b => { b.disabled = false; });
    if (tip) tip.textContent = '写入失败，可重试';
  }
}
/* 离开报告 / 关页面：没自评的题按默认强度（答对一般 / 答错忘记）补写，避免漏记 */
function flushReportGrades(useBeacon) {
  const S = state.session, R = S && S.report;
  if (!R || !R.results) return;
  R.results.forEach(r => {
    if (r.rated) return;
    r.rated = true;
    const body = { id: r.card.id, grade: r.grade || (r.right ? 4 : 1), choice: r.chosen || '', timeout: (S.timeouts && S.timeouts[r.card.id]) ? 1 : 0 };
    if (useBeacon && navigator.sendBeacon) {
      try {
        const blob = new Blob([JSON.stringify(Object.assign({}, body, { token: tok() }))], { type: 'application/json' });
        if (navigator.sendBeacon('/api/grade', blob)) return;
      } catch (e) { }
    }
    POST('/api/grade', body).catch(() => { });
  });
}

function toggleNote() {
  const area = document.getElementById('note-area'); if (!area) return;
  if (area.dataset.open === '1') { area.innerHTML = ''; area.dataset.open = '0'; return; }
  const f = state.session.full;
  area.dataset.open = '1';
  area.innerHTML = `<div class="note-box"><h4>📝 我的笔记</h4>
    <textarea id="note-ta" placeholder="写下你的思路、易错提醒、秒杀技巧…">${esc(f.note || '')}</textarea>
    <div class="row"><span class="note-saved" id="note-saved">${f.note_updated ? '上次保存 ' + esc(f.note_updated) : ''}</span>
    <button class="btn sm ok" id="note-save">保存笔记</button></div></div>`;
  document.getElementById('note-save').onclick = async () => {
    const text = document.getElementById('note-ta').value.trim();
    await POST('/api/note', { id: c2id(), text });
    f.note = text;
    document.getElementById('note-saved').textContent = text ? '已保存 ✓' : '已清空笔记';
  };
}

async function doReveal() {
  const S = state.session, c = S.queue[S.idx];
  stopLimitTimer();
  try { const d = await API('/api/question?id=' + c.id); S.full = d.card; } catch (e) { return fatal(e); }
  S.phase = 'answer'; renderOptions();
  // 看到答案这一刻也落一条：万一没点自评就离开，回溯里仍能看到当时选了什么
  const ans = (S.full && S.full.answer) || '';
  markPractice(S, [{
    qid: c.qid, choice: S.chosen || '', timeout: 0, pos: S.idx + 1, ms: Math.round(qElapsed(S)),
    correct: (S.chosen && String(S.chosen).toUpperCase() === String(ans).toUpperCase()) ? 1 : 0,
  }]);
}

async function doGrade(g) {
  const S = state.session, c = S.queue[S.idx];
  if (S._grading) return;          // 自评立即跳转后，连按 1/2/3/4 不能重复评分
  S._grading = true;
  const dur = qElapsed(S);
  S.times.push(dur); stopLimitTimer();
  let gr = null;
  try { gr = await POST('/api/grade', { id: c.id, grade: g, choice: S.chosen || '' }); } catch (e) { }
  if (gr && typeof gr.interval === 'number') S.lastInterval = gr.interval;
  // 回溯：边答边对记「看答案那一刻」的选择与客观正误；复习模式没有选项，用自评档位判对错
  const ans = (S.full && S.full.answer) || '';
  const correct = isRev(S)
    ? (g >= 3 ? 1 : 0)
    : ((S.chosen && String(S.chosen).toUpperCase() === String(ans).toUpperCase()) ? 1 : 0);
  markPractice(S, [{ qid: c.qid, choice: S.chosen || '', correct, timeout: 0, ms: dur, pos: S.idx + 1 }]);
  refreshSide();
  S.graded = g;
  S._grading = false;
  if (isRev(S)) {
    // 需求：复习自评后立即进入下一题，不再有停留延迟
    nextCard();
    return;
  }
  renderNextBar(false);
  saveSession();
}

function nextCard() {
  const S = state.session; if (!S) return;
  clearTimeout(S._autoT);
  S.graded = 0;
  S._grading = false;      // 换题即解锁：下一题必须能正常自评
  S.idx++;
  if (S.idx >= S.queue.length) {
    // 这一批题做完了：回溯里把本组收尾；接着抽到的下一批算新的一组
    endPractice(S);
    S.gid = ''; S.gidPending = null;
    moreCards().then(() => { ensureGid(S); renderCard(); });
  } else renderCard();
  saveSession();
}

/* 丢弃本题：服务端记一笔（所有练习模式都不再抽到它），并从本组队列里拿掉。
   记录保留在「真题浏览 → 已丢弃」里，随时可以恢复。 */
async function dropCurrent() {
  const S = state.session;
  if (!S || !S.queue || !S.queue.length) return;
  const c = S.queue[S.idx]; if (!c) return;
  if (S._dropping) return;
  const left = S.queue.length - 1;
  const tip = '· 本题不再出现在任何练习里（新题 / 错题重练 / 复习到期都跳过）；\n'
    + '· 可在「真题浏览 → 已丢弃」中找到并恢复。';
  if (!confirm(`丢弃第 ${S.idx + 1} 题？\n\n${tip}${left ? '' : '\n\n这是本组最后一题，丢弃后会抽取下一批题。'}`)) return;
  S._dropping = true;
  try { await POST('/api/discard', { id: c.id, on: 1 }); }
  catch (e) { S._dropping = false; toast('丢弃失败：' + (e.message || e)); return; }
  S._dropping = false;
  stopLimitTimer();
  captureInk();
  S.queue.splice(S.idx, 1);
  if (S.answers) delete S.answers[c.id];
  if (S.spent) delete S.spent[c.id];
  if (S.fulls) delete S.fulls[c.id];
  if (S.marked) S.marked.delete(c.id);
  if (!S.queue.length) {           // 整组丢完：收工回总览
    clearSession();
    toast('本组已全部丢弃');
    location.hash = '#/';
    return;
  }
  if (S.idx >= S.queue.length) {   // 丢的是最后一题：按「做完最后一题」继续抽题或收尾
    S.idx = S.queue.length - 1;
    saveSession();
    nextCard();
    return;
  }
  S.phase = 'question'; S.chosen = null; S.full = null; S.graded = 0;
  renderCard();
  saveSession();
  toast('已丢弃 · 可在「真题浏览 → 已丢弃」里找回');
}

function renderNextBar(auto) {
  const box = document.getElementById('act'); if (!box) return;
  const S = state.session;
  const last = S.idx >= S.queue.length - 1;
  if (auto) {
    // 复习模式：自评后自动进入下一题，只提示下次时间，留一个「停留查看」的口子
    const nxt = S.lastInterval === 0 ? '今天再练'
      : (S.lastInterval ? `下次 ${S.lastInterval} 天后` : '已记录');
    const html = `<span class="nx-tip">✓ 已记录 · ${nxt}复习 · 即将进入${last ? '完成页' : '下一题'}…</span>
      <button class="btn ghost sm nx-stay">停留查看</button>`;
    const g = box.querySelector('.grade');
    if (g) { g.classList.add('nextbar'); g.innerHTML = html; }
    else box.insertAdjacentHTML('beforeend', `<div class="grade nextbar">${html}</div>`);
    const stay = box.querySelector('.nx-stay');
    if (stay) stay.onclick = () => { clearTimeout(S._autoT); renderNextBar(false); };
    return;
  }
  // 只换掉评分区：答案、解析、笔记都要留在页面上（原先整块替换会让它们消失）
  const html = `<span class="nx-tip">已记录 · 看完解析再继续</span>
    <button class="btn ok nx-go">${last ? '完成本组 →' : '下一题 →'} <small>空格</small></button>`;
  const g = box.querySelector('.grade');
  if (g) { g.classList.add('nextbar'); g.innerHTML = html; }
  else box.insertAdjacentHTML('beforeend', `<div class="grade nextbar">${html}</div>`);
  const go = box.querySelector('.nx-go');
  if (go) { go.onclick = nextCard; go.focus({ preventScroll: true }); }
}

/* ---------- 做题计时：本题用时 / 本组累计用时（可暂停；离开练习自动暂停，回来继续） ----------
   计时不再用「当前时间 - 开始时间」，而是「累计毫秒 + 本次运行起点」：
   暂停时把这段运行区间结算进累计值、运行起点清零，时间就真正停住；
   离开练习或关掉标签页再回来，离开的那段时间不会被算进去。 */
function fmtClock(ms) {
  const t = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
  const p = n => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}
let CLOCK_TIMER = null;
function qElapsed(S) { if (!S) return 0; return (S.qAcc || 0) + (S.qRun ? Date.now() - S.qRun : 0); }
function allElapsed(S) { if (!S) return 0; return (S.cAcc || 0) + (S.cRun ? Date.now() - S.cRun : 0); }
function isClockPaused(S) { return !!S && !S.cRun; }
function clockPause(S) {
  if (!S || !S.cRun) return false;
  const t = Date.now();
  if (S.qRun) { S.qAcc = (S.qAcc || 0) + (t - S.qRun); S.qRun = 0; }
  S.cAcc = (S.cAcc || 0) + (t - S.cRun); S.cRun = 0;
  pauseLimitTimer(S);              // 单题倒计时跟着一起冻结
  return true;
}
function clockResume(S) {
  if (!S || S.cRun) return false;
  const t = Date.now();
  S.cRun = t;
  if (!S.qRun) S.qRun = t;
  resumeLimitTimer(S);
  return true;
}
/* 换题：先把上一题的用时结算进 qTimes，再把这道题已累计的用时恢复出来。
   以前换题一律归零，先答后对回看做过得题时会重新计时；现在按题目 id 记账，
   回到做过的题就是在原用时上继续走。 */
function clockStartQ(S, qid) {
  if (!S) return;
  const t = Date.now();
  if (S.qRun) { S.qAcc = (S.qAcc || 0) + (t - S.qRun); S.qRun = 0; }
  S.qTimes = S.qTimes || {};
  if (S.qQid != null) S.qTimes[S.qQid] = S.qAcc || 0;
  if (qid != null) {
    S.qQid = qid;
    S.qAcc = Math.max(0, +S.qTimes[qid] || 0);   // 做过的题接着算，没做过才是 0
  }
  S.qRun = S.cRun ? t : 0;
}
function syncClockUi(S) {
  const box = document.getElementById('qtimer'); if (!box) return;
  const paused = isClockPaused(S);
  box.classList.toggle('paused', paused);
  const ic = document.getElementById('qt-icon'); if (ic) ic.textContent = paused ? '▶' : '⏱';
  const hint = document.getElementById('qt-hint'); if (hint) hint.textContent = paused ? '已暂停 · 点此继续' : '';
  box.title = paused ? '计时已暂停，点击继续' : '左键单击这里可暂停计时';
}
function tickClock() {
  const S = state.session;
  const nowEl = document.getElementById('qt-now'), allEl = document.getElementById('qt-all');
  if (!S || !nowEl || !allEl) return;
  nowEl.textContent = fmtClock(qElapsed(S));
  allEl.textContent = fmtClock(allElapsed(S));
  syncClockUi(S);
}
function startClock() {
  stopClock();
  const S = state.session;
  if (!S || !document.getElementById('qtimer')) return;
  clockResume(S);                  // 进入答题 / 换题 / 从别的页面回来都自动继续
  tickClock();
  CLOCK_TIMER = setInterval(tickClock, 500);
}
function stopClock() {
  if (CLOCK_TIMER) { clearInterval(CLOCK_TIMER); CLOCK_TIMER = null; }
}
/* 离开练习：结算本段运行时间并暂停；重进时 startClock 从暂停处继续 */
function pauseClock() {
  const S = state.session;
  if (S) clockPause(S);
  stopClock();
  // 先答后对中途离开：把已选答案先落库，回溯里能看到「做到哪、选了什么」
  if (S && isDeferred(S) && !S.submitted && S.answers) {
    const now = Date.now();
    if (!S.markAt || now - S.markAt > 60000) {
      const items = (S.queue || []).map((c, i) => {
        const ch = S.answers[c.id];
        if (!ch) return null;
        return {
          qid: c.qid, choice: ch, correct: 0, timeout: 0, pos: i + 1,
          ms: Math.round((S.spent && S.spent[c.id]) || (S.qQid === c.id ? qElapsed(S) : 0) || 0),
        };
      }).filter(Boolean);
      if (items.length) { S.markAt = now; markPractice(S, items); }
    }
  }
  try { saveSession(); } catch (e) { }
}
/* 左键点时间：暂停 / 继续 */
function toggleClockPause() {
  const S = state.session; if (!S) return;
  if (isClockPaused(S)) { clockResume(S); startClock(); }
  else { clockPause(S); stopClock(); }
  syncClockUi(S);
  stSync();                        // 暂停期间不算学习时长
  try { saveSession(); } catch (e) { }
}

/* ---------- 学习时长：答题 + 看解析 的连续计时 ----------
   不做「题数 × 平均时长」估算，按秒实时累计：只要停留在答题页 / 解析页且标签页可见就计入，
   点计时胶囊暂停、切到后台、回到总览或设置页则停止。每 20 秒把增量上报一次（离开页面时立刻上报），
   服务端按天累加进 study_time 表，总览面板据此显示「今日学习时长 / 总学习时长」。 */
const ST_ROUTES = new Set(['#/study', '#/review', '#/wrongbook', '#/favorites', '#/materials',
  '#/detail', '#/exam', '#/browse', '#/kadian', '#/doubts']);
const ST = { acc: 0, sent: 0, last: 0, timer: null, sending: false, p: null };

function stShouldRun() {
  if (document.hidden) return false;
  const h = (location.hash || '#/').split('?')[0];
  if (!ST_ROUTES.has(h)) return false;                       // 总览 / 统计 / 设置不算学习
  const S = state.session;
  // 只有"计时胶囊就在眼前且被手动暂停"时才不计时；离开答题页后暂停状态不该继续影响其它页面
  if (S && !S.submitted && isClockPaused(S) && document.getElementById('qtimer')) return false;
  return true;
}
function stStep() {
  const t = Date.now(); const d = t - ST.last; ST.last = t;
  if (d > 0) ST.acc += Math.min(d, 10000);   // 休眠 / 后台节流造成的超长间隔不计
}
/* 常驻 1 秒心跳：该计时就累加，不该计时只把时间基准推后（不补算），
   这样在答题页 / 解析页 / 报告页之间来回切换都不会漏计或重复计。 */
function stTick() {
  if (!stShouldRun()) { ST.last = Date.now(); return; }
  stStep();
  if (ST.acc - ST.sent >= 20000) stFlush(false);
}
function stBoot() {
  if (ST.timer) return;
  ST.last = Date.now();
  ST.timer = setInterval(stTick, 1000);
}
function stSync() {
  const h = (location.hash || '#/').split('?')[0];
  // 离开学习页 / 切到后台：把还没上报的零头立刻落库，回到总览时数字才对得上
  if (!stShouldRun() && (!ST_ROUTES.has(h) || document.hidden)) stFlush(false);
}
function stFlush(keepalive) {
  const pend = Math.round(ST.acc - ST.sent);
  if (pend < 1000) return Promise.resolve();
  if (ST.sending) return ST.p || Promise.resolve();
  const upto = ST.acc;
  ST.sending = true;
  ST.p = fetch(withU('/api/study-time'), {
    method: 'POST', keepalive: !!keepalive,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ms: pend, token: tok() }),
  }).then(r => (r && r.ok) ? r.json() : null).then(j => {
    ST.sent = upto;
    if (j && typeof j.today_ms === 'number') { ST.todayMs = j.today_ms; ST.totalMs = j.total_ms || 0; }
  }).catch(() => { /* 网络失败：增量留着下次重试 */ }).then(() => { ST.sending = false; });
  return ST.p;
}
/* 把手上未上报的时长送出去并等它落库（总览 / 统计页取数前调用，保证卡片数字当场就是准的） */
async function stSettle() {
  for (let i = 0; i < 3; i++) {
    try { await stFlush(false); } catch (e) { }
    if (!ST.sending) break;
  }
}
/* 时长展示：卡片里用带小号单位的形式，避免「1 小时 23 分」把大数字撑换行 */
function durHtml(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 60000));
  if (total < 1) return (ms > 0 ? '&lt;1' : '0') + '<small>分</small>';
  if (total < 60) return total + '<small>分</small>';
  const h = Math.floor(total / 60), m = total % 60;
  return h + '<small>小时</small>' + (m ? m + '<small>分</small>' : '');
}
function durText(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 60000));
  if (total < 1) return '不到 1 分钟';
  if (total < 60) return total + ' 分钟';
  const h = Math.floor(total / 60), m = total % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

/* 紧凑时长：看板小卡片里用，避免「1 小时 30 分」被列宽截断 */
function durTight(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (!h) return m + 'm';
  return h + 'h' + (m % 60 ? (m % 60) + 'm' : '');
}

/* ---------- 功能2：限时模式倒计时 / 超时自动判错 ---------- */
function startLimitTimer(sec, qid) {
  const S = state.session; if (!S) return;
  // 同一题暂停过后重新渲染：按剩余时间接着走，而不是重新满血计时
  const reuse = qid && S.limitQid === qid && S.limitRemainMs > 0;
  const ms = reuse ? S.limitRemainMs : sec * 1000;
  stopLimitTimer();
  S.limitQid = qid || null;
  S.limitSec = Math.max(1, Math.round(ms / 1000));
  S.limitDeadline = Date.now() + ms;
  const box = document.getElementById('ctime-box'); if (!box) return;
  box.innerHTML = `<div class="ctime" id="ctime" title="本题限时剩余秒数"><span class="ct-ring" aria-hidden="true"></span><span id="ctime-n">${Math.ceil(S.limitSec)}</span></div>`;
  tickLimit();
  S.limitInterval = setInterval(tickLimit, 200);
}
function stopLimitTimer() {
  const S = state.session;
  if (S && S.limitInterval) { clearInterval(S.limitInterval); S.limitInterval = null; }
  if (S) { S.limitDeadline = 0; S.limitRemainMs = 0; }
}
function pauseLimitTimer(S) {
  if (!S || !S.limitInterval) return;
  clearInterval(S.limitInterval); S.limitInterval = null;
  S.limitRemainMs = Math.max(0, (S.limitDeadline || 0) - Date.now());
  S.limitDeadline = 0;
}
function resumeLimitTimer(S) {
  if (!S || S.limitInterval || !S.limitRemainMs) return;
  S.limitDeadline = Date.now() + S.limitRemainMs;
  S.limitRemainMs = 0;
  S.limitInterval = setInterval(tickLimit, 200);
}
function tickLimit() {
  const S = state.session; if (!S || !S.limitDeadline) return;
  const remain = Math.max(0, (S.limitDeadline - Date.now()) / 1000);
  const el = document.getElementById('ctime'); if (!el) return;
  const pct = Math.max(0, Math.min(100, remain / (S.limitSec || 1) * 100));
  el.style.setProperty('--v', pct.toFixed(1));
  el.classList.toggle('low', remain <= 10);
  const n = document.getElementById('ctime-n'); if (n) n.textContent = Math.ceil(remain);
  if (remain <= 0) { stopLimitTimer(); if (isDeferred(S)) deferredTimeout(); else timeoutCurrent(); }
}
async function timeoutCurrent() {
  const S = state.session, c = S.queue[S.idx];
  if (!S || !c) return;
  const dur = qElapsed(S);
  S.times.push(dur); stopLimitTimer();
  try { await POST('/api/grade', { id: c.id, grade: 1, timeout: 1, choice: '' }); } catch (e) { }
  markPractice(S, [{ qid: c.qid, choice: '', correct: 0, timeout: 1, ms: dur, pos: S.idx + 1 }]);
  S.tally.done++; S.tally.wrong++; S.timeoutN = (S.timeoutN || 0) + 1;
  refreshSide();
  S.graded = 1;
  renderNextBar();
  saveSession();
}

async function moreCards() {
  const S = state.session, p = new URLSearchParams();
  p.set('mode', S.mode); p.set('size', String((S.cfg && S.cfg.size) || loadSessionSize()));
  const cfg = S.cfg || {};
  if (cfg.module) p.set('module', cfg.module);
  if (cfg.category) p.set('category', cfg.category);
  if (cfg.kadian) p.set('kadian', cfg.kadian);
  if (cfg.ref) p.set('ref', cfg.ref);
  let res = { cards: [] }; try { res = await API('/api/next?' + p); } catch (e) { }
  if (res.cards.length) { S.queue = res.cards; S.idx = 0; }
}

/* ---------- 练习报告（先答后对交卷后） ---------- */
function fmtDur(ms) {
  const s = Math.round((ms || 0) / 1000);
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60), r = s % 60;
  return m + ' 分' + (r ? ' ' + r + ' 秒' : '');
}
function fmtStamp(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/* 半环仪表盘：按正确率填充，颜色随正确率分档 */
function gaugeSvg(right, total) {
  const pct = total ? right / total : 0;
  const r = 80, cx = 100, cy = 100, len = Math.PI * r;
  const color = pct >= 0.8 ? 'var(--ok)' : pct >= 0.6 ? 'var(--brand)' : 'var(--bad)';
  return `<svg class="rp-gauge" viewBox="0 0 200 120" role="img" aria-label="答对 ${right} / ${total}">
    <path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}" fill="none" stroke="var(--paper-2)" stroke-width="14" stroke-linecap="round"/>
    <path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round"
      stroke-dasharray="${(len * pct).toFixed(1)} ${len.toFixed(1)}"/>
    <text x="${cx}" y="62" text-anchor="middle" class="rp-g-l">答对</text>
    <text x="${cx}" y="96" text-anchor="middle" class="rp-g-n">${right}</text>
    <text x="${cx}" y="116" text-anchor="middle" class="rp-g-t">/${total}</text>
  </svg>`;
}
function renderReport() {
  stopClock();
  const S = state.session; if (!S || !S.report) return;
  const R = S.report, rs = R.results, total = rs.length;
  const right = rs.filter(r => r.right).length;
  const unanswered = rs.filter(r => !r.chosen).length;
  const wrong = total - right - unanswered;
  const acc = total ? Math.round(right / total * 100) : 0;
  const spentMs = rs.reduce((a, r) => a + r.ms, 0) || R.totalMs;
  // 按模块分组统计
  const byMod = {};
  rs.forEach(r => {
    const k = r.card.module || '其他';
    const m = byMod[k] || (byMod[k] = { n: 0, right: 0, ms: 0 });
    m.n++; if (r.right) m.right++; m.ms += r.ms;
  });
  const cfg = S.cfg || {};
  const scope = [cfg.module, cfg.category].filter(Boolean).join(' / ') || '全部模块';
  app.innerHTML = `
  <div class="report">
    <div class="rp-top">
      <a class="btn sm ghost" href="#/study">← 返回练习</a>
      <h1 style="margin:0">练习报告</h1><span></span>
    </div>
    <section class="card rp-hero">
      <span class="rp-acc ${acc >= 80 ? 'good' : acc >= 60 ? 'mid' : 'low'}">正确率 ${acc}%</span>
      ${gaugeSvg(right, total)}
      <dl class="rp-meta">
        <div><dt>练习类型</dt><dd>${esc(MODE_LABEL[S.mode] || '练习')}（${esc(scope)}）· 先答后对</dd></div>
        <div><dt>交卷时间</dt><dd>${fmtStamp(R.submittedAt)}</dd></div>
      </dl>
    </section>
    <section class="card">
      <h2 class="rp-h">考试情况</h2>
      <div class="rp-stats">
        <div><span>一共</span><b class="c-brand">${total}<small>题</small></b></div>
        <div><span>答对</span><b class="c-ok">${right}<small>题</small></b></div>
        <div><span>答错</span><b class="c-bad">${wrong}<small>题</small></b></div>
        <div><span>未答</span><b class="c-muted">${unanswered}<small>题</small></b></div>
        <div><span>总用时</span><b class="c-brand">${fmtDur(spentMs)}</b></div>
      </div>
      ${Object.entries(byMod).map(([k, m]) => `
        <div class="rp-mod"><b>${esc(k)}</b>
          <span class="sub" style="margin:0">共 ${m.n} 题，答对 ${m.right} 题，正确率 ${Math.round(m.right / m.n * 100)}%，用时 ${fmtDur(m.ms)}</span>
          <div class="pbar"><i style="width:${m.right / m.n * 100}%;background:var(--ok)"></i></div>
        </div>`).join('')}
      ${R.gradeFail ? `<p class="rp-warn">⚠ 有 ${R.gradeFail} 题的作答记录未能写入复习计划（网络异常），报告本身不受影响。</p>` : ''}
    </section>
    <section class="card">
      <div class="rp-card-head"><h2 class="rp-h" style="margin:0">答题卡</h2>
        <span class="rp-legend"><i class="lg-none"></i>未答 <i class="lg-ok"></i>答对 <i class="lg-bad"></i>答错</span></div>
      <div class="rp-dots">${rs.map((r, i) => `<button type="button" class="rp-dot ${!r.chosen ? 'none' : r.right ? 'ok' : 'bad'}" data-i="${i}" title="第 ${i + 1} 题">${i + 1}</button>`).join('')}</div>
      <p class="sub" style="margin:10px 0 0">点击题号可直接查看该题解析；解析页按 <b>1 / 2 / 3 / 4</b> 自评记忆强度（忘记 / 困难 / 一般 / 熟悉），系统据此安排复习</p>
    </section>
    <div class="rp-actions">
      <button class="btn ghost big" id="rp-all">全部解析</button>
      <button class="btn ok big" id="rp-wrong" ${right === total ? 'disabled title="本次全部答对"' : ''}>错题解析${right === total ? '' : `（${total - right}）`}</button>
    </div>
    <div class="row" style="justify-content:center;margin-top:12px">
      <a class="btn ghost sm" href="#/study">再练一组</a>
      <a class="btn ghost sm" href="#/wrongbook">看错题本</a>
      <a class="btn ghost sm" href="#/">返回总览</a>
    </div>
  </div>`;
  window.scrollTo(0, 0);
  document.getElementById('rp-all').onclick = () => renderReportAnalysis('all', 0);
  const wb = document.getElementById('rp-wrong'); if (wb) wb.onclick = () => renderReportAnalysis('wrong', 0);
  app.querySelectorAll('.rp-dot').forEach(b => b.onclick = () => {
    const i = +b.dataset.i; renderReportAnalysis('all', i);
  });
}
/* 解析浏览：filter=all|wrong，pos 为该列表内的位置。
   ctx 让「练习报告」与「今日回溯」共用同一套界面：
   back/backLabel/doneLabel 控制入口文案，history 时标出超时，grade=false 时隐藏记忆强度自评。 */
function analysisPage(rows, filter, pos, ctx) {
  ctx = ctx || {};
  const back = ctx.back || renderReport;
  const list = rows.map((r, i) => ({ r, i })).filter(x => filter === 'all' || !x.r.right);
  if (!list.length) return back();
  pos = Math.max(0, Math.min(list.length - 1, pos));
  const { r, i } = list[pos], c = r.full;
  const verdict = ctx.review
    ? (r.right ? `<span class="tag review">✓ 当时自评：记得 · 正确答案 ${esc(c.answer)}</span>`
      : `<span class="tag wrong-tag">✗ 当时自评：遗忘 · 正确答案 ${esc(c.answer)}</span>`)
    : r.timeout ? `<span class="tag wrong-tag">⏱ 超时${r.chosen ? ` · 你选 ${esc(r.chosen)}` : ''} · 正确答案 ${esc(c.answer)}</span>`
      : !r.chosen ? `<span class="tag learning">未作答 · 正确答案 ${esc(c.answer)}</span>`
        : r.right ? `<span class="tag review">✓ 答对 · 正确答案 ${esc(c.answer)}</span>`
          : `<span class="tag wrong-tag">✗ 你选 ${esc(r.chosen)} · 正确答案 ${esc(c.answer)}</span>`;
  app.innerHTML = `
  <div class="report">
    <div class="rp-top">
      <button class="btn sm ghost" id="ra-back">${ctx.backLabel || '← 返回报告'}</button>
      <b>${filter === 'all' ? '全部解析' : '错题解析'} · ${pos + 1} / ${list.length}</b>
      <span class="sub" style="margin:0">原第 ${i + 1} 题</span>
    </div>
    <div class="rp-dots compact">${list.map((x, k) => `<button type="button" class="rp-dot ${x.r.timeout ? 'bad' : !x.r.chosen ? 'none' : x.r.right ? 'ok' : 'bad'} ${k === pos ? 'cur' : ''}" data-k="${k}">${x.i + 1}</button>`).join('')}</div>
    <article class="card">
      <div class="qhead">
        <span class="tag">${esc(c.module)}/${esc(c.category)}</span>
        <span class="tag">${esc(c.region || '?')} ${esc(c.year || '')}</span>
        ${verdict}
        <span class="sub" style="margin:0">用时 ${fmtDur(r.ms)}</span>
      </div>
      ${c.material ? `<details class="material-wrap"><summary style="cursor:pointer;color:var(--brand);margin-bottom:8px">📄 给定材料</summary><div class="material">${c.material}</div></details>` : ''}
      <div class="stem">${c.stem || '<i>（题干为图片，见下方选项）</i>'}</div>
      <div class="opts">${c.options.map(o => `<div class="opt ${o.is_answer ? 'show-ans' : ''} ${r.chosen === o.key && o.is_answer ? 'correct' : ''} ${r.chosen === o.key && !o.is_answer ? 'wrong' : ''}">
        <span class="k">${o.key}</span><span class="body">${o.html || esc(o.label)}</span>
        ${o.is_answer ? '<span class="opt-picked ok">正确答案</span>' : (r.chosen === o.key ? '<span class="opt-picked bad">你的选择</span>' : '')}
      </div>`).join('')}</div>
      <div class="qtools" style="margin-top:14px">
        <button class="qtool ${c.fav ? 'on' : ''}" id="ra-fav">${c.fav ? '★ 已收藏' : '☆ 收藏'}</button>
        <a class="qtool" href="#/detail?id=${c.id}">🔍 完整标注</a>
        <button class="qtool ra-push" data-qn="${c.id}" data-qid="${esc(c.qid || '')}">📤 推题</button>
      </div>
      ${ctx.grade === false ? '' : `<div class="rp-grade" id="ra-grade">
        <span>记忆强度</span>
        ${GRADE_DEF.map((g, k) => `<button type="button" class="gbtn ${r.rated && r.grade === g.v ? 'on' : ''}" data-g="${g.v}" ${r.rated ? 'disabled' : ''}>${k + 1} ${g.n}</button>`).join('')}
        <span class="g-tip" id="ra-grade-tip">${r.rated ? '已写入复习计划' : `自评后写入复习计划（键盘 1/2/3/4）· 不自评则按「${r.right ? '一般' : '忘记'}」记录`}</span>
      </div>`}
      ${revealHtml(c)}
    </article>
    <div class="row deferred-nav">
      <button class="btn ghost" id="ra-prev" ${pos === 0 ? 'disabled' : ''}>← 上一题</button>
      ${pos < list.length - 1 ? `<button class="btn" id="ra-next">下一题 →</button>` : `<button class="btn ok" id="ra-done">${ctx.doneLabel || '返回报告'}</button>`}
    </div>
  </div>`;
  window.scrollTo(0, 0);
  const go = k => analysisPage(rows, filter, k, ctx);
  document.getElementById('ra-back').onclick = back;
  document.getElementById('ra-prev').onclick = () => go(pos - 1);
  const nx = document.getElementById('ra-next'); if (nx) nx.onclick = () => go(pos + 1);
  const dn = document.getElementById('ra-done'); if (dn) dn.onclick = back;
  app.querySelectorAll('.rp-dot[data-k]').forEach(b => b.onclick = () => go(+b.dataset.k));
  document.getElementById('ra-fav').onclick = async () => {
    const on = !c.fav;
    try { await POST('/api/fav', { id: c.id, on }); } catch (e) { alert('收藏失败：' + e); return; }
    c.fav = on ? 1 : 0;
    const b = document.getElementById('ra-fav'); b.classList.toggle('on', on); b.textContent = on ? '★ 已收藏' : '☆ 收藏';
    refreshSide();
  };
  const rap = document.querySelector('.ra-push');
  if (rap) rap.onclick = () => openPushDialog(c.id, c.qid, (c.module || '') + (c.category ? ' · ' + c.category : ''));
  // 记忆强度自评：点按钮或按 1/2/3/4
  const gbox = document.getElementById('ra-grade');
  if (gbox) {
    gbox.querySelectorAll('.gbtn').forEach(b => b.onclick = () => rateReportItem(r, +b.dataset.g, gbox));
    state.gradeCtx = r.rated ? null : (g => rateReportItem(r, g, gbox));
  }
}
/* 练习报告的解析入口（行为与改造前一致） */
function renderReportAnalysis(filter, pos) {
  const S = state.session; if (!S || !S.report) return;
  analysisPage(S.report.results, filter, pos, { back: renderReport });
}

/* 今日回溯：点某一组 → 直接用「交卷后解析」那套界面看这组的每一题 */
async function rvGroupAnalysis(gid, filter, pos) {
  let d;
  try { d = await API('/api/practice/group?full=1&gid=' + encodeURIComponent(gid)); }
  catch (e) { alert('加载失败：' + (e.message || e)); return; }
  const gp = d.group || {}, items = d.items || [];
  const rows = items.map(it => ({
    chosen: String(it.choice || '').toUpperCase(),
    right: !!it.correct,
    timeout: !!it.timeout,
    ms: it.ms || 0,
    rated: true,
    full: it.card || {},
  }));
  if (!rows.length) { alert('这组没有题目记录'); return; }
  analysisPage(rows, filter || 'all', pos || 0, {
    back: () => viewToday(),
    backLabel: '← 返回今天',
    doneLabel: '返回今天',
    grade: false,
    review: gp.mode === 'review',
  });
}

async function finishSession() {
  captureInk();                       // 本组结束：最后一题的笔迹先收好，随后整组清除
  const S0 = state.session; if (S0) clockPause(S0);
  if (S0) endPractice(S0);            // 回溯：本组标记为已完成并记下总用时
  stopClock();
  clearInkStore();
  clearUlStore();
  const S = state.session;
  const total = S.tally.done, right = S.tally.right, wrong = S.tally.wrong;
  const acc = total ? Math.round(right / total * 100) : 0;
  const marked = S.marked ? Array.from(S.marked) : [];
  let timing = '';
  if (S.limitOn && S.times && S.times.length) {
    const sum = S.times.reduce((a, b) => a + b, 0);
    const avg = sum / S.times.length / 1000;
    const tm = Math.floor(sum / 1000 / 60), ts = Math.round(sum / 1000 % 60);
    // 功能2：正确率对比（本次限时 vs 平时不限时整体）
    let cmp = '';
    try {
      const accData = await API('/api/accuracy');
      let c = 0, w = 0;
      (accData.module || []).forEach(m => { c += (m.c || 0); w += (m.w || 0); });
      const baseAcc = (c + w) ? Math.round(c / (c + w) * 100) : null;
      if (baseAcc !== null) {
        const diff = acc - baseAcc;
        const cls = diff >= 0 ? 'var(--ok)' : 'var(--bad)';
        cmp = `<p style="margin-top:6px">平时不限时正确率 <b style="color:var(--muted)">${baseAcc}%</b> · 本次限时 <b style="color:${cls}">${acc}%</b>（${diff >= 0 ? '+' : ''}${diff}）</p>`;
      }
    } catch (e) { }
    timing = `<p>总用时 ${tm} 分 ${ts} 秒 · 平均单题 ${avg.toFixed(1)}s · 本组正确率 <b style="color:${acc >= 60 ? 'var(--ok)' : 'var(--warn)'}">${acc}%</b>${S.timeoutN ? ` · 超时 <b style="color:var(--bad)">${S.timeoutN}</b> 次` : ''}</p>${cmp}`;
  }
  app.innerHTML = `<div class="empty"><div class="big">🏁</div>
    <h2>本组完成！</h2>
    <p>本轮练习 ${total} 题 · 对 ${right} · 错 ${wrong}</p>
    ${timing}
    ${marked.length ? `<div class="card" style="max-width:560px;margin:10px auto 0;text-align:left">
      <h3 style="margin:0 0 6px">⚑ 本组标记的题（${marked.length}）</h3>
      <p class="sub" style="margin:0 0 12px">这些标记仅在本组有效，退出后清除。可一键进入复盘模式单独重做。</p>
      <button class="btn warn" onclick="startSession({mode:'ids',ids:[${marked.join(',')}]})">▶ 复盘标记题（${marked.length}）</button>
    </div>` : ''}
    <div class="row"><a class="btn ok" href="#/review">继续复习到期</a>
      <a class="btn" href="#/study">练习更多新题</a>
      <a class="btn ghost" href="#/wrongbook">看错题本</a>
      <a class="btn ghost" href="#/">返回总览</a></div></div>`;
}

/* 离开页面（切标签、最小化、关闭、刷新）同样算「退出」，暂停并保存；
   回到页面且还停在答题页时自动继续，和切换菜单的行为一致。 */
document.addEventListener('visibilitychange', () => {
  ST.last = Date.now();                            // 先推后基准，隐藏期间的时间不补算
  stSync();
  if (document.hidden) stFlush(true);              // 切走前把已累计的学习时长报上去
  const S = state.session;
  if (!S || S.submitted) return;
  if (document.hidden) { captureInk(); clockPause(S); stopClock(); try { saveSession(); } catch (e) { } }
  else if (document.getElementById('qtimer')) startClock();
});
window.addEventListener('pagehide', () => {
  try { flushReportGrades(true); } catch (e) { }   // 关页面：未自评的题也要写进复习计划
  try { stFlush(true); } catch (e) { }             // 关页面：学习时长立即落库，不等下一次心跳
  const S = state.session;
  if (!S || S.submitted) return;
  captureInk();
  clockPause(S);
  try { saveSession(); } catch (e) { }
});

/* keyboard */
document.addEventListener('keydown', (e) => {
  // Ctrl/Cmd+B：收起 / 展开左侧功能栏（唯一需要放行的组合键）
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'b' || e.key === 'B')) {
    if (window.innerWidth > 820) { e.preventDefault(); toggleNavFit(); }
    return;
  }
  // 组合键与输入法组字一律不当作答 / 不自评：
  // PC 上划完线顺手 Ctrl+C 复制选中的文字，e.key 就是 c，曾被当成「按 C 选答案」，
  // 而且选完还会自动跳下一题，看起来完全像「划线把选项选上了」。Ctrl+A / Ctrl+D / Ctrl+1~4 同理。
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.keyCode === 229) return;
  const S = state.session;
  const typing = !!(e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT'));
  // 先答后对复盘页：1/2/3/4 自评记忆强度
  if (!typing && state.gradeCtx) {
    const g = GRADE_BY_KEY[e.key];
    if (g) { e.preventDefault(); state.gradeCtx(g); return; }
  }
  if (S && document.getElementById('opts')) {
    if (typing) return;
    const answerable = !isRev(S);
    if (isDeferred(S)) {
      if (S.submitted) return;
      const k = e.key.toUpperCase();
      const o = 'ABCDEF'.includes(k) && (S.queue[S.idx].options || []).find(x => x.key.toUpperCase() === k);
      if (o) { e.preventDefault(); deferredChoose(o.key); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); deferredGoto(S.idx + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); deferredGoto(S.idx - 1); }
      return;
    }
    if (S.phase === 'question') {
      // 复习模式：先回忆阶段按 0 也直接揭示答案（等同于点「显示选项与答案」）
      if (!answerable && e.key === '0') {
        e.preventDefault(); doReveal(); return;
      }
      // 复习模式：1/2/3/4 直接自评掌握度，不必先看选项与解析
      if (!answerable) {
        const gq = GRADE_BY_KEY[e.key];
        if (gq) { e.preventDefault(); doGrade(gq); return; }
      }
      if (answerable && 'ABCD'.includes(e.key.toUpperCase())) {
        const o = S.queue[S.idx].options.find(x => x.key.toUpperCase() === e.key.toUpperCase());
        if (o) { S.chosen = o.key; doReveal(); }
      } else if ((e.key === ' ' || e.key === 'Enter') && !answerable) { e.preventDefault(); doReveal(); }
    } else if (S.phase === 'answer') {
      // 复习模式：V 键随时展开/收起答案与解析（组合键已在函数开头排除，不会抢 Ctrl+V）
      if (!answerable && e.key === '0' && document.getElementById('ans-line')) {
        e.preventDefault(); toggleAns(); return;
      }
      if (S.graded) {   // 已评分：空格/回车进入下一题
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); nextCard(); }
      } else {
        const g = GRADE_BY_KEY[e.key];
        if (g) { e.preventDefault(); doGrade(g); }
      }
    }
  }
  if (state.exam && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const E = state.exam; const dir = e.key === 'ArrowRight' ? 1 : -1;
    examGoto(E.cur + dir);
  }
});

/* ---------- browse ---------- */
async function viewBrowse(extra) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const f = { module: q.get('module') || '', category: q.get('category') || '', kadian: q.get('kadian') || '', region: q.get('region') || '', year: q.get('year') || '', q: q.get('q') || '', only: q.get('only') || '', page: +(q.get('page') || 1) };
  loading('查询中…');
  const [fac, res] = await Promise.all([API('/api/facets'), API('/api/browse?' + buildQ(f))]);
  const heading = f.only === 'wrong' ? '错题本' : f.only === 'fav' ? '我的收藏'
    : f.only === 'discarded' ? '已丢弃的题' : '真题浏览';
  const dFrom = f.only === 'wrong' ? '&from=wrong' : f.only === 'fav' ? '&from=fav' : '';   // 详情页可翻上/下一题
  const actionBtn = f.only === 'wrong' ? `<a class="btn ok" href="#" onclick="startSession({mode:'wrong'});return false;">▶ 只练错题</a>`
    : f.only === 'fav' ? `<a class="btn ok" href="#" onclick="startSession({mode:'fav'});return false;">▶ 只练收藏</a>` : '';
  const droppedN = res.discarded || 0;
  app.innerHTML = `
  <h1>${heading}</h1><p class="sub">共匹配 ${res.total.toLocaleString()} 题 · 点击查看全部深度标注</p>
  <div class="card" style="margin-bottom:16px">
    <h2 style="margin-top:0">🔍 题干关键词搜题</h2>
    <div class="filters">
      <label class="fld">模块<select id="s-mod"><option value="">全部</option>
        ${BOOT.modules.map(m => `<option ${f.module === m.module ? 'selected' : ''}>${esc(m.module)}</option>`).join('')}</select></label>
      <label class="fld">大类<select id="s-cat"><option value="">全部</option>
        ${BOOT.categories.map(c => `<option ${f.category === c.category ? 'selected' : ''} value="${esc(c.category)}">${esc(c.category)}</option>`).join('')}</select></label>
      <label class="fld">关键词<input id="s-q" size="22" placeholder="如 增长率 / 下列表述正确" value="${esc(f.q)}"></label>
      <button class="btn" id="s-search">搜索</button>
    </div>
    <div id="search-hist" class="chipset" style="margin:6px 0 12px"></div>
    <div id="search-results"></div>
  </div>
  ${actionBtn ? `<div class="row" style="margin-bottom:14px">${actionBtn}</div>` : ''}
  <div class="row" style="margin-bottom:14px;gap:8px;flex-wrap:wrap">
    <a class="btn sm ${f.only === 'discarded' ? 'ok' : 'ghost'}" href="#/browse?only=discarded">🚫 已丢弃${droppedN ? ' ' + droppedN : ''}</a>
    ${f.only === 'discarded'
      ? `<a class="btn sm ghost" href="#/browse">← 回到全部真题</a><span class="sub" style="margin:0">丢弃的题不会出现在练习里；点「恢复」即可放回抽题池</span>`
      : `<span class="sub" style="margin:0">练习时不想再做的题，可在题头点「🚫 丢弃」放进来</span>`}
  </div>
  <div class="card" style="margin-bottom:16px"><div class="filters">
    <label class="fld">模块<select id="b-mod"><option value="">全部</option>
      ${BOOT.modules.map(m => `<option ${f.module === m.module ? 'selected' : ''}>${esc(m.module)}</option>`).join('')}</select></label>
    <label class="fld">大类<select id="b-cat"><option value="">全部</option>
      ${BOOT.categories.map(c => `<option ${f.category === c.category ? 'selected' : ''} value="${esc(c.category)}">${esc(c.category)}</option>`).join('')}</select></label>
    <label class="fld">地区<select id="b-region"><option value="">全部</option>
      ${fac.regions.map(r => `<option ${f.region === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
    <label class="fld">年份<select id="b-year"><option value="">全部</option>
      ${fac.years.map(y => `<option ${f.year === y ? 'selected' : ''}>${esc(y)}</option>`).join('')}</select></label>
    <label class="fld">考点/题干<input id="b-q" size="18" placeholder="关键字" value="${esc(f.q)}"></label>
    <label class="fld">考点名<input id="b-kd" size="16" value="${esc(f.kadian)}"></label>
    <button class="btn" id="b-go">筛选</button>
  </div></div>
  <div class="card tbl-wrap cards" style="padding:0;overflow:auto"><table><thead><tr>
    <th>考点 / 大类</th><th>地区</th><th>年份</th><th>答</th><th>对错</th><th>状态</th><th>下次复习</th><th>★</th><th></th></tr></thead><tbody>
    ${res.rows.map(r => `<tr>
      <td data-label="考点"><b>${esc((r.kadian || '').split('/').pop().slice(0, 30))}</b><br><span class="tag">${esc(r.module)}/${esc(r.category)}</span></td>
      <td data-inline data-label="地区">${esc(r.region)}</td><td data-inline data-label="年份">${esc(r.year)}</td>
      <td data-inline data-label="答" style="color:var(--ok);font-weight:800">${esc(r.answer)}</td>
      <td data-inline data-label="对错"><span style="color:var(--ok)">${r.correct || 0}</span>/<span style="color:var(--bad)">${r.wrong || 0}</span></td>
      <td data-inline data-label="状态"><span class="tag ${esc(r.status)}">${{ new: '未学', learning: '学习中', review: '复习中' }[r.status] || r.status}</span>${r.dropped ? ' <span class="tag dropped">🚫 已丢弃</span>' : ''}</td>
      <td data-inline data-label="复习">${r.status === 'new' ? '—' : esc(r.due) + (r.due <= BOOT.today ? ' ⏰' : '')} ${r.interval ? '<span class="tag">' + r.interval + 'd</span>' : ''}</td>
      <td data-inline data-label="">${r.fav ? '★' : ''}</td>
      <td data-inline data-label=""><div class="row" style="gap:10px;justify-content:flex-end"><a class="linkback" href="#/detail?id=${r.id}${dFrom}">详情</a>${f.only === 'discarded' ? `<button class="btn sm ghost row-restore" type="button" data-id="${r.id}">↺ 恢复</button>` : ''}</div></td></tr>`).join('')}
  </tbody></table></div>
  ${pager(res.total, f.page, f)}`;
  document.querySelectorAll('.row-restore').forEach(b => b.onclick = async () => {
    b.disabled = true;
    try {
      await POST('/api/discard', { id: +b.dataset.id, on: 0 });
      toast('已恢复 · 会重新出现在练习里');
      viewBrowse();
    } catch (e) { b.disabled = false; toast('恢复失败：' + (e.message || e)); }
  });
  document.getElementById('b-go').onclick = () => goBrowse({ module: val('b-mod'), category: val('b-cat'), region: val('b-region'), year: val('b-year'), q: val('b-q'), kadian: val('b-kd'), only: f.only, page: 1 });
  document.getElementById('s-search').onclick = runSearch;
  const sq = document.getElementById('s-q');
  if (sq) sq.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });
  renderSearchHist();
  if (f.q) runSearch();
}
/* ---------- 功能4：题干关键词搜题 ---------- */
function jq(s) { return JSON.stringify(s); }
async function runSearch() {
  const kw = (document.getElementById('s-q') || {}).value;
  if (!kw || !kw.trim()) { const b = document.getElementById('search-results'); if (b) b.innerHTML = '<div class="sub">输入关键词后回车或点击搜索</div>'; return; }
  const term = kw.trim();
  pushSearchHist(term); renderSearchHist();
  const m = val('s-mod'), c = val('s-cat');
  const p = new URLSearchParams(); p.set('q', term); if (m) p.set('module', m); if (c) p.set('category', c); p.set('size', '30');
  const res = await API('/api/search?' + p);
  const box = document.getElementById('search-results'); if (!box) return;
  if (!res.rows.length) { box.innerHTML = `<div class="empty" style="padding:20px">没有匹配「${esc(term)}」的题干</div>`; return; }
  box.innerHTML = `<p class="sub">匹配 ${res.total} 题（显示前 ${res.rows.length} 条）· 点击卡片看完整标注</p>` +
    res.rows.map(r => `<div class="card kd-card" style="margin-bottom:10px;cursor:pointer" onclick="location.hash='#/detail?id=${r.id}'">
      <div class="row" style="justify-content:space-between"><b>${esc((r.kadian || '').split('/').pop().slice(0, 30))}</b>
        <span class="tag">${esc(r.module)}/${esc(r.category)}</span></div>
      <div class="sub" style="margin:6px 0">${esc(r.snippet)}…</div>
      <div class="row" style="gap:6px">
        <span class="tag ${r.status === 'new' ? 'new' : r.status}">${{ new: '未学', learning: '学习中', review: '复习中' }[r.status] || r.status}</span>
        ${r.wrong ? '<span class="tag learning">曾答错</span>' : ''}${r.fav ? '<span class="tag review">★</span>' : ''}
        <span class="sub" style="margin:0">正确答案 ${esc(r.answer)}</span></div>
    </div>`).join('');
}
function renderSearchHist() {
  const box = document.getElementById('search-hist'); if (!box) return;
  const h = loadSearchHist();
  box.innerHTML = h.length ? ('<span class="sub" style="margin:0 8px 0 0">最近搜索：</span>' + h.map(k => `<button class="qtool" onclick="fillSearch(${jq(k)})">${esc(k)}</button>`).join('')) : '';
}
function fillSearch(k) { const i = document.getElementById('s-q'); if (i) i.value = k; runSearch(); }

async function viewWrongbook() {
  loading();
  const st = await API('/api/wrongbook/stats');
  const list = await API('/api/browse?only=wrong&size=8').catch(() => ({ rows: [] }));
  const mkList = (rows) => rows.map(r => `<tr>
    <td><b>${esc((r.kadian || '').split('/').pop().slice(0, 30))}</b><br><span class="tag">${esc(r.module)}/${esc(r.category)}</span></td>
    <td>${esc(r.region)}</td><td>${esc(r.year)}</td>
    <td style="color:var(--ok);font-weight:800">${esc(r.answer)}</td>
    <td><span class="tag learning">错 ${r.wrong || 0}</span></td>
    <td>${r.status === 'new' ? '—' : esc(r.due) + (r.due <= BOOT.today ? ' ⏰' : '')}</td>
    <td><a class="linkback" href="#/detail?id=${r.id}&from=wrong">详情</a></td></tr>`).join('');
  app.innerHTML = `
  <h1>错题本</h1><p class="sub">答错的题会自动收集到这里。连续两次自评「一般/熟悉」将自动移出待重练队列。</p>
  <div class="grid g3">
    <div class="card kpi bad"><div class="n">${st.total}</div><div class="l">📕 错题总数</div></div>
    <div class="card kpi ok"><div class="n">${st.mastered}</div><div class="l">✅ 已掌握</div></div>
    <div class="card kpi warn"><div class="n">${st.pending}</div><div class="l">🔁 待重练</div></div>
  </div>
  <div class="center" style="padding:26px">
    <div class="row">
      <button class="btn big ok" id="wb-redo">▶ 开始错题重练</button>
      <a class="btn big ghost" href="#/browse?only=wrong">查看错题明细列表</a>
    </div>
  </div>
  <h2>待重练预览（最近 ${Math.min(8, (list.rows || []).length)} 题）</h2>
  ${ (list.rows && list.rows.length) ? `<div class="card" style="padding:0;overflow:auto"><table><thead><tr>
    <th>考点 / 大类</th><th>地区</th><th>年份</th><th>答</th><th>状态</th><th>下次复习</th><th></th></tr></thead><tbody>
    ${mkList(list.rows)}</tbody></table></div>` : '<div class="empty">还没有错题，先去练习吧</div>' }
  `;
  const rb = document.getElementById('wb-redo');
  if (rb) rb.onclick = () => startSession({ mode: 'wrongredo' });
}
function viewFavorites() {
  if (!location.hash.includes('only=fav')) { location.hash = '#/browse?only=fav'; return; }
  return viewBrowse();
}
function val(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }
function buildQ(f) { const p = new URLSearchParams(); Object.entries(f).forEach(([k, v]) => { if (v) p.set(k, v); }); return p; }
function goBrowse(f) { location.hash = '#/browse?' + buildQ(f); }
function pager(total, page, f) {
  const pages = Math.ceil(total / 25); if (pages <= 1) return '';
  const mk = (p) => { const q = Object.assign({}, f, { page: p }); return `#/browse?${buildQ(q)}`; };
  return `<div class="pager">
    ${page > 1 ? `<a class="btn ghost" href="${mk(page - 1)}">← 上一页</a>` : ''}
    <span>第 ${page} / ${pages.toLocaleString()} 页</span>
    ${page < pages ? `<a class="btn ghost" href="${mk(page + 1)}">下一页 →</a>` : ''}</div>`;
}

/* ---------- detail ---------- */
async function viewDetail(id, from) {
  if (state.qdKey) { document.removeEventListener('keydown', state.qdKey); state.qdKey = null; }   // 换页先摘掉翻题快捷键
  loading();
  let d; try { d = await API('/api/question?id=' + id); } catch (e) { return fatal(e); }
  const c = d.card, s = d.srs;
  // 从错题本 / 收藏点进来时，可以在当前界面直接翻上/下一题，不用退回列表再点
  const seqFrom = (from === 'wrong' || from === 'fav') ? from : '';
  let seq = null, pos = -1;
  if (seqFrom) {
    try {
      const sq = await API('/api/idseq?only=' + seqFrom);
      seq = (sq.ids || []).map(Number);
      pos = seq.indexOf(+id);
      if (pos < 0) seq = null;                 // 不在序列里（刚被移出错题本等）：不显示翻页
    } catch (e) { seq = null; }
  }
  const navHref = k => `#/detail?id=${seq[k]}&from=${seqFrom}`;
  const backHref = seqFrom === 'wrong' ? '#/wrongbook' : seqFrom === 'fav' ? '#/favorites' : '';
  const backLabel = seqFrom === 'wrong' ? '← 返回错题本' : seqFrom === 'fav' ? '← 返回收藏' : '← 返回';
  app.innerHTML = `
  ${backHref ? `<a class="linkback" href="${backHref}">${backLabel}</a>`
      : `<a class="linkback" onclick="history.back()">${backLabel}</a>`}
  <div class="qhead" style="margin-top:10px">
    <span class="tag">${esc(c.module)}/${esc(c.category)}</span>
    <span class="tag">${esc(c.region)} ${esc(c.year)}</span>
    <span class="tag ${esc(s ? s.status : 'new')}">${{ new: '未学', learning: '学习中', review: '复习中' }[s ? s.status : 'new'] || ''}</span>
    <span class="tag">下次复习 ${s ? esc(s.due) : '—'}</span>
    ${d.dropped ? '<span class="tag dropped">🚫 已丢弃</span>' : ''}
  </div>
  <h1 style="font-size:20px">${esc(c.kadian)}</h1>
  <p class="sub">${esc(c.paper || '')}</p>
  <div class="qtools">
    <button class="qtool ${c.fav ? 'on' : ''}" id="d-fav">${c.fav ? '★ 已收藏' : '☆ 收藏'}</button>
    <button class="qtool ${d.dropped ? 'on' : ''}" id="d-drop" title="丢弃后不再出现在练习中，可随时恢复">${d.dropped ? '↺ 已丢弃 · 点此恢复' : '🚫 丢弃本题'}</button>
    <button class="qtool ${c.doubt_status === 'resolved' ? 'on' : ''}" id="d-doubt">${c.doubt_status === 'resolved' ? '✓ 疑点已复核' : '⚑ 标记疑点已复核'}</button>
    <button class="qtool" id="d-push">📤 推题</button>
  </div>
  ${c.ask_model ? `<div class="askmodel">💡 问法模型：${esc(c.ask_model)}</div>` : ''}
  ${c.material ? `<details open class="material-wrap"><summary style="cursor:pointer;color:var(--brand);margin-bottom:8px">📄 给定材料</summary><div class="material">${c.material}</div></details>` : ''}
  <div class="stem">${c.stem}</div>
  <div class="opts">${c.options.map(o => `<div class="opt ${o.is_answer ? 'show-ans' : ''}">
    <span class="k">${o.key}</span><span class="body">${o.html || esc(o.label)}</span>
    ${o.is_answer ? '<span style="color:var(--ok);font-weight:800">✔</span>' : ''}</div>`).join('')}</div>
  <div class="answer-line right">正确答案：${esc(c.answer)}</div>
  <div class="note-box"><h4>📝 我的笔记</h4>
    <textarea id="d-note">${esc(c.note || '')}</textarea>
    <div class="row"><span class="note-saved" id="d-note-saved">${c.note_updated ? '上次保存 ' + esc(c.note_updated) : ''}</span>
    <button class="btn sm ok" id="d-note-save">保存笔记</button></div></div>
  <div class="reveal">
    ${c.mother ? `<div class="sec mother"><h4>🧩 母题抽象</h4>${inlineMd(c.mother)}</div>` : ''}
    ${c.reasoning ? `<div class="sec"><h4>🔗 推理链</h4>${inlineMd(c.reasoning)}</div>` : ''}
    ${c.fastest ? `<div class="sec fastest"><h4>⚡ 最快解法</h4>${inlineMd(c.fastest)}</div>` : ''}
    ${c.pitfalls ? `<div class="sec pitfalls"><h4>⚠ 易错点</h4>${inlineMd(c.pitfalls)}</div>` : ''}
    ${c.analysis ? `<div class="sec"><h4>📘 官方解析</h4>${c.analysis}</div>` : ''}
    ${c.doubt ? `<div class="sec doubt"><h4>❓ 疑点待复核</h4>${inlineMd(c.doubt)}</div>` : ''}
  </div>
  <div class="row" style="margin-top:20px">
    <a class="btn ok" href="#/study?module=${encodeURIComponent(c.module)}&category=${encodeURIComponent(c.category)}&kadian=${encodeURIComponent(c.kadian)}">按此考点练习同类题</a>
  </div>
  ${seq ? `<div class="row qd-nav">
    ${pos > 0 ? `<a class="btn ghost" href="${navHref(pos - 1)}">← 上一题</a>` : '<span class="btn ghost disabled" aria-disabled="true">← 上一题</span>'}
    <span class="sub qd-pos"><i class="qd-pos-full">${seqFrom === 'wrong' ? '错题本' : '收藏'} · 第 ${pos + 1} / ${seq.length} 题</i><i class="qd-pos-mini">${pos + 1} / ${seq.length}</i></span>
    ${pos < seq.length - 1 ? `<a class="btn" href="${navHref(pos + 1)}">下一题 →</a>` : '<span class="btn disabled" aria-disabled="true">下一题 →</span>'}
  </div>
  <p class="sub qd-nav-tip">键盘 ← / → 可直接翻上/下一题</p>` : ''}`;
  document.getElementById('d-fav').onclick = async (e) => {
    const on = !c.fav; await POST('/api/fav', { id: c.id, on }); c.fav = on ? 1 : 0;
    const b = document.getElementById('d-fav'); b.classList.toggle('on', !!on); b.textContent = on ? '★ 已收藏' : '☆ 收藏'; refreshSide();
  };
  document.getElementById('d-note-save').onclick = async () => {
    const text = document.getElementById('d-note').value.trim();
    await POST('/api/note', { id: c.id, text });
    document.getElementById('d-note-saved').textContent = text ? '已保存 ✓' : '已清空笔记';
  };
  const ddb = document.getElementById('d-drop');
  if (ddb) ddb.onclick = async () => {
    const on = !d.dropped;
    if (on && !confirm('丢弃后本题不再出现在练习里，可在「真题浏览 → 已丢弃」找回。确定丢弃？')) return;
    ddb.disabled = true;
    try { await POST('/api/discard', { id: c.id, on }); }
    catch (e) { ddb.disabled = false; toast('操作失败：' + (e.message || e)); return; }
    d.dropped = on;
    ddb.disabled = false;
    ddb.classList.toggle('on', on);
    ddb.textContent = on ? '↺ 已丢弃 · 点此恢复' : '🚫 丢弃本题';
    toast(on ? '已丢弃 · 可在「真题浏览 → 已丢弃」找回' : '已恢复 · 会重新出现在练习里');
  };
  document.getElementById('d-doubt').onclick = async () => {
    const resolved = c.doubt_status !== 'resolved';
    await POST('/api/doubt', { id: c.id, status: resolved ? 'resolved' : '' });
    c.doubt_status = resolved ? 'resolved' : '';
    const b = document.getElementById('d-doubt'); b.classList.toggle('on', resolved);
    b.textContent = resolved ? '✓ 疑点已复核' : '⚑ 标记疑点已复核';
  };
  const dpb = document.getElementById('d-push');
  if (dpb) dpb.onclick = () => openPushDialog(c.id, c.qid, (c.module || '') + (c.category ? ' · ' + c.category : ''));
  if (seq) {
    if (state.qdKey) { document.removeEventListener('keydown', state.qdKey); state.qdKey = null; }
    const onKey = (e) => {
      if ((location.hash || '').indexOf('#/detail') !== 0) {          // 离开详情页：自行摘掉监听
        document.removeEventListener('keydown', onKey); state.qdKey = null; return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;                  // 别抢浏览器的复制/全选
      const t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;  // 正在写笔记
      if (e.key === 'ArrowLeft' && pos > 0) { e.preventDefault(); location.hash = navHref(pos - 1); }
      else if (e.key === 'ArrowRight' && pos < seq.length - 1) { e.preventDefault(); location.hash = navHref(pos + 1); }
    };
    state.qdKey = onKey;
    document.addEventListener('keydown', onKey);
  }
}

/* ---------- kadian ---------- */
async function viewKadian() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const m = q.get('module') || '', cat = q.get('category') || '';
  loading('加载考点…');
  const p = new URLSearchParams(); if (m) p.set('module', m); if (cat) p.set('category', cat); p.set('size', '200');
  const res = await API('/api/kadian?' + p);
  app.innerHTML = `
  <h1>考点导航</h1><p class="sub">按考点聚合，横向对比不同省份的同类考法</p>
  <div class="filters card">
    <label class="fld">模块<select id="k-mod"><option value="">全部</option>
      ${BOOT.modules.map(x => `<option ${m === x.module ? 'selected' : ''}>${esc(x.module)}</option>`).join('')}</select></label>
    <label class="fld">大类<select id="k-cat"><option value="">全部</option>
      ${BOOT.categories.filter(c => !m || c.module === m).map(c => `<option ${cat === c.category ? 'selected' : ''} value="${esc(c.category)}">${esc(c.category)}</option>`).join('')}</select></label>
    <button class="btn" id="k-go">筛选</button>
  </div>
  <div class="grid g2" style="margin-top:16px">
    ${res.rows.map(r => `<div class="card kd-card" onclick="goKadianBrowse('${enc(r.kd)}')">
      <div class="row" style="justify-content:space-between"><b>${esc((r.kd || '').split('/').pop().slice(0, 34))}</b><span class="tag">${r.n} 题</span></div>
      <div class="sub" style="margin:6px 0">${esc(r.module || r.m)}/${esc(r.category || r.c)}</div>
      ${r.mother ? `<div style="font-size:13px;color:var(--purple)">🧩 ${esc(String(r.mother).replace(/[#*>`]/g, '').slice(0, 120))}…</div>` : ''}
      </div>`).join('')}
  </div>`;
  document.getElementById('k-go').onclick = () => { location.hash = '#/kadian?module=' + encodeURIComponent(val('k-mod')) + '&category=' + encodeURIComponent(val('k-cat')); };
}
function enc(s) { return encodeURIComponent(s); }
function goKadianBrowse(kd) { location.hash = '#/browse?kadian=' + kd; }

/* markdown-lite for text fields (they contain html already) */
function inlineMd(t) { return t || ''; }

/* 做题时隐去材料里的 Obsidian 疑点/解析 callout（> [!warning] …）避免剧透答案逻辑 */
function stripCallouts(t) {
  if (!t) return t;
  let s = String(t);
  // 1) 纯文本层面先剔除 '>' 引用行（Obsidian callout 形如 '> [!warning] 疑点…'）。
  //    必须先于 innerHTML 处理：innerHTML 会把 '>' 序列化成 '&gt;'，导致后续正则漏网。
  s = s.replace(/^[ \t]*>[^\n]*(?:\n[ \t]*>[^\n]*)*/gm, '');
  // 2) 兜底：整行含强解析信号的裸解析段落（不带 callout 标记也会剧透）
  s = s.split('\n').filter(line => {
    const plain = line.replace(/<[^>]+>/g, '');
    if (!plain.trim() || /<img|<p>|<\/p>/i.test(line)) return true;
    return !/(官方解析|疑点|待人工复核|不影响\s*(正确)?答案|以\s*[A-F]\s*作答为准|与答案\s*[：:]?\s*[A-F])/.test(plain);
  }).join('\n');
  // 3) HTML 引用块
  if (/<blockquote/i.test(s)) {
    const d = document.createElement('div'); d.innerHTML = s;
    d.querySelectorAll('blockquote').forEach(e => e.remove());
    s = d.innerHTML;
  }
  // 压缩多余空行
  s = s.replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
  return s;
}
function toggleMatFull() {
  const el = document.getElementById('mat-toggle'), body = document.getElementById('mat-stripped');
  if (!el || !body) return;
  const raw = window.__curMatRaw || '';
  if (el.dataset.on === '1') { body.innerHTML = stripCallouts(raw); el.dataset.on = ''; el.textContent = '显示疑点提示 ▾'; }
  else { body.innerHTML = raw; el.dataset.on = '1'; el.textContent = '隐藏疑点提示 ▴'; }
}

/* ---------- materials ---------- */
let MATREFS = [];
async function viewMaterials() {
  loading('加载材料组…');
  const res = await API('/api/materials?size=100');
  MATREFS = res.rows.map(r => r.ref);
  app.innerHTML = `
  <h1>材料组题</h1><p class="sub">资料分析按同一段材料成组出题，整组一起练最贴近真实考场</p>
  <div class="grid g2">
    ${res.rows.map((r, i) => `<div class="card kd-card" onclick="startMat(${i})">
      <div class="row" style="justify-content:space-between"><b>📄 材料组</b><span class="tag">${r.n} 题</span></div>
      <div class="sub" style="margin:8px 0;line-height:1.5">${esc(r.snippet)}…</div>
      <div class="row"><span class="btn sm ghost">整组开练 →</span></div>
    </div>`).join('')}
  </div>
  ${!res.rows.length ? '<div class="empty">暂无成组材料</div>' : ''}`;
}
function startMat(i) { startSession({ mode: 'material', ref: MATREFS[i] }); }

/* ---------- doubts ---------- */
async function viewDoubts() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const only = q.get('only') || '';
  const sort = q.get('sort') || (only === 'mine' ? 'time' : '');
  const page = +(q.get('page') || 1);
  loading('加载疑点…');
  const p = new URLSearchParams();
  if (only) p.set('only', only);
  if (sort) p.set('sort', sort);
  p.set('page', page); p.set('size', '20');
  const res = await API('/api/doubts?' + p);
  const mineN = res.mine || 0;
  const mk = (o = {}) => {
    const x = new URLSearchParams();
    const on = o.only !== undefined ? o.only : only;
    const so = o.sort !== undefined ? o.sort : sort;
    if (on) x.set('only', on);
    if (so) x.set('sort', so);
    x.set('page', o.page || 1);
    return `#/doubts?${x}`;
  };
  const subline = only === 'mine'
    ? `你标记过的 ${res.total.toLocaleString()} 条记录${sort === 'time' ? ' · 按标记时间从新到旧' : ''}`
    : only === 'pending'
      ? `还有 ${res.total.toLocaleString()} 题没有复核`
      : `共 ${res.total.toLocaleString()} 题标注了「官方解析可能存在疑点」，逐条复核形成自己的判断`;
  app.innerHTML = `
  <h1>疑点复核</h1><p class="sub">${subline}</p>
  <p class="sub" style="margin-top:-6px">答题页工具栏的「⚑ 标记」只是本组内的临时书签，退出即清；这里记录的是被标注为「解析存疑」的题目及你的复核结论。</p>
  <div class="chipset">
    <a class="btn sm ${!only ? '' : 'ghost'}" href="${mk({ only: '', page: 1 })}">全部疑点</a>
    <a class="btn sm ${only === 'pending' ? '' : 'ghost'}" href="${mk({ only: 'pending', page: 1 })}">仅看待复核</a>
    <a class="btn sm ${only === 'mine' ? '' : 'ghost'}" href="${mk({ only: 'mine', sort: 'time', page: 1 })}">我标记过的${mineN ? `（${mineN}）` : ''}</a>
  </div>
  <div class="chipset" style="margin-top:-4px">
    <span class="sub" style="margin:0 6px 0 0">排序</span>
    <a class="btn sm ${sort !== 'time' ? '' : 'ghost'}" href="${mk({ sort: '', page: 1 })}">按模块</a>
    <a class="btn sm ${sort === 'time' ? '' : 'ghost'}" href="${mk({ sort: 'time', page: 1 })}">按标记时间</a>
  </div>
  ${res.rows.length ? res.rows.map(r => `<div class="card" style="margin-bottom:12px">
    <div class="qhead">
      <span class="tag">${esc(r.module)}/${esc(r.category)}</span>
      <span class="tag">${esc(r.region)} ${esc(r.year)}</span>
      ${r.ds_status === 'resolved' ? '<span class="tag review">✓ 已复核</span>' : '<span class="tag learning">待复核</span>'}
      ${r.ds_updated ? `<span class="tag" title="${esc(r.ds_updated)}">⚑ ${agoIso(r.ds_updated)}</span>` : ''}
    </div>
    <div class="sub" style="margin:4px 0">${esc((r.kadian || '').split('/').pop().slice(0, 40))}</div>
    <div class="reveal" style="margin-top:8px"><div class="sec doubt"><h4>❓ 疑点</h4>${inlineMd(r.doubt)}</div></div>
    ${r.ds_note ? `<div class="sub" style="margin-top:6px">我的备注：${esc(r.ds_note)}</div>` : ''}
    <div class="row" style="margin-top:10px">
      <a class="linkback" href="#/detail?id=${r.id}">查看完整题</a>
      <button class="btn sm ${r.ds_status === 'resolved' ? 'ghost' : 'ok'}" onclick="markDoubt(${r.id}, '${r.ds_status === 'resolved' ? '' : 'resolved'}', this)">
        ${r.ds_status === 'resolved' ? '撤销复核标记' : '✓ 标记已复核'}</button>
    </div>
  </div>`).join('') : `<div class="empty"><div class="big">🔍</div>
    <h2>${only === 'mine' ? '还没有标记过疑点' : '没有符合条件的题'}</h2>
    <p>${only === 'mine' ? '在题目详情或解析页点「⚑ 标记疑点已复核」，记录会带着时间出现在这里。' : '换个筛选条件看看。'}</p>
    <a class="btn" href="${mk({ only: '', sort: '', page: 1 })}">看全部疑点</a></div>`}
  ${res.total > 20 ? `<div class="pager">
    ${page > 1 ? `<a class="btn ghost" href="${mk({ page: page - 1 })}">← 上一页</a>` : ''}
    <span>第 ${page} 页 · 共 ${Math.ceil(res.total / 20)} 页</span>
    ${page * 20 < res.total ? `<a class="btn ghost" href="${mk({ page: page + 1 })}">下一页 →</a>` : ''}</div>` : ''}`;
}
async function markDoubt(id, status, btn) {
  await POST('/api/doubt', { id, status });
  // 复核状态与「标记时间」是一起变的，直接重渲染这一页，让时间和数量立刻对上
  const y = window.scrollY;
  await viewDoubts();
  window.scrollTo(0, y);
}

/* ---------- exam ---------- */
function viewExam() {
  const cats = BOOT.categories;
  app.innerHTML = `
  <h1>模拟考试</h1><p class="sub">限定题量与时长，整卷作答，交卷即时判分并按记忆曲线记录</p>
  <div class="card" style="max-width:640px">
    <div class="filters">
      <label class="fld">模块<select id="e-mod"><option value="">全部混合</option>
        ${BOOT.modules.map(m => `<option value="${esc(m.module)}">${esc(m.module)}</option>`).join('')}</select></label>
      <label class="fld">大类<select id="e-cat"><option value="">全部大类</option>
        ${cats.map(c => `<option value="${esc(c.category)}">${esc(c.category)}</option>`).join('')}</select></label>
      <label class="fld">题量<input id="e-n" type="number" value="10" min="5" max="60" style="width:90px"></label>
      <label class="fld">时长(分钟)<input id="e-t" type="number" value="15" min="1" max="180" style="width:90px"></label>
    </div>
    <div class="row"><button class="btn big warn" id="e-go">▶ 开始模考</button></div>
  </div>
  <h2>历史记录</h2>
  <div class="card" style="padding:0;overflow:auto" id="e-hist"><div class="loading">加载历史…</div></div>`;
  const emod = document.getElementById('e-mod');
  emod.onchange = () => {
    const c = document.getElementById('e-cat'); const mv = emod.value;
    c.innerHTML = '<option value="">全部大类</option>' + BOOT.categories.filter(x => !mv || x.module === mv)
      .map(x => `<option value="${esc(x.category)}">${esc(x.category)}</option>`).join('');
  };
  document.getElementById('e-go').onclick = () => startExam({
    module: emod.value, category: document.getElementById('e-cat').value,
    n: Math.max(5, Math.min(60, +document.getElementById('e-n').value || 10)),
    minutes: Math.max(1, +document.getElementById('e-t').value || 15),
  });
  loadExamHistory();
}
async function loadExamHistory() {
  const box = document.getElementById('e-hist'); if (!box) return;
  const d = await API('/api/exam/history');
  if (!d.rows.length) { box.innerHTML = '<div class="empty" style="padding:24px">还没有模考记录</div>'; return; }
  box.innerHTML = `<table><thead><tr><th>时间</th><th>名称</th><th>题量</th><th>正确</th><th>得分</th><th>用时</th></tr></thead><tbody>
    ${d.rows.map(r => `<tr><td>${esc((r.ts || '').replace('T', ' ').slice(0, 16))}</td><td>${esc(r.title)}</td>
      <td>${r.total}</td><td style="color:var(--ok)">${r.correct}</td>
      <td><b style="color:${r.score >= 60 ? 'var(--ok)' : 'var(--warn)'}">${r.score}</b></td>
      <td>${Math.floor((r.duration || 0) / 60)}分${(r.duration || 0) % 60}秒</td></tr>`).join('')}</tbody></table>`;
}

async function startExam(cfg) {
  loading('组卷中…');
  const p = new URLSearchParams(); p.set('mode', 'new'); p.set('size', cfg.n);
  if (cfg.module) p.set('module', cfg.module);
  if (cfg.category) p.set('category', cfg.category);
  let res; try { res = await API('/api/next?' + p); } catch (e) { return fatal(e); }
  if (!res.cards.length) { app.innerHTML = `<div class="empty"><div class="big">📭</div><h2>该范围没有可组的新题</h2>
    <div class="row"><a class="btn" href="#/exam">返回</a></div></div>`; return; }
  const reveal = await Promise.all(res.cards.map(c => API('/api/question?id=' + c.id).then(d => d.card)));
  state.exam = {
    items: reveal.map(c => ({ card: c, chosen: null })),
    cur: 0, total: reveal.length,
    deadline: Date.now() + cfg.minutes * 60 * 1000,
    minutes: cfg.minutes, submitted: false, title: (cfg.module || '全模块') + ' 模考',
  };
  renderExam();
  clearInterval(state.exam.timer);
  state.exam.timer = setInterval(examTick, 1000);
}

function examTick() {
  const E = state.exam; if (!E || E.submitted) return;
  const remain = E.deadline - Date.now();
  const el = document.getElementById('ex-time');
  if (el) {
    const s = Math.max(0, Math.floor(remain / 1000));
    el.textContent = fmt(s); el.classList.toggle('low', s <= 60);
  }
  if (remain <= 0) { clearInterval(E.timer); examSubmit(true); }
}
function fmt(s) { const m = Math.floor(s / 60), r = s % 60; return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r; }

function renderExam() {
  const E = state.exam; if (!E) return;
  const it = E.items[E.cur], c = it.card;
  app.innerHTML = `
  <div class="exam-timer"><div><b style="font-size:15px">模拟考试 · ${esc(E.title)}</b><div class="sub" style="margin:2px 0 0">第 ${E.cur + 1} / ${E.total} 题</div></div>
    <div style="text-align:right"><div class="t" id="ex-time">--:--</div><div class="sub" style="margin:0">剩余时间</div></div></div>
  <div class="exam-nav">${E.items.map((x, i) => `<button class="exam-dot ${x.chosen ? 'answered' : ''} ${i === E.cur ? 'cur' : ''}" onclick="examGoto(${i})">${i + 1}</button>`).join('')}</div>
  ${c.material ? `<details open class="material-wrap"><summary style="cursor:pointer;color:var(--brand);margin-bottom:8px">📄 给定材料 <span class="m-hint">（疑点提示将在作答后显示）</span></summary><div class="material" style="max-height:340px">${stripCallouts(c.material)}</div></details>` : ''}
  <div class="qhead"><span class="tag">${esc(c.module)}/${esc(c.category)}</span><span class="tag">${esc((c.kadian || '').split('/').pop().slice(0, 22))}</span></div>
  <div class="stem exam-q">${c.stem || '<i>（题干为图片）</i>'}</div>
  <div class="opts">${c.options.map(o => `<div class="opt ${it.chosen === o.key ? 'sel' : ''}" data-key="${o.key}">
    <span class="k">${o.key}</span><span class="body">${o.html || esc(o.label)}</span></div>`).join('')}</div>
  <div class="row" style="margin-top:20px;justify-content:space-between">
    <button class="btn ghost" ${E.cur === 0 ? 'disabled' : ''} onclick="examGoto(${E.cur - 1})">← 上一题</button>
    <div class="row">
      ${E.cur < E.total - 1 ? `<button class="btn" onclick="examGoto(${E.cur + 1})">下一题 →</button>` : ''}
      <button class="btn ok" onclick="examSubmit(false)">✅ 交卷</button>
    </div>
  </div>`;
  examTick();
  document.querySelectorAll('.opt').forEach(el => bindPick(el, () => { it.chosen = el.dataset.key; renderExam(); }));
}
function examGoto(i) {
  const E = state.exam; if (!E || i < 0 || i >= E.total) return;
  E.cur = i; renderExam();
}

async function examSubmit(auto) {
  const E = state.exam; if (!E || E.submitted) return;
  E.submitted = true; clearInterval(E.timer);
  const used = Math.round((E.minutes * 60 * 1000 - Math.max(0, E.deadline - Date.now())) / 1000);
  const items = E.items.map(x => ({ id: x.card.id, correct: !!(x.chosen && x.chosen === x.card.answer) }));
  let res; try { res = await POST('/api/exam/submit', { title: E.title, duration: used, items }); } catch (e) { return fatal(e); }
  const answered = E.items.filter(x => x.chosen).length;
  app.innerHTML = `
  <div class="exam-result card">
    <div class="sub" style="margin-bottom:6px">${auto ? '⏰ 时间到，已自动交卷' : '🎉 交卷成功'}</div>
    <div class="score" style="color:${res.score >= 60 ? 'var(--ok)' : 'var(--warn)'}">${res.score}</div>
    <div class="sub">得分</div>
    <div class="row" style="justify-content:center;margin:16px 0">
      <span class="tag">共 ${res.total} 题</span><span class="tag review">答对 ${res.correct}</span>
      <span class="tag">作答 ${answered}</span><span class="tag">用时 ${Math.floor(used / 60)}分${used % 60}秒</span>
    </div>
    <p class="sub">成绩已按「对→一般 / 错→忘记」写入记忆曲线，错题自动进错题本。</p>
    <div class="row" style="justify-content:center">
      <button class="btn" onclick="examReview()">逐题查看</button>
      <a class="btn ok" href="#/exam">再来一卷</a>
      <a class="btn ghost" href="#/wrongbook">看错题本</a>
      <a class="btn ghost" href="#/">返回总览</a>
    </div>
  </div>
  <div id="ex-review"></div>`;
  refreshSide();
}
function examReview() {
  const E = state.exam; const box = document.getElementById('ex-review');
  box.innerHTML = `<h2>逐题对照</h2>` + E.items.map((x, i) => {
    const c = x.card; const ok = x.chosen && x.chosen === c.answer;
    return `<div class="card" style="margin-bottom:12px">
      <div class="row" style="justify-content:space-between"><b>第 ${i + 1} 题</b>
        <span class="tag ${ok ? 'review' : 'learning'}">${ok ? '✓ 正确' : (x.chosen ? '✗ 选' + x.chosen + '，应' + c.answer : '未作答，应' + c.answer)}</span></div>
      <div class="stem" style="font-size:15px;margin:10px 0">${c.stem}</div>
      <div class="opts">${c.options.map(o => `<div class="opt ${o.is_answer ? 'show-ans' : ''} ${x.chosen === o.key && !o.is_answer ? 'wrong' : ''}">
        <span class="k">${o.key}</span><span class="body">${o.html || esc(o.label)}</span></div>`).join('')}</div>
    </div>`;
  }).join('');
  box.scrollIntoView({ behavior: 'smooth' });
}

/* ---------- stats ---------- */
/* ---------- 今日回溯：按组回看今天练过的每一道题 ---------- */
const RV_MODE = Object.assign({}, MODE_LABEL, { ids: '复盘标记', legacy: '旧记录', review: '复习到期' });
const PRACTICE_TITLE = { mix: '练习新题', review: '复习到期', wrong: '错题重练', wrongredo: '错题重练', fav: '收藏练习', material: '材料组题', ids: '复盘标记', exam: '模拟考试' };
function rvDay(off) {
  const d = new Date(); d.setDate(d.getDate() - off);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function rvDayLabel(day) {
  if (day === rvDay(0)) return '今天';
  if (day === rvDay(1)) return '昨天';
  if (day === rvDay(2)) return '前天';
  const p = String(day).split('-');
  return p.length === 3 ? `${+p[1]}月${+p[2]}日` : day;
}
function rvClock(ts) {
  const m = String(ts || '').match(/(\d{2}:\d{2})/);
  return m ? m[1] : '';
}
function rvWhen(ts) {
  const s = String(ts || '');
  const d = s.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2})/);
  return d ? `${+d[2]}月${+d[3]}日 ${d[4]}` : (rvClock(s) || '—');
}
function rvResult(it, g) {
  const review = g.mode === 'review';
  if (it.correct) return '<span class="rv-r ok">✓ 对</span>';
  if (it.timeout) return '<span class="rv-r bad">✗ 超时</span>';
  if (!review && !it.choice) return '<span class="rv-r none">未答</span>';
  return `<span class="rv-r bad">✗ ${review ? '遗忘' : '错'}</span>`;
}
function rvGroupCard(g) {
  const n = g.n || 0, answered = g.answered || 0;
  const pct = n ? Math.round(answered / n * 100) : 0;
  const acc = answered ? Math.round((g.right_n || 0) / answered * 100) : 0;
  const done = g.state === 'done';
  return `<section class="card rv-g" data-gid="${esc(g.gid)}">
    <button type="button" class="rv-g-head" aria-expanded="false">
      <div class="rv-g-main">
        <div class="rv-g-title">
          <b>${esc(g.title || RV_MODE[g.mode] || '练习')}</b>
          ${g.legacy ? '' : (g.mode === 'review'
      ? '<span class="mode-badge">回忆自评</span>'
      : g.answer_mode === 'deferred'
        ? '<span class="mode-badge deferred">先答后对</span>'
        : '<span class="mode-badge">边答边对</span>')}
          ${g.legacy ? '<span class="tag" style="color:var(--ink-3)">旧记录 · 未保存选项</span>'
      : (done ? '<span class="tag">已交卷</span>' : '<span class="tag" style="color:var(--warn)">未完成</span>')}
        </div>
        <div class="rv-g-meta">
          <span>${rvClock(g.started)}${done && g.ended ? ' – ' + rvClock(g.ended) : ''}</span>
          <span>${answered < n ? `已答 ${answered}/${n} 题` : `${n} 题`}</span>
          <span>用时 ${durTight(g.total_ms || g.spent_ms)}</span>
          ${g.timeout_n ? `<span style="color:var(--warn)">超时 ${g.timeout_n}</span>` : ''}
          ${g.scope ? `<span>${esc(g.scope)}</span>` : ''}
        </div>
        <div class="pbar rv-pbar"><i style="width:${pct}%"></i></div>
      </div>
      <div class="rv-g-acc">
        <b style="color:${!answered ? 'var(--ink-3)' : acc >= 80 ? 'var(--ok)' : acc >= 60 ? 'var(--brand)' : 'var(--bad)'}">${answered ? acc + '%' : '—'}</b>
        <span>${g.right_n || 0}/${answered}</span>
      </div>
      <span class="rv-caret" aria-hidden="true">▾</span>
    </button>
    <div class="rv-g-body" hidden></div>
  </section>`;
}
function rvItemsHtml(g, items) {
  if (!items.length) return '<p class="sub" style="padding:14px">这组还没有作答记录。</p>';
  const review = g.mode === 'review';
  const wrongN = items.filter(it => it.choice && !it.correct).length;
  return `<div class="rv-acts">
      <button type="button" class="btn ok sm rv-ana" data-filter="all">📖 看这组解析</button>
      ${(!review && wrongN) ? `<button type="button" class="btn ghost sm rv-ana" data-filter="wrong">错题解析（${wrongN}）</button>` : ''}
      <button type="button" class="btn ghost sm rv-redo" data-gid="${esc(g.gid)}">↻ 重做这组（${items.length} 题）</button>
      <span class="sub" style="margin:0">与交卷后看到的解析界面一致，可逐题翻看</span>
    </div>
    <div class="tbl-wrap cards rv-tbl"><table>
    <thead><tr><th>#</th><th>模块</th><th>题干</th><th>你的选择</th><th>正确答案</th><th>结果</th><th>用时</th></tr></thead>
    <tbody>${items.map((it, i) => {
    const choice = it.choice
      ? `<b>${esc(it.choice)}</b>`
      : (review ? '<span class="sub">—</span>' : '<span class="rv-none">未答</span>');
    return `<tr class="rv-row" data-qid="${esc(it.qid)}">
        <td data-label="" data-inline>${it.pos || i + 1}</td>
        <td data-label="模块">${esc(it.module || '')}${it.category ? `<span class="sub">${esc(it.category)}</span>` : ''}</td>
        <td data-label="题干">${esc(it.stem || '（题目已下架）')}</td>
        <td data-label="你的选择" data-inline>${choice}</td>
        <td data-label="正确答案" data-inline><b style="color:var(--ok)">${esc(it.answer || '')}</b></td>
        <td data-label="结果" data-inline>${rvResult(it, g)}</td>
        <td data-label="用时" data-inline>${it.ms ? durTight(it.ms) : '—'}</td>
      </tr>`;
  }).join('')}</tbody></table></div>
    <p class="sub rv-hint">点任意一题直接打开该题解析（和交卷后看到的一样）。</p>`;
}
async function viewToday() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const want = q.get('date') || '';
  loading('整理练习记录…');
  let d;
  try { d = await API('/api/practice/today' + (want ? '?date=' + encodeURIComponent(want) : '')); }
  catch (e) { return fatal(e); }
  const sum = d.summary || {}, groups = d.groups || [];
  const acc = sum.answered ? Math.round((sum.right || 0) / sum.answered * 100) : 0;
  const days = [0, 1, 2, 3, 4, 5, 6].map(rvDay);
  const isToday = d.date === rvDay(0);
  app.innerHTML = `
  <h1>${isToday ? '今日回溯' : rvDayLabel(d.date) + '回溯'}</h1>
  <p class="sub">按组回看练过的每一道题：当时选了什么、对没对、用了多久。先答后对模式记录的是<b>交卷对答案那一刻</b>的状态。</p>
  <div class="rv-days">${days.map((day, i) => `<a class="rv-day ${day === d.date ? 'on' : ''}" href="#/today${i === 0 ? '' : '?date=' + day}">${rvDayLabel(day)}</a>`).join('')}</div>
  <div class="grid g4 rv-sum">
    <div class="card kpi brand"><div class="n">${sum.groups || 0}</div><div class="l">练习组数</div></div>
    <div class="card kpi"><div class="n">${sum.questions || 0}</div><div class="l">共练习题数</div></div>
    <div class="card kpi ok"><div class="n">${acc}%</div><div class="l">正确率 (${sum.right || 0}/${sum.answered || 0})</div></div>
    <div class="card kpi warn"><div class="n">${durTight(sum.ms || 0)}</div><div class="l">答题用时</div></div>
  </div>
  ${(sum.questions || 0) > (sum.answered || 0)
      ? `<p class="sub" style="margin:10px 0 0">还有 ${sum.questions - sum.answered} 题未作答（含中途退出未交卷的组），在下面的组里可以看到具体是哪几道。</p>` : ''}
  <div class="rv-list">
    ${groups.length ? groups.map(rvGroupCard).join('') : `<div class="empty"><div class="big">🗂</div>
      <h2>${isToday ? '今天还没有练习记录' : '这一天没有练习记录'}</h2>
      <p>开始一组练习后，这里会按组列出所有题目与当时的作答状态。</p>
      <div class="row"><a class="btn ok" href="#/study">去练习 →</a><a class="btn ghost" href="#/">返回总览</a></div></div>`}
  </div>
  <div class="footer">只记录本机账号的练习明细 · 交卷后再复看不会改动当时的答案状态</div>`;

  const byGid = {};
  groups.forEach(g => byGid[g.gid] = g);
  document.querySelectorAll('.rv-g').forEach(box => {
    const g = byGid[box.dataset.gid]; if (!g) return;
    const head = box.querySelector('.rv-g-head');
    const body = box.querySelector('.rv-g-body');
    head.onclick = async () => {
      const open = !box.classList.contains('open');
      box.classList.toggle('open', open);
      head.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
      if (!open || body.dataset.loaded) return;
      let items = g.items;
      if (!items) {
        body.innerHTML = '<div class="loading">加载题目…</div>';
        try {
          const dd = await API('/api/practice/group?gid=' + encodeURIComponent(g.gid));
          items = dd.items || [];
        } catch (e) {
          body.innerHTML = `<p class="sub" style="color:var(--bad);padding:12px">加载失败：${esc(e.message || e)}</p>`;
          return;
        }
      }
      body.dataset.loaded = '1';
      body.innerHTML = rvItemsHtml(g, items);
      body.querySelectorAll('.rv-ana').forEach(b => b.onclick = (ev) => {
        ev.stopPropagation();
        rvGroupAnalysis(g.gid, b.dataset.filter, 0);
      });
      body.querySelectorAll('tr.rv-row').forEach((tr, i) => {
        tr.onclick = () => rvGroupAnalysis(g.gid, 'all', i);
      });
      const rvRedo = body.querySelector('.rv-redo');
      if (rvRedo) rvRedo.onclick = async (ev) => {
        ev.stopPropagation();
        rvRedo.disabled = true; rvRedo.textContent = '准备中…';
        try {
          // 需要题目的题库主键（ids 模式按 id 取题），组明细里一次取全
          const dd = await API('/api/practice/group?full=1&gid=' + encodeURIComponent(g.gid));
          const ids = (dd.items || []).map(x => x.card && x.card.id).filter(Boolean);
          if (!ids.length) { alert('这组没有可重做的题（题目可能已下架）'); rvRedo.disabled = false; return; }
          startSession({ mode: 'ids', ids, size: ids.length, revMode: g.mode === 'review', title: '回溯重做 · ' + (g.title || RV_MODE[g.mode] || '练习') });
        } catch (e) {
          alert('重做失败：' + (e.message || e));
          rvRedo.disabled = false; rvRedo.textContent = '↻ 重做这组（' + items.length + ' 题）';
        }
      };
    };
  });
}

async function viewStats() {
  loading('统计中…');
  await stSettle();                 // 同上：学习时长先落库再取数
  const [st, heat, sk, acc, weak] = await Promise.all([
    API('/api/stats'), API('/api/heatmap?days=180'), API('/api/streak'), API('/api/accuracy'), API('/api/weak'),
  ]);
  const hm = {}; heat.days.forEach(d => hm[d.d] = d.n);
  const cells = [];
  const todayD = new Date();
  const N = 182;
  const start = new Date(todayD); start.setDate(start.getDate() - (N - 1));
  // align start to Sunday
  start.setDate(start.getDate() - start.getDay());
  // 8 档分级：按「真正练过的那些天」的分位切刀，颜色跟着自己的节奏走，
  // 不再被固定阈值（1/5/10/20）压成一大片同色——练 3 题和练 19 题也能看出差别。
  const activeN = heat.days.map(d => d.n).filter(n => n > 0).sort((a, b) => a - b);
  const qv = p => activeN.length ? activeN[Math.min(activeN.length - 1, Math.max(0, Math.round(p * (activeN.length - 1))))] : 1;
  const cuts = [1, qv(.15), qv(.30), qv(.43), qv(.55), qv(.68), qv(.80), qv(.92)];   // 8 刀 → 8 档
  for (let i = 1; i < cuts.length; i++) if (cuts[i] <= cuts[i - 1]) cuts[i] = cuts[i - 1] + 1;
  const lvOf = n => { let lv = 0; for (const c of cuts) { if (n >= c) lv++; else break; } return Math.min(8, lv); };
  const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const pad2 = n => String(n).padStart(2, '0');
  for (let d = new Date(start); d <= todayD; d.setDate(d.getDate() + 1)) {
    // 用本地日期做键：toISOString 是 UTC，东八区凌晨会整体错一天
    const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const n = hm[key] || 0;
    const lv = lvOf(n);
    const tip = n ? `${key} ${WD[d.getDay()]} · 练了 ${n} 题` : `${key} ${WD[d.getDay()]} · 没练`;
    cells.push(`<div class="heat-cell l${lv}" title="${tip}" aria-label="${tip}"></div>`);
  }
  const heatDays = activeN.length, heatMax = activeN.length ? activeN[activeN.length - 1] : 0;
  const heatTotal = activeN.reduce((a, b) => a + b, 0);
  const goalPct = sk.goal ? Math.min(100, Math.round(sk.today / sk.goal * 100)) : 0;
  const maxAcc = (a) => { const t = (a.c || 0) + (a.w || 0); return t ? Math.round(a.c / t * 100) : 0; };
  app.innerHTML = `
  <h1>数据统计</h1><p class="sub">学习节奏 · 正确率 · 薄弱考点，一眼看清</p>
  <div class="grid g4">
    <div class="card kpi ok"><div class="n">${sk.current}</div><div class="l">🔥 连续打卡(天)</div></div>
    <div class="card kpi purple"><div class="n">${sk.best}</div><div class="l">🏆 最长连续(天)</div></div>
    <div class="card kpi brand"><div class="n">${st.studied_today}</div><div class="l">✅ 今日已练</div></div>
    <div class="card kpi warn"><div class="n">${st.wrong}</div><div class="l">📕 错题总数</div></div>
  </div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card kpi brand time" title="今日学习时长（答题 + 看解析）：${durText(st.today_ms)}"><div class="n">${durHtml(st.today_ms)}</div><div class="l">⏱️ 今日学习时长</div></div>
    <div class="card kpi purple time" title="累计学习时长（答题 + 看解析）：${durText(st.total_ms)}"><div class="n">${durHtml(st.total_ms)}</div><div class="l">⏳ 总学习时长</div></div>
  </div>
  <div class="card" style="margin-top:16px">
    <div class="ring-row">
      <div class="ring" style="--v:${goalPct}"><div class="in"><b>${sk.today}/${sk.goal}</b><span>今日目标</span></div></div>
      <div>
        <h2 style="margin:0 0 8px">每日目标</h2>
        <p class="sub" style="margin:0 0 12px">当前每天目标 <b>${sk.goal}</b> 题</p>
        <div class="row">
          <input id="g-in" type="number" min="1" max="500" value="${sk.goal}" style="width:100px">
          <button class="btn sm" id="g-set">更新目标</button>
        </div>
      </div>
    </div>
  </div>
  <h2>练习热力图（近半年）</h2>
  <div class="card">
    <div class="heat-sum">${heatDays} 天有练习 · 共 ${heatTotal.toLocaleString()} 题 · 最猛的一天 ${heatMax} 题</div>
    <div class="heat-wrap"><div class="heat-grid">${cells.join('')}</div></div>
    <div class="heat-legend">少
      <span class="heat-cell"></span><span class="heat-cell l1"></span><span class="heat-cell l2"></span><span class="heat-cell l3"></span><span class="heat-cell l4"></span><span class="heat-cell l5"></span><span class="heat-cell l6"></span><span class="heat-cell l7"></span><span class="heat-cell l8"></span>
      多 <span class="heat-legend-tip">每格一天，颜色越暖表示当天练得越多</span></div>
  </div>
  <h2>各模块正确率</h2>
  <div class="card">
    ${acc.module.map(a => { const pc = maxAcc(a); return `<div class="acc-row">
      <span class="name">${esc(a.k)}</span><div class="track"><i style="width:${pc}%"></i></div>
      <span class="pct">${pc}% · 对${a.c}/错${a.w}</span></div>`; }).join('') || '<div class="sub" style="margin:0">练习后这里会显示正确率</div>'}
  </div>
  <h2>各大类正确率</h2>
  <div class="card">
    ${acc.category.slice(0, 12).map(a => { const pc = maxAcc(a); return `<div class="acc-row">
      <span class="name" title="${esc(a.k)}">${esc((a.k || '').slice(0, 14))}</span><div class="track"><i style="width:${pc}%"></i></div>
      <span class="pct">${pc}% · 对${a.c}/错${a.w}</span></div>`; }).join('') || '<div class="sub" style="margin:0">暂无数据</div>'}
  </div>
  <h2>薄弱考点（错误 / 遗忘最多）</h2>
  <div class="grid g2">
    ${weak.rows.slice(0, 12).map(r => `<div class="card kd-card" onclick="goKadianBrowse('${enc(r.kd)}')">
      <div class="row" style="justify-content:space-between"><b>${esc((r.kd || '').split('/').pop().slice(0, 26))}</b><span class="tag">${esc(r.m)}</span></div>
      <div class="sub" style="margin:6px 0">做过 ${r.seen} · 对 ${r.c || 0} 错 ${r.w || 0} · 遗忘 ${r.lp || 0}</div>
      <div class="bar"><i style="width:${r.acc}%;background:linear-gradient(90deg,var(--bad),var(--warn))"></i></div>
      <div class="sub" style="margin:4px 0 0">正确率 ${r.acc}%</div>
    </div>`).join('') || '<div class="sub">还没有练过错题，暂无薄弱点</div>'}
  </div>`;
  document.getElementById('g-set').onclick = async () => {
    const v = Math.max(1, Math.min(500, +document.getElementById('g-in').value || GOAL_DEFAULT));
    await POST('/api/goal', { value: v }); viewStats();
  };
}

/* ---------- settings ---------- */
async function viewSettings() {
  const paceD = await API('/api/review/plan').catch(() => null);
  const pacing = (paceD && paceD.pacing) || 'std';
  const PACE_TIP = {
    tight: '紧凑 ×0.7：间隔更短，重见频率高，适合考前冲刺期。',
    std: '标准 ×1.0：熟悉隔 4 天、一般隔 2 天、困难隔 1 天，之后按掌握度指数拉长。',
    loose: '舒缓 ×1.6：间隔更长，每天复习压力小，适合时间紧张的备考期。',
  };
  app.innerHTML = `
  <h1>设置</h1><p class="sub">外观与学习习惯</p>
  <div class="card" style="max-width:640px">
    <h2 style="margin-top:0">外观</h2>
    <div class="row" style="justify-content:space-between;margin:14px 0">
      <span>主题（点击循环：暗色 → 亮色 → 跟随系统）</span>
      <button class="btn ghost" id="st-theme">当前：<b id="st-theme-name"></b></button>
    </div>
    <div style="margin:14px 0">
      <div class="sub" style="margin-bottom:8px">字号</div>
      <div class="row" id="st-fonts">
        ${[14, 15, 16, 17, 18, 19].map(px => `<button class="qtool" data-px="${px}" style="font-size:${px}px">${px}</button>`).join('')}
      </div>
    </div>
    <div class="row" style="justify-content:space-between;margin:14px 0">
      <span>专注模式（隐藏侧栏，居中窄列）</span>
      <button class="btn ghost" id="st-focus"></button>
    </div>
    <div class="row" id="st-navfit-row" style="justify-content:space-between;margin:14px 0">
      <span>收起左侧功能栏（内容区更宽 · 快捷键 Ctrl+B）</span>
      <button class="btn ghost" id="st-navfit"></button>
    </div>
  </div>
  <div class="card" style="max-width:640px;margin-top:16px">
    <h2 style="margin-top:0">答题模式</h2>
    <div class="seg" id="st-amode" role="radiogroup" aria-label="答题模式">
      <button type="button" class="seg-btn ${getAnswerMode() === 'instant' ? 'on' : ''}" data-m="instant" role="radio" aria-checked="${getAnswerMode() === 'instant'}">边答边对</button>
      <button type="button" class="seg-btn ${getAnswerMode() === 'deferred' ? 'on' : ''}" data-m="deferred" role="radio" aria-checked="${getAnswerMode() === 'deferred'}">先答后对</button>
    </div>
    <p class="sub" id="st-amode-tip" style="margin:10px 0 0">${ANSWER_MODE_TIP[getAnswerMode()]}</p>
  </div>
  <div class="card" style="max-width:640px;margin-top:16px">
    <h2 style="margin-top:0">复习节奏</h2>
    <p class="sub" style="margin:0 0 12px">掌握越牢间隔拉得越长；四档自评的首学间隔已拉开（熟悉 4 天 / 一般 2 天 / 困难 1 天），这里再整体缩放所有间隔。</p>
    <div class="seg" id="st-pace" role="radiogroup" aria-label="复习节奏">
      ${[['tight', '紧凑'], ['std', '标准'], ['loose', '舒缓']].map(([v, n]) =>
      `<button type="button" class="seg-btn ${pacing === v ? 'on' : ''}" data-p="${v}" role="radio" aria-checked="${pacing === v}">${n}</button>`).join('')}
    </div>
    <p class="sub" id="st-pace-tip" style="margin:10px 0 0">${PACE_TIP[pacing]}</p>
  </div>
  <div class="card" style="max-width:640px;margin-top:16px">
    <h2 style="margin-top:0">做题数量</h2>
    <p class="sub" style="margin:0 0 12px">两项分开设置：每组题量决定一次练习抽多少题，每日目标是当天的总题量。默认每组 <b>${SESSION_SIZE_DEFAULT}</b> 题、每日 <b>${GOAL_DEFAULT}</b> 题。</p>
    <div class="row" style="align-items:flex-end;gap:14px;flex-wrap:wrap">
      <label class="fld">每次做题数<input id="st-size" type="number" min="1" max="200" value="${loadSessionSize()}" style="width:110px"></label>
      <label class="fld">每日目标<input id="st-goal" type="number" min="1" max="500" style="width:110px"></label>
      <button class="btn" id="st-num-save">保存</button>
      <span class="sub" id="st-goal-cur" style="margin:0"></span>
    </div>
  </div>
  <div class="card" style="max-width:640px;margin-top:16px">
    <h2 style="margin-top:0">答题区宽度</h2>
    <p class="sub" style="margin:0 0 10px">PC 端做题时内容列的宽度。屏幕较小或竖屏时会自动收窄，手机端不受影响。</p>
    <div class="seg" id="st-readw" role="radiogroup" aria-label="答题区宽度">
      ${READW_ORDER.map(w => `<button type="button" class="seg-btn ${getReadW() === w ? 'on' : ''}" data-w="${w}" role="radio" aria-checked="${getReadW() === w}">${READW_LABEL[w]}</button>`).join('')}
    </div>
  </div>
  <div class="card" style="max-width:640px;margin-top:16px">
    <h2 style="margin-top:0">🖱 PC 右键快捷画笔</h2>
    <p class="sub" style="margin:0 0 12px">做题时不用再去点工具条：<b>右键单击</b>切到画笔，再单击一次切回鼠标；<b>右键双击</b>切到橡皮；<b>滚轮</b>调整当前工具的大小（按住 Ctrl / ⌘ 滚轮才是缩放画布）。该手势仅在鼠标设备上生效，手机端不受影响。</p>
    <div class="row" style="align-items:center;gap:12px">
      <button class="btn" id="st-rmouse">—</button>
      <span class="sub" id="st-rmouse-tip" style="margin:0"></span>
    </div>
  </div>
  <div class="card" style="max-width:640px;margin-top:16px">
    <h2 style="margin-top:0">📤 数据导出</h2>
    <p class="sub" style="margin:0 0 12px">将错题本 / 笔记导出为 Markdown 文件，可粘贴到 Obsidian、Notion 等笔记软件。导出内容仅含当前账号数据。</p>
    <div class="row">
      <button class="btn" id="st-exp-wb">📕 导出错题本 (.md)</button>
      <button class="btn" id="st-exp-note">📝 导出笔记 (.md)</button>
    </div>
  </div>
    <div class="card" style="max-width:640px;margin-top:16px">
    <h2 style="margin-top:0">🔄 偏好同步（跟随应用账号）</h2>
    <p class="sub" style="margin:0 0 6px">只需要一个账号。做题进度、错题本、收藏、笔记、统计、每日目标本来就在服务端；本机偏好（主题、字号、答题模式、限时设置、每次做题数、答题区宽度、右键手势、已做题目缓存）也一并存到同一个账号下。</p>
    <p class="sub" style="margin:0 0 12px">换设备时用同一个用户名 + 密码登录，进度和偏好都会自动恢复，不用再做任何额外授权。</p>
    <div class="row" style="justify-content:space-between;gap:16px;flex-wrap:wrap">
      <div>同步到账号：<b id="st-prefs-user">…</b><br><span class="sub" id="st-prefs-status" style="margin:4px 0 0">检查中…</span></div>
      <div class="row">
        <button class="btn" id="st-prefs-push">立即上传偏好</button>
        <button class="btn ghost" id="st-prefs-pull">从账号恢复偏好</button>
      </div>
    </div>
  </div>
  <div class="card" style="max-width:640px;margin-top:16px">
    <h2 style="margin-top:0">🤝 陪伴者</h2>
    <p class="sub" style="margin:0 0 12px">陪伴者已经是普通账号的一个功能（不再需要单独开账号）：把你的<b>用户名 + 链接码</b>给对方，或填对方的用户名 + 链接码，就能互相查看学习情况、互相推题。<b>查看始终只读，不能修改对方任何记录，也不能替对方答题</b>。</p>
    <div id="st-teacher-list" class="sub">加载中…</div>
    <div class="row" style="margin-top:12px">
      <a class="btn ok" href="#/coach">前往「陪伴者」设置链接码 / 添加</a>
    </div>
  </div>
  <div class="card" style="max-width:640px;margin-top:16px">
    <h2 style="margin-top:0">👤 账号管理</h2>
    <div class="row" style="justify-content:space-between;gap:16px;flex-wrap:wrap">
      <div>当前账号：<b id="st-user">—</b>${(ME && ME.username) ? '（用户名 ' + esc(ME.username) + '）' : ''}<br><span class="sub" style="margin:4px 0 0">${(ME && ME.anon) ? '游客模式：这是仅本设备独有的临时身份，和其它设备互不相通。要用手机和电脑同步进度，请点「升级为正式账号」设一个用户名密码，然后在另一台设备用「登录」输入同一个账号。' : '各账号的学习进度、收藏与笔记相互隔离；多台设备用同一个用户名 + 密码登录，看到的就是同一份进度（可同时在线，互不顶替）。'}</span></div>
      <div class="row">
        <button class="btn ghost" id="st-switch">切换账号</button>
        <button class="btn" id="st-pw">修改密码</button>
        <button class="btn" id="st-out">退出账号</button>
        <button class="btn danger" id="st-clear">🧹 清空做题信息</button>
        <button class="btn danger" id="st-del">删除当前账号</button>
        <button class="btn ok" id="st-upgrade">升级为正式账号</button>
      </div>
    </div>
    ${(ME && ME.anon) ? '<p class="sub" style="margin:10px 0 0">游客模式无需登录即可使用；如需跨设备同步或在其它浏览器继续学习，可「升级为正式账号」设定用户名与密码。</p>' : ''}
  </div>
  <div class="card" style="max-width:640px;margin-top:16px">
    <h2 style="margin-top:0">关于</h2>
    <p class="sub" style="margin:0">题库与学习数据均保存在服务端数据库，登录后使用。共 ${BOOT.total.toLocaleString()} 题。
    重新导入题库不影响已积累的复习进度、笔记与收藏。</p>
  </div>`;
  document.getElementById('st-theme-name').textContent = themeName(getTheme());
  document.getElementById('st-theme').onclick = () => { toggleTheme(); document.getElementById('st-theme-name').textContent = themeName(getTheme()); };
  const fs = getFont();
  document.querySelectorAll('#st-fonts .qtool').forEach(b => {
    if (+b.dataset.px === fs) b.classList.add('on');
    b.onclick = () => { setFont(+b.dataset.px); document.querySelectorAll('#st-fonts .qtool').forEach(x => x.classList.remove('on')); b.classList.add('on'); };
  });
  const fbtn = document.getElementById('st-focus');
  const syncFocus = () => { fbtn.textContent = isFocus() ? '已开启 · 关闭' : '已关闭 · 开启'; fbtn.className = 'btn ' + (isFocus() ? 'ok' : 'ghost'); };
  syncFocus(); fbtn.onclick = () => { setFocus(!isFocus()); syncFocus(); };
  const nfb = document.getElementById('st-navfit');
  const syncNavFit = () => {
    const on = isNavFit();
    nfb.textContent = on ? '已收起 · 展开' : '已展开 · 收起';
    nfb.className = 'btn ' + (on ? 'ok' : 'ghost');
  };
  syncNavFit(); nfb.onclick = () => { setNavFit(!isNavFit()); syncNavFit(); };
  try { renderTeacherBox(); } catch (e) { }   // 陪伴者督导：读我已绑定的陪伴者
  API('/api/streak').then(s => {
    document.getElementById('st-goal').value = s.goal;
    document.getElementById('st-goal-cur').textContent = '今日 ' + s.today + '/' + s.goal;
  });
  document.querySelectorAll('#st-amode .seg-btn').forEach(b => b.onclick = () => {
    setAnswerMode(b.dataset.m);
    document.querySelectorAll('#st-amode .seg-btn').forEach(x => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
    document.getElementById('st-amode-tip').textContent = ANSWER_MODE_TIP[getAnswerMode()];
  });
  document.querySelectorAll('#st-pace .seg-btn').forEach(b => b.onclick = async () => {
    const v = b.dataset.p;
    try { await POST('/api/pacing', { value: v }); } catch (e) { alert('保存失败：' + (e.message || e)); return; }
    document.querySelectorAll('#st-pace .seg-btn').forEach(x => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
    document.getElementById('st-pace-tip').textContent = PACE_TIP[v];
  });
  document.getElementById('st-num-save').onclick = async () => {
    const sz = saveSessionSize(document.getElementById('st-size').value);
    document.getElementById('st-size').value = sz;
    const goalEl = document.getElementById('st-goal');
    const v = Math.max(1, Math.min(500, +goalEl.value || GOAL_DEFAULT));
    await POST('/api/goal', { value: v });
    const s = await API('/api/streak'); document.getElementById('st-goal-cur').textContent = '今日 ' + s.today + '/' + s.goal;
    alert(`已保存：每次 ${sz} 题 · 每日目标 ${v} 题`);
  };
  document.querySelectorAll('#st-readw .seg-btn').forEach(b => b.onclick = () => {
    setReadW(b.dataset.w);
    document.querySelectorAll('#st-readw .seg-btn').forEach(x => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
  });
  const rbtn = document.getElementById('st-rmouse');
  if (rbtn) {
    syncRmouseBtn();
    rbtn.onclick = () => { setRmouse(!getRmouse()); syncRmouseBtn(); };
  }
  // 功能5：导出 / 功能6：账号管理
  document.getElementById('st-exp-wb').onclick = async () => {
    const d = await API('/api/export/wrongbook');
    if (!d.text) { alert('当前账号还没有错题'); return; }
    downloadMd(d.filename, d.text);
  };
  document.getElementById('st-exp-note').onclick = async () => {
    const d = await API('/api/export/notes');
    if (!d.text) { alert('当前账号还没有笔记'); return; }
    downloadMd(d.filename, d.text);
  };
  const su = document.getElementById('st-user'); if (su) su.textContent = ME ? (ME.name || ME.username) : '未登录';
  const anon = !!(ME && ME.anon);
  if (document.getElementById('st-switch')) document.getElementById('st-switch').onclick = logoutUser;   // 切换账号 = 退出后用另一账号登录
  const pwBtn = document.getElementById('st-pw'); if (pwBtn) pwBtn.style.display = anon ? 'none' : '';
  const delBtn = document.getElementById('st-del'); if (delBtn) delBtn.style.display = anon ? 'none' : '';
  const upBtn = document.getElementById('st-upgrade'); if (upBtn) upBtn.style.display = anon ? '' : 'none';
  if (pwBtn) pwBtn.onclick = changePassword;
  document.getElementById('st-out').onclick = logoutUser;
  if (delBtn) delBtn.onclick = doDeleteUser;
  const clrBtn = document.getElementById('st-clear'); if (clrBtn) clrBtn.onclick = clearPracticeData;
  if (upBtn) upBtn.onclick = upgradeAccount;

  /* 偏好同步卡片（跟随应用账号，无额外授权） */
  const pu = document.getElementById('st-prefs-user'), ps = document.getElementById('st-prefs-status');
  const pPush = document.getElementById('st-prefs-push'), pPull = document.getElementById('st-prefs-pull');
  if (pu) pu.textContent = ME ? (ME.name || ME.username || '当前账号') : '未登录';
  if (ps) ps.textContent = ME ? '已连接：本机偏好变更会自动存到该账号' : '登录后即可跨设备同步偏好';
  if (pPush) pPush.onclick = async () => {
    pPush.disabled = true; ps.textContent = '正在上传…';
    const r = await prefsPushNow().catch(e => ({ ok: false, error: { message: String(e) } }));
    pPush.disabled = false;
    if (r && r.ok) ps.textContent = '已保存到账号 · ' + new Date().toLocaleTimeString();
    else { ps.textContent = '上传失败'; alert('上传失败：' + ((r && r.error && r.error.message) || '未知错误')); }
  };
  if (pPull) pPull.onclick = async () => {
    if (!confirm('从账号恢复会用账号里的记录覆盖本机偏好（主题、字号、答题模式、限时、题量、宽度、右键手势、已做题目缓存）。\n做题进度与每日目标不受影响。继续？')) return;
    pPull.disabled = true; ps.textContent = '正在恢复…';
    const r = await prefsPull().catch(e => ({ ok: false, error: { message: String(e) } }));
    pPull.disabled = false;
    if (!r || !r.ok) { ps.textContent = '恢复失败'; alert('恢复失败：' + ((r && r.error) || '网络异常')); return; }
    if (!r.prefs || !Object.keys(r.prefs).length) {
      ps.textContent = '账号里还没有偏好记录，已把当前设置作为初始值上传';
      prefsPushNow().catch(() => { });
      return;
    }
    applyPrefs(r.prefs);
    ps.textContent = '已从账号恢复：本机偏好已更新（做题进度未变）';
  };
}

/* 游客账号升级为正式账号：设定用户名 + 密码，解除匿名 */
function upgradeAccount() {
  const box = document.createElement('div');
  box.className = 'modal-mask';
  box.innerHTML = `<div class="modal card">
    <h2 style="margin-top:0">🛡️ 升级为正式账号</h2>
    <p class="sub" style="margin-bottom:14px">为游客身份设定用户名和密码后，即可在任何浏览器凭账号登录、继续你的学习进度（数据不变）。</p>
    <label class="fld" style="display:block;margin-bottom:8px">用户名<input id="up-user" size="20" autocomplete="username"></label>
    <label class="fld" style="display:block;margin-bottom:8px">密码（至少 6 位）<input id="up-pw" type="password" size="20" autocomplete="new-password"></label>
    <button class="btn ok" id="up-go" style="width:100%">升级并保存</button>
    <button class="btn ghost" id="up-cancel" style="width:100%;margin-top:8px">取消</button>
  </div>`;
  document.body.appendChild(box);
  const $ = id => box.querySelector('#' + id);
  const cancel = () => box.remove();
  box.querySelector('#up-cancel').onclick = cancel;
  box.onclick = e => { if (e.target === box) cancel(); };
  $('up-go').onclick = async () => {
    const username = $('up-user').value.trim();
    const password = $('up-pw').value;
    if (!username || password.length < 6) { alert('用户名不能为空，密码至少 6 位'); return; }
    try {
      const r = await POST('/api/auth/upgrade', { username, password });
      if (!r.ok) { alert(r.error || '升级失败'); return; }
      onLoginOk(r); box.remove(); location.reload();
    } catch (e) { alert('操作失败：' + e); }
  };
  $('up-user').focus();
}

/* ---------- 主题 / 字号 / 专注 ---------- */
const THEME_ORDER = ['dark', 'light', 'auto'];
function getTheme() { try { return localStorage.getItem('kg_theme') || 'dark'; } catch (e) { return 'dark'; } }
function themeName(t) { return { dark: '暗色', light: '亮色', auto: '跟随系统' }[t] || t; }
function resolveReal(t) {
  if (t === 'auto') return (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  return t;
}
function applyTheme(t) {
  const real = resolveReal(t);
  document.documentElement.setAttribute('data-theme', real);
  const b = document.getElementById('theme-toggle');
  if (b) { b.textContent = real === 'light' ? '🌙' : (t === 'auto' ? '🌓' : '☀️'); b.title = '主题：' + themeName(t) + '（点击切换）'; }
}
function toggleTheme() {
  const cur = getTheme();
  const next = THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length];
  try { localStorage.setItem('kg_theme', next); } catch (e) { }
  applyTheme(next);
  cloudSchedule();
}
function getFont() { try { return +(localStorage.getItem('kg_fontscale')) || 15; } catch (e) { return 15; } }
function setFont(px) { try { localStorage.setItem('kg_fontscale', px); } catch (e) { } document.documentElement.style.fontSize = px + 'px'; cloudSchedule(); }
function isFocus() { return document.documentElement.getAttribute('data-focus') === '1'; }
/* 左侧功能栏收起/展开（桌面端）：状态存 localStorage，并随偏好同步到账号 */
function isNavFit() { return document.documentElement.getAttribute('data-navfit') === '1'; }
function setNavFit(on) {
  if (on) document.documentElement.setAttribute('data-navfit', '1');
  else document.documentElement.removeAttribute('data-navfit');
  try { localStorage.setItem('kg_navfit', on ? '1' : '0'); } catch (e) { }
  cloudSchedule();
}
function toggleNavFit() { if (window.innerWidth <= 820) return; setNavFit(!isNavFit()); }   // 窄屏侧栏本就是顶部横条，不收
function setFocus(on) {
  if (on) document.documentElement.setAttribute('data-focus', '1'); else document.documentElement.removeAttribute('data-focus');
  try { localStorage.setItem('kg_focus', on ? '1' : '0'); } catch (e) { }
  cloudSchedule();
}

/* ---------- 陪伴者模式（只读督导） ----------
   陪伴者已融合为普通账号的功能：任何账号都能在「陪伴者」模块里互加（用户名 + 链接码）。
   role=teacher 仅作旧数据兼容，不再限制任何路由或写操作。 */
const STUDENT_NAV = `<a href="#/">总览面板</a>
      <a href="#/study">开始练习</a>
      <a href="#/review">复习到期</a>
      <a href="#/wrongbook">错题本</a>
      <a href="#/favorites">我的收藏</a>
      <a href="#/exam">模拟考试</a>
      <a href="#/browse">真题浏览</a>
      <a href="#/kadian">考点导航</a>
      <a href="#/materials">材料组题</a>
      <a href="#/doubts">疑点复核</a>
      <a href="#/coach">陪伴者<span class="nav-dot" id="nav-push-dot" style="display:none"></span></a>
      <a href="#/stats">数据统计</a>
      <a href="#/settings">设置</a>`;

function isTeacher() { return false; }   // 陪伴者已融合为普通账号功能，不再有只读角色

function renderNav() {
  const navEl = document.getElementById('nav'); if (!navEl) return;
  navEl.innerHTML = STUDENT_NAV;
  refreshEncDot();
  refreshPushDot();
}

function agoIso(ts) {
  if (!ts) return '—';
  const d = new Date(String(ts).replace(' ', 'T'));
  if (isNaN(d.getTime())) return '—';
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return '刚刚';
  if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
  if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function mmss(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function liveDot(live) {
  const on = !!(live && live.online);
  return `<span class="live-dot ${on ? 'on' : ''}"><i></i>${on ? '正在答题' : '未在答题'}</span>`;
}

/* 陪读卡片（列表里的一张）：指标分类与陪读自己的总览面板对齐 */
function tStuCard(s) {
  const lv = s.live || {};
  const line = s.online
    ? `第 ${lv.idx || '?'}/${lv.total || '?'} 题 · ${esc(lv.module || '')}${lv.paused ? ' · 已暂停' : ''}`
    : (s.last_ts ? '最近学习 ' + agoIso(s.last_ts) : '还没有答题记录');
  return `<a class="card tstu" href="#/coach/peer?uid=${encodeURIComponent(s.id)}" data-uid="${esc(s.id)}">
    <div class="tstu-top"><b>${esc(s.name || s.username || '陪读')}</b>${liveDot(lv)}</div>
    <div class="tstu-grid">
      <div><span class="sub">今日待复习</span><b style="color:var(--warn)">${s.due_review}</b></div>
      <div><span class="sub">未学新题</span><b style="color:var(--brand)">${(s.new || 0).toLocaleString()}</b></div>
      <div><span class="sub">今日已练习</span><b style="color:var(--ok)">${s.studied_today || 0}</b></div>
      <div><span class="sub">已纳入复习</span><b style="color:var(--purple)">${(s.learned || 0).toLocaleString()}</b></div>
    </div>
    <div class="tstu-grid" style="margin-top:8px">
      <div><span class="sub">错题本</span><b style="color:var(--bad)">${s.wrong || 0}</b></div>
      <div><span class="sub">我的收藏</span><b style="color:var(--purple)">${s.fav || 0}</b></div>
      <div title="今日学习时长（答题 + 看解析）"><span class="sub">今日学习时长</span><b>${durTight(s.today_ms)}</b></div>
      <div title="累计学习时长（答题 + 看解析）"><span class="sub">总学习时长</span><b>${durTight(s.total_ms)}</b></div>
    </div>
    <div class="tstu-live">${line}</div>
  </a>`;
}

/* 陪伴者模块：普通账号的一个功能（不再是独立只读角色）
   - 我的陪伴圈：互相加的人（双向：都能看对方情况、互相推题）
   - 我的链接码：别人凭「用户名 + 链接码」加我，不用给密码
   - 推题收件箱：谁给我推了什么题 */
async function viewCoach() {
  loading();
  const [peersD, inD, outD] = await Promise.all([
    API('/api/coach/peers').catch(() => ({ peers: [], code: '' })),
    API('/api/push/list?box=in').catch(() => ({ items: [], unread: 0 })),
    API('/api/push/list?box=out').catch(() => ({ items: [] })),
  ]);
  const peers = peersD.peers || [], code = peersD.code || '';
  const inbox = inD.items || [], outbox = outD.items || [];
  const meName = (ME && (ME.name || ME.username)) || '我';

  app.innerHTML = `
  <h1 style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">陪伴者
    <a class="btn ghost" href="#/coach/encourage" style="font-size:13px;padding:5px 12px">💌 鼓励信息</a></h1>
  <p class="sub">和信任的人互相陪伴：把自己的链接码给对方，或录入对方的链接码，就能互看学习情况、互相推题。查看对方数据始终只读，不会改动对方任何记录。</p>

  <div class="card" style="max-width:760px">
    <h2 style="margin-top:0">🔑 我的链接码</h2>
    <p class="sub" style="margin:0 0 10px">别人用「你的用户名 + 这个链接码」就能把你加为陪伴对象，<b>不需要密码</b>。链接码 2-8 位字母或数字，可随时改。</p>
    <div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">
      <label class="fld">我的用户名<input value="${esc((ME && ME.username) || '')}" readonly size="14" style="opacity:.75"></label>
      <label class="fld">链接码<input id="co-code" size="10" maxlength="8" placeholder="如 8K2M" value="${esc(code)}" autocomplete="off"></label>
      <button class="btn ok" id="co-code-save">保存链接码</button>
      ${code ? '<button class="btn ghost" id="co-code-clear">清除</button>' : ''}
    </div>
    <p class="sub" style="margin:10px 0 0">${code
      ? `把你的「用户名 + <b>${esc(code)}</b>」告诉对方即可。`
      : '还没有设置链接码，别人暂时不能加你。'}</p>
  </div>

  <div class="card" style="max-width:760px;margin-top:16px">
    <h2 style="margin-top:0">➕ 添加陪伴者 / 陪伴对象</h2>
    <p class="sub" style="margin:0 0 10px">填对方的<b>用户名 + 链接码</b>（对方在自己的「陪伴者」页能看到）。绑定后是双向的：你能看对方，对方也能看你，双方可以互相推题。</p>
    <div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">
      <label class="fld">对方用户名<input id="co-u" size="16" autocomplete="off"></label>
      <label class="fld">对方的链接码<input id="co-c" size="10" maxlength="8" autocomplete="off"></label>
      <button class="btn ok" id="co-add">添加</button>
    </div>
  </div>

  <h2>👥 我的陪伴圈（${peers.length}）</h2>
  ${peers.length ? `<div class="grid g3 tgrid">${peers.map(p => coachCard(p)).join('')}</div>`
      : `<div class="card"><p class="sub" style="margin:0">还没有陪伴关系。把你的链接码给对方，或者填对方的用户名 + 链接码添加。</p></div>`}

  <h2>📥 收到的推题${inD.unread ? `（<span style="color:var(--warn)">${inD.unread} 条未读</span>）` : ''}</h2>
  ${inbox.length ? `<div class="card">${inbox.map(x => pushRow(x, 'in')).join('')}</div>`
      : '<div class="card"><p class="sub" style="margin:0">还没有收到推题。对方在任意题目界面点「推题」推给你，就会出现在这里。</p></div>'}

  <h2>📤 我推出的题（${outbox.length}）</h2>
  ${outbox.length ? `<div class="card">${outbox.map(x => pushRow(x, 'out')).join('')}</div>`
      : '<div class="card"><p class="sub" style="margin:0">还没有推过题。做题时点右侧「📤 推题」就能把这道题推给陪伴圈里的人。</p></div>'}
  <p class="sub" id="co-updated" style="margin-top:14px"></p>`;
  app.querySelectorAll('[data-pushback]').forEach(b => b.onclick = () => openPushDialog(+b.dataset.pushback, '', '把这道题推回去', b.dataset.to || ''));

  const codeEl = document.getElementById('co-code');
  document.getElementById('co-code-save').onclick = async () => {
    const v = codeEl.value.trim();
    if (!/^[0-9A-Za-z]{2,8}$/.test(v)) { alert('链接码为 2-8 位字母或数字'); return; }
    try { await POST('/api/linkcode', { code: v }); toast('链接码已保存：' + v); viewCoach(); }
    catch (e) { alert('保存失败：' + (e.message || e)); }
  };
  const clearBtn = document.getElementById('co-code-clear');
  if (clearBtn) clearBtn.onclick = async () => {
    if (!confirm('清除后别人将不能用链接码加你，已建立的陪伴关系不受影响。确定吗？')) return;
    try { await POST('/api/linkcode', { code: '' }); viewCoach(); } catch (e) { alert('操作失败'); }
  };
  document.getElementById('co-add').onclick = async () => {
    const username = document.getElementById('co-u').value.trim();
    const cd = document.getElementById('co-c').value.trim();
    if (!username || !cd) { alert('请填写对方用户名和链接码'); return; }
    const btn = document.getElementById('co-add'); btn.disabled = true; btn.textContent = '添加中…';
    try {
      const r = await POST('/api/teacher/register', { username, code: cd });
      if (!r.ok) { alert(r.error || '添加失败'); }
      else { toast('已添加：' + ((r.peer && r.peer.name) || username)); viewCoach(); return; }
    } catch (e) { alert('添加失败：' + e.message); }
    btn.disabled = false; btn.textContent = '添加';
  };

  // 收到推题自动标已读（让角标归零）
  if (inD.unread) { POST('/api/push/read', {}).then(() => refreshPushDot()).catch(() => { }); }

  // 实时状态轮询：只更新在线圆点与进度文字
  state.tpoll = setInterval(async () => {
    if (document.hidden) return;
    if ((location.hash || '').split('?')[0] !== '#/coach') return;
    try {
      const r = await API('/api/coach/peers');
      (r.peers || []).forEach(p => {
        const card = document.querySelector(`.tstu[data-uid="${p.id}"]`); if (!card) return;
        const dot = card.querySelector('.live-dot'); const lv = p.live || {};
        if (dot) { dot.classList.toggle('on', !!p.online); dot.innerHTML = `<i></i>${p.online ? '正在答题' : '未在答题'}`; }
        const line = card.querySelector('.tstu-live');
        if (line) line.textContent = p.online
          ? `第 ${lv.idx || '?'}/${lv.total || '?'} 题 · ${lv.module || ''}${lv.paused ? ' · 已暂停' : ''}`
          : (p.last_ts ? '最近学习 ' + agoIso(p.last_ts) : '还没有答题记录');
      });
      const up = document.getElementById('co-updated');
      if (up) up.textContent = '实时状态更新于 ' + new Date().toLocaleTimeString();
    } catch (e) { }
  }, 5000);
}

/* 陪伴圈里的一张卡：技能等同原陪读卡，额外标明「我加的 / 加我的」 */
function coachCard(p) {
  const role = p.is_mine ? '我加的陪伴对象' : '加我为陪伴者';
  const html = tStuCard(p);
  return html.replace('<div class="tstu-top">', `<div class="tstu-top"><span class="tag" style="margin-right:auto;font-size:11px">${role}</span>`);
}

/* 推题记录行 */
function pushRow(x, dir) {
  const who = esc(x.peer_name || x.peer_username || '对方');
  const stem = esc((x.stem || '').slice(0, 46));
  const t = agoIso(x.ts);
  const dot = (dir === 'in' && !x.read_ts) ? '<span class="push-new">NEW</span>' : '';
  const openBtn = x.qn ? `<a class="btn ghost" href="#/detail?id=${x.qn}">看这题</a>` : '';
  const pushBack = (dir === 'in' && x.qn) ? `<button class="btn" data-pushback="${x.qn}" data-to="${esc(x.from_uid || '')}">↩ 推回去</button>` : '';
  return `<div class="push-row" data-pid="${x.id}">
    <div class="push-main">
      <div><b>${dir === 'in' ? '来自 ' + who : '推给 ' + who}</b>${dot}
        <span class="sub"> · ${t}</span></div>
      <div class="sub push-stem">${stem || '（题目已不可用）'}</div>
      ${x.note ? `<div class="push-note">💬 ${esc(x.note)}</div>` : ''}
    </div>
    <div class="row" style="gap:8px;flex-wrap:wrap">${openBtn}${pushBack}</div>
  </div>`;
}

/* 实时答题面板：尽量直接看到整道题（题干 + 选项），看不清再点开完整习题 */
function tLiveHtml(live, name, uid) {
  const lv = live || {};
  if (!lv.online) {
    return `<div class="tstu-top"><b>${esc(name || '')} 的答题状态</b><span class="live-dot"><i></i>未在答题</span></div>
      <p class="sub" style="margin:10px 0 0">此刻没有在答题。陪读开始做题后，这里会自动出现题目与进度。</p>`;
  }
  const pct = lv.total ? Math.min(100, Math.round((lv.idx || 0) * 100 / lv.total)) : 0;
  // 原文 HTML 优先（图表/公式都在 <img> 里，纯文本会变成一堆「［图］」）
  const matHtml = (lv.material_html || '').trim();
  const mat = (lv.material || '').trim();
  const stemHtml = (lv.stem_html || '').trim();
  const choice = String(lv.choice || '').toUpperCase();
  const opts = lv.options || [];
  const hasQ = !!(lv.qid || lv.id) && !!uid;
  const openAttr = hasQ
    ? `data-open="1" data-uid="${esc(String(uid))}" data-id="${esc(String(lv.id || ''))}" data-qid="${esc(String(lv.qid || ''))}" data-choice="${esc(choice)}"`
    : '';
  const optHtml = opts.length ? `<div class="tlive-opts">${opts.map(o => {
    const k = String(o.key || '').toUpperCase();
    const on = k && k === choice;
    return `<div class="tlive-opt${on ? ' on' : ''}"><span class="k">${esc(k)}</span>
      <span class="b">${o.html || esc(o.label || '')}</span>${on ? '<span class="tlive-pick">陪读选</span>' : ''}</div>`;
  }).join('')}</div>` : '';
  return `<div class="tstu-top"><b>${esc(name || '')} 正在答题</b><span class="live-dot on"><i></i>实时</span></div>
    <div class="tlive-row">
      <span class="tag">${esc(lv.mode || '练习')}</span>
      <span class="sub">第 <b>${lv.idx || '?'}</b> / ${lv.total || '?'} 题</span>
      <span class="sub">已答 <b>${lv.answered || 0}</b> 题</span>
      ${lv.paused ? '<span class="tag vbadge" style="background:var(--paper-2);color:var(--warn)">已暂停</span>' : ''}
      ${hasQ ? `<button class="btn sm ghost tlive-open" type="button" ${openAttr}>📖 完整习题</button>` : ''}
    </div>
    <div class="pbar" style="margin:10px 0 12px"><i style="width:${pct}%"></i></div>
    ${(matHtml || mat) ? `<div class="tlive-mat">
        <div class="tlive-mat-h">📄 材料${lv.cut ? ' · 已截断，点开看全文' : ''}<span class="m-hint">（框内可上下滑动）</span></div>
        <div class="tlive-mat-b">${matHtml || esc(mat)}</div></div>` : ''}
    <div class="tlive-q${hasQ ? ' tlive-click' : ''}" ${openAttr}>
      <span class="sub">${esc(lv.module || '')}${lv.category ? ' · ' + esc(lv.category) : ''}</span>
      <div class="tlive-stem-body">${stemHtml || esc(lv.stem || '（题目加载中）')}${lv.cut && !stemHtml ? ' …' : ''}</div>
      ${hasQ ? '<div class="tlive-q-go">点这里看完整题干与选项 →</div>' : ''}
    </div>
    ${optHtml}
    <div class="tlive-row" style="margin-top:10px">
      <span class="sub">本题用时 <b>${mmss(lv.q_ms)}</b></span>
      <span class="sub">累计用时 <b>${mmss(lv.all_ms)}</b></span>
      ${choice ? `<span class="sub">陪读已选 <b>${esc(choice)}</b></span>` : '<span class="sub">还没选答案</span>'}
    </div>`;
}

async function viewTeacherStudent(uid) {
  loading();
  if (!uid) { location.hash = '#/coach'; return; }
  const d = await API('/api/teacher/student?uid=' + encodeURIComponent(uid));
  const s = d.student || {}; const b = d.brief || {};
  const days = d.days || []; const recent = d.recent || []; const wrong = d.wrong || []; const exams = d.exams || [];
  const dayMap = {}; days.forEach(x => dayMap[x.day] = +x.ms || 0);
  const axis = [];
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(); dt.setDate(dt.getDate() - i);
    axis.push(dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0'));
  }
  const maxMs = Math.max(1, ...axis.map(a => dayMap[a] || 0));
  // 与被看护陪读自己的总览面板一致：模块进度 + 掌握度分布
  const dueMod = {}; (b.due_by_module || []).forEach(x => dueMod[x.m] = x.n);
  const mastery = b.mastery || {}; const mkeys = ['学习中', '初记', '短期', '长期', '稳固'];
  const maxM = Math.max(1, ...mkeys.map(k => mastery[k] || 0));
  const bars = axis.map(a => {
    const ms = dayMap[a] || 0;
    const h = ms ? Math.max(3, Math.round(ms * 76 / maxMs)) : 2;
    return `<div class="tbar-col" title="${a} · ${durText(ms)}">
      <i style="height:${h}px;${ms ? '' : 'opacity:.25'}"></i>
      <span>${+a.slice(8)}</span></div>`;
  }).join('');

  app.innerHTML = `
  <a class="back-link" href="#/coach">← 返回陪伴者</a>
  <h1 style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">${esc(s.name || s.username || '陪读')}
    <span class="tag">${esc(s.username || '')}</span>${liveDot(b.live)}</h1>
  <p class="sub">查看视图：所有数字直接来自对方的账号数据，且不能修改对方任何记录。可用下方「推题」把自己觉得有价值的题推给对方。</p>

  <div class="card tlive" id="tlive">${tLiveHtml(b.live, s.name || s.username, uid)}</div>

  <div class="grid g4" style="margin-top:16px">
    <div class="card kpi warn"><div class="n">${b.due_review || 0}</div><div class="l">🔔 今日待复习</div></div>
    <div class="card kpi brand"><div class="n">${(b.new || 0).toLocaleString()}</div><div class="l">✨ 未学新题</div></div>
    <div class="card kpi ok"><div class="n">${b.studied_today || 0}</div><div class="l">✅ 今日已练习</div></div>
    <div class="card kpi purple"><div class="n">${(b.learned || 0).toLocaleString()}</div><div class="l">📈 已纳入复习</div></div>
  </div>
  <div class="grid g4" style="margin-top:12px">
    <div class="card kpi"><div class="n" style="color:var(--bad)">${b.wrong || 0}</div><div class="l">📕 错题本</div></div>
    <div class="card kpi"><div class="n" style="color:var(--purple)">${b.fav || 0}</div><div class="l">⭐ 我的收藏</div></div>
    <div class="card kpi brand time" title="今日学习时长（答题 + 看解析）：${durText(b.today_ms)}"><div class="n">${durHtml(b.today_ms)}</div><div class="l">⏱️ 今日学习时长</div></div>
    <div class="card kpi purple time" title="累计学习时长（答题 + 看解析）：${durText(b.total_ms)}"><div class="n">${durHtml(b.total_ms)}</div><div class="l">⏳ 总学习时长</div></div>
  </div>

  <div class="card" style="margin-top:16px">
    <h2 style="margin-top:0">近 14 天学习时长</h2>
    <div class="tbars">${bars}</div>
  </div>

  <h2>各模块进度</h2>
  <div class="grid g2">
    ${(b.by_module || []).map(m => {
      const pct = m.total ? Math.round(m.learned / m.total * 100) : 0;
      return `<div class="card"><div class="row" style="justify-content:space-between">
        <b>${esc(m.m)}</b><span class="tag">已学 ${m.learned}/${m.total} (${pct}%)</span></div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="sub" style="margin:8px 0 0">今日待复习：${dueMod[m.m] || 0}</div>
      </div>`;
    }).join('')}
  </div>

  <h2>掌握度分布（按复习间隔）</h2>
  <div class="card">
    ${mkeys.map(k => `<div class="row" style="justify-content:space-between;margin:6px 0">
      <span>${k}</span><span><b>${(mastery[k] || 0).toLocaleString()}</b>
      <span style="display:inline-block;vertical-align:middle;width:180px;height:8px;background:var(--panel2);border-radius:9px;margin-left:10px">
      <span style="display:block;height:100%;width:${(mastery[k] || 0) / maxM * 100}%;background:linear-gradient(90deg,var(--brand),var(--purple));border-radius:9px"></span></span></span>
    </div>`).join('')}
  </div>

  <div class="card" style="margin-top:16px">
    <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
      <h2 style="margin:0">最近作答</h2>
      <span class="sub" style="margin:0">累计 ${b.answered || 0} 题 · 正确率 ${b.answered ? b.accuracy + '%' : '—'} · 点任意一行看原题</span>
    </div>
    ${recent.length ? `<div class="tbl-wrap cards"><table><thead><tr><th>时间</th><th>模块</th><th>题型</th><th>题干</th><th>结果</th></tr></thead><tbody>
      ${recent.map(r => `<tr class="qrow" data-id="${r.id || ''}" data-qid="${esc(r.qid || '')}" title="点击查看原题">
        <td class="nowrap" data-label="时间">${agoIso(r.ts)}</td><td class="nowrap" data-label="模块">${esc(r.module || '')}</td>
        <td class="nowrap" data-label="题型">${esc(r.category || '')}</td><td data-label="题干">${esc(r.stem || '')}…</td>
        <td data-label="结果">${r.right ? '<span class="tag vbadge">正确</span>' : '<span class="tag" style="background:var(--paper-2);color:var(--bad)">错误</span>'}${r.timeout ? ' <span class="tag">超时</span>' : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="sub" style="margin:8px 0 0">还没有作答记录。</p>'}
  </div>

  <div class="card" style="margin-top:16px">
    <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
      <h2 style="margin:0">错题（按错误次数）</h2>
      ${wrong.length ? '<span class="sub" style="margin:0">点任意一行看原题</span>' : ''}
    </div>
    ${wrong.length ? `<div class="tbl-wrap cards"><table><thead><tr><th>模块</th><th>题干</th><th>错误</th><th>下次复习</th></tr></thead><tbody>
      ${wrong.map(w => `<tr class="qrow" data-id="${w.id || ''}" data-qid="${esc(w.qid || '')}" title="点击查看原题">
        <td class="nowrap" data-label="模块">${esc(w.module || '')}<br><span class="sub">${esc(w.category || '')}</span></td>
        <td data-label="题干">${esc(w.stem || '')}…</td><td class="nowrap" data-label="错误">${w.wrong} 次</td><td class="nowrap" data-label="下次复习">${esc(w.due || '—')}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="sub" style="margin:8px 0 0">暂无错题。</p>'}
  </div>

  <div class="card" style="margin-top:16px">
    <h2 style="margin-top:0">模拟考试</h2>
    ${exams.length ? `<div class="tbl-wrap cards"><table><thead><tr><th>时间</th><th>试卷</th><th>得分</th><th>正确</th><th>用时</th></tr></thead><tbody>
      ${exams.map(x => `<tr><td class="nowrap" data-label="时间">${agoIso(x.ts)}</td><td data-label="试卷">${esc(x.title || '')}</td>
        <td class="nowrap" data-label="得分">${x.score}</td><td class="nowrap" data-label="正确">${x.correct}/${x.total}</td><td class="nowrap" data-label="用时">${durText((x.duration || 0) * 1000)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="sub" style="margin:0">还没有模考记录。</p>'}
  </div>

  <div class="card" style="margin-top:16px">
    <div class="row" style="justify-content:space-between">
      <span class="sub" style="margin:0">需要取消对这位陪读的查看权限？</span>
      <button class="btn ghost" id="t-unlink">解除绑定</button>
    </div>
  </div>`;

  app.querySelectorAll('tr.qrow').forEach(tr => {
    tr.onclick = () => tQPop(uid, { id: tr.dataset.id, qid: tr.dataset.qid });
  });

  // 实时卡：点「完整习题」或题干区都直接开整题视图（浏览器里选字复制时不算点击）
  const tliveBox = document.getElementById('tlive');
  if (tliveBox) tliveBox.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-open]');
    if (!t) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && String(sel).trim()) return;
    const c = t.getAttribute('data-choice') || '';
    tQPop(t.getAttribute('data-uid'), { id: t.getAttribute('data-id'), qid: t.getAttribute('data-qid'), choice: c });
  });

  document.getElementById('t-unlink').onclick = async () => {
    if (!confirm('解除后你将看不到该陪读的任何记录，确定吗？')) return;
    await POST('/api/teacher/unlink', { uid: s.id });
    location.hash = '#/coach';
  };

  state.tpoll = setInterval(async () => {
    if (document.hidden) return;
    if ((location.hash || '').split('?')[0] !== '#/coach/peer') return;
    try {
      const r = await API('/api/teacher/live?uid=' + encodeURIComponent(uid));
      const box = document.getElementById('tlive');
      if (box) {
        // 只在内容真的变化时重绘：否则陪伴者读到材料一半会被 3 秒轮询打断
        const html = tLiveHtml(r.live, (r.student && r.student.name) || s.name, uid);
        if (box.dataset.h !== html) {
          const prevTop = (box.querySelector('.tlive-mat-b') || {}).scrollTop || 0;
          box.innerHTML = html; box.dataset.h = html;
          const nb = box.querySelector('.tlive-mat-b');
          if (nb && prevTop) nb.scrollTop = prevTop;
        }
      }
    } catch (e) { }
  }, 3000);
}

/* 点开陪读正在做/做过的题：与练习页同一套排版，完整材料 + 题干 + 选项 + 答案 + 解析 */
async function tQPop(uid, opt) {
  if (!uid || !opt || (!opt.id && !opt.qid)) return;
  const choice = String(opt.choice || '').toUpperCase();
  const old = document.getElementById('tq-mask'); if (old) old.remove();
  const mask = document.createElement('div');
  mask.id = 'tq-mask'; mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal tq-modal tq-full" role="dialog" aria-modal="true" aria-label="完整习题">
    <div class="tq-bar"><b id="tq-title">完整习题</b>
      <span class="sub" style="margin:0" id="tq-sub"></span>
      <button class="btn ghost sm" id="tq-x" type="button">关闭</button></div>
    <div class="tq-body" id="tq-body"><div class="loading">加载中…</div></div>
  </div>`;
  document.body.appendChild(mask);
  const close = () => { mask.remove(); document.removeEventListener('keydown', onEsc); };
  const onEsc = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onEsc);
  mask.addEventListener('click', e => { if (e.target === mask) close(); });
  document.getElementById('tq-x').onclick = close;
  try {
    const q = new URLSearchParams({ uid });
    if (opt.id) q.set('id', opt.id); else q.set('qid', opt.qid);
    const d = await API('/api/teacher/question?' + q.toString());
    const c = d.card || {}; const srs = d.srs || null; const hist = d.history || [];
    const ansKey = String(c.answer || '').trim().toUpperCase();
    document.getElementById('tq-title').textContent = c.kadian || '完整习题';
    document.getElementById('tq-sub').textContent = [c.module, c.category, c.region, c.year]
      .filter(Boolean).join(' · ') + (choice ? ` · 陪读已选 ${choice}` : '');
    const optHtml = (c.options || []).map(o => {
      const k = String(o.key || '').toUpperCase();
      const isAns = !!o.is_answer || (!!ansKey && k === ansKey);
      const mine = !!choice && k === choice;
      const cls = 'opt' + (isAns ? ' show-ans' : '') + (mine && !isAns ? ' sel' : '');
      const tag = (mine && isAns) ? '<span class="tq-tag ok">✔ 陪读选对了</span>'
        : isAns ? '<span class="tq-tag ok">正确答案</span>'
          : mine ? '<span class="tq-tag bad">陪读选择</span>' : '';
      return `<div class="${cls}"><span class="k">${esc(k)}</span>
        <span class="body">${o.html || esc(o.label)}</span>${tag}</div>`;
    }).join('');
    document.getElementById('tq-body').innerHTML = `
      <div class="qhead">
        ${srs ? `<span class="tag ${esc(srs.status || '')}">${{ new: '未学', learning: '学习中', review: '复习中' }[srs.status] || '已学'}</span>` : '<span class="tag">未学</span>'}
        ${srs && srs.wrong ? `<span class="tag" style="color:var(--bad)">错过 ${srs.wrong} 次</span>` : ''}
        ${srs && srs.due ? `<span class="tag">下次复习 ${esc(srs.due)}</span>` : ''}
        ${c.paper ? `<span class="tag">${esc(c.paper)}</span>` : ''}
      </div>
      ${c.material ? `<details open class="material-wrap"><summary style="cursor:pointer;color:var(--brand);margin-bottom:8px">📄 给定材料<span class="m-hint">（完整原文，含图片 · 框内可滚动）</span></summary><div class="material">${c.material}</div></details>` : ''}
      <div class="stem">${c.stem || ''}</div>
      <div class="opts">${optHtml}</div>
      <div class="answer-line right">正确答案：${esc(c.answer || '')}${choice ? ` · 陪读选择：${esc(choice)}` : ''}</div>
      ${c.note ? `<div class="tq-note"><b>陪读笔记</b><div>${esc(c.note)}</div></div>` : ''}
      ${revealHtml(c)}
      ${hist.length ? `<div class="tq-hist"><b>该陪读最近作答</b>
        <div class="tq-hist-row">${hist.map(h => `<span class="tag" title="${esc(h.ts)}">${agoIso(h.ts)} · ${h.right ? '对' : '错'}${h.timeout ? ' · 超时' : ''}</span>`).join('')}</div></div>` : ''}`;
  } catch (e) {
    document.getElementById('tq-body').innerHTML = `<p class="sub" style="margin:0;color:var(--bad)">加载失败：${esc(e.message || e)}</p>`;
  }
}

/* 鼓励信息：陪伴者发，陪读主页收 */
function fileToDataUrl(file, cb) {
  const fr = new FileReader();
  fr.onerror = () => cb('');
  fr.onload = () => {
    const img = new Image();
    img.onerror = () => cb('');
    img.onload = () => {
      const max = 1100;
      let w = img.width, h = img.height;
      if (w > max) { h = Math.round(h * max / w); w = max; }
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      let q = 0.82, out = cv.toDataURL('image/jpeg', q);
      while (out.length > 1500000 && q > 0.4) { q -= 0.12; out = cv.toDataURL('image/jpeg', q); }
      cb(out);
    };
    img.src = fr.result;
  };
  fr.readAsDataURL(file);
}

async function viewTeacherEncourage() {
  loading();
  const [st, mine] = await Promise.all([
    API('/api/teacher/students').catch(() => ({ students: [] })),
    API('/api/teacher/encouragements').catch(() => ({ items: [] })),
  ]);
  const list = st.students || []; const items = mine.items || [];
  app.innerHTML = `
  <h1>鼓励信息</h1>
  <p class="sub">发布后会显示在陪读的<b>总览面板顶部</b>，支持文字 + 一张照片。</p>
  <div class="card" style="max-width:720px">
    <div class="row" style="margin-bottom:12px">
      <label class="fld">发给
        <select id="te-target">
          <option value="*">全部陪读</option>
          ${list.map(s => `<option value="${esc(s.id)}">${esc(s.name || s.username)}</option>`).join('')}
        </select>
      </label>
    </div>
    <label class="fld" style="display:block">鼓励的话（最多 300 字）
      <textarea id="te-text" rows="3" maxlength="300" placeholder="例：今天的资料分析进步很大，继续保持这个节奏！" style="width:100%"></textarea>
    </label>
    <div class="row" style="margin:12px 0;gap:10px;align-items:center">
      <input type="file" id="te-file" accept="image/*" style="display:none">
      <button class="btn ghost" id="te-pick">📷 选择照片</button>
      <button class="btn ghost" id="te-clear" style="display:none">移除照片</button>
      <span class="sub" id="te-tip" style="margin:0">可不配图</span>
    </div>
    <div id="te-prev"></div>
    <button class="btn ok" id="te-send" style="margin-top:12px">发布到陪读主页</button>
  </div>

  <div class="card" style="max-width:720px;margin-top:16px">
    <h2 style="margin-top:0">已发布 <span class="sub" style="font-weight:400;font-size:13px">· 点「回复」可以接着聊</span></h2>
    <div id="te-list">${items.length ? items.map(e => `
      <div class="enc-box" data-id="${e.id}">
        <div class="enc-item">
          ${e.has_img ? `<img class="enc-thumb" src="${withU('/api/encourage/img?id=' + e.id)}" alt="">` : ''}
          <div class="enc-body">
            <div class="sub" style="margin:0 0 4px">${esc(e.target_name || '全部陪读')} · ${agoIso(e.ts)}
              ${e.unread ? `<span class="enc-dot">${e.unread} 条新回复</span>` : ''}</div>
            <div>${esc(e.text || '（仅图片）')}</div>
          </div>
          <button class="btn ghost te-del" data-id="${e.id}">删除</button>
        </div>
        ${e.threads && e.threads.length ? `<div class="enc-threads">${e.threads.map(t => `
          <div class="enc-th" onclick="openEncThread(${e.id},{sid:'${esc(t.sid)}',onclose:viewTeacherEncourage})" title="点开继续聊">
            <span class="enc-th-n">${esc(t.name || '陪读')}</span>
            <span class="enc-th-x">${esc(t.last_text || '')}</span>
            <span class="enc-th-d">${agoIso(t.last_ts)}</span>
            ${t.unread ? `<span class="enc-dot">${t.unread}</span>` : ''}
            <span class="enc-th-go">回复 →</span>
          </div>`).join('')}</div>`
      : `<div class="enc-threads"><div class="enc-th-none">还没有陪读回复过这条寄语。</div></div>`}
      </div>`).join('') : '<p class="sub" style="margin:0">还没有发布过鼓励信息。</p>'}
    </div>
  </div>`;

  let img = '';
  const prev = document.getElementById('te-prev');
  const clearBtn = document.getElementById('te-clear');
  const tip = document.getElementById('te-tip');
  document.getElementById('te-pick').onclick = () => document.getElementById('te-file').click();
  document.getElementById('te-file').onchange = (ev) => {
    const f = ev.target.files && ev.target.files[0]; if (!f) return;
    tip.textContent = '正在压缩…';
    fileToDataUrl(f, (d) => {
      img = d || '';
      if (!img) { tip.textContent = '这张图片读不出来，换一张试试'; return; }
      tip.textContent = '已选 1 张照片（' + Math.round(img.length / 1024) + ' KB）';
      prev.innerHTML = `<img class="enc-prev-img" src="${img}" alt="预览">`;
      clearBtn.style.display = 'inline-flex';
    });
  };
  clearBtn.onclick = () => {
    img = ''; prev.innerHTML = ''; clearBtn.style.display = 'none'; tip.textContent = '可不配图';
    document.getElementById('te-file').value = '';
  };
  document.getElementById('te-send').onclick = async () => {
    const text = document.getElementById('te-text').value.trim();
    if (!text && !img) { alert('写点文字或选一张照片吧'); return; }
    const btn = document.getElementById('te-send');
    btn.disabled = true; btn.textContent = '发布中…';
    try {
      const r = await POST('/api/teacher/encourage', { text, image: img, student_uid: document.getElementById('te-target').value });
      if (!r.ok) { alert(r.error || '发布失败'); btn.disabled = false; btn.textContent = '发布到陪读主页'; return; }
      viewTeacherEncourage();
    } catch (e) {
      alert('发布失败：' + e.message);
      btn.disabled = false; btn.textContent = '发布到陪读主页';
    }
  };
  document.querySelectorAll('.te-del').forEach(b => b.onclick = async () => {
    if (!confirm('删除这条鼓励信息？陪读主页上会同时消失。')) return;
    await POST('/api/teacher/encourage/delete', { id: +b.dataset.id });
    viewTeacherEncourage();
  });
}

/* 陪读总览：陪伴者寄语（可回复，点开就是一条对话） */
function encHtml(items) {
  if (!items || !items.length) return '';
  return `<div class="enc-wrap">${items.slice(0, 2).map(e => {
    const n = e.n || 0, unread = e.unread || 0;
    return `<div class="card enc-card enc-click" onclick="openEncThread(${e.id})" title="点开回复陪伴者">
      <div class="enc-head">
        <span class="enc-badge">💌 陪伴者寄语</span>
        ${unread ? `<span class="enc-dot">${unread} 条新回复</span>` : ''}
        <span class="sub">${esc(e.teacher_name || '陪伴者')} · ${agoIso(e.ts)}</span>
      </div>
      ${e.text ? `<p class="enc-text">${esc(e.text)}</p>` : ''}
      ${e.has_img ? `<img class="enc-img" loading="lazy" src="${withU('/api/encourage/img?id=' + e.id)}" alt="陪伴者寄语配图">` : ''}
      ${e.last_text ? `<div class="enc-last">
        <span class="enc-last-k">${e.last_role === 'teacher' ? '陪伴者' : '我'}</span>
        <span class="enc-last-t">${esc(e.last_text)}</span>
        <span class="enc-last-d">${agoIso(e.last_ts)}</span>
      </div>` : ''}
      <div class="enc-row">
        <span class="enc-n">${n ? `💬 ${n} 条往来` : '还没有回复'}</span>
        <span class="enc-go">${unread ? '有新的回复 →' : '回复 / 查看对话 →'}</span>
      </div>
    </div>`;
  }).join('')}</div>`;
}

/* 一条寄语 = 一条对话：陪伴者和陪读都能在这里继续说话 */
let ENC_CUR = null;
/* 点气泡里的图看大图（手机上错题照片要看得清） */
function encZoom(src) {
  const old = document.querySelector('.enc-zoom'); if (old) old.remove();
  const d = document.createElement('div');
  d.className = 'enc-zoom';
  d.innerHTML = `<img src="${src}" alt="查看大图">`;
  d.onclick = () => d.remove();
  document.body.appendChild(d);
}

async function openEncThread(rid, opt) {
  opt = opt || {};
  const old = document.getElementById('enc-mask'); if (old) old.remove();
  ENC_CUR = { rid, sid: opt.sid || '', isT: isTeacher(), onclose: opt.onclose || null };
  const mask = document.createElement('div');
  mask.id = 'enc-mask'; mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal enc-modal" role="dialog" aria-modal="true" aria-label="寄语对话">
    <div class="enc-bar"><b id="enc-title">💌 寄语对话</b>
      <span class="sub" id="enc-sub" style="margin:0"></span>
      <button class="btn ghost sm" id="enc-x" type="button">关闭</button></div>
    <div class="enc-thread" id="enc-thread"><div class="loading">加载中…</div></div>
    <div class="enc-foot">
      <div class="enc-attach" id="enc-attach">
        <img id="enc-attach-img" alt="待发送的图片">
        <button class="enc-attach-x" id="enc-attach-x" type="button" aria-label="移除图片" title="移除图片">×</button>
      </div>
      <input type="file" id="enc-file" accept="image/*" style="display:none">
      <div class="enc-foot-row">
        <button class="btn ghost enc-pick" id="enc-pick" type="button" title="附一张照片">📷</button>
        <textarea id="enc-input" rows="2" maxlength="1000" placeholder="${(ENC_CUR.isT ? '回复陪读…' : '回复陪伴者…') + (window.innerWidth <= 560 ? '' : '（Ctrl+Enter 发送）')}"></textarea>
        <button class="btn ok" id="enc-send" type="button">发送</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(mask);
  const close = () => {
    mask.remove(); document.removeEventListener('keydown', onEsc);
    const cb = ENC_CUR && ENC_CUR.onclose; ENC_CUR = null;
    if (cb) { try { cb(); } catch (e) { } }
    else { refreshEncBlock(); refreshEncDot(); }
  };
  const onEsc = e => {
    if (e.key !== 'Escape') return;
    const z = document.querySelector('.enc-zoom');
    if (z) { z.remove(); return; }      // 先关大图，再关对话
    close();
  };
  document.addEventListener('keydown', onEsc);
  mask.addEventListener('click', e => { if (e.target === mask) close(); });
  document.getElementById('enc-x').onclick = close;

  const box = document.getElementById('enc-thread');
  const loadThread = async () => {
    let d;
    try {
      d = await API('/api/encourage/thread?id=' + rid + (ENC_CUR.sid ? '&sid=' + encodeURIComponent(ENC_CUR.sid) : ''));
    } catch (e) {
      box.innerHTML = `<p class="sub" style="margin:0;color:var(--bad)">加载失败：${esc(e.message || e)}</p>`;
      return;
    }
    ENC_CUR.sid = d.sid || ENC_CUR.sid;
    document.getElementById('enc-sub').textContent = d.is_teacher
      ? `与 ${d.partner || '陪读'} 的往来` : `与 ${d.partner || '陪伴者'} 的往来`;
    const msgs = d.messages || [];
    box.innerHTML = msgs.map((m, i) => {
      const mine = m.role === (d.is_teacher ? 'teacher' : 'student');
      return `<div class="enc-msg ${mine ? 'mine' : 'other'}${i === 0 ? ' first' : ''}">
        <div class="enc-bubble${m.has_img && !m.text ? ' only-img' : ''}">
          ${m.has_img ? `<img class="enc-bubble-img" loading="lazy" src="${withU('/api/encourage/img?id=' + m.id)}" alt="寄语配图" onclick="encZoom(this.src)">` : ''}
          ${m.text ? `<div class="enc-bubble-t">${esc(m.text)}</div>` : ''}
          <div class="enc-bubble-m">${esc(m.author_name || '')} · ${agoIso(m.ts)}</div>
        </div></div>`;
    }).join('') + (msgs.length < 2 ? `<p class="sub enc-tip">${d.is_teacher ? '这里只有你发的寄语，等陪读回一句。' : '想说点什么就回一句，陪伴者能看到。'}</p>` : '');
    box.scrollTop = box.scrollHeight;
  };

  /* 回复也能附图：选图 → 本地压缩成 dataURL → 预览 → 随文字一起发出 */
  let encAtt = '';
  const attachBox = document.getElementById('enc-attach');
  const attachImg = document.getElementById('enc-attach-img');
  const setAttach = (d) => {
    encAtt = d || '';
    if (encAtt) { attachImg.src = encAtt; attachBox.style.display = 'flex'; }
    else { attachBox.style.display = 'none'; attachImg.removeAttribute('src'); }
  };
  document.getElementById('enc-pick').onclick = () => document.getElementById('enc-file').click();
  document.getElementById('enc-file').onchange = (ev) => {
    const f = ev.target.files && ev.target.files[0]; if (!f) return;
    const pick = document.getElementById('enc-pick');
    pick.disabled = true; pick.textContent = '…';
    fileToDataUrl(f, (d) => {
      pick.disabled = false; pick.textContent = '📷';
      ev.target.value = '';
      if (!d) { alert('这张图片读不出来，换一张试试'); return; }
      setAttach(d);
      document.getElementById('enc-input').focus();
    });
  };
  document.getElementById('enc-attach-x').onclick = () => setAttach('');

  document.getElementById('enc-send').onclick = async () => {
    const ta = document.getElementById('enc-input');
    const text = (ta.value || '').trim();
    if (!text && !encAtt) { ta.focus(); return; }
    const btn = document.getElementById('enc-send');
    btn.disabled = true; btn.textContent = '发送中…';
    try {
      await POST('/api/encourage/reply', { id: rid, text, sid: ENC_CUR ? ENC_CUR.sid : '', image: encAtt });
      ta.value = '';
      setAttach('');
      await loadThread();
    } catch (e) {
      alert('发送失败：' + (e.message || e));
    }
    btn.disabled = false; btn.textContent = '发送';
  };
  document.getElementById('enc-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); document.getElementById('enc-send').click(); }
  });
  document.getElementById('enc-input').focus();
  await loadThread();
}

/* 关掉对话后局部刷新总览的寄语区，不用整页重绘 */
async function refreshEncBlock() {
  const box = document.querySelector('.enc-wrap'); if (!box) return;
  let d;
  try { d = await API('/api/encourage'); } catch (e) { return; }
  const html = encHtml(d.items);
  if (!html) { box.remove(); return; }
  const tmp = document.createElement('div'); tmp.innerHTML = html;
  box.replaceWith(tmp.firstElementChild);
}

/* 侧栏未读角标：陪读看陪伴者回了几条，陪伴者看陪读回了几条 */
async function refreshEncDot() {
  const el = document.getElementById('nav-enc-dot'); if (!el) return;
  if (!tok()) { el.style.display = 'none'; return; }
  try {
    const d = await API('/api/encourage/unread');
    if (d && d.n > 0) { el.textContent = d.n > 99 ? '99+' : d.n; el.style.display = 'inline-flex'; }
    else el.style.display = 'none';
  } catch (e) { el.style.display = 'none'; }
}

/* 侧栏推题未读角标 */
async function refreshPushDot() {
  const el = document.getElementById('nav-push-dot'); if (!el) return;
  if (!tok()) { el.style.display = 'none'; return; }
  try {
    const d = await API('/api/push/list?box=in');
    const n = (d && d.unread) || 0;
    if (n > 0) { el.textContent = n > 99 ? '99+' : n; el.style.display = 'inline-flex'; }
    else el.style.display = 'none';
  } catch (e) { el.style.display = 'none'; }
}

/* ---------- 推题：任意习题界面都能把当前题推给陪伴圈里的人 ---------- */
async function openPushDialog(qn, qidStr, label, presetTo) {
  let peers = [];
  try { const d = await API('/api/coach/peers'); peers = d.peers || []; } catch (e) { }
  if (!peers.length) {
    alert('还没有陪伴关系。\n先去侧栏「陪伴者」把你的链接码给对方，或填对方的用户名 + 链接码添加，再回来推题。');
    return;
  }
  document.querySelectorAll('.modal-mask.push-mask').forEach(m => m.remove());
  const box = document.createElement('div');
  box.className = 'modal-mask push-mask';
  box.innerHTML = `<div class="modal card" style="max-width:520px">
    <h2 style="margin-top:0">📤 推题给陪伴者</h2>
    <p class="sub" style="margin:0 0 12px">${esc(label || '')}</p>
    <label class="fld" style="display:block;margin-bottom:10px">推给谁
      <div class="push-pick" id="pu-who">
        ${peers.map(p => `<button type="button" class="qtool" data-uid="${esc(p.id)}">${esc(p.name || p.username)}</button>`).join('')}
      </div>
    </label>
    <label class="fld" style="display:block;margin-bottom:12px">留言（可选，200 字内）
      <input id="pu-note" size="30" maxlength="200" placeholder="比如：这题老是错，帮我看看">
    </label>
    <div class="row" style="justify-content:flex-end;gap:8px">
      <button class="btn ghost" id="pu-cancel">取消</button>
      <button class="btn ok" id="pu-go">推送</button>
    </div>
  </div>`;
  document.body.appendChild(box);
  let who = (presetTo && peers.some(p => p.id === presetTo)) ? presetTo
    : (peers.length === 1 ? peers[0].id : '');
  const btns = box.querySelectorAll('#pu-who .qtool');
  btns.forEach(b => {
    b.classList.toggle('on', b.dataset.uid === who);
    b.onclick = () => { who = b.dataset.uid; btns.forEach(x => x.classList.toggle('on', x === b)); };
  });
  box.querySelector('#pu-cancel').onclick = () => box.remove();
  box.onclick = e => { if (e.target === box) box.remove(); };
  box.querySelector('#pu-go').onclick = async () => {
    if (!who) { alert('请选择推给谁'); return; }
    const note = box.querySelector('#pu-note').value.trim();
    const btn = box.querySelector('#pu-go'); btn.disabled = true; btn.textContent = '推送中…';
    try {
      const r = await POST('/api/push', { to_uid: who, id: qn, qid: qidStr, note });
      if (!r.ok) { alert(r.error || '推送失败'); btn.disabled = false; btn.textContent = '推送'; return; }
      box.remove();
      toast('已推送，对方在「陪伴者」模块能看到');
    } catch (e) { alert('推送失败：' + e.message); btn.disabled = false; btn.textContent = '推送'; }
  };
}

/* 轻提示（页面底部浮一条，2 秒消失） */
function toast(msg) {
  let el = document.getElementById('kg-toast');
  if (!el) { el = document.createElement('div'); el.id = 'kg-toast'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

/* 设置页：我已绑定的陪伴者（陪读侧） */
async function renderTeacherBox() {
  const box = document.getElementById('st-teacher-list'); if (!box) return;
  const d = await API('/api/coach/peers').catch(() => ({ peers: [] }));
  const list = d.peers || [];
  box.innerHTML = list.length
    ? list.map(t => `<div class="enc-item"><div class="enc-body"><b>${esc(t.name || t.username)}</b>
        <span class="sub"> · 用户名 ${esc(t.username)} · 绑定于 ${agoIso(t.created)}</span></div>
        <button class="btn ghost st-t-del" data-id="${esc(t.id)}">解除</button></div>`).join('')
    : '还没有陪伴关系。点下方按钮进入「陪伴者」，用链接码互相添加。';
  box.querySelectorAll('.st-t-del').forEach(b => b.onclick = async () => {
    if (!confirm('解除后双方都看不到对方的学习记录，确定吗？')) return;
    try { await POST('/api/teacher/detach', { teacher_uid: b.dataset.id }); } catch (e) { }
    renderTeacherBox();
  });

}

/* ---------- 学习实时状态上报（给陪伴者端看） ---------- */
function liveSnapshot() {
  const S = state.session;
  const onAnswerPage = !!document.getElementById('qtimer');
  if (!S || S.submitted || !onAnswerPage) return { status: 'idle' };
  const c = S.queue[S.idx] || {};
  let right = 0, wrong = 0;
  if (S.fulls) {
    Object.keys(S.answers || {}).forEach(k => {
      const f = S.fulls[k];
      if (f && f.answer) { if (S.answers[k] === f.answer) right++; else wrong++; }
    });
  }
  // 边答边对用 S.chosen（选完即解析），先答后对用 S.answers 记账
  const deferredMode = S.mode === 'deferred';
  const answered = deferredMode
    ? Object.keys(S.answers || {}).length
    : Math.min(S.queue.length, S.idx + (S.chosen ? 1 : 0));
  return {
    status: 'answering', mode: MODE_LABEL[S.mode] || '练习',
    qid: String(c.qid || ''), id: c.id || 0,
    // 选项一起上报：陪伴者只看题干看不出孩子在四个选项里选哪个（带原文，图形题的选项就是图）
    options: (c.options || []).map(o => ({ key: o.key, label: o.html || o.label || '' })),
    idx: S.idx + 1, total: S.queue.length,
    answered, right, wrong,
    q_ms: Math.round(qElapsed(S)), all_ms: Math.round(allElapsed(S)),
    paused: isClockPaused(S) ? 1 : 0,
    choice: deferredMode ? (S.answers[c.id] || '') : (S.chosen || ''),
  };
}
const LIVE = { tick: null };
function liveStart() {
  if (LIVE.tick || isTeacher()) return;
  const beat = () => {
    if (!tok()) return;
    try {
      fetch('/api/live/ping', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign(liveSnapshot(), { token: tok() })),
        keepalive: true,
      }).catch(() => { });
    } catch (e) { }
  };
  beat();
  LIVE.tick = setInterval(beat, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) beat(); });
}

/* ---------- 账号：登录 / 注册 / 退出 / 密码 ---------- */
function syncUserChip() {
  const el = document.getElementById('user-name'); if (!el) return;
  const nm = ME ? (ME.name || ME.username) : '';
  el.textContent = ME ? nm : '未登录';
  el.title = ME ? '点击切换 / 新建账号' : '点击登录';
}

function onLoginOk(d) {
  setTok(d.token); ME = d.user;
  try { localStorage.removeItem('kg_cur_user'); } catch (e) { }   // 老标识不再使用
  syncUserChip();
}

/* 登录 / 注册界面（未登录时全屏，不列出任何账号名，避免泄露他人昵称） */
function showLogin(msg) {
  document.querySelectorAll('.modal-mask').forEach(m => m.remove());
  const box = document.createElement('div');
  box.className = 'modal-mask';
  box.innerHTML = `<div class="modal card">
    <h2 style="margin-top:0">🔐 考公脑库</h2>
    <p class="sub" style="margin-bottom:14px">${msg ? esc(msg) + '<br>' : ''}登录后使用，各账号的学习数据相互隔离。</p>
    <div class="row" style="gap:8px;margin-bottom:12px">
      <button class="qtool on" id="lg-tab-login">登录</button>
      <button class="qtool" id="lg-tab-reg">注册新账号</button>
    </div>
    <label class="fld" style="display:block;margin-bottom:8px">用户名<input id="lg-user" size="20" autocomplete="username"></label>
    <label class="fld" style="display:block;margin-bottom:8px">密码<input id="lg-pw" type="password" size="20" autocomplete="current-password"></label>
    <label class="fld" id="lg-name-wrap" style="display:none;margin-bottom:8px">昵称（可留空）<input id="lg-name" size="20" maxlength="12"></label>
    <button class="btn ok" id="lg-go" style="width:100%">登录</button>
    <div class="guest-sep"><span>或</span></div>
    <button class="btn guest" id="lg-guest" style="width:100%">🚪 游客模式 · 免注册直接使用</button>
    <p class="sub" style="margin:12px 0 0;font-size:12px">💡 首次使用点「注册新账号」。用户名 2-20 字，密码至少 6 位。<br><b>手机和电脑要看到同一份进度，请两台设备都走「登录」并输入同一个用户名和密码</b>；游客模式是每台设备各自独立的新身份，彼此不通，也不会自动合并。</p>
  </div>`;
  document.body.appendChild(box);
  const $ = id => box.querySelector('#' + id);
  let mode = 'login';
  const setMode = m => {
    mode = m;
    $('lg-tab-login').classList.toggle('on', m === 'login');
    $('lg-tab-reg').classList.toggle('on', m === 'reg');
    $('lg-go').textContent = m === 'login' ? '登录' : '注册并进入';
    $('lg-name-wrap').style.display = m === 'reg' ? 'block' : 'none';
    const gb = $('lg-guest'); if (gb) gb.style.display = '';
    const sep = box.querySelector('.guest-sep'); if (sep) sep.style.display = '';
  };
  $('lg-tab-login').onclick = () => setMode('login');
  $('lg-tab-reg').onclick = () => setMode('reg');
  const submit = async () => {
    const username = $('lg-user').value.trim();
    const password = $('lg-pw').value;
    if (!username || !password) { alert('请输入用户名和密码'); return; }
    try {
      if (mode === 'reg') {
        const r = await fetch('/api/auth/register', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, name: $('lg-name').value.trim() }),
        }).then(r => r.json());
        if (!r.ok) { alert(r.error || '注册失败'); return; }
        onLoginOk(r); box.remove(); location.reload();
      } else {
        const r = await fetch('/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        }).then(r => r.json());
        if (r.need_password) { box.remove(); return showSetPassword(username); }
        if (!r.ok) { alert(r.error || '登录失败'); return; }
        onLoginOk(r); box.remove();
        location.reload();
      }
    } catch (e) { alert('操作失败：' + e); }
  };
  $('lg-go').onclick = submit;
  $('lg-pw').onkeydown = e => { if (e.key === 'Enter') submit(); };
  $('lg-guest').onclick = async () => {
    try {
      const r = await fetch('/api/auth/guest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      }).then(r => r.json());
      if (!r.ok) { alert(r.error || '进入游客模式失败'); return; }
      onLoginOk(r); box.remove(); location.reload();
    } catch (e) { alert('操作失败：' + e); }
  };
  $('lg-user').focus();
}

/* 老账号首次补设密码 */
function showSetPassword(username) {
  const box = document.createElement('div');
  box.className = 'modal-mask';
  box.innerHTML = `<div class="modal card">
    <h2 style="margin-top:0">🔑 为账号设置密码</h2>
    <p class="sub" style="margin-bottom:14px">账号「${esc(username)}」还没有设置密码。请设置一个密码来保护你的学习记录，设置后其他人就无法进入你的账号。</p>
    <label class="fld" style="display:block;margin-bottom:8px">用户名<input id="sp-user" size="20" value="${esc(username)}"></label>
    <label class="fld" style="display:block;margin-bottom:8px">新密码（至少 6 位）<input id="sp-pw" type="password" size="20" autocomplete="new-password"></label>
    <button class="btn ok" id="sp-go" style="width:100%">设置密码并进入</button>
    <p class="sub" style="margin:12px 0 0;font-size:12px">⚠️ 请尽快完成设置，在此之前任何知道你用户名的人都可能占用该账号。</p>
  </div>`;
  document.body.appendChild(box);
  const $ = id => box.querySelector('#' + id);
  const submit = async () => {
    const username2 = $('sp-user').value.trim();
    const password = $('sp-pw').value;
    if (!username2 || password.length < 6) { alert('密码至少 6 位'); return; }
    let legacy_id = '';
    try { legacy_id = localStorage.getItem('kg_cur_user') || ''; } catch (e) { }
    const r = await fetch('/api/auth/claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username2, password, legacy_id }),
    }).then(r => r.json());
    if (!r.ok) { alert(r.error || '设置失败'); return; }
    onLoginOk(r); box.remove(); location.reload();
  };
  $('sp-go').onclick = submit;
  $('sp-pw').onkeydown = e => { if (e.key === 'Enter') submit(); };
  $('sp-pw').focus();
}

/* 账号菜单：只显示自己，不列出他人账号 */
function openUserMenu() {
  const box = document.createElement('div');
  box.className = 'modal-mask';
  box.innerHTML = `<div class="modal card">
    <h2 style="margin-top:0">👤 账号</h2>
    <p class="sub" style="margin-bottom:14px">当前登录：<b>${esc((ME && ME.name) || '—')}</b>${(ME && ME.username) ? '（用户名 ' + esc(ME.username) + '）' : ''}</p>
    <button class="btn" id="um-pw" style="width:100%;margin-bottom:8px">🔑 修改密码</button>
    <button class="btn danger" id="um-out" style="width:100%;margin-bottom:8px">退出账号</button>${(ME && ME.anon) ? '<p class="sub" style="margin:0">游客模式：退出将清除本浏览器的全部学习数据。</p>' : ''}
    <a class="btn ghost" href="#/settings" style="width:100%;margin-bottom:8px" onclick="document.querySelector('.modal-mask').remove()">⚙ 账号管理</a>
    <button class="btn ghost" id="um-close" style="width:100%">关闭</button>
  </div>`;
  document.body.appendChild(box);
  const close = () => box.remove();
  box.querySelector('#um-close').onclick = close;
  box.onclick = e => { if (e.target === box) close(); };
  box.querySelector('#um-out').onclick = () => { close(); logoutUser(); };
  box.querySelector('#um-pw').onclick = () => { close(); changePassword(); };
  if (ME && ME.anon) {
    const pwBtn = box.querySelector('#um-pw');
    if (pwBtn) pwBtn.remove();
  }
}

function changePassword() {
  const box = document.createElement('div');
  box.className = 'modal-mask';
  box.innerHTML = `<div class="modal card">
    <h2 style="margin-top:0">🔑 修改密码</h2>
    <label class="fld" style="display:block;margin-bottom:8px">原密码<input id="cp-old" type="password" size="20"></label>
    <label class="fld" style="display:block;margin-bottom:12px">新密码（至少 6 位）<input id="cp-new" type="password" size="20" autocomplete="new-password"></label>
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" id="cp-cancel">取消</button>
      <button class="btn ok" id="cp-go">确认修改</button>
    </div>
  </div>`;
  document.body.appendChild(box);
  const $ = id => box.querySelector('#' + id);
  $('cp-cancel').onclick = () => box.remove();
  $('cp-go').onclick = async () => {
    const old_password = $('cp-old').value, password = $('cp-new').value;
    if (password.length < 6) { alert('新密码至少 6 位'); return; }
    const r = await POST('/api/auth/password', { old_password, password });
    if (!r.ok) { alert(r.error || '修改失败'); return; }
    onLoginOk(r); box.remove(); alert('密码已修改 ✓');
  };
}

/* 退出账号：清除本机登录凭证，数据仍安全保存在服务端 */
async function logoutUser() {
  if (!confirm('退出当前账号？\n你的学习数据仍安全保存在服务器上，之后用用户名和密码即可重新登录。')) return;
  await fetch('/api/auth/logout', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: tok() }),
  }).catch(() => { });
  setTok(''); ME = null;
  location.reload();
}

/* 清空做题信息：清进度/作答/模考/统计，保留收藏、笔记、疑点 */
async function clearPracticeData() {
  if (!ME) return;
  const name = ME.name || '当前账号';
  if (!confirm(`清空「${name}」的全部做题信息？\n\n将清空：答题记录、复习进度与到期安排、错题本、模考历史、学习统计、学习时长、已做题目缓存\n保留不动：收藏的题目、笔记、疑点标记\n\n此操作不可撤销。`)) return;
  let r;
  try { r = await POST('/api/account/reset-practice', {}); }
  catch (e) { alert('清空失败：' + (e.message || '网络异常')); return; }
  if (!r || !r.ok) { alert('清空失败：' + ((r && r.error) || '未知错误')); return; }
  try { localStorage.setItem('kg_seen', '[]'); } catch (e) { }
  clearSession(); state.session = null;
  clearInkStore();
  clearUlStore();
  // 账号偏好里也存了「已做题目缓存」，不同步清掉的话换设备登录又会被拉回来
  await prefsFlush().catch(() => { });
  await refreshSide();
  const cur = document.getElementById('st-goal-cur');
  if (cur) { try { const s = await API('/api/streak'); cur.textContent = '今日 ' + s.today + '/' + s.goal; } catch (e) { } }
  alert(`已清空做题信息：${r.srs || 0} 条题目进度、${r.reviews || 0} 条作答记录、${r.exams || 0} 场模考。`);
  nav().catch(() => { });
}

async function doDeleteUser() {
  if (!ME) return;
  if (!confirm(`确定删除账号「${ME.name}」吗？\n该账号的复习进度、错题本、收藏和笔记将被永久清除，且无法恢复。`)) return;
  if (!confirm('再次确认：此操作不可撤销，真的要删除吗？')) return;
  const password = prompt('请输入当前密码以确认删除：');
  if (password === null) return;
  const r = await POST('/api/users/delete', { password });
  if (!r.ok) { alert(r.error || '删除失败'); return; }
  setTok(''); ME = null;
  location.reload();
}

/* ---------- 偏好同步（跟随应用账号，存在服务端 user_settings） ----------
   已下线 WorkBuddy 云账号同步：它需要额外一次 OAuth，且只在本机/线上两套域名之一可用，
   结果就是「一个应用两套同步入口、还经常点了没反应」。现在所有数据只认应用账号：
   做题进度、收藏、笔记、统计、每日目标是服务端表；本机偏好（主题、字号、答题模式、
   限时、题量、宽度、右键手势、已做缓存）也存在同一账号下，登录即自动拉取。 */
function collectPrefs() {
  return {
    limits: loadLimits(),
    limitOn: !!LIMIT_ON,
    theme: getTheme(),
    fontscale: getFont(),
    focus: isFocus() ? 1 : 0,
    navfit: isNavFit() ? 1 : 0,
    answerMode: getAnswerMode(),
    readw: getReadW(),
    sessionSize: loadSessionSize(),
    rmouse: getRmouse() ? 1 : 0,
    seen: loadSeen(),
  };
}
function applyPrefs(d) {
  if (!d || typeof d !== 'object') return false;
  let ok = false;
  try {
    if (d.limits && typeof d.limits === 'object' && Object.keys(d.limits).length) {
      localStorage.setItem('kg_limits', JSON.stringify(Object.assign({}, LIMIT_DEFAULT, d.limits)));
    }
    if (typeof d.limitOn === 'boolean') {
      LIMIT_ON = d.limitOn;
      try { localStorage.setItem('kg_limit_on', d.limitOn ? '1' : '0'); } catch (e) { }
    }
    if (d.theme && THEME_ORDER.indexOf(d.theme) >= 0) {
      try { localStorage.setItem('kg_theme', d.theme); } catch (e) { }
      applyTheme(d.theme);
    }
    if (+d.fontscale >= 12 && +d.fontscale <= 24) setFont(+d.fontscale);
    if (d.focus === 0 || d.focus === 1) setFocus(!!d.focus);
    // 侧栏收起是纯界面状态：本机已明确设置过就以本机为准，避免刚收起就被账号旧值拉回
    if ((d.navfit === 0 || d.navfit === 1) && localStorage.getItem('kg_navfit') === null) {
      setNavFit(!!d.navfit);
    }
    if (d.readw && READW_ORDER.indexOf(d.readw) >= 0) { setReadW(d.readw); syncReadWSeg(); }
    if (+d.sessionSize >= 1) { try { localStorage.setItem(SESSION_SIZE_KEY, String(clampSessionSize(d.sessionSize))); } catch (e) { } }
    if (d.rmouse === 0 || d.rmouse === 1) { try { localStorage.setItem(RMOUSE_KEY, d.rmouse ? '1' : '0'); } catch (e) { } syncRmouseBtn(); }
    if (d.answerMode === 'instant' || d.answerMode === 'deferred') {
      try { localStorage.setItem(ANSWER_MODE_KEY, d.answerMode); } catch (e) { }
      document.querySelectorAll('#st-amode .seg-btn, #s-amode .seg-btn').forEach(b => {
        const on = b.dataset.m === d.answerMode;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      });
      ['st-amode-tip', 's-amode-tip'].forEach(id => {
        const tip = document.getElementById(id);
        if (tip) tip.textContent = ANSWER_MODE_TIP[d.answerMode];
      });
    }
    if (Array.isArray(d.seen) && d.seen.length) {
      const s = new Set(loadSeen());
      d.seen.forEach(q => s.add(String(q)));
      try { localStorage.setItem('kg_seen', JSON.stringify(Array.from(s).slice(-800))); } catch (e) { }
    }
    ok = true;
  } catch (e) { /* 云端数据格式异常时忽略该项，不影响本地 */ }
  return ok;
}

/* 偏好写回账号：变更后 1.2 秒合并推送，避免拖动滑块时刷请求 */
let PREFS_TIMER = null;
function cloudSchedule() {
  if (!ME || !tok()) return;
  clearTimeout(PREFS_TIMER);
  PREFS_TIMER = setTimeout(() => { prefsPushNow().catch(() => { }); }, 1200);
}
async function prefsPushNow() {
  if (!ME || !tok()) return { ok: false, error: { message: '未登录，偏好仅保存在本机' } };
  return POST('/api/prefs', { prefs: collectPrefs() });
}
async function prefsPull() { return API('/api/prefs'); }
async function prefsFlush() {
  if (PREFS_TIMER) { clearTimeout(PREFS_TIMER); PREFS_TIMER = null; }
  return prefsPushNow().catch(() => ({ ok: false }));
}

/* ---------- boot ---------- */
(async function boot() {
  // 注意：跳转中(HEALING)不 return。若 location.replace 因故未生效，
  // 页面还能继续正常渲染，避免永远停在"加载中…"。
  try { initGestureGuard(); } catch (e) { }   // 作答手势守卫：拖拽选字/划线不许作答
  applyTheme(getTheme());
  setFont(getFont());
  try { localStorage.removeItem('kg_preferred_years'); } catch (e) { }   // 已下线功能的遗留键

  const tb = document.getElementById('theme-toggle'); if (tb) tb.onclick = toggleTheme;
  const nb = document.getElementById('nav-toggle'); if (nb) nb.onclick = toggleNavFit;
  const nr = document.getElementById('nav-reveal'); if (nr) nr.onclick = toggleNavFit;
  const fe = document.getElementById('focus-exit'); if (fe) fe.onclick = () => { setFocus(false); };
  if (window.matchMedia) {
    try { matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (getTheme() === 'auto') applyTheme('auto'); }); } catch (e) { }
  }
  // bootstrap 与 auth/me 并行发起（省一个往返 RTT；me 依赖的 token 在 localStorage，无先后依赖）
  const bootP = API('/api/bootstrap').then(b => ({ ok: true, b }), e => ({ ok: false, e }));
  const meP = fetch('/api/auth/me?token=' + encodeURIComponent(tok()))
    .then(r => r.json()).catch(() => null);
  const br = await bootP;
  if (!br.ok) return fatal('后端未就绪：' + br.e);
  BOOT = br.b;

  // 判断是否已登录：未登录则显示登录 / 注册界面
  let me = (await meP) || { ok: false };
  if (me && me.ok && me.user) {
    ME = me.user;
  } else {
    setTok('');
    let legacy = '';
    try { legacy = localStorage.getItem('kg_cur_user') || ''; } catch (e) { }
    showLogin(legacy ? '检测到本机已有账号但尚未设置密码，请输入用户名登录后设置。' : '');
    return;   // 登录成功后会 reload
  }

  const un = document.getElementById('user-name'); if (un) un.onclick = () => openUserMenu();
  syncUserChip();
  renderNav();       // 陪伴者账号只显示「陪读看板 / 鼓励信息」，陪读显示原有导航
  if (!isTeacher()) {
    stBoot();          // 学习时长心跳：登录后开始按秒累计（答题 + 看解析）
    liveStart();       // 答题状态心跳：陪伴者端据此实时看进度
    refreshSide().catch(() => { });
  }
  nav().catch(() => { });

  if (isTeacher()) return;   // 陪伴者没有任何本地偏好/学习数据要同步

  // 偏好同步：账号里有记录就应用到本机；没有就把当前设置作为初始值上传
  try {
    const r = await prefsPull();
    if (r && r.ok && r.prefs && Object.keys(r.prefs).length) applyPrefs(r.prefs);
    else if (r && r.ok) await prefsPushNow().catch(() => { });
  } catch (e) { /* 偏好同步失败不影响主流程 */ }
})();
