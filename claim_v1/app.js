/* claim_v3 - 扭蛋机 + 口令积分 + 真里程碑 + 存档码 */
(function() {
  'use strict';

  const STORAGE_KEY = 'jiahong-claim-v3';
  const RARITY_WEIGHT = { SSR: 5, SR: 15, R: 30, N: 50 };
  const REDRAW_COST = 50;
  const RARITY_ORDER = ['N', 'R', 'SR', 'SSR'];
  const TITLES = ['勇敢者', '智多星', '创造家', '小达人'];
  const NAME_A = ['小', '阿', '星', '云', '月', '风', '糖', '米'];
  const NAME_B = ['朗', '羽', '辰', '宝', '豆', '乐', '阳', '灵', '可', '果'];
  const MILESTONES = [
    { p: 100,  icon: '🎟️', label: '换蛋券 ×1（免费再抽一次）' },
    { p: 500,  icon: '👑', label: '皇冠配饰（印在档案卡上）' },
    { p: 1000, icon: '★',  label: '金边档案 + 专属称号' },
    { p: 2000, icon: '🎰', label: '双蛋券 ×1（一次抽俩选一个）' },
  ];

  const state = {
    step: 'name-input',
    owner: '',
    filterGender: 'all',
    filterTags: [],
    gachaResult: null,
    doubleCandidates: null,   // 双蛋模式：[r1, r2]
    characterName: '',
    message: '',
    points: 0,
    owned: [],
    unlockedMilestones: [],
    coupons: 0,
    doubleCoupons: 0,
    firstDrawUsed: false,
    usedCodes: [],
    title: '',
    muted: false,
  };

  let gachaAnimating = false;

  // ============= 音效（WebAudio 合成，无音频文件）=============
  const Sound = (() => {
    let ctx = null;
    function ac() {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function tone(freq, dur, opt) {
      opt = opt || {};
      if (state.muted) return;
      try {
        const a = ac();
        const t = a.currentTime + (opt.delay || 0);
        const o = a.createOscillator();
        const g = a.createGain();
        o.type = opt.type || 'sine';
        o.frequency.setValueAtTime(freq, t);
        if (opt.slide) o.frequency.exponentialRampToValueAtTime(opt.slide, t + dur);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(opt.gain || 0.15, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g); g.connect(a.destination);
        o.start(t); o.stop(t + dur + 0.05);
      } catch (e) {}
    }
    function noise(dur, opt) {
      opt = opt || {};
      if (state.muted) return;
      try {
        const a = ac();
        const t = a.currentTime + (opt.delay || 0);
        const len = Math.floor(a.sampleRate * dur);
        const buf = a.createBuffer(1, len, a.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
        const src = a.createBufferSource(); src.buffer = buf;
        const f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = opt.freq || 2600; f.Q.value = 1;
        const g = a.createGain(); g.gain.value = opt.gain || 0.2;
        src.connect(f); f.connect(g); g.connect(a.destination);
        src.start(t);
      } catch (e) {}
    }
    return {
      click: () => tone(660, 0.06, { type: 'triangle', gain: 0.08 }),
      shake: () => { for (let i = 0; i < 6; i++) noise(0.09, { delay: i * 0.16, freq: 2400, gain: 0.18 }); },
      crank: () => tone(180, 0.3, { slide: 320, type: 'square', gain: 0.06 }),
      pop: () => { tone(320, 0.12, { slide: 80, gain: 0.28 }); tone(900, 0.08, { delay: 0.05, gain: 0.14 }); },
      coin: () => { tone(1245, 0.07, { type: 'square', gain: 0.06 }); tone(1868, 0.12, { type: 'square', gain: 0.06, delay: 0.07 }); },
      reveal: (rar) => {
        const seqs = { N: [523, 659], R: [523, 659, 784], SR: [523, 659, 784, 1047], SSR: [392, 523, 659, 784, 1047, 1319] };
        (seqs[rar] || seqs.N).forEach((f, i) => tone(f, 0.22, { delay: i * 0.09, gain: 0.15, type: 'triangle' }));
        if (rar === 'SSR') [1568, 2093].forEach((f, i) => tone(f, 0.4, { delay: 0.6 + i * 0.12, gain: 0.09 }));
      },
      milestone: () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.25, { delay: i * 0.08, type: 'triangle', gain: 0.14 })),
      error: () => tone(220, 0.18, { type: 'sawtooth', gain: 0.07 }),
    };
  })();

  // ============= 视图 =============
  function showView(name) {
    state.step = name;
    document.querySelectorAll('.view').forEach(v => { v.hidden = v.dataset.view !== name; });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (name === 'archive') renderArchive();
    if (name === 'gacha') prepareGachaView();
    refreshPoints();
  }

  // ============= 候选池（P0-①：tag 不缩池，只加权重）=============
  function pool() {
    // 性别是硬偏好；性格 tag 只是心愿，不缩小池子
    return window.CHARACTERS.filter(c => state.filterGender === 'all' || c.gender === state.filterGender);
  }
  function matchedCount(c) {
    return c.tags.filter(t => state.filterTags.includes(t)).length;
  }
  function charWeight(c) {
    return 1 + matchedCount(c) * 0.35; // 心愿命中越多，越容易被摇到（温和倾斜）
  }
  function updatePoolSummary() {
    const n = pool().length;
    const el = document.getElementById('pool-summary');
    // 池子太小时不显示数字，保留神秘感（机器人只有 1 位）
    const label = n <= 2 ? '<strong>神秘小队</strong>' : '<strong>' + n + '</strong> 位英雄';
    el.innerHTML = '英雄池 ' + label + (state.filterTags.length ? ' · 心愿已许下 ✨' : '');
  }

  // ============= 抽卡算法 =============
  // 先按【固定档位概率】滚稀有度（SSR 5% / SR 15% / R 30% / N 50%），
  // 池子里没有的档位概率自动归一化；档内再按心愿加权选角色。
  // 注意：不能按"每个角色"加权——那会让角色多的档位（N 12个）稀释角色少的档位（SSR 2个）。
  function pickRarity(candidates) {
    const present = new Set(candidates.map(c => c.rarity));
    let total = 0;
    RARITY_ORDER.forEach(r => { if (present.has(r)) total += RARITY_WEIGHT[r]; });
    let roll = Math.random() * total;
    for (const r of RARITY_ORDER.slice().reverse()) { // SSR 优先判定
      if (!present.has(r)) continue;
      roll -= RARITY_WEIGHT[r];
      if (roll < 0) return r;
    }
    return 'N';
  }
  function pickCharInRarity(cands) {
    const weights = cands.map(charWeight);
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < cands.length; i++) {
      r -= weights[i];
      if (r < 0) return cands[i];
    }
    return cands[cands.length - 1];
  }
  function rollOne() {
    const candidates = pool();
    const rar = pickRarity(candidates);
    const inR = candidates.filter(c => c.rarity === rar);
    const c = pickCharInRarity(inR);
    // P0-①：心愿达成需要真实命中 min(2, 心愿数) 个 tag，不再必中
    const need = Math.min(2, state.filterTags.length);
    const boost = state.filterTags.length > 0 && matchedCount(c) >= need;
    return { char: c, boost: boost };
  }
  function upgradeRarity(r) {
    const i = RARITY_ORDER.indexOf(r);
    return RARITY_ORDER[Math.min(i + 1, 3)];
  }
  function visualRarity(result) {
    return result.boost ? upgradeRarity(result.char.rarity) : result.char.rarity;
  }
  function getRarityColor(r) {
    return { N: '#3da5ff', R: '#2ed3a3', SR: '#9b6bff', SSR: '#ffb830' }[r] || '#999';
  }

  // ============= 抽卡成本（P0-④）=============
  function canDraw() {
    if (!state.firstDrawUsed) return { ok: true, label: '首次免费' };
    if (state.coupons > 0) return { ok: true, coupon: true, label: '🎟️ 用换蛋券（剩 ' + state.coupons + ' 张）' };
    if (state.points >= REDRAW_COST) return { ok: true, cost: true, label: '花费 ⭐' + REDRAW_COST };
    return { ok: false, label: '再抽需要 ⭐' + REDRAW_COST + ' 或换蛋券，去完成任务吧～' };
  }
  function payForDraw(pay) {
    if (pay.coupon) state.coupons--;
    else if (pay.cost) state.points -= REDRAW_COST;
    state.firstDrawUsed = true;
    saveAll();
    refreshPoints();
  }

  // ============= 扭蛋机视图 =============
  const CAP_COLORS = ['#ff8fb2', '#ffd76a', '#7ed6ff', '#a78bfa', '#7ee8c7', '#ffb08a'];
  function prepareGachaView() {
    // 在玻璃罩里撒满小蛋
    const box = document.getElementById('gm-capsules');
    box.innerHTML = '';
    for (let i = 0; i < 14; i++) {
      const cap = document.createElement('div');
      cap.className = 'mini-cap';
      const col = CAP_COLORS[i % CAP_COLORS.length];
      cap.style.background = 'radial-gradient(circle at 32% 30%, #ffffff, ' + col + ' 60%)';
      cap.style.left = (8 + Math.random() * 76) + '%';
      cap.style.top = (30 + Math.random() * 58) + '%';
      cap.style.animationDelay = (Math.random() * 0.35) + 's';
      box.appendChild(cap);
    }
    // 成本提示
    const pay = canDraw();
    document.getElementById('gacha-cost').textContent = pay.label;
    // 双蛋按钮
    const dbl = document.getElementById('btn-double');
    document.getElementById('double-count').textContent = state.doubleCoupons;
    dbl.hidden = state.doubleCoupons <= 0 || gachaAnimating;
  }

  function doGacha(mode) {
    if (gachaAnimating) return;
    if (pool().length === 0) return;

    if (mode === 'double') {
      if (state.doubleCoupons <= 0) return;
      state.doubleCoupons--;
      state.firstDrawUsed = true;
      saveAll();
    } else {
      const pay = canDraw();
      if (!pay.ok) {
        document.getElementById('gacha-hint').textContent = pay.label;
        Sound.error();
        return;
      }
      payForDraw(pay);
    }

    const results = mode === 'double' ? [rollOne(), rollOne()] : [rollOne()];
    runGachaAnim(results, mode === 'double');
  }

  function runGachaAnim(results, isDouble) {
    gachaAnimating = true;
    document.getElementById('btn-double').hidden = true;
    const knob = document.getElementById('btn-knob');
    const dome = document.getElementById('gm-dome');
    const capsule = document.getElementById('gm-capsule');
    const hint = document.getElementById('gacha-hint');
    const area = document.getElementById('gacha-result-area');
    area.innerHTML = '';
    state.doubleCandidates = null;
    document.getElementById('btn-go-rename').disabled = true;

    knob.disabled = true;
    knob.classList.add('spin');
    dome.classList.add('shake');
    Sound.crank();
    Sound.shake();
    hint.textContent = '摇一摇...';

    setTimeout(() => {
      dome.classList.remove('shake');
      knob.classList.remove('spin');
      // 蛋掉进窗口
      capsule.hidden = false;
      capsule.classList.remove('dropped', 'popped');
      requestAnimationFrame(() => requestAnimationFrame(() => capsule.classList.add('dropped')));
      hint.textContent = '蛋掉下来了！';

      setTimeout(() => {
        capsule.classList.add('popped');
        Sound.pop();
        // 展示结果
        results.forEach((res, i) => {
          setTimeout(() => showResultCard(res, isDouble, area), i * 500);
        });
        const totalWait = isDouble ? 700 + results.length * 500 : 900;
        setTimeout(() => {
          gachaAnimating = false;
          knob.disabled = false;
          prepareGachaView();
          if (!isDouble) {
            state.gachaResult = results[0];
            document.getElementById('btn-go-rename').disabled = false;
            hint.textContent = '抽到了 ' + results[0].char.name + '！带 TA 回家吧';
          } else {
            hint.textContent = '两个英雄，点一个带 TA 回家！';
          }
        }, totalWait);
      }, 800);
    }, 1100);
  }

  function showResultCard(res, isDouble, area) {
    const rar = visualRarity(res);
    const card = document.createElement('div');
    card.className = 'result-card' + (isDouble ? ' pickable' : '');
    if (rar === 'SSR') {
      const burst = document.createElement('div');
      burst.className = 'ssr-burst';
      card.appendChild(burst);
    }
    const img = document.createElement('img');
    img.src = res.char.img;
    img.alt = res.char.name;
    card.appendChild(img);

    const rarEl = document.createElement('div');
    rarEl.className = 'result-rarity ' + rar;
    rarEl.textContent = rar === 'SSR' ? '★ SSR 传说 ★' : rar;
    card.appendChild(rarEl);

    if (res.boost) {
      const b = document.createElement('div');
      b.className = 'result-boost';
      b.textContent = '💖 心愿达成';
      card.appendChild(b);
    }

    const nm = document.createElement('div');
    nm.className = 'result-name';
    nm.textContent = res.char.name;
    card.appendChild(nm);

    if (isDouble) {
      const ph = document.createElement('div');
      ph.className = 'result-pick-hint';
      ph.textContent = '点我选 TA';
      card.appendChild(ph);
      card.addEventListener('click', () => {
        if (state.gachaResult) return; // 已选过
        state.gachaResult = res;
        card.classList.add('chosen');
        card.classList.remove('pickable');
        ph.textContent = '✅ 就是 TA 了';
        area.querySelectorAll('.result-card').forEach(c => { if (c !== card) c.style.opacity = '0.45'; });
        document.getElementById('btn-go-rename').disabled = false;
        Sound.click();
      });
    }

    area.appendChild(card);
    Sound.reveal(rar);
    spawnParticles(getRarityColor(rar), rar === 'SSR' ? 40 : 22);
  }

  function spawnParticles(color, count) {
    const layer = document.createElement('div');
    layer.className = 'particles';
    document.body.appendChild(layer);
    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      p.className = 'particle';
      const dx = (Math.random() - 0.5) * 500;
      const dy = -100 - Math.random() * 300;
      p.style.cssText = 'left:50%;top:45%;background:' + color + ';--dx:' + dx + 'px;--dy:' + dy + 'px;width:' + (6 + Math.random() * 8) + 'px;height:' + (6 + Math.random() * 8) + 'px;animation-delay:' + (Math.random() * 0.3) + 's;';
      layer.appendChild(p);
    }
    setTimeout(() => layer.remove(), 1600);
  }

  // ============= 起名（P1-⑦：骰子 + 候选名 + 一句话）=============
  function randomName(c) {
    const poolNames = (c.alts || []).slice();
    for (let i = 0; i < 3; i++) {
      poolNames.push(NAME_A[Math.floor(Math.random() * NAME_A.length)] + NAME_B[Math.floor(Math.random() * NAME_B.length)]);
    }
    return poolNames[Math.floor(Math.random() * poolNames.length)];
  }

  function enterName() {
    const res = state.gachaResult;
    if (!res) return;
    const c = res.char;
    const rar = visualRarity(res);
    const stage = document.getElementById('rename-stage');
    stage.innerHTML =
      '<img src="' + c.img + '" alt="' + c.name + '">' +
      '<div><span class="rename-rarity ' + rar + '">' + (rar === 'SSR' ? '★ SSR 传说 ★' : rar) + '</span></div>' +
      '<div class="rename-tags">' + c.tags.map(t => '<span>' + t + '</span>').join('') + '</div>' +
      '<p class="rename-intro">' + c.intro + '</p>';

    // 候选名 chips
    const altBox = document.getElementById('alt-chips');
    altBox.innerHTML = '';
    (c.alts || []).forEach(n => {
      const b = document.createElement('button');
      b.className = 'alt-chip';
      b.textContent = n;
      b.addEventListener('click', () => {
        document.getElementById('input-character-name').value = n;
        state.characterName = n;
        document.getElementById('btn-go-archive').disabled = false;
        Sound.click();
      });
      altBox.appendChild(b);
    });

    document.getElementById('input-character-name').value = '';
    document.getElementById('input-message').value = '';
    document.getElementById('btn-go-archive').disabled = true;
    state.characterName = '';
    state.message = '';
    showView('rename');
    setTimeout(() => document.getElementById('input-character-name').focus(), 250);
  }

  // ============= 里程碑（P0-③：全部真实兑现）=============
  function checkMilestones() {
    MILESTONES.forEach(m => {
      if (state.points >= m.p && !state.unlockedMilestones.includes(m.p)) {
        state.unlockedMilestones.push(m.p);
        if (m.p === 100) state.coupons++;
        if (m.p === 2000) state.doubleCoupons++;
        celebrateMilestone(m);
      }
    });
  }
  function celebrateMilestone(m) {
    document.getElementById('milestone-icon').textContent = m.icon;
    document.getElementById('milestone-label').textContent = m.label;
    document.getElementById('milestone-overlay').hidden = false;
    Sound.milestone();
    spawnParticles('#ffb830', 30);
    renderTitlePicker();
  }

  function renderTitlePicker() {
    const block = document.getElementById('title-block');
    const unlocked = state.unlockedMilestones.includes(1000);
    block.hidden = !unlocked;
    if (!unlocked) return;
    const row = document.getElementById('row-titles');
    row.innerHTML = '';
    TITLES.forEach(t => {
      const c = document.createElement('button');
      c.className = 'chip' + (state.title === t ? ' chip-active' : '');
      c.textContent = t;
      c.addEventListener('click', () => {
        state.title = t;
        saveAll();
        renderTitlePicker();
        renderArchive();
        Sound.click();
      });
      row.appendChild(c);
    });
  }

  // ============= 口令兑换（P0-②）=============
  function redeemCode() {
    const input = document.getElementById('input-code');
    const fb = document.getElementById('code-fb');
    const code = input.value.trim();
    if (!code) return;
    const table = window.TEACHER_CODES || {};
    if (state.usedCodes.includes(code)) {
      fb.textContent = '这个口令已经用过啦';
      fb.className = 'code-fb bad';
      Sound.error();
      return;
    }
    if (!(code in table)) {
      fb.textContent = '口令不对，再问问老师～';
      fb.className = 'code-fb bad';
      Sound.error();
      return;
    }
    state.usedCodes.push(code);
    state.points += table[code];
    fb.textContent = '🎉 口令正确！+' + table[code] + ' 分';
    fb.className = 'code-fb ok';
    input.value = '';
    Sound.coin();
    checkMilestones();
    saveAll();
    refreshPoints();
    renderArchive();
  }

  // ============= 档案视图 =============
  function renderArchive() {
    // 当前英雄：刚抽的，或小队里最后一个
    let cur = state.gachaResult;
    if (!cur && state.owned.length > 0) {
      const last = state.owned[state.owned.length - 1];
      const found = window.CHARACTERS.find(c => c.id === last.id);
      if (found) {
        cur = { char: found, boost: last.rarity !== found.rarity };
        state.gachaResult = cur;
        state.characterName = last.name;
        state.message = last.message || '';
      }
    }
    if (cur) drawArchiveCard(cur.char, visualRarity(cur));
    renderBadges();
    renderOwned();
    renderTitlePicker();
    refreshPoints();
  }

  function renderBadges() {
    const el = document.getElementById('points-badges');
    el.innerHTML = '';
    const labels = { 100: '🎟️ 换蛋券', 500: '👑 皇冠配饰', 1000: '★ 金边称号', 2000: '🎰 双蛋券' };
    state.unlockedMilestones.forEach(m => {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = labels[m];
      el.appendChild(b);
    });
  }

  function renderOwned() {
    const grid = document.getElementById('owned-grid');
    document.getElementById('owned-count').textContent = state.owned.length;
    grid.innerHTML = '';
    state.owned.forEach(o => {
      const cell = document.createElement('div');
      cell.className = 'owned-cell';
      cell.innerHTML =
        '<img src="' + o.img + '" alt="' + o.name + '">' +
        '<div class="owned-name">' + o.name + '</div>' +
        '<span class="owned-rarity">' + o.rarity + '</span>';
      grid.appendChild(cell);
    });
  }

  function refreshPoints() {
    document.querySelectorAll('.topbar-points').forEach(el => { el.textContent = '⭐ ' + state.points; });
    const fill = document.getElementById('points-fill');
    if (fill) fill.style.width = Math.min(state.points / 2000 * 100, 100) + '%';
    document.querySelectorAll('.tick').forEach(t => {
      const p = parseInt(t.dataset.p, 10);
      t.style.left = (p / 2000 * 100) + '%';
      t.classList.toggle('done', state.points >= p);
    });
    // 再抽按钮文案
    const again = document.getElementById('btn-again');
    if (again) {
      if (!state.firstDrawUsed) again.textContent = '再抽一次';
      else if (state.coupons > 0) again.textContent = '再抽一次（🎟️×' + state.coupons + '）';
      else again.textContent = '再抽一次（⭐' + REDRAW_COST + '）';
    }
  }

  // ============= Canvas 档案卡（P2-⑩：家长向重设计）=============
  function drawArchiveCard(c, rar) {
    const cv = document.getElementById('canvas-archive');
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const goldBorder = state.unlockedMilestones.includes(1000);
    const hasCrown = state.unlockedMilestones.includes(500);
    const cMap = { N: '#3da5ff', R: '#2ed3a3', SR: '#9b6bff', SSR: '#f08c00' };

    // 糖果渐变底
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#fff5fa');
    bg.addColorStop(0.5, '#f3efff');
    bg.addColorStop(1, '#e8f4ff');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 装饰星星
    ctx.font = '26px sans-serif';
    ctx.fillStyle = 'rgba(155,107,255,0.25)';
    const stars = [[60,150],[690,120],[40,520],[700,560],[90,880],[660,900],[370,80],[40,320],[710,330]];
    stars.forEach(s => ctx.fillText('✦', s[0], s[1]));

    // 顶部稀有度带
    ctx.fillStyle = cMap[rar] || '#888';
    ctx.fillRect(0, 0, W, 14);

    // 金边（1000 分解锁）
    if (goldBorder) {
      ctx.strokeStyle = '#f0b429';
      ctx.lineWidth = 10;
      ctx.strokeRect(8, 8, W - 16, H - 16);
      ctx.strokeStyle = '#c08020';
      ctx.lineWidth = 2;
      ctx.strokeRect(22, 22, W - 44, H - 44);
    }

    ctx.textAlign = 'center';

    // 标题
    ctx.fillStyle = '#3a3050';
    ctx.font = 'bold 40px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('我的英雄档案', W / 2, 78);

    // 稀有度徽章
    ctx.fillStyle = cMap[rar];
    ctx.font = 'bold 26px "PingFang SC", sans-serif';
    ctx.fillText(rar === 'SSR' ? '★ SSR 传说 ★' : '◆ ' + rar + ' ◆', W / 2, 122);

    // 角色大图（全身，不裁圆）
    const img = new Image();
    img.onload = () => {
      const boxW = W - 200, boxH = 400;
      const scale = Math.min(boxW / img.width, boxH / img.height);
      const w = img.width * scale, h = img.height * scale;
      const ix = (W - w) / 2, iy = 150 + (boxH - h) / 2;
      // 圆形光晕底座
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(W / 2, 150 + boxH - 24, 170, 26, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(124,92,255,0.12)';
      ctx.fill();
      ctx.restore();
      ctx.drawImage(img, ix, iy, w, h);
      // 皇冠（500 分解锁）
      if (hasCrown) {
        ctx.font = '56px sans-serif';
        ctx.fillText('👑', W / 2, iy + 16);
      }
      drawCardText(ctx, W, H, c, rar, goldBorder);
    };
    img.onerror = () => drawCardText(ctx, W, H, c, rar, goldBorder);
    img.src = c.img;
  }

  function drawCardText(ctx, W, H, c, rar, goldBorder) {
    const cMap = { N: '#3da5ff', R: '#2ed3a3', SR: '#9b6bff', SSR: '#f08c00' };
    let y = 600;

    // 角色名（孩子起的）
    ctx.fillStyle = '#8a8598';
    ctx.font = '18px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('原名 ' + c.name, W / 2, y);
    ctx.fillStyle = '#3a3050';
    ctx.font = 'bold 52px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(state.characterName, W / 2, y + 56);

    // 称号
    if (state.title) {
      const tw = ctx.measureText('★ ' + state.title + ' ★').width;
      ctx.fillStyle = '#fff3d6';
      roundRect(ctx, W / 2 - tw / 2 - 18, y + 76, tw + 36, 36, 18);
      ctx.fill();
      ctx.fillStyle = '#a86a00';
      ctx.font = 'bold 20px "PingFang SC", sans-serif';
      ctx.fillText('★ ' + state.title + ' ★', W / 2, y + 101);
      y += 44;
    }

    // 小主人 + 积分
    ctx.fillStyle = '#5a5470';
    ctx.font = '22px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('小主人：' + state.owner + '   ·   ⭐ ' + state.points + ' 分', W / 2, y + 140);

    // 孩子送的一句话（家长 wow 点）
    if (state.message) {
      ctx.fillStyle = '#7c5cff';
      ctx.font = 'italic 20px "PingFang SC", "Microsoft YaHei", sans-serif';
      const lines = wrapText(ctx, '“' + state.message + '”', W - 180);
      lines.forEach((ln, i) => ctx.fillText(ln, W / 2, y + 182 + i * 30));
      y += (lines.length - 1) * 30;
    }

    // 徽章行
    const badgeIcons = [];
    if (state.unlockedMilestones.includes(100)) badgeIcons.push('🎟️');
    if (state.unlockedMilestones.includes(500)) badgeIcons.push('👑');
    if (state.unlockedMilestones.includes(1000)) badgeIcons.push('★');
    if (state.unlockedMilestones.includes(2000)) badgeIcons.push('🎰');
    if (badgeIcons.length) {
      ctx.font = '30px sans-serif';
      ctx.fillText(badgeIcons.join('  '), W / 2, y + 232);
    }

    // 底部：性格 + 日期 + 专属编号
    ctx.fillStyle = '#8a8598';
    ctx.font = '17px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('◇ ' + c.personality, W / 2, H - 92);
    ctx.font = '15px "PingFang SC", "Microsoft YaHei", sans-serif';
    const hero = state.owned[state.owned.length - 1];
    const codeNo = hero ? '#' + String(hero.ts % 1000000).padStart(6, '0') : '#000000';
    ctx.fillText('专属编号 ' + codeNo + '   ·   ' + formatDate(new Date()), W / 2, H - 60);
    if (goldBorder) {
      ctx.fillStyle = '#c08020';
      ctx.font = 'bold 15px "PingFang SC", sans-serif';
      ctx.fillText('★ 金边档案 ★', W / 2, H - 32);
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function wrapText(ctx, text, maxW) {
    const lines = [];
    let line = '';
    for (const ch of text) {
      line += ch;
      if (ctx.measureText(line).width > maxW && line.length > 1) {
        lines.push(line.slice(0, -1));
        line = ch;
      }
    }
    if (line) lines.push(line);
    return lines.slice(0, 3);
  }

  function formatDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // ============= 持久化 + 存档码（P1-⑧）=============
  function exportData() {
    return {
      v: 3,
      owner: state.owner,
      points: state.points,
      owned: state.owned,
      unlockedMilestones: state.unlockedMilestones,
      coupons: state.coupons,
      doubleCoupons: state.doubleCoupons,
      firstDrawUsed: state.firstDrawUsed,
      usedCodes: state.usedCodes,
      title: state.title,
    };
  }
  function applyData(a) {
    state.owner = a.owner || '';
    state.points = a.points || 0;
    state.owned = a.owned || [];
    state.unlockedMilestones = a.unlockedMilestones || [];
    state.coupons = a.coupons || 0;
    state.doubleCoupons = a.doubleCoupons || 0;
    state.firstDrawUsed = !!a.firstDrawUsed;
    state.usedCodes = a.usedCodes || [];
    state.title = a.title || '';
  }
  function saveAll() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(exportData()));
  }
  function loadAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const a = JSON.parse(raw);
      if (!a.owner) return false;
      applyData(a);
      return true;
    } catch (e) { return false; }
  }

  function makeSaveCode() {
    return btoa(unescape(encodeURIComponent(JSON.stringify(exportData()))));
  }
  function restoreFromCode(str) {
    try {
      const a = JSON.parse(decodeURIComponent(escape(atob(str.trim()))));
      if (!a.owner) return false;
      applyData(a);
      saveAll();
      return true;
    } catch (e) { return false; }
  }

  // ============= 下载 & 导出 =============
  function downloadCard() {
    const cv = document.getElementById('canvas-archive');
    const url = cv.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = '英雄档案_' + state.characterName + '_' + state.owner + '.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    Sound.click();
  }

  // P2-⑨：英雄包导出（供后续课程项目读取）
  function exportHeroPack() {
    const pack = {
      format: 'hero-pack/v1',
      owner: state.owner,
      points: state.points,
      title: state.title,
      heroes: state.owned,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = state.owner + '_英雄包.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    Sound.click();
  }

  // ============= 初始化 =============
  function init() {
    const hasSave = loadAll();

    // 首次交互解锁音频
    document.body.addEventListener('pointerdown', function unlock() {
      try { Sound.click(); } catch (e) {}
      document.body.removeEventListener('pointerdown', unlock);
    }, { once: true });

    // 静音开关
    const muteBtn = document.getElementById('btn-mute');
    muteBtn.addEventListener('click', () => {
      state.muted = !state.muted;
      muteBtn.textContent = state.muted ? '🔇' : '🔊';
    });

    // 返回工坊
    document.getElementById('btn-home').addEventListener('click', () => {
      location.href = '/workshop_v1/';
    });

    // 视图1：身份
    const ownerInput = document.getElementById('input-owner');
    if (state.owner) ownerInput.value = state.owner;
    ownerInput.addEventListener('input', () => {
      state.owner = ownerInput.value.trim();
      document.getElementById('btn-go-filter').disabled = !state.owner;
    });
    const btnGoFilter = document.getElementById('btn-go-filter');
    btnGoFilter.disabled = !state.owner;
    btnGoFilter.addEventListener('click', () => { saveAll(); Sound.click(); showView('filter'); });

    // 存档码恢复
    document.getElementById('btn-show-restore').addEventListener('click', () => {
      const p = document.getElementById('restore-panel');
      p.hidden = !p.hidden;
    });
    document.getElementById('btn-do-restore').addEventListener('click', () => {
      const fb = document.getElementById('restore-fb');
      const ok = restoreFromCode(document.getElementById('input-savecode').value);
      if (ok) {
        fb.textContent = '✅ 档案找回来啦！';
        fb.className = 'restore-fb ok';
        Sound.milestone();
        setTimeout(() => showView('archive'), 800);
      } else {
        fb.textContent = '存档码不对，检查一下再试';
        fb.className = 'restore-fb bad';
        Sound.error();
      }
    });

    // 视图2：筛选
    document.querySelectorAll('#row-gender .chip').forEach(c => {
      c.addEventListener('click', () => {
        document.querySelectorAll('#row-gender .chip').forEach(x => x.classList.remove('chip-active'));
        c.classList.add('chip-active');
        state.filterGender = c.dataset.gender;
        updatePoolSummary();
        Sound.click();
      });
    });
    document.querySelectorAll('#row-tags .chip').forEach(c => {
      c.addEventListener('click', () => {
        c.classList.toggle('chip-active');
        const t = c.dataset.tag;
        if (c.classList.contains('chip-active')) {
          if (!state.filterTags.includes(t)) state.filterTags.push(t);
        } else {
          state.filterTags = state.filterTags.filter(x => x !== t);
        }
        updatePoolSummary();
        Sound.click();
      });
    });
    document.getElementById('btn-go-gacha').addEventListener('click', () => {
      state.gachaResult = null;
      document.getElementById('gacha-result-area').innerHTML = '';
      document.getElementById('gacha-hint').textContent = '转动摇杆，释放你的英雄';
      const capsule = document.getElementById('gm-capsule');
      capsule.hidden = true;
      capsule.classList.remove('dropped', 'popped');
      showView('gacha');
    });
    document.getElementById('btn-back-name').addEventListener('click', () => showView('name-input'));

    // 视图3：扭蛋
    document.getElementById('btn-knob').addEventListener('click', () => doGacha('single'));
    document.getElementById('btn-double').addEventListener('click', () => doGacha('double'));
    document.getElementById('btn-go-rename').addEventListener('click', enterName);

    // 视图4：起名
    document.getElementById('btn-dice').addEventListener('click', () => {
      if (!state.gachaResult) return;
      const n = randomName(state.gachaResult.char);
      document.getElementById('input-character-name').value = n;
      state.characterName = n;
      document.getElementById('btn-go-archive').disabled = false;
      Sound.click();
    });
    document.getElementById('input-character-name').addEventListener('input', (e) => {
      state.characterName = e.target.value.trim();
      document.getElementById('btn-go-archive').disabled = !state.characterName;
    });
    document.getElementById('input-message').addEventListener('input', (e) => {
      state.message = e.target.value.trim();
    });
    document.getElementById('btn-go-archive').addEventListener('click', () => {
      const res = state.gachaResult;
      const rar = visualRarity(res);
      state.owned.push({
        id: res.char.id,
        name: state.characterName,
        originalName: res.char.name,
        rarity: rar,
        img: res.char.img,
        intro: res.char.intro,
        personality: res.char.personality,
        message: state.message,
        ts: Date.now(),
      });
      saveAll();
      Sound.milestone();
      spawnParticles(getRarityColor(rar), 26);
      showView('archive');
    });
    document.getElementById('btn-back-filter').addEventListener('click', () => showView('filter'));

    // 视图5：档案
    document.getElementById('btn-download-card').addEventListener('click', downloadCard);
    document.getElementById('btn-export-pack').addEventListener('click', exportHeroPack);
    document.getElementById('btn-again').addEventListener('click', () => {
      document.getElementById('btn-go-gacha').click();
    });
    document.getElementById('btn-redeem').addEventListener('click', redeemCode);
    document.getElementById('input-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') redeemCode();
    });
    document.getElementById('btn-savecode').addEventListener('click', () => {
      const p = document.getElementById('savecode-panel');
      p.hidden = !p.hidden;
      if (!p.hidden) document.getElementById('output-savecode').value = makeSaveCode();
    });
    document.getElementById('btn-copy-code').addEventListener('click', () => {
      const ta = document.getElementById('output-savecode');
      ta.select();
      navigator.clipboard.writeText(ta.value).catch(() => document.execCommand('copy'));
      Sound.click();
    });
    document.getElementById('btn-reset').addEventListener('click', () => {
      if (confirm('换一位小朋友开始？当前档案会先清掉（记得先保存存档码！）')) {
        localStorage.removeItem(STORAGE_KEY);
        location.reload();
      }
    });
    document.getElementById('btn-milestone-ok').addEventListener('click', () => {
      document.getElementById('milestone-overlay').hidden = true;
      Sound.click();
    });

    // 决定首屏
    if (hasSave && state.owned.length > 0) {
      showView('archive');
    } else {
      showView('name-input');
    }
    updatePoolSummary();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
