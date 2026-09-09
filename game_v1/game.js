/* 星星大冒险 game_v1
   与扭蛋机(claim_v1)同源共享 localStorage 'jiahong-claim-v3'
   - 角色：owned[] 里的英雄立绘替代篮子
   - 积分：points 互通（商店消费直接写回同一存档）
   - 稀有度：SSR 金尾迹+多1命 / SR 彩虹尾迹
   - v2 玩法补丁：jiahong-mods.patch 可加自定义实体/攻击光弹/掉落道具（同一框架内）
*/
(function () {
  'use strict';

  const STORAGE_KEY = 'jiahong-claim-v3';
  const CLAIM_BASE = '/claim_v1/'; // 角色图相对路径前缀

  // ============ 存档读写（与扭蛋机同一格式） ============
  function loadSave() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const a = JSON.parse(raw);
      if (!a.owner || !a.owned || a.owned.length === 0) return null;
      return a;
    } catch (e) { return null; }
  }
  function writeSave(mutator) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const a = JSON.parse(raw);
      mutator(a);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
      return true;
    } catch (e) { return false; }
  }

  // ============ 全局状态 ============
  const S = {
    save: null,          // 整个存档
    hero: null,          // 当前出战英雄
    heroImg: null,       // Image 对象
    running: false,
    score: 0,
    best: 0,
    lives: 3,
    dur: 60,
    startAt: 0,
    timeUp: false,
    // 可调参数（咒语/商店会改）
    params: {
      starSpeed: 2.2,      // 基础下落速度
      spawnInterval: 900,  // 生成间隔 ms
      starSize: 26,
      goldChance: 0.08,    // 金星概率
      bombChance: 0.0,     // 炸弹星概率
      magnet: 0,           // 磁铁剩余帧数
      invincible: 0,       // 无敌剩余帧数
      shield: 0,          // 护盾剩余帧数（v2 玩法补丁）
      double: 0,          // 双倍分剩余帧数
      wide: 0,            // 加宽剩余帧数
      hurt: 0,            // 受伤红屏剩余帧数
      catcherScale: 1.0,   // 角色接星宽度倍率
    },
  };

  const $ = id => document.getElementById(id);
  // ============ 分享码（?v=）：压缩 base64url ============
  function b64ToBytes(s){ s = s.replace(/-/g, '+').replace(/_/g, '/'); while(s.length % 4) s += '='; const bin = atob(s); const out = new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i); return out; }
  function bytesToB64(bytes){ let bin=''; for(let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]); return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
  async function inflateObj(str){
    if (str.indexOf('z.') === 0) {
      const stream = new Blob([b64ToBytes(str.slice(2))]).stream().pipeThrough(new DecompressionStream('deflate'));
      const buf = await new Response(stream).arrayBuffer();
      return JSON.parse(new TextDecoder().decode(new Uint8Array(buf)));
    }
    if (str.indexOf('u.') === 0) { return JSON.parse(new TextDecoder().decode(b64ToBytes(str.slice(2)))); }
    return null;
  }


  // ============ 简易音效 ============
  const Sfx = (() => {
    let ctx = null;
    function ac() { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); return ctx; }
    function beep(freq, dur, type, vol) {
      try {
        const a = ac(), o = a.createOscillator(), g = a.createGain();
        o.type = type || 'sine'; o.frequency.value = freq;
        g.gain.setValueAtTime(vol || 0.12, a.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
        o.connect(g); g.connect(a.destination);
        o.start(); o.stop(a.currentTime + dur);
      } catch (e) {}
    }
    return {
      catch: () => { beep(880, 0.12, 'sine', 0.1); setTimeout(() => beep(1320, 0.15, 'sine', 0.08), 60); },
      gold: () => { beep(1047, 0.1, 'triangle', 0.12); setTimeout(() => beep(1568, 0.2, 'triangle', 0.1), 80); },
      miss: () => beep(160, 0.3, 'sawtooth', 0.08),
      bomb: () => beep(90, 0.5, 'square', 0.12),
      cast: () => { beep(660, 0.1, 'triangle', 0.1); setTimeout(() => beep(990, 0.12, 'triangle', 0.1), 70); setTimeout(() => beep(1320, 0.18, 'triangle', 0.1), 140); },
      buy: () => { beep(523, 0.08, 'square', 0.06); setTimeout(() => beep(784, 0.12, 'square', 0.06), 60); },
      shoot: () => { beep(500, 0.07, 'triangle', 0.07); },
      boom: () => { beep(150, 0.22, 'sawtooth', 0.09); },
      power: () => { beep(660, 0.09, 'triangle', 0.09); setTimeout(() => beep(990, 0.12, 'triangle', 0.08), 80); },
      over: () => { beep(440, 0.2, 'sine', 0.1); setTimeout(() => beep(330, 0.25, 'sine', 0.1), 180); setTimeout(() => beep(220, 0.4, 'sine', 0.1), 380); },
    };
  })();

  // ============ 制作台改造读取（jiahong-mods：伙伴在制作台帮你改的） ============
  let mods = {};
  function loadMods() {
    try { return JSON.parse(localStorage.getItem('jiahong-mods') || '{}'); } catch (e) { return {}; }
  }
  function applyMods() {
    mods = loadMods() || {};
    const p = S.params;
    const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
    if (num(mods.star_speed) != null) p.starSpeed = mods.star_speed;
    if (num(mods.star_size) != null) p.starSize = mods.star_size;
    if (num(mods.spawn_interval) != null) p.spawnInterval = mods.spawn_interval;
    if (num(mods.gold_chance) != null) p.goldChance = mods.gold_chance;
    if (num(mods.bomb_chance) != null) p.bombChance = mods.bomb_chance;
    if (num(mods.catcher_scale) != null) p.catcherScale = mods.catcher_scale;
    if (num(mods.extra_life) != null) S.extraLivesMod = mods.extra_life;
    if (mods.magnet === true) S.magnetMod = true;
    if (typeof mods.title === 'string' && mods.title.trim()) S.titleMod = mods.title.trim();
    loadPatch();
    const durN = num(mods.duration);
    S.dur = (durN != null ? Math.max(10, Math.min(600, durN)) : 60);
    S.scriptCode = (typeof mods.script === 'string') ? mods.script : '';
  }

  // ============ v2 玩法补丁（jiahong-mods.patch：同一接星星框架内，加实体/攻击/道具） ============
  const PATCH_KINDS = ['good','gold','bad','power'];
  const PATCH_POWERS = ['magnet','shield','double','life','invincible','wide'];
  const PATCH_SIDES = ['top','sine','left','right'];
  const PATCH_SHAPES = ['text','circle','star','heart','rect'];
  function clampNum(v, min, max, d){ const n = Number(v); return isFinite(n) ? Math.max(min, Math.min(max, n)) : d; }
  function normEntity(e){
    if(!e || typeof e !== 'object') return null;
    const kind = PATCH_KINDS.includes(e.kind) ? e.kind : (e.bad ? 'bad' : 'good');
    const d = {
      id: String(e.id || ('e' + Math.random().toString(36).slice(2, 6))),
      kind: kind,
      shape: PATCH_SHAPES.includes(e.shape) ? e.shape : 'text',
      text: typeof e.text === 'string' ? e.text.slice(0, 6) : '',
      color: typeof e.color === 'string' ? e.color.slice(0, 16) : '#ff6b9d',
      size: clampNum(e.size, 12, 64, 30),
      speed: clampNum(e.speed, 0.5, 9, 2),
      interval: clampNum(e.interval, 500, 9000, 1800),
      score: clampNum(e.score, 0, 300, (kind === 'gold' ? 50 : 10)),
      damage: clampNum(e.damage, 1, 3, 1),
      side: PATCH_SIDES.includes(e.side) ? e.side : 'top',
      amp: clampNum(e.amp, 10, 160, 60),
      power: PATCH_POWERS.includes(e.power) ? e.power : '',
      targetable: !!e.targetable,
    };
    if(kind === 'power' && !PATCH_POWERS.includes(e.power)) return null;
    return d;
  }
  function loadPatch(){
    patch = null;
    const raw = (mods && mods.patch) || null;
    if(!raw || typeof raw !== 'object') return;
    const entities = Array.isArray(raw.entities) ? raw.entities.map(normEntity).filter(Boolean) : [];
    patch = { entities: entities, attack: !!raw.attack };
  }


  // ============ 初始化流程 ============
  async function init() {
    S.save = loadSave();
    S.best = parseInt(localStorage.getItem('star-game-best') || '0', 10);
    // 分享码：?v=xxx（游客也能玩这一版，不写认领存档）
    let versionData = null;
    try {
      const q = new URLSearchParams(location.search);
      const v = q.get('v');
      if (v) versionData = await inflateObj(v);
    } catch (e) { versionData = null; }
    if (versionData && versionData.m && typeof versionData.m === 'object') {
      try { localStorage.setItem('jiahong-mods', JSON.stringify(versionData.m)); } catch (e) {}
    }
    applyMods();
    S.cameFromShare = !!(versionData && versionData.m);
    if (S.cameFromShare) {
      S.shareOwner = (versionData && versionData.o) || '';
      S.shareVersion = (versionData && versionData.n) || '';
    }

    if (!S.save) {
      if (versionData && versionData.m) {
        // 游客试玩：内存里给一个默认伙伴，不写入认领存档
        S.save = { v: 3, owner: '朋友', points: 0, owned: [{ id: 'guest', name: '小玩', originalName: '小玩', rarity: 'N', img: '', intro: '', personality: '勇敢又好奇', message: '', ts: Date.now() }] };
        S.guestMode = true;
        var gh = (versionData && versionData.h) ? versionData.h : null;
        var gHero = { id: 'guest', name: (gh && gh.name) || '小玩', originalName: (gh && gh.originalName) || '', rarity: (gh && gh.rarity) || 'N', img: (gh && gh.img) || '', intro: '', personality: '勇敢又好奇', message: '', ts: Date.now() };
        S.save.owned = [gHero];
        S.shareOwner = (versionData && versionData.o) || '';
        S.shareVersion = (versionData && versionData.n) || '';
        S.cameFromShare = true;
      } else {
        $('no-hero').hidden = false;
        bindImport();
        return;
      }
    }
    if (!S.save) {
      $('no-hero').hidden = false;
      bindImport();
      return;
    }

    if (S.save.owned.length === 1) {
      pickHero(0);
    } else {
      showHeroSelect();
    }
    bindGlobal();
  }

  function bindImport() {
    $('import-file').addEventListener('change', e => {
      const f = e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const pack = JSON.parse(reader.result);
          if (pack.format !== 'hero-pack/v1' || !pack.heroes || !pack.heroes.length) throw new Error('bad');
          // 转成存档格式写入
          const data = {
            v: 3, owner: pack.owner, points: pack.points || 0,
            owned: pack.heroes, unlockedMilestones: [], coupons: 0,
            doubleCoupons: 0, firstDrawUsed: true, usedCodes: [], title: pack.title || '',
          };
          localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
          $('import-fb').textContent = '✅ 导入成功！正在进入...';
          $('import-fb').className = 'import-fb ok';
          setTimeout(() => location.reload(), 600);
        } catch (err) {
          $('import-fb').textContent = '❌ 文件不对，请导入扭蛋机导出的英雄包 (.json)';
          $('import-fb').className = 'import-fb err';
        }
      };
      reader.readAsText(f);
    });
  }

  function showHeroSelect() {
    $('hero-select').hidden = false;
    const grid = $('hero-grid');
    grid.innerHTML = '';
    S.save.owned.forEach((h, i) => {
      const cell = document.createElement('div');
      cell.className = 'hero-cell';
      cell.innerHTML =
        '<img src="' + CLAIM_BASE + h.img + '" alt="">' +
        '<div class="h-name">' + esc(h.name) + '</div>' +
        '<div class="h-rar rar-' + h.rarity + '">' + h.rarity + '</div>';
      cell.addEventListener('click', () => {
        $('hero-select').hidden = true;
        pickHero(i);
      });
      grid.appendChild(cell);
    });
  }

  function pickHero(idx) {
    S.hero = S.save.owned[idx];
    S.heroImg = new Image();
    if (S.hero.img) { S.heroImg.src = CLAIM_BASE + S.hero.img; } else { S.heroImg = null; }
    $('game-area').hidden = false;
    $('game-title').textContent = S.titleMod || (S.hero.name + ' 的星星大冒险');
    const logoEl = $('logo-title');
    if (logoEl) logoEl.textContent = S.titleMod ? ('⭐ ' + S.titleMod) : '⭐ 星星大冒险';
    $('mask-hero-img').src = CLAIM_BASE + S.hero.img;
    const rarEl = $('mask-rarity');
    rarEl.textContent = S.hero.rarity;
    rarEl.className = 'mask-rarity rar-' + S.hero.rarity;
    // 稀有度提示
    const tips = {
      SSR: '🌟 传说英雄！金色尾迹 + 开局多 1 条命',
      SR: '💜 史诗英雄！彩虹尾迹',
      R: '💚 稀有英雄出战！',
      N: '💙 勇气可嘉的小英雄出战！',
    };
    $('mask-tip').textContent = (tips[S.hero.rarity] || tips.N) + '\n⏱ 本局限时 ' + S.dur + ' 秒，时间到自动结算';
  }

  function bindGlobal() {
    $('btn-start').addEventListener('click', startGame);
    $('btn-restart').addEventListener('click', () => { $('mask-over').hidden = true; startGame(); });
    $('btn-change-hero').addEventListener('click', () => {
      $('mask-over').hidden = true;
      $('game-area').hidden = true;
      showHeroSelect();
    });
  }


  // ============ 游戏核心 ============
  const cv = document.getElementById('cv');
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  let stars = [], particles = [], projectiles = [], catcherX = W / 2, keys = {};
  let patch = null, patchTimers = [], shotCool = 0;
  let scriptTimers = [], scriptOnFrame = [], scriptErr = null;
  let scriptCatchHooks = [], scriptHurtHooks = [];
  let lastSpawn = 0, rafId = null, frame = 0;

  function startGame() {
    S.running = true;
    S.score = 0;
    S.lives = (S.hero.rarity === 'SSR' ? 4 : 3) + (S.extraLivesMod || 0);
    stars = []; particles = []; projectiles = []; frame = 0; shotCool = 0;
    // 每局重置临时增益（商店买的是本局生效；制作台改的磁铁是永久的）
    S.params.magnet = 0;
    if (S.magnetMod) S.params.magnet = Infinity;
    S.params.invincible = 0;
    S.params.shield = 0; S.params.double = 0; S.params.wide = 0; S.params.hurt = 0;
    patchTimers = (patch && patch.entities) ? patch.entities.map(function (def) {
      return { def: def, interval: def.interval, next: performance.now() + 300 + Math.random() * 700 };
    }) : [];
    $('mask-start').hidden = true;
    $('mask-over').hidden = true;
    scriptTimers = []; scriptOnFrame = []; scriptCatchHooks = []; scriptHurtHooks = []; scriptErr = null;
    setupScript(S.scriptCode);
    lastSpawn = performance.now();
    S.startAt = performance.now();
    S.timeUp = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(loop);
  }

  function spawnStar() {
    const p = S.params;
    const roll = Math.random();
    let type = 'normal';
    if (roll < p.bombChance) type = 'bomb';
    else if (roll < p.bombChance + p.goldChance) type = 'gold';
    stars.push({
      x: 30 + Math.random() * (W - 60),
      y: -30,
      vy: p.starSpeed * (0.8 + Math.random() * 0.5),
      type: type,
      size: p.starSize * (type === 'gold' ? 1.25 : 1),
      rot: Math.random() * Math.PI * 2,
    });
  }

  function catcherWidth(){ return 90 * S.params.catcherScale * (S.params.wide > 0 ? 1.5 : 1); }
  function spawnPatchEntity(def){
    let x = 0, y = 0, vx = 0, vy = 0, baseX = 0, phase = 0;
    if (def.side === 'left' || def.side === 'right') {
      y = 40 + Math.random() * (H * 0.35);
      if (def.side === 'left') { x = -40; vx = def.speed; } else { x = W + 40; vx = -def.speed; }
    } else if (def.side === 'sine') {
      x = 30 + Math.random() * (W - 60); y = -30; baseX = x; phase = Math.random() * 6.28; vy = def.speed;
    } else {
      x = 30 + Math.random() * (W - 60); y = -30; vy = def.speed * (0.85 + Math.random() * 0.3);
    }
    stars.push({ def: def, kind: def.kind, x: x, y: y, vx: vx, vy: vy, phase: phase, baseX: baseX, size: def.size, rot: Math.random() * 6.28, type: 'custom', dead: false });
  }
  function updatePatchTimers(now){
    if (!patch) return;
    patchTimers.forEach(function (t) {
      if (now >= t.next) { spawnPatchEntity(t.def); t.next = now + t.interval; }
    });
  }
  function moveCustom(st){
    const d = st.def;
    if (d.side === 'left' || d.side === 'right') {
      st.x += st.vx; st.y += Math.sin(st.phase) * 0.6; st.phase += 0.05;
      if ((d.side === 'left' && st.x > W + 50) || (d.side === 'right' && st.x < -50)) st.dead = true;
      return;
    }
    if (d.side === 'sine') { st.y += st.vy; st.x = st.baseX + Math.sin(st.phase) * d.amp; st.phase += 0.05; }
    else { st.y += st.vy; st.rot += 0.03; }
    if (st.y > H + 50) { st.dead = true; st.exited = true; }
  }
  function drawGuestHero(hw, cy){
    const r = Math.max(16, hw * 0.34);
    ctx.save(); ctx.translate(catcherX, cy - 12);
    ctx.fillStyle = '#FFD166';
    ctx.beginPath(); ctx.arc(0, 0, r, 0, 6.29); ctx.fill();
    ctx.strokeStyle = '#E8A93A'; ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = '#3A3A3A';
    ctx.beginPath(); ctx.arc(-r * 0.35, -r * 0.15, r * 0.12, 0, 6.29); ctx.arc(r * 0.35, -r * 0.15, r * 0.12, 0, 6.29); ctx.fill();
    ctx.strokeStyle = '#3A3A3A'; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(0, r * 0.15, r * 0.45, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
    ctx.restore();
  }

  function drawCustomShape(st){
    const d = st.def, s = st.size, x = st.x, y = st.y;
    if (d.shape === 'text' && d.text) {
      ctx.save(); ctx.font = s + 'px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(d.text, x, y); ctx.restore(); return;
    }
    ctx.save(); ctx.translate(x, y); ctx.rotate(st.rot || 0); ctx.fillStyle = d.color;
    if (d.shape === 'circle') { ctx.beginPath(); ctx.arc(0, 0, s * 0.55, 0, 6.29); ctx.fill(); }
    else if (d.shape === 'star') { drawStarShape(s); }
    else if (d.shape === 'heart') { drawHeartShape(s); }
    else { ctx.fillRect(-s / 2, -s / 2, s, s); }
    ctx.restore();
  }
  function drawStarShape(s){
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a1 = (i * 4 * Math.PI) / 5 - Math.PI / 2;
      ctx.lineTo(Math.cos(a1) * s, Math.sin(a1) * s);
    }
    ctx.closePath(); ctx.fill();
  }
  function drawHeartShape(s){
    ctx.beginPath();
    ctx.moveTo(0, s * 0.4);
    ctx.bezierCurveTo(s * 0.5, -s * 0.25, s * 1.0, s * 0.25, 0, s * 0.85);
    ctx.bezierCurveTo(-s * 1.0, s * 0.25, -s * 0.5, -s * 0.25, 0, s * 0.4);
    ctx.closePath(); ctx.fill();
  }
  function applyPower(power){
    const p = S.params;
    if (power === 'magnet') p.magnet = 600;
    else if (power === 'shield') p.shield = 600;
    else if (power === 'double') p.double = 600;
    else if (power === 'wide') p.wide = 600;
    else if (power === 'life') S.lives++;
    else if (power === 'invincible') p.invincible = 600;
    Sfx.power();
  }
  // ---------- 玩法脚本运行时（AI 写的"这一段玩法"，受控执行） ----------
  const SCRIPT_BANNED = ['document','window','localStorage','sessionStorage','fetch(','XMLHttpRequest','WebSocket','eval(','new Function','import(','require(','process','globalThis','constructor','top','parent'];
  function setupScript(code){
    if (!code || typeof code !== 'string') return;
    for (let i = 0; i < SCRIPT_BANNED.length; i++) {
      if (code.indexOf(SCRIPT_BANNED[i]) >= 0) { scriptErr = '脚本含不允许的操作，已停用'; return; }
    }
    const api = {
      every: function (ms, fn) { scriptTimers.push({ ms: Math.max(200, Math.min(60000, Number(ms) || 1000)), next: 0, fn: fn }); },
      onFrame: function (fn) { scriptOnFrame.push(fn); },
      spawn: function (data) { if (stars.length > 220) return; const def = normEntity(data); if (def) spawnPatchEntity(def); },
      addScore: function (n) { S.score += (Number(n) || 0); },
      addLife: function (n) { S.lives += (Number(n) || 0); },
      lives: function () { return S.lives; },
      score: function () { return S.score; },
      flash: function () { S.params.hurt = 18; },
      shield: function () { S.params.shield = Math.max(S.params.shield, 600); },
      width: function (t) { if (t) S.params.wide = Math.max(S.params.wide, 600); },
      onCatch: function (kind, fn) { scriptCatchHooks.push({ kind: kind || '*', fn: fn }); },
      onHurt: function (fn) { scriptHurtHooks.push(fn); },
    };
    try {
      const fn = new Function('R', '"use strict";\n' + code);
      fn(api);
    } catch (e) { scriptErr = String((e && e.message) || e); }
  }
  function runCatchHooks(kind){
    if (!S.running) return;
    scriptCatchHooks.forEach(function (h) {
      try { if (!h.kind || h.kind === '*' || h.kind === kind) h.fn({ kind: kind }); } catch (e) { scriptErr = String((e && e.message) || e); }
    });
  }
  function runHurtHooks(){
    if (!S.running) return;
    scriptHurtHooks.forEach(function (h) {
      try { h.fn(); } catch (e) { scriptErr = String((e && e.message) || e); }
    });
  }

  function runScripts(now){
    if (scriptErr || !S.running) return;
    for (let i = 0; i < scriptTimers.length; i++) {
      const t = scriptTimers[i];
      if (now >= t.next) {
        try { t.fn(); } catch (e) { scriptErr = String((e && e.message) || e); break; }
        t.next = now + t.ms;
      }
    }
    if (scriptErr) return;
    for (let i = 0; i < scriptOnFrame.length; i++) {
      try { scriptOnFrame[i](); } catch (e) { scriptErr = String((e && e.message) || e); break; }
    }
  }

  function flashHurt(){ S.params.hurt = 18; runHurtHooks(); }
  function hurtHero(){
    const p = S.params;
    if (p.invincible > 0) return false;
    if (p.shield > 0) { p.shield = 0; burst(catcherX, H - 90, '#4cc9f0', 14); Sfx.power(); return false; }
    S.lives--;
    flashHurt();
    return true;
  }

  function fireShot(){
    if (!S.running || !patch || !patch.attack) return;
    if (shotCool > 0) return;
    shotCool = 14;
    const cy = H - 90;
    projectiles.push({ x: catcherX, y: cy - 70, vy: -10 });
    Sfx.shoot();
  }
  function updateProjectiles(){
    const p = S.params;
    projectiles.forEach(function (pr) {
      pr.y += pr.vy;
      if (pr.y < -30) { pr.dead = true; return; }
      stars.forEach(function (st) {
        if (st.dead || st.type !== 'custom' || !st.def || !st.def.targetable) return;
        const dx = pr.x - st.x, dy = pr.y - st.y;
        const rr = (st.size / 2) + 8;
        if (dx * dx + dy * dy < rr * rr) {
          pr.dead = true; st.dead = true;
          const pts = (st.def.score || 20) * (p.double > 0 ? 2 : 1);
          S.score += pts;
          burst(st.x, st.y, st.def.color || '#ff6b9d', 16);
          Sfx.boom();
        }
      });
    });
    projectiles = projectiles.filter(function (pr) { return !pr.dead; });
  }
  function drawProjectiles(){
    ctx.fillStyle = '#fff3a6';
    projectiles.forEach(function (pr) {
      ctx.beginPath(); ctx.arc(pr.x, pr.y, 5, 0, 6.29); ctx.fill();
      ctx.fillStyle = '#ffd166';
      ctx.beginPath(); ctx.arc(pr.x, pr.y, 3, 0, 6.29); ctx.fill();
      ctx.fillStyle = '#fff3a6';
    });
  }
  function catchCustom(st){
    const p = S.params;
    const k2 = st.kind;
    if (k2 === 'bad') { burst(st.x, st.y, '#ff5544', 14); Sfx.bomb(); hurtHero(); runCatchHooks('bad'); return; }
    if (k2 === 'power') { applyPower(st.def.power || 'magnet'); burst(st.x, st.y, '#5ce1a8', 12); runCatchHooks('power'); return; }
    const pts = (st.def.score || 10) * (p.double > 0 ? 2 : 1);
    S.score += pts;
    if (k2 === 'gold') Sfx.gold(); else Sfx.catch();
    burst(st.x, st.y, k2 === 'gold' ? '#ffd700' : (st.def.color || '#9fe8ff'), 10);
    runCatchHooks(k2);
  }

  function missPenalty(){
    if (S.params.invincible <= 0) { S.lives--; flashHurt(); Sfx.miss(); }
  }


  function loop(now) {
    if (!S.running) return;
    frame++;
    update(now);
    draw();
    rafId = requestAnimationFrame(loop);
  }

  function update(now) {
    const p = S.params;
    // 生成（默认星星）
    if (now - lastSpawn > p.spawnInterval) { spawnStar(); lastSpawn = now; }
    // 生成（玩法补丁实体）
    updatePatchTimers(now);
    // 键盘
    if (keys['ArrowLeft'] || keys['a']) catcherX -= 7;
    if (keys['ArrowRight'] || keys['d']) catcherX += 7;
    catcherX = Math.max(50, Math.min(W - 50, catcherX));
    // 增益倒计时
    if (p.magnet > 0) p.magnet--;
    if (p.invincible > 0) p.invincible--;
    if (p.shield > 0) p.shield--;
    if (p.double > 0) p.double--;
    if (p.wide > 0) p.wide--;
    if (p.hurt > 0) p.hurt--;
    if (shotCool > 0) shotCool--;

    const catcherW = catcherWidth();
    const cy = H - 90;

    // 玩法脚本
    runScripts(now);

    // 光弹
    updateProjectiles();

    stars.forEach(st => {
      // 磁铁吸附（坏的不吸）
      if (p.magnet > 0 && (st.type === 'custom' ? st.kind !== 'bad' : st.type !== 'bomb')) {
        const dx = catcherX - st.x;
        if (Math.abs(dx) < 160) st.x += dx * 0.06;
      }
      if (st.type === 'custom') {
        moveCustom(st);
        if (st.dead) {
          if (st.exited && (st.kind === 'good' || st.kind === 'gold') && p.invincible <= 0) { S.lives--; flashHurt(); Sfx.miss(); }
          return;
        }
      } else {
        st.y += st.vy;
        st.rot += 0.03;
      }
      // 接到判定
      if (st.y > cy - 20 && st.y < cy + 40 && Math.abs(st.x - catcherX) < catcherW / 2 + st.size / 2) {
        st.dead = true;
        if (st.type === 'custom') { catchCustom(st); }
        else if (st.type === 'bomb') {
          if (p.invincible <= 0) { S.lives--; flashHurt(); Sfx.bomb(); }
          runCatchHooks('bomb');
          burst(st.x, cy, '#ff5544', 18);
        } else {
          const pts = (st.type === 'gold' ? 50 : 10) * (p.double > 0 ? 2 : 1);
          S.score += pts;
          if (st.type === 'gold') Sfx.gold(); else Sfx.catch();
          runCatchHooks(st.type);
          burst(st.x, cy, st.type === 'gold' ? '#ffd700' : '#9fe8ff', st.type === 'gold' ? 16 : 8);
        }
        return;
      }
      // 漏接（仅默认星星）
      if (st.type !== 'custom' && st.y > H + 30 && !st.dead) {
        st.dead = true;
        if (st.type !== 'bomb' && p.invincible <= 0) { S.lives--; flashHurt(); Sfx.miss(); }
      }
    });
    stars = stars.filter(s => !s.dead);

    // 粒子
    particles.forEach(pt => { pt.x += pt.vx; pt.y += pt.vy; pt.vy += 0.15; pt.life--; });
    particles = particles.filter(pt => pt.life > 0);

    // 稀有度尾迹
    if (S.hero.rarity === 'SSR') {
      particles.push({ x: catcherX + (Math.random() - 0.5) * 70, y: cy + 20, vx: (Math.random() - 0.5), vy: 0.5 + Math.random(), life: 30, color: '#ffd700', size: 3 });
    } else if (S.hero.rarity === 'SR') {
      const hues = ['#ff6b9d', '#ffb400', '#7cffb2', '#7c5cff'];
      particles.push({ x: catcherX + (Math.random() - 0.5) * 70, y: cy + 20, vx: (Math.random() - 0.5), vy: 0.5 + Math.random(), life: 25, color: hues[frame % 4], size: 3 });
    }

    // 结束
    if (now - S.startAt >= S.dur * 1000) { endGame('time'); return; }
    if (S.lives <= 0) endGame('lives');
  }
  function burst(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = 1 + Math.random() * 3;
      particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1, life: 25 + Math.random() * 20, color, size: 2 + Math.random() * 3 });
    }
  }

  function drawStar(x, y, size, rot, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a1 = (i * 4 * Math.PI) / 5 - Math.PI / 2;
      ctx.lineTo(Math.cos(a1) * size, Math.sin(a1) * size);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    // 背景星点
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    for (let i = 0; i < 30; i++) {
      const sx = (i * 137 + frame * 0.2) % W, sy = (i * 89 + frame * 0.1) % H;
      ctx.fillRect(sx, sy, 2, 2);
    }
    // 粒子
    particles.forEach(pt => {
      ctx.globalAlpha = Math.min(1, pt.life / 25);
      ctx.fillStyle = pt.color;
      ctx.beginPath(); ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2); ctx.fill();
    });
    ctx.globalAlpha = 1;
    // 光弹
    drawProjectiles();

    // 星星
    stars.forEach(st => {
      if (st.type === 'custom') { drawCustomShape(st); return; }
      if (st.type === 'gold') drawStar(st.x, st.y, st.size, st.rot, '#ffd700');
      else if (st.type === 'bomb') drawStar(st.x, st.y, st.size, st.rot, '#ff5544');
      else drawStar(st.x, st.y, st.size, st.rot, '#bfe8ff');
    });
    // 角色
    const cy = H - 90;
    if (S.params.invincible > 0 && frame % 10 < 5) ctx.globalAlpha = 0.5;
    const hw = 100 * S.params.catcherScale * (S.params.wide > 0 ? 1.5 : 1), hh = 100 * S.params.catcherScale * (S.params.wide > 0 ? 1.5 : 1);
    if (S.heroImg && S.heroImg.complete) {
      ctx.drawImage(S.heroImg, catcherX - hw / 2, cy - hh / 2 - 10, hw, hh);
    } else {
      drawGuestHero(hw, cy);
    }
    if (S.heroImg && S.heroImg.complete) {
      const hw = 100 * S.params.catcherScale * (S.params.wide > 0 ? 1.5 : 1), hh = 100 * S.params.catcherScale * (S.params.wide > 0 ? 1.5 : 1);
      ctx.drawImage(S.heroImg, catcherX - hw / 2, cy - hh / 2 - 10, hw, hh);
    } else {
      ctx.fillStyle = '#ffd700';
      ctx.fillRect(catcherX - 45, cy - 15, 90, 30);
    }
    ctx.globalAlpha = 1;
    // 磁铁指示
    if (S.params.magnet > 0) {
      ctx.strokeStyle = 'rgba(124,92,255,0.6)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(catcherX, cy, 160, 0, Math.PI * 2); ctx.stroke();
    }
    // 护盾指示
    if (S.params.shield > 0) { ctx.strokeStyle = 'rgba(76,201,240,0.85)'; ctx.lineWidth = 3; ctx.setLineDash([7, 6]); ctx.beginPath(); ctx.arc(catcherX, cy, 64, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
    // 双倍分指示
    if (S.params.double > 0) { ctx.fillStyle = '#ffd166'; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'left'; ctx.fillText('×2 双倍分!', 16, 56); }

    // HUD
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('得分 ' + S.score, 16, 34);
    ctx.textAlign = 'right';
    ctx.fillText('❤'.repeat(Math.max(0, S.lives)), W - 16, 34);
    // 倒计时（让孩子知道这局什么时候到头）
    if (S.running) {
      const remain = Math.max(0, S.dur - (performance.now() - S.startAt) / 1000);
      const sec = Math.ceil(remain);
      ctx.fillStyle = (sec <= 10 ? '#ff6b6b' : '#ffffff');
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⏱ ' + sec + ' 秒', W / 2, 30);
    }
    // 受伤红屏（被炸弹/坏蛋炸到）
    if (S.params.hurt > 0) {
      ctx.fillStyle = 'rgba(255,45,45,' + (0.28 * (S.params.hurt / 18)).toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
    }
  }

  // ---------- 建议（裂变闭环：玩家玩完给创作者提建议） ----------
  let suggestBound = false;
  function showSuggestPanel(){
    const pan = $('suggest-panel');
    if (!pan) return;
    const who = S.shareOwner || '';
    const ver = S.shareVersion || '';
    $('suggest-sub').textContent = '你玩到的是' + (who ? '「' + who + '」' : '朋友') + (ver ? '的「' + ver + '」' : '的游戏') + '。哪里好玩？哪里可以更好？写下你的想法，TA 会看到并改进！';
    pan.hidden = false;
    if (pan.scrollIntoView) pan.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (!suggestBound) {
      suggestBound = true;
      $('btn-suggest').addEventListener('click', submitSuggest);
    }
  }
  function submitSuggest(){
    const text = ($('suggest-text').value || '').trim();
    const fb = $('suggest-fb');
    if (!text) { fb.textContent = '先写一句你的想法吧～'; return; }
    const btn = $('btn-suggest');
    btn.disabled = true;
    fetch('/api/suggest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: S.shareOwner || '', hero: S.hero ? S.hero.name : '', version: S.shareVersion || '', text: text }) })
      .then(function(r){ return r.json(); }).then(function(res){
        if (res.ok) { fb.textContent = '✅ 已发给' + (S.shareOwner ? '「' + S.shareOwner + '」' : 'TA') + '啦！TA 会看到你的建议～'; btn.textContent = '✅ 已发送'; }
        else { fb.textContent = '发送失败，再试一次？'; btn.disabled = false; }
      }).catch(function(){ fb.textContent = '网络没通，发送失败（可以先截图发给他）'; btn.disabled = false; });
  }

  function endGame(reason) {
    if (!S.running) return;
    S.running = false;
    if (S.score > S.best) {
      S.best = S.score;
      localStorage.setItem('star-game-best', String(S.best));
    }
    $('over-title').textContent = (reason === 'time') ? '⏱ 时间到！' : '💔 游戏结束';
    $('over-score').textContent = S.score;
    $('over-best').textContent = S.best;
    $('mask-over').hidden = false;
    if (S.cameFromShare) showSuggestPanel();
    Sfx.over();
  }

  // 输入
  cv.addEventListener('mousemove', e => {
    const r = cv.getBoundingClientRect();
    catcherX = (e.clientX - r.left) * (W / r.width);
  });
  cv.addEventListener('touchmove', e => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    catcherX = (e.touches[0].clientX - r.left) * (W / r.width);
  }, { passive: false });
  window.addEventListener('keydown', e => { keys[e.key] = true; if (e.key === ' ' || e.key === 'ArrowUp') { e.preventDefault(); fireShot(); } });
  window.addEventListener('keyup', e => { keys[e.key] = false; });
  cv.addEventListener('click', () => { fireShot(); });
  cv.addEventListener('touchstart', e => { e.preventDefault(); fireShot(); }, { passive: false });

  function esc(s) { return String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

  // 测试钩子（dev）：暴露当前局内状态
  window.__starDebug = function () {
    return {
      running: S.running, score: S.score, lives: S.lives,
      stars: stars.length, shots: projectiles.length, hurt: S.params.hurt, scriptErr: scriptErr, scriptTimers: scriptTimers.length,
      patch: patch ? { attack: patch.attack, entities: patch.entities.length } : null,
      params: { magnet: S.params.magnet, invincible: S.params.invincible, shield: S.params.shield, double: S.params.double, wide: S.params.wide, starSpeed: S.params.starSpeed },
      starList: stars.slice(0, 8).map(function (s) { return { kind: s.kind || s.type, x: Math.round(s.x), y: Math.round(s.y), text: s.def ? s.def.text : '' }; }),
    };
  };

  // 启动
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
