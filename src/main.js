import './style.css';
import { db, auth } from './firebase.js';
import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore';
import { onAuthStateChanged, signInAnonymously, GoogleAuthProvider, signInWithPopup, linkWithPopup, signOut } from 'firebase/auth';

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const STORE_KEY       = 'rituario_v1';
const CODE_KEY        = 'rituario_sync_code';
const THEME_KEY       = 'rituario_theme';
const ONBOARD_KEY     = 'rituario_onboarded';
const REMIND_KEY      = 'rituario_reminders_on';
const REMIND_DATE_KEY = 'rituario_reminders_lastfire';
const COLORS = ['#5c6e4e','#bd5b3a','#c79a4b','#6b7fa3','#8a5a8c'];
const MONTH_NAMES   = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const MONTH_ABBR    = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
const WEEKDAY_LETTERS = ['L','M','X','J','V','S','D'];

// ─── STATE ────────────────────────────────────────────────────────────────────
let state         = load();
let editingId     = null;
let sheetMode     = 'daily';
let activeTab     = 'daily';
let syncCode      = localStorage.getItem(CODE_KEY) || null;
let suppressNextWrite = false;
let currentUser   = null;

// Fecha que el usuario está viendo (por defecto hoy)
let currentViewDate = new Date();
currentViewDate.setHours(0,0,0,0);

// Calendario diario
let calDate  = new Date();

// Calendario mensual
let monthCalOpen = false;
let monthCalYear = new Date().getFullYear();

// Emoji picker
let activeEmojiCat = null;

// Reminder interval
let reminderInterval = null;

// Onboarding
let onboardSelected = new Set();

// Audio
let audioCtx = null;

// ─── HELPERS DE FECHA ────────────────────────────────────────────────────────
function formatDateKey(d) {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}
function todayKey() { return formatDateKey(new Date()); }
function dayKey(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return formatDateKey(d);
}
function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function rgbToHex(rgb) {
  if (rgb.startsWith('#')) return rgb;
  const m = rgb.match(/\d+/g);
  return m ? '#' + m.slice(0,3).map(x => (+x).toString(16).padStart(2,'0')).join('') : COLORS[0];
}
function isToday(d) { return formatDateKey(d) === todayKey(); }

// ─── LOAD / SAVE ──────────────────────────────────────────────────────────────
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!parsed.monthlyHabits) parsed.monthlyHabits = [];
      if (!parsed.monthlyLog)    parsed.monthlyLog = {};
      return parsed;
    }
  } catch(e) {}
  return {
    habits: [
      {id:'h1', name:'Beber 2L de agua',    sub:'8 vasos al día', icon:'💧', color:'#5c6e4e'},
      {id:'h2', name:'Caminar 10.000 pasos', sub:'',              icon:'👣', color:'#bd5b3a'},
      {id:'h3', name:'Leer 20 minutos',      sub:'',              icon:'📖', color:'#c79a4b'},
    ],
    log: {},
    monthlyHabits: [
      {id:'m1', name:'Leer un libro', sub:'', icon:'📚', color:'#6b7fa3'},
      {id:'m2', name:'Ahorrar 100€',  sub:'', icon:'💰', color:'#c79a4b'},
    ],
    monthlyLog: {}
  };
}

function save(pushCloud = true) {
  state.updatedAt = Date.now();
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  if (pushCloud) {
    if (suppressNextWrite) { suppressNextWrite = false; return; }
    pushToCloud();
  }
}

// ─── FIREBASE ────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, user => {
  currentUser = user;
  if (!user) {
    signInAnonymously(auth).catch(() => setSyncStatus('off'));
    return;
  }
  syncCode = user.uid;
  localStorage.setItem(CODE_KEY, syncCode);
  updateAccountUI(user);
  attachCloudListener();
});

function attachCloudListener() {
  if (!syncCode) return;
  onSnapshot(doc(db, 'rituario_users', syncCode), snap => {
    if (snap.exists()) {
      const cloudData = snap.data();
      const cloudTime = cloudData.updatedAt || 0;
      const localTime = state.updatedAt || 0;
      if (cloudTime > localTime) {
        suppressNextWrite = true;
        state = cloudData;
        if (!state.monthlyHabits) state.monthlyHabits = [];
        if (!state.monthlyLog)    state.monthlyLog = {};
        save(false);
        render();
        if (activeTab === 'monthly') renderMonthly();
        renderCalendar();
      }
    } else {
      pushToCloud();
    }
    setSyncStatus('live');
  }, err => { console.error(err); setSyncStatus('off'); });
}

async function pushToCloud() {
  if (!syncCode) return;
  await setDoc(doc(db, 'rituario_users', syncCode), state)
    .catch(err => { console.error(err); setSyncStatus('off'); });
}

async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const wasAnon  = currentUser && currentUser.isAnonymous;
  const localState = JSON.parse(JSON.stringify(state));
  try {
    let result;
    if (wasAnon) {
      try { result = await linkWithPopup(currentUser, provider); }
      catch(err) {
        if (err.code === 'auth/credential-already-in-use') result = await signInWithPopup(auth, provider);
        else throw err;
      }
    } else {
      result = await signInWithPopup(auth, provider);
    }
    syncCode = result.user.uid;
    localStorage.setItem(CODE_KEY, syncCode);
    updateAccountUI(result.user);
    const snap = await getDoc(doc(db, 'rituario_users', syncCode));
    if (!snap.exists()) { state = localState; save(true); }
    attachCloudListener();
  } catch(err) { console.error(err); }
}

async function signOutGoogle() {
  await signOut(auth);
  localStorage.removeItem(CODE_KEY);
  syncCode = null;
  closeLinkSheet();
  location.reload();
}

// ─── NAVEGACIÓN DE DÍA ───────────────────────────────────────────────────────
function changeDay(delta) {
  const next = new Date(currentViewDate);
  next.setDate(next.getDate() + delta);
  next.setHours(0,0,0,0);
  // No permitir ir al futuro más allá de hoy
  const today = new Date(); today.setHours(0,0,0,0);
  if (next > today) return;
  currentViewDate = next;
  render();
  updateDateNav();
}

function updateDateNav() {
  const today = new Date(); today.setHours(0,0,0,0);
  const nextBtn = document.getElementById('btnDayNext');
  if (nextBtn) nextBtn.disabled = currentViewDate >= today;
  // Si estamos viendo el pasado, indicarlo
  const isPast = formatDateKey(currentViewDate) !== todayKey();
  document.getElementById('mainTitle').textContent = isPast ? formatDateKey(currentViewDate) : 'Hoy';
}

// ─── RENDER PRINCIPAL ────────────────────────────────────────────────────────
function render() {
  const viewKey  = formatDateKey(currentViewDate);
  const todayK   = todayKey();
  const isPast   = viewKey !== todayK;
  const todayLog = state.log[viewKey] || {};

  // Dateline
  document.getElementById('dateline').textContent =
    currentViewDate.toLocaleDateString('es-ES', {weekday:'long', day:'numeric', month:'long'});

  updateDateNav();

  // Lista de hábitos
  const list = document.getElementById('habitsList');
  list.innerHTML = '';
  state.habits.forEach(h => {
    const done = !!todayLog[h.id];
    const readonlyClass = isPast ? ' readonly' : '';
    list.insertAdjacentHTML('beforeend', `
      <div class="card${done ? ' done' : ''}${readonlyClass}" style="--accent:${h.color}" data-id="${h.id}">
        <div class="seal">
          <span class="icon-glyph">${h.icon}</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
        </div>
        <div class="meta">
          <div class="name">${escapeHtml(h.name)}</div>
          ${h.sub ? `<div class="sub">${escapeHtml(h.sub)}</div>` : ''}
        </div>
        <div class="chev" data-edit="${h.id}">✎</div>
      </div>`);
  });

  renderStreak();
  renderSummary();
  renderCalendar();
}

function renderStreak() {
  const dotsEl = document.getElementById('streakDots');
  dotsEl.innerHTML = '';

  // Calcula racha desde hoy hacia atrás
  let streak = 0;
  for (let i = 0; ; i--) {
    if (dayComplete(dayKey(i))) streak++;
    else break;
    if (i < -60) break;
  }
  document.getElementById('streakNum').textContent =
    streak === 0 ? 'Empieza hoy' : `${streak} día${streak>1?'s':''} seguido${streak>1?'s':''}`;

  // 14 puntos de color
  for (let i = -13; i <= 0; i++) {
    const key    = dayKey(i);
    const status = dayStatus(key);
    const d = document.createElement('div');
    d.className = `d ${status === 'green' ? 'full' : ''} ${status} ${i === 0 ? 'today' : ''}`.trim();
    dotsEl.appendChild(d);
  }
}

function renderSummary() {
  const viewKey  = formatDateKey(currentViewDate);
  const todayLog = state.log[viewKey] || {};
  const total    = state.habits.length;
  const done     = state.habits.filter(h => todayLog[h.id]).length;
  const isPast   = viewKey !== todayKey();
  const el       = document.getElementById('summary');
  if (total === 0) { el.innerHTML = ''; return; }
  el.innerHTML = `<b>${done}/${total}</b> ${isPast ? 'completados ese día' : 'completados hoy'}`;
}

// ─── RENDER MENSUAL ──────────────────────────────────────────────────────────
function renderMonthly() {
  const now      = new Date();
  const mKey     = monthKey(now);
  const monthLog = state.monthlyLog[mKey] || {};
  const monthName = now.toLocaleDateString('es-ES', {month:'long', year:'numeric'});
  document.getElementById('monthLabel').textContent = monthName.charAt(0).toUpperCase() + monthName.slice(1);

  const list = document.getElementById('monthlyList');
  list.innerHTML = '';
  state.monthlyHabits.forEach(h => {
    const done = !!monthLog[h.id];
    list.insertAdjacentHTML('beforeend', `
      <div class="card${done ? ' done' : ''}" style="--accent:${h.color}" data-id="${h.id}">
        <div class="seal">
          <span class="icon-glyph">${h.icon}</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
        </div>
        <div class="meta">
          <div class="name">${escapeHtml(h.name)}</div>
          ${h.sub ? `<div class="sub">${escapeHtml(h.sub)}</div>` : ''}
        </div>
        <div class="chev" data-edit="${h.id}">✎</div>
      </div>`);
  });

  const done = state.monthlyHabits.filter(h => monthLog[h.id]).length;
  document.getElementById('monthlyCount').textContent = `${done}/${state.monthlyHabits.length}`;
  document.getElementById('monthlyEmptyHint').style.display =
    state.monthlyHabits.length === 0 ? 'block' : 'none';
}

// ─── INTERACCIONES ────────────────────────────────────────────────────────────
function toggleHabit(id) {
  const viewKey = formatDateKey(currentViewDate);
  if (!state.log[viewKey]) state.log[viewKey] = {};

  const wasComplete = dayComplete(viewKey);
  const turningOn   = !state.log[viewKey][id];
  state.log[viewKey][id] = turningOn;

  save();
  render();
  renderCalendar();

  playTick(turningOn);
  vibrate(turningOn ? 15 : 8);

  if (!wasComplete && dayComplete(viewKey)) celebrateDay('¡Día completo! 🎉');
}

function toggleMonthlyHabit(id) {
  const mKey = monthKey();
  if (!state.monthlyLog[mKey]) state.monthlyLog[mKey] = {};

  const wasComplete = monthlyComplete(mKey);
  const turningOn   = !state.monthlyLog[mKey][id];
  state.monthlyLog[mKey][id] = turningOn;

  save();
  renderMonthly();
  if (monthCalOpen) renderMonthlyCalendar();

  playTick(turningOn);
  vibrate(turningOn ? 15 : 8);

  if (!wasComplete && monthlyComplete(mKey)) celebrateDay('¡Objetivo cumplido! 🎉');
}

function dayComplete(key) {
  const log = state.log[key];
  return log && state.habits.length > 0 && state.habits.every(h => !!log[h.id]);
}

function monthlyComplete(key) {
  const log = state.monthlyLog[key];
  return log && state.monthlyHabits.length > 0 && state.monthlyHabits.every(h => !!log[h.id]);
}

function dayStatus(key) {
  const log   = state.log[key];
  const total = state.habits.length;
  if (total === 0 || !log) return 'nodata';
  const missing = total - state.habits.filter(h => log[h.id]).length;
  return missing === 0 ? 'green' : missing <= 2 ? 'yellow' : 'red';
}

// ─── PESTAÑAS ────────────────────────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  document.getElementById('tabDailyBtn').classList.toggle('sel', tab === 'daily');
  document.getElementById('tabMonthlyBtn').classList.toggle('sel', tab === 'monthly');
  document.getElementById('dailySection').style.display   = tab === 'daily'   ? '' : 'none';
  document.getElementById('monthlySection').style.display = tab === 'monthly' ? '' : 'none';
  // Título
  if (tab === 'daily') { updateDateNav(); }
  else { document.getElementById('mainTitle').textContent = 'Este mes'; renderMonthly(); }
}

// ─── MODALES DE HÁBITO ───────────────────────────────────────────────────────
function listForMode(mode) { return mode === 'monthly' ? state.monthlyHabits : state.habits; }

function openSheet(id)        { sheetMode = 'daily';   openSheetCommon(id, 'Nuevo hábito',          'Editar hábito'); }
function openMonthlySheet(id) { sheetMode = 'monthly'; openSheetCommon(id, 'Nuevo objetivo mensual', 'Editar objetivo'); }

function openSheetCommon(id, newTitle, editTitle) {
  editingId = id || null;
  const delBtn = document.getElementById('deleteBtn');
  const nameEl = document.getElementById('fName');
  const subEl  = document.getElementById('fSub');

  let h = { name:'', sub:'', icon: sheetMode === 'monthly' ? '🎯' : '💧', color: COLORS[0] };
  if (editingId) {
    h = listForMode(sheetMode).find(x => x.id === editingId);
    document.getElementById('sheetTitle').textContent = editTitle;
    delBtn.style.display = 'block';
  } else {
    document.getElementById('sheetTitle').textContent = newTitle;
    delBtn.style.display = 'none';
  }
  nameEl.value = h.name;
  subEl.value  = h.sub;
  nameEl.placeholder = sheetMode === 'monthly' ? 'p. ej. Leer un libro'    : 'p. ej. Beber 2L de agua';
  subEl.placeholder  = sheetMode === 'monthly' ? 'p. ej. Antes de fin de mes' : 'p. ej. 8 vasos al día';

  document.getElementById('iconTriggerPreview').textContent = h.icon;
  document.getElementById('emojiDropdown').classList.remove('open');
  document.getElementById('iconChevron').classList.remove('open');

  activeEmojiCat = CATEGORY_KEYS.find(cat => EMOJI_CATEGORIES[cat].includes(h.icon)) || CATEGORY_KEYS[0];
  renderEmojiTabs(h.icon);
  renderEmojiGrid(h.icon);

  const colorPicker = document.getElementById('colorPicker');
  colorPicker.innerHTML = '';
  COLORS.forEach(c => {
    const b = document.createElement('div');
    b.className = 'swatch' + (c === h.color ? ' sel' : '');
    b.style.background = c;
    colorPicker.appendChild(b);
  });

  document.getElementById('overlay').classList.add('open');
}

function closeSheet() {
  document.getElementById('overlay').classList.remove('open');
  editingId = null;
}

function saveHabit() {
  const name = document.getElementById('fName').value.trim();
  if (!name) { document.getElementById('fName').focus(); return; }
  const sub   = document.getElementById('fSub').value.trim();
  const icon  = document.getElementById('iconTriggerPreview').textContent || '💧';
  const color = rgbToHex(document.querySelector('.swatch.sel')?.style.background || COLORS[0]);
  const list  = listForMode(sheetMode);

  if (editingId) {
    const h = list.find(x => x.id === editingId);
    h.name = name; h.sub = sub; h.icon = icon; h.color = color;
  } else {
    list.push({ id: 'h' + Date.now(), name, sub, icon, color });
  }
  save();
  closeSheet();
  if (sheetMode === 'monthly') renderMonthly(); else render();
}

function deleteHabit() {
  if (!editingId) return;
  if (sheetMode === 'monthly') state.monthlyHabits = state.monthlyHabits.filter(h => h.id !== editingId);
  else state.habits = state.habits.filter(h => h.id !== editingId);
  save();
  closeSheet();
  if (sheetMode === 'monthly') renderMonthly(); else render();
}

// ─── CALENDARIOS ─────────────────────────────────────────────────────────────
// Calendario diario siempre visible — toggleCalendar eliminado
function shiftMonth(delta) { calDate.setMonth(calDate.getMonth() + delta); renderCalendar(); }

function renderCalendar() {
  document.getElementById('calWeekdays').innerHTML = WEEKDAY_LETTERS.map(l => `<span>${l}</span>`).join('');
  document.getElementById('calMonthLabel').textContent = `${MONTH_NAMES[calDate.getMonth()]} ${calDate.getFullYear()}`;

  const grid = document.getElementById('calGrid');
  grid.innerHTML = '';
  const year  = calDate.getFullYear(), month = calDate.getMonth();
  const days  = new Date(year, month+1, 0).getDate();
  let offset  = new Date(year, month, 1).getDay() - 1;
  if (offset < 0) offset = 6;

  for (let i=0; i<offset; i++) grid.insertAdjacentHTML('beforeend','<div class="cal-cell empty"></div>');
  for (let d=1; d<=days; d++) {
    const key    = formatDateKey(new Date(year, month, d));
    const todayK = todayKey();
    let cls = key > todayK ? 'future' : dayStatus(key);
    if (key === todayK) cls += ' today';
    grid.insertAdjacentHTML('beforeend', `<div class="cal-cell ${cls}">${d}</div>`);
  }
}

function toggleMonthlyCalendar() {
  monthCalOpen = !monthCalOpen;
  document.getElementById('monthlyCalendarPanel').classList.toggle('open', monthCalOpen);
  document.getElementById('monthlyCalToggle').classList.toggle('open', monthCalOpen);
  if (monthCalOpen) renderMonthlyCalendar();
}
function shiftYear(delta) { monthCalYear += delta; renderMonthlyCalendar(); }

function renderMonthlyCalendar() {
  document.getElementById('calYearLabel').textContent = monthCalYear;
  const grid = document.getElementById('monthGrid');
  grid.innerHTML = '';
  const now = new Date();

  for (let m=0; m<12; m++) {
    const key = `${monthCalYear}-${String(m+1).padStart(2,'0')}`;
    const isFuture = monthCalYear > now.getFullYear() ||
      (monthCalYear === now.getFullYear() && m > now.getMonth());
    let cls;
    if (isFuture) {
      cls = 'future';
    } else {
      const log = state.monthlyLog[key];
      if (!log || state.monthlyHabits.length === 0) { cls = 'nodata'; }
      else {
        const missing = state.monthlyHabits.length - state.monthlyHabits.filter(h => log[h.id]).length;
        cls = missing === 0 ? 'green' : missing <= 2 ? 'yellow' : 'red';
      }
    }
    if (monthCalYear === now.getFullYear() && m === now.getMonth()) cls += ' current';
    const done = state.monthlyLog[key] ? state.monthlyHabits.filter(h => state.monthlyLog[key][h.id]).length : 0;
    const frac = (!isFuture && state.monthlyHabits.length > 0) ? `<span class="frac">${done}/${state.monthlyHabits.length}</span>` : '';
    grid.insertAdjacentHTML('beforeend', `<div class="month-cell ${cls}"><span>${MONTH_ABBR[m]}</span>${frac}</div>`);
  }
}

// ─── EMOJI PICKER ────────────────────────────────────────────────────────────
const EMOJI_CATEGORIES = {
  '🙂':['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥵','🥶','😵','🤯','🥳','😎','🤓','🧐','😕','😟','🙁','😮','😯','😲','😳','🥺','😦','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','💀','💩'],
  '✋':['👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🙏','✍️','💅','🤳','💪','🦾','🦵','🦶','👂','🦻','👃','🧠','🦷','👀','👁️','👅','👄'],
  '🏃':['🏃','🏃‍♀️','🚶','🚶‍♀️','🧘','🧘‍♀️','🏋️','🏋️‍♀️','🤸','🤸‍♀️','⛹️','🤾','🏌️','🏄','🏊','🤽','🚴','🚵','🤺','🤼','🤹','🧗','🏇','⛷️','🏂','🤿','🚣','🛌','🛀','🧖','💃','🕺','👯','🤝','💑','💏'],
  '💧':['💧','💦','🌊','🔥','⭐','🌟','✨','⚡','☀️','🌙','⛅','☁️','🌈','❄️','💤','💢','💥','💫','🌸','🌺','🌻','🌼','🌷','🌹','🍀','🌱','🌳','🍃','🌵','🪴'],
  '🍎':['🍎','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🥑','🥦','🥬','🥒','🌶️','🫑','🌽','🥕','🧄','🧅','🥔','🍠','🥐','🍞','🥖','🥗','🥙','🍕','🍔','🌭','🌮','🌯','🥪','🍳','🥘','🍲','🍜','🍣','🍱','🥟','🍿','🧂','🥫','🍰','🎂','🍪','🍩','🍫','🍬','🍭','🍵','☕','🥤','🧃','🍺','🍷','🥂','💧'],
  '⚽':['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🪀','🏓','🏸','🥅','⛳','🪁','🏹','🎣','🤿','🥊','🥋','🎽','🛹','🛼','🛷','⛸️','🥌','🎿','⛷️','🏂','🏋️','🤼','🤸','⛹️','🤺','🤾','🏌️','🏇','🧘'],
  '📚':['📚','📖','📝','✏️','🖊️','🖋️','📔','📕','📗','📘','📙','📓','📒','📃','📄','📑','🔖','🏷️','💼','📁','📂','🗂️','📅','📆','🗒️','🗓️','📇','📈','📉','📊','📌','📍','📎','🖇️','📏','📐','✂️','🗃️','🗄️','🗑️'],
  '🎯':['🎯','🎲','🎮','🎧','🎵','🎶','🎤','🎸','🎹','🎨','🎭','🎬','📷','📸','🎥','💡','🔦','🕯️','💰','💵','💳','📱','💻','⌚','⏰','⏱️','⏲️','🕰️','🧭','🔑','🔒','🛠️','🔧','🔨','⚙️','🧹','🧺','🧼','🪥','🚿','🛁','🪒'],
  '❤️':['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉️','☸️','✡️','🔯','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','🆗','✅','✔️','☑️','✳️','❌','❗','❓','💯','🔄']
};
const CATEGORY_KEYS = Object.keys(EMOJI_CATEGORIES);
activeEmojiCat = CATEGORY_KEYS[0];

function toggleEmojiPicker() {
  document.getElementById('emojiDropdown').classList.toggle('open');
  document.getElementById('iconChevron').classList.toggle('open');
}
function renderEmojiTabs(selectedIcon) {
  document.getElementById('emojiTabs').innerHTML = CATEGORY_KEYS.map(cat =>
    `<button type="button" class="emoji-tab${cat===activeEmojiCat?' sel':''}" data-cat="${cat}">${cat}</button>`
  ).join('');
}
function renderEmojiGrid(selectedIcon) {
  document.getElementById('emojiPicker').innerHTML = EMOJI_CATEGORIES[activeEmojiCat].map(em =>
    `<div class="emoji-opt${em===selectedIcon?' sel':''}">${em}</div>`
  ).join('');
}

// ─── ONBOARDING ──────────────────────────────────────────────────────────────
const HABIT_SUGGESTIONS = [
  {name:'Beber 2L de agua',    sub:'8 vasos al día', icon:'💧'},
  {name:'Caminar 10.000 pasos',sub:'',               icon:'👣'},
  {name:'Leer 20 minutos',     sub:'',               icon:'📖'},
  {name:'Meditar',             sub:'10 minutos',     icon:'🧘'},
  {name:'Hacer ejercicio',     sub:'',               icon:'🏋️'},
  {name:'Dormir 8 horas',      sub:'',               icon:'😴'},
  {name:'Comer sano',          sub:'',               icon:'🥗'},
  {name:'Escribir diario',     sub:'',               icon:'✍️'},
  {name:'Reducir pantalla',    sub:'',               icon:'📵'},
  {name:'Estirar',             sub:'5 minutos',      icon:'🤸'},
  {name:'Ahorrar',             sub:'',               icon:'💰'},
  {name:'Practicar gratitud',  sub:'',               icon:'🙏'},
];

function renderOnboardGrid() {
  document.getElementById('onboardGrid').innerHTML = HABIT_SUGGESTIONS.map((s,i) =>
    `<div class="onboard-chip${onboardSelected.has(i)?' sel':''}" data-idx="${i}"><span class="em">${s.icon}</span><span>${s.name}</span></div>`
  ).join('');
}
function toggleOnboardChip(i) {
  onboardSelected.has(i) ? onboardSelected.delete(i) : onboardSelected.add(i);
  renderOnboardGrid();
  document.getElementById('onboardStart').textContent =
    onboardSelected.size > 0 ? `Empezar con ${onboardSelected.size}` : 'Empezar';
}
function maybeShowOnboarding() {
  if (localStorage.getItem(ONBOARD_KEY)) return;
  onboardSelected = new Set([0,1,2]);
  renderOnboardGrid();
  document.getElementById('onboardStart').textContent = `Empezar con ${onboardSelected.size}`;
  document.getElementById('onboardOverlay').classList.add('open');
}
function skipOnboarding() {
  localStorage.setItem(ONBOARD_KEY,'1');
  document.getElementById('onboardOverlay').classList.remove('open');
}
function finishOnboarding() {
  if (onboardSelected.size > 0) {
    state.habits = [...onboardSelected].map((i,idx) => ({
      id:'h'+Date.now()+idx, name:HABIT_SUGGESTIONS[i].name,
      sub:HABIT_SUGGESTIONS[i].sub, icon:HABIT_SUGGESTIONS[i].icon,
      color:COLORS[idx % COLORS.length]
    }));
    save(); render();
  }
  skipOnboarding();
}

// ─── TEMA ────────────────────────────────────────────────────────────────────
function applyTheme(mode) {
  const resolved = mode === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : mode;
  document.documentElement.setAttribute('data-theme', resolved);
}
function setTheme(mode) {
  localStorage.setItem(THEME_KEY, mode);
  applyTheme(mode);
  document.querySelectorAll('.theme-opt').forEach(b => b.classList.toggle('sel', b.dataset.theme === mode));
}
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'auto';
  applyTheme(saved);
  document.querySelectorAll('.theme-opt').forEach(b => b.classList.toggle('sel', b.dataset.theme === saved));
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if ((localStorage.getItem(THEME_KEY)||'auto') === 'auto') applyTheme('auto');
    });
  }
}

// ─── SONIDO & VIBRACIÓN ──────────────────────────────────────────────────────
function playTick(rising) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.type = 'sine';
    const t = audioCtx.currentTime;
    o.frequency.setValueAtTime(rising ? 520 : 320, t);
    o.frequency.exponentialRampToValueAtTime(rising ? 880 : 200, t + 0.09);
    g.gain.setValueAtTime(0.08, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.start(t); o.stop(t + 0.13);
  } catch(e) {}
}
function vibrate(ms) { if (navigator.vibrate) navigator.vibrate(ms); }

function celebrateDay(message = '¡Día completo! 🎉') {
  const layer  = document.createElement('div'); layer.className = 'confetti-layer';
  const colors = ['--moss','--clay','--gold'].map(v => getComputedStyle(document.documentElement).getPropertyValue(v).trim());
  for (let i=0; i<28; i++) {
    const p = document.createElement('span'); p.className = 'confetti-piece';
    p.style.left = (Math.random()*100)+'vw';
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = (Math.random()*0.4)+'s';
    p.style.transform = `rotate(${Math.random()*360}deg)`;
    layer.appendChild(p);
  }
  const banner = document.createElement('div'); banner.className = 'celebrate-banner'; banner.textContent = message;
  document.body.appendChild(layer); document.body.appendChild(banner);
  vibrate([15,60,15,60,30]);
  setTimeout(() => banner.classList.add('show'), 20);
  setTimeout(() => banner.classList.remove('show'), 2200);
  setTimeout(() => { layer.remove(); banner.remove(); }, 2800);
}

// ─── RECORDATORIOS ───────────────────────────────────────────────────────────
function remindersEnabled() { return localStorage.getItem(REMIND_KEY) === '1'; }
function updateReminderUI() {
  document.getElementById('remindToggleState').textContent =
    (remindersEnabled() && Notification.permission === 'granted') ? 'Activado' : 'Desactivado';
}
async function toggleReminders() {
  if (!('Notification' in window)) return alert('Este navegador no admite notificaciones.');
  if (!window.isSecureContext)     return alert('Los avisos solo funcionan en HTTPS.');
  if (remindersEnabled()) {
    localStorage.setItem(REMIND_KEY,'0');
    if (reminderInterval) { clearInterval(reminderInterval); reminderInterval = null; }
    return updateReminderUI();
  }
  if (Notification.permission === 'denied') return alert('Notificaciones bloqueadas en el navegador.');
  if (await Notification.requestPermission() !== 'granted') return updateReminderUI();
  localStorage.setItem(REMIND_KEY,'1');
  checkReminder();
  reminderInterval = setInterval(checkReminder, 15 * 60 * 1000);
  updateReminderUI();
}
function checkReminder() {
  if (!remindersEnabled() || Notification.permission !== 'granted' || state.habits.length === 0 || dayComplete(todayKey())) return;
  const now = new Date(), eod = new Date(now); eod.setHours(24,0,0,0);
  if ((eod - now) / 3600000 > 8 || localStorage.getItem(REMIND_DATE_KEY) === todayKey()) return;
  localStorage.setItem(REMIND_DATE_KEY, todayKey());
  const body = 'Te quedan hábitos por marcar hoy ¡No lo dejes para después!';
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.ready.then(reg => reg.showNotification('Rituario', {body, icon:'icon-192.png', tag:'rituario-reminder'}));
  } else {
    try { new Notification('Rituario', {body, icon:'icon-192.png'}); } catch(e) {}
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && remindersEnabled() && Notification.permission === 'granted') checkReminder();
});

// ─── SYNC UI ─────────────────────────────────────────────────────────────────
function setSyncStatus(mode) {
  const dot = document.getElementById('syncDot');
  if (!dot) return;
  dot.className = 'dot-sync' + (mode==='live' ? ' live' : mode==='off' ? ' off' : '');
  document.getElementById('syncText').textContent =
    mode==='live' ? 'sincronizado' : mode==='off' ? 'solo local' : 'conectando…';
}
function updateAccountUI(user) {
  if (user && !user.isAnonymous) {
    document.getElementById('loggedOutView').style.display = 'none';
    document.getElementById('loggedInView').style.display  = 'block';
    document.getElementById('accountAvatar').src = user.photoURL || '';
    document.getElementById('accountName').textContent  = user.displayName || 'Tu cuenta';
    document.getElementById('accountEmail').textContent = user.email || '';
  } else {
    document.getElementById('loggedOutView').style.display = 'block';
    document.getElementById('loggedInView').style.display  = 'none';
  }
}
function openLinkSheet()     { updateAccountUI(currentUser); document.getElementById('linkOverlay').classList.add('open'); }
function closeLinkSheet()    { document.getElementById('linkOverlay').classList.remove('open'); }
function openSettingsSheet() { document.getElementById('settingsOverlay').classList.add('open'); updateReminderUI(); }
function closeSettingsSheet(){ document.getElementById('settingsOverlay').classList.remove('open'); }

// ─── DELEGACIÓN DE EVENTOS ───────────────────────────────────────────────────
document.addEventListener('click', e => {
  const t = e.target;

  // Tabs & header
  if (t.closest('#tabDailyBtn'))   switchTab('daily');
  if (t.closest('#tabMonthlyBtn')) switchTab('monthly');
  if (t.closest('#syncPill'))      openLinkSheet();
  if (t.closest('#btnSettings'))   openSettingsSheet();

  // Navegación de día
  if (t.closest('#btnDayPrev')) changeDay(-1);
  if (t.closest('#btnDayNext')) changeDay(1);

  // Onboarding
  if (t.closest('#btnSkipOnboarding')) skipOnboarding();
  if (t.closest('#onboardStart'))      finishOnboarding();
  const chip = t.closest('.onboard-chip');
  if (chip) toggleOnboardChip(parseInt(chip.dataset.idx));

  // Cards
  const chev = t.closest('.chev');
  const card = t.closest('.card');
  if (chev) {
    if (activeTab === 'daily') openSheet(chev.dataset.edit);
    else openMonthlySheet(chev.dataset.edit);
    e.stopPropagation();
  } else if (card && !card.classList.contains('readonly')) {
    if (activeTab === 'daily') toggleHabit(card.dataset.id);
    else toggleMonthlyHabit(card.dataset.id);
  }

  // Fabs
  if (t.closest('#btnAddHabit'))        openSheet();
  if (t.closest('#btnAddMonthlyHabit')) openMonthlySheet();

  // Modales (cerrar al clic en fondo)
  if (t.id === 'overlay')         closeSheet();
  if (t.id === 'settingsOverlay') closeSettingsSheet();
  if (t.id === 'linkOverlay')     closeLinkSheet();

  // Botones de modal
  if (t.closest('#btnCancelSheet'))   closeSheet();
  if (t.closest('#btnSaveHabit'))     saveHabit();
  if (t.closest('#deleteBtn'))        deleteHabit();
  if (t.closest('#btnCloseSettings')) closeSettingsSheet();
  if (t.closest('#btnCloseLink'))     closeLinkSheet();

  // Emoji picker
  if (t.closest('#iconTrigger')) toggleEmojiPicker();
  const emojiTab = t.closest('.emoji-tab');
  if (emojiTab) {
    activeEmojiCat = emojiTab.dataset.cat;
    const sel = document.getElementById('iconTriggerPreview').textContent;
    renderEmojiTabs(sel); renderEmojiGrid(sel);
  }
  const emojiOpt = t.closest('.emoji-opt');
  if (emojiOpt) {
    document.querySelectorAll('.emoji-opt').forEach(x => x.classList.remove('sel'));
    emojiOpt.classList.add('sel');
    document.getElementById('iconTriggerPreview').textContent = emojiOpt.textContent;
    document.getElementById('emojiDropdown').classList.remove('open');
    document.getElementById('iconChevron').classList.remove('open');
  }
  const swatch = t.closest('.swatch');
  if (swatch) {
    document.querySelectorAll('.swatch').forEach(x => x.classList.remove('sel'));
    swatch.classList.add('sel');
  }
  const themeOpt = t.closest('.theme-opt');
  if (themeOpt) setTheme(themeOpt.dataset.theme);

  // Calendarios

  if (t.closest('#btnPrevMonth'))      shiftMonth(-1);
  if (t.closest('#btnNextMonth'))      shiftMonth(1);
  if (t.closest('#monthlyCalToggle'))  toggleMonthlyCalendar();
  if (t.closest('#btnPrevYear'))       shiftYear(-1);
  if (t.closest('#btnNextYear'))       shiftYear(1);

  // Auth
  if (t.closest('#btnSignIn'))  signInWithGoogle();
  if (t.closest('#btnSignOut')) signOutGoogle();

  // Recordatorios
  if (t.closest('#remindToggleBtn')) toggleReminders();
});

// ─── ARRANQUE ────────────────────────────────────────────────────────────────
applyTheme(localStorage.getItem(THEME_KEY) || 'auto'); // inmediato, sin flash
render();
initTheme();
maybeShowOnboarding();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if ('Notification' in window && remindersEnabled() && Notification.permission === 'granted') {
  checkReminder();
  reminderInterval = setInterval(checkReminder, 15 * 60 * 1000);
}
