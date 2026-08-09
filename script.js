import { db, ensureAuth } from './firebase-init.js';
import { ref, set, get, onValue, update, onDisconnect, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-database.js';

const N = 10;
const $ = s => document.querySelector(s);
const boardEl = $('#board');
const statusEl = $('#status');
const banner = $('#captureBanner');
const wait = ms => new Promise(r => setTimeout(r, ms));

let B = [];
let turn = 1;
let sel = null;
let chain = false;
let locked = false;
let room = null;
let myUid = null;
let mySide = null;
let roomHostId = null;
let roomHasTwo = false;
let onlineStarted = false;
let unsub = null;
let applyingRemote = false;
let lastMoveId = null;
let lastWinnerShown = 0;

const mode = () => $('#mode').value;
const level = () => $('#level').value;
const mandatory = () => $('#mandatory').checked;

function freshBoard() {
  const b = Array.from({ length: N }, () => Array(N).fill(null));
  for (let r = 0; r < 4; r++) for (let c = 0; c < N; c++) if ((r + c) % 2) b[r][c] = { p: 2, k: false };
  for (let r = 6; r < N; r++) for (let c = 0; c < N; c++) if ((r + c) % 2) b[r][c] = { p: 1, k: false };
  return b;
}

function cloneBoard(b = B) { return JSON.parse(JSON.stringify(b)); }
function inside(r, c) { return r >= 0 && r < N && c >= 0 && c < N; }

function savePrefs() {
  localStorage.setItem('damesPrefs', JSON.stringify({
    sound: $('#sound').checked,
    hints: $('#hints').checked,
    mandatory: mandatory(),
    theme: $('#theme').value,
    name: $('#playerName').value.trim()
  }));
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('damesPrefs') || '{}');
    if (p.sound !== undefined) $('#sound').checked = p.sound;
    if (p.hints !== undefined) $('#hints').checked = p.hints;
    if (p.mandatory !== undefined) $('#mandatory').checked = p.mandatory;
    if (p.theme) $('#theme').value = p.theme;
    if (p.name) $('#playerName').value = p.name;
  } catch {}
  applyTheme(false);
}

function saveLocal() {
  if (mode() === 'online' || applyingRemote) return;
  localStorage.setItem('damesGame', JSON.stringify({ B, turn, mode: mode(), level: level(), mandatory: mandatory() }));
}

function restoreLocal() {
  try {
    const s = JSON.parse(localStorage.getItem('damesGame') || 'null');
    if (!s?.B) return false;
    B = s.B;
    turn = s.turn || 1;
    $('#mode').value = s.mode === 'online' ? 'ai' : (s.mode || 'ai');
    $('#level').value = s.level || 'medium';
    if (s.mandatory !== undefined) $('#mandatory').checked = s.mandatory;
    return true;
  } catch { return false; }
}

function saveOnlineSession() {
  if (!room) return;
  localStorage.setItem('damesOnlineSession', JSON.stringify({ room, side: mySide, at: Date.now() }));
}

function clearOnlineSession() { localStorage.removeItem('damesOnlineSession'); }

function init(clear = true) {
  if (clear) B = freshBoard();
  turn = 1; sel = null; chain = false; locked = false; lastMoveId = null; lastWinnerShown = 0;
  $('#winner').classList.add('hidden');
  banner.textContent = '';
  render();
  saveLocal();
}

function capturesFor(r, c, b = B) {
  const x = b[r]?.[c];
  if (!x) return [];
  const out = [];
  if (x.k) {
    for (const [dr, dc] of [[1,1],[1,-1],[-1,1],[-1,-1]]) {
      let rr = r + dr, cc = c + dc, enemy = null;
      while (inside(rr, cc)) {
        if (b[rr][cc]) {
          if (b[rr][cc].p === x.p || enemy) break;
          enemy = [rr, cc];
        } else if (enemy) out.push({ r: rr, c: cc, cap: enemy });
        rr += dr; cc += dc;
      }
    }
  } else {
    for (const [dr, dc] of [[1,1],[1,-1],[-1,1],[-1,-1]]) {
      const mr = r + dr, mc = c + dc, tr = r + 2 * dr, tc = c + 2 * dc;
      if (inside(tr, tc) && b[mr]?.[mc] && b[mr][mc].p !== x.p && !b[tr][tc]) out.push({ r: tr, c: tc, cap: [mr, mc] });
    }
  }
  return out;
}

function anyCaps(p, b = B) {
  const a = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (b[r][c]?.p === p) {
    for (const m of capturesFor(r, c, b)) a.push({ fr: r, fc: c, ...m });
  }
  return a;
}

function movesFor(r, c) {
  const x = B[r]?.[c];
  if (!x) return [];
  const caps = capturesFor(r, c);
  if (mandatory() && anyCaps(x.p).length) return caps;
  const out = [...caps];
  if (x.k) {
    for (const [dr, dc] of [[1,1],[1,-1],[-1,1],[-1,-1]]) {
      let rr = r + dr, cc = c + dc;
      while (inside(rr, cc) && !B[rr][cc]) { out.push({ r: rr, c: cc }); rr += dr; cc += dc; }
    }
  } else {
    const dr = x.p === 1 ? -1 : 1;
    for (const dc of [-1, 1]) if (inside(r + dr, c + dc) && !B[r + dr][c + dc]) out.push({ r: r + dr, c: c + dc });
  }
  return out;
}

function allMoves(p) {
  const caps = anyCaps(p);
  if (mandatory() && caps.length) return caps;
  const a = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (B[r][c]?.p === p) {
    for (const m of movesFor(r, c)) a.push({ fr: r, fc: c, ...m });
  }
  return a;
}

function viewCoord(r, c) {
  return (mode() === 'online' && mySide === 2) ? [N - 1 - r, N - 1 - c] : [r, c];
}

function updateNames() {
  if (mode() === 'online' && room) return;
  $('#p1name').textContent = 'Joueur';
  $('#p2name').textContent = mode() === 'ai' ? 'IA' : 'Joueur 2';
}

function render() {
  boardEl.innerHTML = '';
  const targets = sel ? movesFor(...sel) : [];
  const cells = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const [vr, vc] = viewCoord(r, c);
    cells.push({ r, c, order: vr * N + vc });
  }
  cells.sort((a, b) => a.order - b.order);

  for (const { r, c } of cells) {
    const s = document.createElement('div');
    s.className = 'sq ' + ((r + c) % 2 ? 'dark' : 'light');
    if ($('#hints').checked && targets.some(m => m.r === r && m.c === c)) s.classList.add('target');
    const x = B[r]?.[c];
    if (x) {
      const p = document.createElement('div');
      p.className = `piece p${x.p}${x.k ? ' king' : ''}${sel && sel[0] === r && sel[1] === c ? ' selected' : ''}`;
      p.dataset.r = r; p.dataset.c = c;
      s.appendChild(p);
    }
    s.onclick = () => click(r, c);
    boardEl.appendChild(s);
  }

  const lightCount = B.flat().filter(x => x?.p === 1).length;
  const darkCount = B.flat().filter(x => x?.p === 2).length;
  $('#p1count').textContent = mySide === 2 ? darkCount : lightCount;
  $('#p2count').textContent = mySide === 2 ? lightCount : darkCount;
  updateNames();

  if (mode() === 'online') {
    if (!room) statusEl.textContent = 'Créez ou rejoignez un salon';
    else if (!roomHasTwo) statusEl.textContent = 'En attente d’un adversaire…';
    else if (!onlineStarted) statusEl.textContent = mySide === 1 ? 'Adversaire connecté — lancez la partie' : 'En attente du lancement par l’hôte…';
    else statusEl.textContent = turn === mySide ? 'À vous de jouer' : 'Tour de l’adversaire';
  } else {
    statusEl.textContent = turn === 1 ? 'Tour : Joueur clair' : (mode() === 'ai' ? 'Tour : IA' : 'Tour : Joueur sombre');
  }
}

function click(r, c) {
  if (locked) return;
  if (mode() === 'ai' && turn === 2) return;
  if (mode() === 'online' && (!roomHasTwo || !onlineStarted || turn !== mySide)) return;

  const x = B[r][c];
  if (x?.p === turn && !chain) {
    if (mandatory() && anyCaps(turn).length && !capturesFor(r, c).length) return;
    sel = [r, c]; render(); return;
  }
  if (sel) {
    const m = movesFor(...sel).find(z => z.r === r && z.c === c);
    if (m) doMove(sel[0], sel[1], m, { broadcast: true });
  }
}

function sound(kind) {
  if (!$('#sound').checked) return;
  const map = {
    move: [260, .07, 'sine'],
    announce: [470, .12, 'triangle'],
    capture: [105, .30, 'square'],
    king: [650, .20, 'sine'],
    win: [760, .28, 'triangle'],
    start: [520, .13, 'sine']
  };
  const [f, d, t] = map[kind] || map.move;
  try {
    const A = new (window.AudioContext || window.webkitAudioContext)();
    const o = A.createOscillator(), g = A.createGain();
    o.type = t; o.frequency.value = f; g.gain.value = .055;
    o.connect(g); g.connect(A.destination); o.start(); o.stop(A.currentTime + d);
  } catch {}
}

async function doMove(fr, fc, m, opt = {}) {
  if (!B[fr]?.[fc]) return;
  locked = true;
  const before = cloneBoard();
  const x = B[fr][fc];

  // Temps 1 : le pion saute / arrive sur sa case.
  B[m.r][m.c] = x;
  B[fr][fc] = null;
  sel = [m.r, m.c];
  render();
  sound('move');
  await wait(420);

  if (m.cap) {
    // Temps 2 : annonce claire de la prise.
    banner.textContent = 'PRISE !';
    sound('announce');
    await wait(650);

    // Temps 3 : la pièce capturée s'illumine puis quitte le plateau.
    const pe = [...boardEl.querySelectorAll('.piece')].find(e => +e.dataset.r === m.cap[0] && +e.dataset.c === m.cap[1]);
    pe?.classList.add('captureWarn');
    await wait(700);
    sound('capture');
    pe?.classList.remove('captureWarn');
    pe?.classList.add('capturing');
    await wait(650);
    B[m.cap[0]][m.cap[1]] = null;
    render();
    await wait(260);

    const more = capturesFor(m.r, m.c);
    if (more.length) {
      chain = true;
      locked = false;
      await syncOnline({ fr, fc, m, before, continuing: true });
      saveLocal();
      if (mode() === 'ai' && turn === 2) setTimeout(ai, 700);
      return;
    }
  }

  if ((x.p === 1 && m.r === 0) || (x.p === 2 && m.r === 9)) {
    if (!x.k) { x.k = true; sound('king'); }
  }

  chain = false; sel = null; banner.textContent = '';
  turn = 3 - turn;
  locked = false;
  render();
  await syncOnline({ fr, fc, m, before, continuing: false });
  saveLocal();
  if (checkEnd()) return;
  if (mode() === 'ai' && turn === 2) setTimeout(ai, 720);
}

function ai() {
  if (turn !== 2 || locked) return;
  let a = chain && sel ? capturesFor(...sel).map(m => ({ fr: sel[0], fc: sel[1], ...m })) : allMoves(2);
  if (!a.length) { showWinner(1); return; }
  const score = m => (m.cap ? 70 : 0) + (m.r >= 7 ? 16 : 0) + (B[m.fr][m.fc]?.k ? 8 : 0) - Math.abs(4.5 - m.c);
  let pick;
  if (level() === 'easy') pick = a[Math.floor(Math.random() * a.length)];
  else {
    a.sort((u, v) => score(v) - score(u));
    const n = level() === 'hard' ? Math.min(2, a.length) : Math.min(5, a.length);
    pick = a[Math.floor(Math.random() * n)];
  }
  sel = [pick.fr, pick.fc]; render();
  setTimeout(() => doMove(pick.fr, pick.fc, pick), 480);
}

function checkEnd() {
  if (!B.flat().some(x => x?.p === turn) || !allMoves(turn).length) {
    showWinner(3 - turn, true);
    return true;
  }
  return false;
}

async function playerNameForSide(side) {
  if (mode() !== 'online' || !room) return side === 1 ? 'Joueur clair' : 'Joueur sombre';
  try {
    const snap = await get(ref(db, `damesRooms/${room}/players`));
    const ps = snap.val() || {};
    return Object.values(ps).find(v => v.side === side)?.name || (side === 1 ? 'Joueur clair' : 'Joueur sombre');
  } catch { return side === 1 ? 'Joueur clair' : 'Joueur sombre'; }
}

async function showWinner(p, broadcast = false) {
  if (!p || lastWinnerShown === p) return;
  lastWinnerShown = p;
  locked = true;
  const name = await playerNameForSide(p);
  $('#winnerText').textContent = name + ' remporte la partie !';
  $('#winner').classList.remove('hidden');
  statusEl.textContent = 'Partie terminée';
  sound('win'); setTimeout(() => sound('win'), 220); confetti();
  if (broadcast && mode() === 'online' && room) {
    update(ref(db, `damesRooms/${room}/game`), { winner: p, status: 'finished', updatedAt: serverTimestamp() }).catch(() => {});
  }
}

function confetti() {
  const c = $('#confetti'), x = c.getContext('2d');
  c.width = innerWidth; c.height = innerHeight;
  const q = Array.from({ length: 170 }, () => ({ x: Math.random()*c.width, y: -20-Math.random()*300, v: 2+Math.random()*5, s: 3+Math.random()*6, a: Math.random()*6, h: Math.random()*360 }));
  let t = 0;
  (function f() {
    x.clearRect(0,0,c.width,c.height);
    q.forEach(p => { p.y += p.v; p.a += .1; x.save(); x.translate(p.x,p.y); x.rotate(p.a); x.fillStyle = `hsl(${p.h} 80% 60%)`; x.fillRect(-p.s/2,-p.s/2,p.s,p.s); x.restore(); });
    if (t++ < 210) requestAnimationFrame(f); else x.clearRect(0,0,c.width,c.height);
  })();
}

function code() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }
function cleanName() { return $('#playerName').value.trim().slice(0, 20) || 'Joueur'; }
function friendlyFirebase(e) {
  const s = String(e?.code || e?.message || e);
  if (s.includes('PERMISSION_DENIED') || s.includes('permission-denied')) return 'règles Firebase à autoriser pour /damesRooms';
  if (s.includes('auth/operation-not-allowed')) return 'activez l’authentification anonyme dans Firebase';
  return e?.message || 'erreur Firebase';
}
function onlineMsg(t) { $('#onlineMsg').textContent = t; $('#roomInfo').classList.remove('hidden'); }

function setOnlineCompact(active) {
  const panel = $('#onlinePanel');
  if (!panel) return;
  panel.classList.toggle('compact', !!active);
  // In compact mode keep only the room code + live status visible.
  if (active && room) $('#shownCode').textContent = room;
}

function updateStartButton() {
  const b = $('#startOnline');
  const isHost = !!myUid && myUid === roomHostId;
  b.classList.toggle('hidden', !isHost || onlineStarted);
  b.disabled = !roomHasTwo || onlineStarted;
  b.textContent = roomHasTwo ? 'Lancer la partie' : 'En attente d’un adversaire…';
}

function showRoom() {
  $('#roomInfo').classList.remove('hidden');
  $('#shownCode').textContent = room;
  $('#roomCode').value = room;
  onlineMsg('Connexion au salon…');
  saveOnlineSession();
}

async function createRoom() {
  try {
    const u = await ensureAuth();
    myUid = u.uid; mySide = 1; roomHostId = myUid;
    room = code();
    B = freshBoard(); turn = 1; chain = false; sel = null; onlineStarted = false; roomHasTwo = false; lastWinnerShown = 0;
    const data = {
      hostId: myUid,
      players: { [myUid]: { name: cleanName(), side: 1, connected: true } },
      game: { board: B, turn: 1, mandatory: mandatory(), status: 'waiting', winner: 0 },
      updatedAt: Date.now()
    };
    await set(ref(db, `damesRooms/${room}`), data);
    await onDisconnect(ref(db, `damesRooms/${room}/players/${myUid}/connected`)).set(false);
    showRoom(); listenRoom();
    history.replaceState(null, '', location.pathname + '?room=' + room);
    render();
  } catch (e) { onlineMsg('Création impossible : ' + friendlyFirebase(e)); }
}

async function joinRoom() {
  try {
    const c = $('#roomCode').value.trim().toUpperCase();
    if (!c) return onlineMsg('Entrez le code du salon.');
    const u = await ensureAuth(); myUid = u.uid;
    const rr = ref(db, `damesRooms/${c}`), s = await get(rr);
    if (!s.exists()) return onlineMsg('Salon introuvable.');
    const data = s.val(), players = data.players || {}, existing = players[myUid];
    roomHostId = data.hostId;
    if (existing) {
      mySide = existing.side;
      await update(ref(db, `damesRooms/${c}/players/${myUid}`), { name: cleanName(), connected: true });
    } else {
      if (Object.keys(players).length >= 2) return onlineMsg('Ce salon est complet.');
      mySide = 2;
      await set(ref(db, `damesRooms/${c}/players/${myUid}`), { name: cleanName(), side: 2, connected: true });
      await update(ref(db, `damesRooms/${c}`), { updatedAt: Date.now() });
    }
    room = c;
    await onDisconnect(ref(db, `damesRooms/${room}/players/${myUid}/connected`)).set(false);
    showRoom(); listenRoom();
    history.replaceState(null, '', location.pathname + '?room=' + room);
    render(); // retourne immédiatement le plateau pour le joueur 2
  } catch (e) { onlineMsg('Connexion impossible : ' + friendlyFirebase(e)); }
}

async function startOnlineGame() {
  if (!room || myUid !== roomHostId) return;
  if (!roomHasTwo) return onlineMsg('Il faut attendre le deuxième joueur.');
  const board = freshBoard();
  lastWinnerShown = 0;
  try {
    await set(ref(db, `damesRooms/${room}/game`), {
      board,
      turn: 1,
      chain: false,
      mandatory: mandatory(),
      status: 'playing',
      winner: 0,
      updatedAt: Date.now()
    });
    sound('start');
  } catch (e) { onlineMsg('Impossible de lancer : ' + friendlyFirebase(e)); }
}

function listenRoom() {
  if (unsub) unsub();
  unsub = onValue(ref(db, `damesRooms/${room}`), async snap => {
    if (!snap.exists()) {
      onlineMsg('Le salon a été fermé.'); roomHasTwo = false; onlineStarted = false; updateStartButton(); return;
    }

    const d = snap.val();
    roomHostId = d.hostId || roomHostId;
    const ps = d.players || {};
    const mine = ps[myUid];
    if (mine) mySide = mine.side;
    const me = Object.values(ps).find(p => p.side === mySide);
    const opponent = Object.values(ps).find(p => p.side !== mySide);
    $('#p1name').textContent = me?.name || cleanName();
    $('#p2name').textContent = opponent?.name || 'En attente…';
    roomHasTwo = Object.keys(ps).length >= 2;

    const g = d.game || {};
    onlineStarted = g.status === 'playing';
    setOnlineCompact(onlineStarted);
    $('#mandatory').checked = g.mandatory !== false;

    if (!roomHasTwo) onlineMsg('En attente d’un adversaire…');
    else if (!onlineStarted && g.status !== 'finished') onlineMsg(myUid === roomHostId ? 'Adversaire connecté. Vous pouvez lancer la partie.' : 'Adversaire connecté. En attente du lancement par l’hôte…');
    else if (opponent?.connected === false) onlineMsg('Adversaire déconnecté — la partie reste sauvegardée.');
    else if (g.status === 'finished') onlineMsg('Partie terminée.');
    else onlineMsg('Partie en cours avec ' + (opponent?.name || 'votre adversaire'));

    updateStartButton();

    if (g.move?.id && g.move.id !== lastMoveId && g.move.by !== myUid) {
      lastMoveId = g.move.id;
      applyingRemote = true;
      B = cloneBoard(g.move.before || g.board || freshBoard());
      turn = g.move.turnBefore || 1;
      sel = [g.move.fr, g.move.fc];
      render();
      await doMove(g.move.fr, g.move.fc, g.move.m, { broadcast: false });
      applyingRemote = false;
    } else if (!locked && g.board) {
      B = g.board;
      turn = g.turn || 1;
      chain = !!g.chain;
      sel = g.chainSel || null;
      render();
    }

    if (g.winner) await showWinner(g.winner, false);
    saveOnlineSession();
  }, e => onlineMsg('Connexion au salon interrompue : ' + friendlyFirebase(e)));
}

async function syncOnline(info) {
  if (mode() !== 'online' || !room || applyingRemote || !info || !onlineStarted) return;
  const id = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  lastMoveId = id;
  const payload = {
    board: B,
    turn,
    chain,
    mandatory: mandatory(),
    status: 'playing',
    move: {
      id,
      by: myUid,
      fr: info.fr,
      fc: info.fc,
      m: info.m,
      before: info.before,
      turnBefore: chain ? turn : 3 - turn
    },
    updatedAt: Date.now()
  };
  if (chain && sel) payload.chainSel = sel;
  else payload.chainSel = null;
  await update(ref(db, `damesRooms/${room}/game`), payload).catch(e => onlineMsg('Synchronisation : ' + friendlyFirebase(e)));
}

function applyTheme(save = true) {
  document.body.classList.toggle('lightTheme', $('#theme').value === 'light');
  if (save) savePrefs();
}

function leaveOnlineState() {
  room = null; mySide = null; roomHostId = null; roomHasTwo = false; onlineStarted = false; applyingRemote = false; lastMoveId = null;
  if (unsub) { unsub(); unsub = null; }
  clearOnlineSession();
  $('#roomInfo').classList.add('hidden');
  $('#startOnline').classList.add('hidden');
  setOnlineCompact(false);
}

function setModeUI() {
  const on = mode() === 'online';
  $('#level').style.display = mode() === 'ai' ? 'inline-block' : 'none';
  $('#onlinePanel').classList.toggle('hidden', !on);
  if (!on) {
    leaveOnlineState();
    history.replaceState(null, '', location.pathname);
    init(true);
  } else {
    B = freshBoard(); turn = 1; sel = null; chain = false; locked = false;
    render();
  }
}

$('#newBtn').onclick = async () => {
  if (mode() === 'online' && room) {
    if (myUid !== roomHostId) return onlineMsg('Seul l’hôte peut démarrer une nouvelle partie.');
    if (!roomHasTwo) return onlineMsg('Il faut attendre le deuxième joueur.');
    return startOnlineGame();
  }
  init(true);
};
$('#rematch').onclick = $('#newBtn').onclick;
$('#home').onclick = () => { $('#winner').classList.add('hidden'); $('#mode').value = 'ai'; setModeUI(); };
$('#mode').onchange = setModeUI;
$('#createRoom').onclick = createRoom;
$('#joinRoom').onclick = joinRoom;
$('#startOnline').onclick = startOnlineGame;
$('#saveName').onclick = async () => {
  savePrefs();
  if (mode() === 'online' && room && myUid) {
    try { await update(ref(db, `damesRooms/${room}/players/${myUid}`), { name: cleanName(), connected: true }); } catch {}
  }
};
$('#copyLink').onclick = async () => {
  if (!room) return;
  const url = location.origin + location.pathname + '?room=' + room;
  try {
    if (navigator.share) await navigator.share({ title: 'Dames', text: 'Rejoins ma partie de Dames', url });
    else { await navigator.clipboard.writeText(url); onlineMsg('Lien copié !'); }
  } catch {}
};
$('#menuBtn').onclick = () => $('#menu').classList.remove('hidden');
$('#closeMenu').onclick = () => $('#menu').classList.add('hidden');
$('#rulesBtn').onclick = () => $('#rules').showModal();
$('#rulesClose').onclick = () => $('#rules').close();
$('#theme').onchange = () => applyTheme(true);
['sound','hints','mandatory'].forEach(id => $('#'+id).onchange = async () => {
  savePrefs(); render();
  if (id === 'mandatory' && mode() === 'online' && room) {
    if (myUid === roomHostId && !onlineStarted) {
      try { await update(ref(db, `damesRooms/${room}/game`), { mandatory: mandatory() }); } catch {}
    } else {
      const snap = await get(ref(db, `damesRooms/${room}/game/mandatory`)).catch(() => null);
      if (snap?.exists()) $('#mandatory').checked = snap.val() !== false;
    }
  }
});
$('#resetSave').onclick = () => { localStorage.removeItem('damesGame'); clearOnlineSession(); init(true); };

loadPrefs();
if (!restoreLocal()) init(true); else render();
$('#level').style.display = mode() === 'ai' ? 'inline-block' : 'none';

const q = new URLSearchParams(location.search).get('room');
if (q) {
  $('#mode').value = 'online';
  $('#onlinePanel').classList.remove('hidden');
  $('#level').style.display = 'none';
  $('#roomCode').value = q.toUpperCase();
  B = freshBoard();
  render();
  statusEl.textContent = 'Entrez votre nom puis rejoignez le salon';
}
