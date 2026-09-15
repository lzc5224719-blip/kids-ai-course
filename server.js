/* ============================================================
   server.js — 零依赖静态服务器 + DeepSeek「制作台」API 代理
   - 静态服务：工作区根目录（/claim_v1 /game_v1 /workshop_v1 /workbench_v1 同源）
   - POST /api/chat：把孩子的需求发给 DeepSeek，返回结构化「改动」JSON
   - 无 key 时自动进入「演示模式」（本地关键词引擎模拟 AI，方便先跑通）
   ============================================================ */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 9000);
const ROOT = __dirname;

// ---------- 读配置 ----------
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'ai-config.json'), 'utf8')); } catch (e) {}
const API_KEY = (process.env.DEEPSEEK_API_KEY || cfg.apiKey || '').trim();
const MODEL = cfg.model || 'deepseek-chat';
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MOCK_MODE = !API_KEY;

// ---------- MIME ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

// ---------- 建议箱（裂变：游客给创作者的游戏提建议） ----------
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, '.wb-data');
const SUGGEST_FILE = path.join(DATA_DIR, 'suggestions.json');
function readSuggestions(){ try { return JSON.parse(fs.readFileSync(SUGGEST_FILE, 'utf8')); } catch (e) { return []; } }
function writeSuggestions(list){ try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SUGGEST_FILE, JSON.stringify(list, null, 2)); } catch (e) {} }

// ---------- 作品分享短码（服务端持久化，把 800+ 字符长链接压成 6 位短码） ----------
const SHARE_FILE = path.join(DATA_DIR, 'shares.json');
function readShares(){ try { return JSON.parse(fs.readFileSync(SHARE_FILE, 'utf8')); } catch (e) { return {}; } }
function writeShares(o){ try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SHARE_FILE, JSON.stringify(o, null, 2)); } catch (e) {} }
function randCode(){ const A = 'abcdefghijkmnpqrstuvwxyz23456789'; let s = ''; for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)]; return s; }

// ---------- 老师口令（服务端，孩子看不到明文；可在 teacher-codes.json 或环境变量 TEACHER_CODES_JSON 里改） ----------
let teacherCodes = { '星河': 1, '萤火虫': 2, '彩虹桥': 5, '大力神': 10 };
if (process.env.TEACHER_CODES_JSON) {
  try { teacherCodes = JSON.parse(process.env.TEACHER_CODES_JSON); } catch (e) {}
} else {
  try { teacherCodes = JSON.parse(fs.readFileSync(path.join(ROOT, 'teacher-codes.json'), 'utf8')); } catch (e) {}
}
const REDEEM_FILE = path.join(DATA_DIR, 'redeemed.json');
function readRedeemed(){ try { return JSON.parse(fs.readFileSync(REDEEM_FILE, 'utf8')); } catch (e) { return {}; } }
function writeRedeemed(o){ try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(REDEEM_FILE, JSON.stringify(o, null, 2)); } catch (e) {} }

// 分享数据裁剪：分享链接是公开传播的，只保留已知字段，数值与 MOD_RULES 同区间
function clipSharePayload(p){
  if (!p || typeof p !== 'object') return null;
  const m = (p.m && typeof p.m === 'object') ? p.m : {};
  const outM = {};
  Object.keys(MOD_RULES).forEach(k => {
    if (m[k] === undefined) return;
    const rule = MOD_RULES[k];
    if (rule.type === 'boolean') { if (m[k] === true) outM[k] = true; return; }
    if (rule.type === 'string') { outM[k] = String(m[k]).slice(0, rule.max || 16); return; }
    const n = Number(m[k]);
    if (!isFinite(n)) return;
    outM[k] = Math.max(rule.min, Math.min(rule.max, n));
  });
  if (m.patch && typeof m.patch === 'object') {
    const es = Array.isArray(m.patch.entities) ? m.patch.entities.map(sanitizeEntity).filter(Boolean).slice(0, 12) : [];
    outM.patch = { entities: es, attack: !!m.patch.attack };
  }
  if (typeof m.script === 'string') { const s = sanitizeScript(m.script); if (s) outM.script = s; }
  return {
    n: String(p.n || '').slice(0, 24),
    o: String(p.o || '').slice(0, 20),
    w: String(p.w || '').slice(0, 60),
    h: (p.h && typeof p.h === 'object') ? {
      name: String(p.h.name || '').slice(0, 20),
      originalName: String(p.h.originalName || '').slice(0, 20),
      rarity: ['N','R','SR','SSR'].includes(p.h.rarity) ? p.h.rarity : 'N',
      img: String(p.h.img || '').slice(0, 120),
    } : null,
    m: outM,
  };
}

// 极简内存限流（同一 key 每 60 秒最多 6 次）
const rateHits = new Map();
function rateAllowed(key, max, windowMs){
  const now = Date.now();
  const arr = (rateHits.get(key) || []).filter(t => now - t < (windowMs || 60000));
  if (arr.length >= (max || 6)) { rateHits.set(key, arr); return false; }
  arr.push(now); rateHits.set(key, arr);
  if (rateHits.size > 1000) { for (const [k] of rateHits) { rateHits.delete(k); if (rateHits.size <= 500) break; } }
  return true;
}

// ---------- 允许的改动键与值范围（校验 AI 输出，防止改坏游戏） ----------
const MOD_RULES = {
  star_speed: { type: 'number', min: 0.8, max: 6, def: 2.2 },
  star_size: { type: 'number', min: 14, max: 48, def: 26 },
  spawn_interval: { type: 'number', min: 300, max: 2000, def: 900 },
  gold_chance: { type: 'number', min: 0, max: 0.5, def: 0.08 },
  bomb_chance: { type: 'number', min: 0, max: 0.3, def: 0 },
  magnet: { type: 'boolean', def: false },
  extra_life: { type: 'number', min: 0, max: 3, def: 0 },
  catcher_scale: { type: 'number', min: 0.8, max: 2, def: 1 },
  title: { type: 'string', max: 16, def: '' },
  duration: { type: 'number', min: 10, max: 600, def: 60 },
};

// ---------- 工具 ----------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function serveStatic(res, pathname) {
  let p = decodeURIComponent(pathname);
  if (p === '/') p = '/workshop_v1/index.html';
  // 目录 → index.html
  if (p.endsWith('/')) p += 'index.html';
  // 防泄露：不对外提供敏感文件
  const low = p.toLowerCase();
  if (low.indexOf('ai-config.json') >= 0 || low.indexOf('/.') >= 0 || low.indexOf('\\.') >= 0) { res.writeHead(404); res.end('Not Found'); return; }
  // 防目录穿越
  // 防目录穿越
  const filePath = path.normalize(path.join(ROOT, p));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- 系统提示词（AI 教练） ----------
function buildSystem(hero, owner) {
  const name = (hero && (hero.name || hero.originalName)) || '小伙伴';
  const rarity = (hero && hero.rarity) || 'N';
  const personality = (hero && hero.personality) || '热情又耐心';
  const kid = owner || '小朋友';
  return [
    '你是「' + name + '」，一个陪伴 9-12 岁孩子「' + kid + '」的 AI 制作小伙伴，性格是：' + personality + '。',
    '孩子正在改造他自己做的一个小游戏「星星大冒险」（接住天上掉下来的星星得分）。他会用大白话告诉你他想给游戏加什么、改什么。',
    '',
    '你要像一位耐心的教练，用「一步步提问」的方式，慢慢引导孩子把想法说清楚。每一步只走一小步，像剥洋葱，不要跳步。',
    '',
    '【对象与安全（必须遵守）】你在陪 9-12 岁孩子：绝不说脏话，不聊恐怖/暴力/成人/危险内容；不主动问也不要孩子的隐私（全名、家庭住址、学校班级、电话、父母信息等）；孩子提起隐私或奇怪话题时，温柔地把话题带回游戏；不替孩子写作业答案，只帮他想思路。',
    '【表达教练】孩子一句话就说清需求并直接改时，reply 要具体表扬他的表达（例："你一次就说清楚了：要改什么、往哪个方向，真棒！"）；如果这次是聊了很多轮才说清，改完后的 reply 轻轻带一句复盘（例："这次我们一步步把想法说清了，下次先告诉 TA 你的感受、再说想怎么变，会更快哦"），一两句即可，别说教。',
    '【先玩再改】孩子说不出哪里不舒服、或听起来根本没玩过当前这版（只说"不好玩""没意思"）时，先请他"去玩一局，记住哪里让你不舒服，再回来告诉我"，或问他一个具体的观察问题，不要凭空猜。',
    '【把决定权留给孩子】要改的是程度（快慢/大小/多少）时，尽量先用 options 让孩子选程度（如"慢一点点，还是慢很多？"），他选完再改；若他已经一句话说清方向+程度就直接改。每次改动后，用孩子听得懂的话说清"会有什么变化"。',
    '【最重要的规则 —— 当孩子只说了「维度」时】',
    '1. 孩子只说了一个维度词（比如「速度」「难度」「我想改改速度」），没说想往哪个方向改时，【绝对禁止】第一句就问「快还是慢」「多还是少」「大还是小」这种方向二选一——那是替孩子把方向列好、让他做选择题，不是引导。',
    '2. 正确的第一步是「先定位问题」：问一个让他观察游戏当下状态、说出感受的问题。例如：「你玩「星星大冒险」的时候，感觉怎么样呀？是觉得太简单有点没意思，还是有点难、接不住呀？」让他自己先说出感受和遇到的情况。',
    '3. 等他答出感受（比如「太难了，接不住」），你再【顺着他的话】往下细化一层：比如「接不住呀，是不是因为星星掉得太快了？」——一步步逼近真正要改的那个东西。',
    '4. 等他说清楚具体要改什么、往哪个方向改（比如「对，太快了」），你才输出「改动」JSON。',
    '5. 每轮只问【一个小问题】，不要一次抛好几个，也不要一上来就给方向选项。',
    '6. 例外：如果他一句话就说完整了（比如「我想让星星变慢」），就直接改，不用绕圈子。',
    '',
    '【你只能输出一个纯 JSON 对象，不要输出任何其他文字、解释或代码块标记】',
    '【特别强调】不管你上一句回复过什么，你现在的这轮回复必须是一个 JSON 对象，绝对不能用自然语言回答。',
    '',
    'JSON 有三种：',
    '提问：{"action":"ask","reply":"<用孩子听得懂的大白话问一个最关键的问题>","options":["<选项1>","<选项2>","<选项3>"]}',
    '改游戏：{"action":"modify","reply":"<用一句话、带点兴奋地告诉孩子你改了什么>","summary":"<改动简短名字，8字以内>","changes":[{"key":"<键>","value":<值>}],"patch":{...}}（changes 和 patch 至少给一个：只调数字给 changes，加新东西/攻击/道具给 patch）',
    '愿望：{"action":"wish","reply":"<热情肯定孩子，并说：我把它写进我们的愿望单啦，下次课我们一起把它做出来！>","note":"<用一句话记清孩子想要的功能>","options":["<现在就能试的方向1>","<方向2>"]}',
    '如果孩子这一句话里同时说了几件不同的事，就在 JSON 里额外加一个数字字段 "heardCount"（等于你能听懂的事有几件，1~5）。只提一件事时可以省略。',
    '',
    '可用的改动键（key）和值的范围：',
    '- star_speed：星星下落速度，数字，默认 2.2。1.4=明显变慢 1.8=稍慢 2.2=正常 3=快 4=很快（孩子说慢一点就取 1.4~1.8，说快一点就取 2.8~3.5）',
    '- star_size：星星大小，数字，20=小 26=正常 40=大',
    '- spawn_interval：星星出现的间隔（毫秒），数字，400=密集 900=正常 1600=稀疏',
    '- gold_chance：出现金星星的概率，数字，0 到 0.5',
    '- bomb_chance：出现炸弹星的概率，数字，0 到 0.3',
    '- magnet：磁铁开关，true 或 false（开启后星星会被吸向角色）',
    '- extra_life：额外生命数，数字，0 到 3',
    '- catcher_scale：角色接星星的宽度倍率，数字，1=正常 1.5=加宽',
    '- title：游戏标题，字符串，简短（16字以内）',
    '- duration：本局限时秒数，数字 10~600，默认 60（孩子说“限时/倒计时/多长时间”就用它）',
    '',
    '【玩法补丁 patch —— 让孩子天马行空的想法能当场做出来】',
    '除了调数字，你还能给游戏加“新东西/新玩法”，通过 JSON 里的 patch 字段：',
    'patch = { "attack": true, "entities": [ {实体} ] }',
    '实体字段：id=简短英文；kind="good"(接到加分)|"gold"(金色大分)|"bad"(坏蛋，碰到扣命)|"power"(吃到给道具)；shape="text"；text=一个 emoji 或字（如 👾🛡🐉💎）；size=14~60；speed=0.5~9；interval=500~9000（每隔多少毫秒来一个）；score=0~300（接到/打掉加的分）；side="top"(正上方掉)|"sine"(蛇形掉)|"left"/"right"(从左右飞过)；targetable=true 表示能被光弹打掉；kind=power 时要带 power="magnet|shield|double|life|invincible|wide"。',
    '例子1：孩子要“会飞的怪兽，我要打它”→ patch={attack:true,entities:[{id:"monster",kind:"bad",shape:"text",text:"👾",size:34,speed:1.6,interval:1200,score:20,targetable:true,side:"top"}]}',
    '例子2：孩子要“掉护盾/双倍分道具”→ entities 加 {kind:"power",power:"shield",shape:"text",text:"🛡",side:"top"} 或 power:"double"。',
    '一次只动手做孩子当前说的一个点。但孩子一条话里如果说了好几件事，必须【逐条回应】：能做的动手做，这次做不了的也要明确说一句「这件事我这次先记进愿望单」——绝不允许只做第一件、其余的一个字不提。孩子没提的不要自作主张加。',
    '',
    '',
    '【玩法脚本 script（更自由：计时/条件/事件，超出 patch 时用）】',
    'JSON 里还可带 "script":"<一小段玩法代码>"。script 只能用这些能力：',
    'R.every(毫秒,函数)：每隔多久做一次；R.onFrame(函数)：每帧执行；R.onCatch("good|gold|bad|power|bomb",函数)：接到某类东西时触发；R.onHurt(函数)：被炸/受伤时触发；',
    'R.spawn({...})：当场生成一个东西（字段同 patch 实体）；R.addScore(分)；R.addLife(条)；R.flash()：闪红；R.shield()：加护盾；R.lives()/R.score()：读取。',
    '只能写这些，不能碰网页/网络/文件；写错会被自动停掉不影响游戏。代码要短（建议 300 字内，最多 1500）。',
    '例子1（每 3 秒掉一颗爱心，接到就加命）： R.every(3000, function(){ R.spawn({ kind:"power", power:"life", shape:"text", text:"❤", size:24, speed:1.5 }); });',
    '例子2（连续接到 3 颗金星就加一条命）： var n=0; R.onCatch("gold", function(){ n++; if(n>=3){ n=0; R.addLife(1); R.flash(); } });',
    '能用 changes/patch 表达的就用它们；需要计时/条件/事件时才用 script。',
    '',
    '规则：',
    '- 一次只输出 1 个改动（changes 数组通常只放 1 个元素）。',
    '- 值必须在给定范围内，不要超出。',
    '- 永远不许说「做不了、不能、不行、还没有」。孩子想要的东西这次真做不出来时，必须用这四种方式承接下来，绝不能装作没听见：①先夸这个想法 ②当场做一个最接近的样子 ③请他再具体说一点 ④记进愿望单并说「我把它记下来，等排进课表我们一起做」。',
    '- 先用 patch 把孩子的想法真正做出来：他说「怪兽/会飞的坏蛋/我要打它」→ patch 加 kind="bad" 的 👾 实体并 targetable:true、attack:true；说「掉护盾/双倍分道具」→ 加 kind="power" 实体；说「限时/倒计时」→ changes 给 duration。能当场做的就当场做，别劝他换别的。',
    '- 孩子说「被炸到/碰到坏蛋屏幕会变红/全屏泛红」：这是游戏自带的受伤反馈——只要加了炸弹星或坏蛋，被炸到就会全屏泛红，不用也不能额外设置；直接加炸弹（bomb_chance 或 💣 坏蛋实体）即可。',
    '- 孩子说清后就直接动手输出 modify/patch，不要反复追问；最多问 2 个小问题，问完必须做；能直接做就直接做。',
    '- 只有孩子想要「做一个全新游戏/换个游戏类型」这种框架外的，才用「愿望单」action=wish：先夸（「这个想法太酷了！」）→ 记进愿望单并承诺「下次课我们一起把它做出来」→ options 给 1-2 个现在能试的方向。',
    '- 每次提问（action=ask）必须带上 options——3 个左右、孩子点一下就回答的短选项（每个不超过 12 个字），这 3 个选项就是刚才那个问题最常见的几种答案。',
    '- 设计问题时，要让 options 里的选项能直接回答它。孩子还有输入框可以自己打字，所以 options 是「最可能的几条路」，不用穷尽，但一定得有。',
    '- 改完（action=modify）之后想继续引导孩子，也可以再加一个 options（比如「还想要点什么」的几条建议）；不带也没关系。',
    '- 这个游戏可以从这些「维度」改：速度、星星数量、星星大小、难度、奖励（金星星概率）、角色能力（接得更宽/命更多）、主题名字。',
    '- 引导的节奏要跟着孩子走：问「感受」时 options 就是几种感受；确认「方向」时 options 才是几种方向。不要每一步都甩「快/慢」，要让孩子自己一层层说出来。',
    '- 全程用孩子能懂的口吻，不说技术黑话。',
  ].join('\n');
}

// ---------- 从 AI 文本里提取 JSON（容错：去掉 ```json 代码块） ----------
function extractJSON(text) {
  if (!text) return null;
  let t = String(text).trim();
  // 去掉 markdown 代码块
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // 直接解析
  try { return JSON.parse(t); } catch (e) {}
  // 截取第一个 { 到最后一个 }
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(t.slice(s, e + 1)); } catch (err) {}
  }
  return null;
}

// ---------- 校验并规范化 AI 输出 ----------
function cleanOptions(opts) {
  if (!Array.isArray(opts)) return [];
  return opts
    .map(o => String(o).trim())
    .filter(o => o && o.length <= 14)
    .slice(0, 4);
}

// ---------- 玩法补丁校验（v2：同一接星星框架内加实体/攻击/道具） ----------
const PATCH_KINDS = ['good','gold','bad','power'];
const PATCH_POWERS = ['magnet','shield','double','life','invincible','wide'];
const PATCH_SIDES = ['top','sine','left','right'];
const PATCH_SHAPES = ['text','circle','star','heart','rect'];
function clampNum(v, min, max, d){ const n = Number(v); return isFinite(n) ? Math.max(min, Math.min(max, n)) : d; }
function sanitizeEntity(e){
  if (!e || typeof e !== 'object') return null;
  const kind = PATCH_KINDS.includes(e.kind) ? e.kind : (e.bad ? 'bad' : 'good');
  const out = {
    id: String(e.id || ('e' + Math.random().toString(36).slice(2, 6))),
    kind,
    label: typeof e.label === 'string' ? e.label.slice(0, 12) : '',
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
  if (kind === 'power' && !PATCH_POWERS.includes(e.power)) return null;
  return out;
}
const SCRIPT_BANNED = ['document','window','localStorage','sessionStorage','fetch(','XMLHttpRequest','WebSocket','eval(','new Function','import(','require(','process','globalThis','constructor','top','parent'];
function sanitizeScript(s){
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t || t.length > 1500) return null;
  for (let i = 0; i < SCRIPT_BANNED.length; i++) { if (t.indexOf(SCRIPT_BANNED[i]) >= 0) return null; }
  return t;
}

function sanitizePatch(p){
  if (!p || typeof p !== 'object') return null;
  const entities = Array.isArray(p.entities) ? p.entities.map(sanitizeEntity).filter(Boolean) : [];
  const attack = p.attack === true || p.attack === 'true' || p.attack === 1;
  if (!attack && entities.length === 0) return null;
  return { attack, entities };
}

function cleanHeard(v){ const n = Number(v); return (Number.isInteger(n) && n >= 1 && n <= 5) ? n : null; }
function sanitizeResult(raw) {
  if (!raw) return { action: 'ask', reply: '我好像没听懂，你能再说一遍吗？比如「我想加个磁铁」。' };
  if (raw.action === 'ask') {
    const out = { action: 'ask', reply: String(raw.reply || '你能再说清楚一点吗？'), options: cleanOptions(raw.options) };
    const h = cleanHeard(raw.heardCount); if (h) out.heardCount = h;
    return out;
  }
  if (raw.action === 'wish') {
    const out = { action: 'wish', reply: String(raw.reply || '这个想法太酷了！我把它写进愿望单，下次课我们一起做出来！'), note: String(raw.note || '').slice(0, 120), options: cleanOptions(raw.options) };
    const h = cleanHeard(raw.heardCount); if (h) out.heardCount = h;
    return out;
  }
  if (raw.action === 'modify') {
    const changes = [];
    const arr = Array.isArray(raw.changes) ? raw.changes : [];
    for (const c of arr) {
      if (!c || !c.key) continue;
      const rule = MOD_RULES[c.key];
      if (!rule) continue;
      let value = c.value;
      if (rule.type === 'number') {
        value = Number(value);
        if (isNaN(value)) continue;
        value = Math.max(rule.min, Math.min(rule.max, value));
      } else if (rule.type === 'boolean') {
        value = value === true || value === 'true';
      } else { // string
        value = String(value).slice(0, rule.max);
      }
      changes.push({ key: c.key, value });
    }
    let patch = null;
    if (raw.patch && typeof raw.patch === 'object') patch = sanitizePatch(raw.patch);
    const script = sanitizeScript(raw.script);
    if (changes.length === 0 && !patch && !script) return { action: 'ask', reply: '我还没学会这个，我们先试试别的？比如「加个磁铁」或者「星星慢一点」。' };
    const out = {
      action: 'modify',
      reply: String(raw.reply || '改好啦！'),
      summary: String(raw.summary || '小小改造').slice(0, 20),
      changes,
      options: cleanOptions(raw.options),
    };
    if (patch) out.patch = patch;
    if (script) out.script = script;
    const h = cleanHeard(raw.heardCount); if (h) out.heardCount = h;
    return out;
  }
  return { action: 'ask', reply: '我好像没听懂，你能再说一遍吗？' };
}

// ---------- 演示模式（无 key）：本地关键词引擎 ----------
function mockChat(lastText) {
  const t = (lastText || '').replace(/\s/g, '');
  const R = [
    { kw: ['磁铁', '吸'], out: { action: 'modify', reply: '好嘞！我给游戏装上了磁铁，星星会自己飞过来啦！', summary: '磁铁吸附', changes: [{ key: 'magnet', value: true }] } },
    { kw: ['加命', '多一条命', '加一条命', '加生命', '复活', '再来一条命'], out: { action: 'modify', reply: '给你多加了一条命，就多一次机会！', summary: '勇气+1', changes: [{ key: 'extra_life', value: 1 }] } },
    { kw: ['慢', '太慢', '慢点', '慢一点'], out: { action: 'modify', reply: '放慢了星星，先练练手，接起来不慌！', summary: '星星减速', changes: [{ key: 'star_speed', value: 1.4 }] } },
    { kw: ['太快了', '太快', '好快'], out: { action: 'modify', reply: '明白，太快了接不住——我把星星放慢一点！', summary: '星星减速', changes: [{ key: 'star_speed', value: 1.4 }] } },
    { kw: ['快', '更快', '快一点'], out: { action: 'modify', reply: '星星下落加速啦，考验手速的时候到了！', summary: '星星加速', changes: [{ key: 'star_speed', value: 3.2 }] } },
    { kw: ['变大', '大一点', '星星大'], out: { action: 'modify', reply: '把星星变大了，更好接啦！', summary: '星星变大', changes: [{ key: 'star_size', value: 34 }] } },
    { kw: ['变小', '小一点', '星星小'], out: { action: 'modify', reply: '把星星变小了，挑战升级！', summary: '星星变小', changes: [{ key: 'star_size', value: 20 }] } },
    { kw: ['金星', '金色', '黄金', '金星星'], out: { action: 'modify', reply: '金星星变多了，一颗就 50 分，冲呀！', summary: '金星暴击', changes: [{ key: 'gold_chance', value: 0.2 }] } },
    { kw: ['不要炸弹', '别掉炸弹', '别加炸弹', '不要坏蛋', '别来炸弹'], out: { action: 'modify', reply: '好，咱们先不放炸弹，安心接星星！', summary: '去掉炸弹', changes: [{ key: 'bomb_chance', value: 0 }] } },
    { kw: ['炸弹', '爆炸'], out: { action: 'modify', reply: '天上开始掉炸弹星了，可千万别接它！', summary: '炸弹来袭', changes: [{ key: 'bomb_chance', value: 0.12 }] } },
    { kw: ['标题', '名字', '改名', '换个名'], out: { action: 'modify', reply: '给你的游戏换了个响亮的新名字！', summary: '换个名字', changes: [{ key: 'title', value: '我的大冒险' }] } },
    { kw: ['简单', '容易', '太难', '好难'], out: { action: 'modify', reply: '让它变简单点——星星更慢、角色接得更宽！', summary: '轻松模式', changes: [{ key: 'star_speed', value: 1.4 }] } },
    { kw: ['挑战', '刺激', '难一点'], out: { action: 'modify', reply: '增加挑战——星星更快、还多了炸弹星！', summary: '挑战模式', changes: [{ key: 'star_speed', value: 3.0 }] } },
    { kw: ['怪兽', '怪物', '坏蛋', '会飞'], out: { action: 'modify', reply: '好嘞！天上会掉小怪兽，碰到会扣命；我还让你能发射光弹打它，敢挑战吗？', summary: '怪兽+光弹', patch: { attack: true, entities: [{ id: 'monster', kind: 'bad', shape: 'text', text: '👾', size: 34, speed: 1.6, interval: 1200, score: 20, targetable: true, side: 'top' }] } } },
    { kw: ['攻击', '光弹', '发射', '打'], out: { action: 'modify', reply: '能攻击啦！点屏幕或按空格，发射光弹把坏蛋打掉！', summary: '攻击光弹', patch: { attack: true } } },
    { kw: ['护盾', '保护罩'], out: { action: 'modify', reply: '天上会掉护盾道具，吃到就有一层保护罩！', summary: '护盾道具', patch: { entities: [{ id: 'shield', kind: 'power', power: 'shield', shape: 'text', text: '🛡', size: 26, speed: 1.8, interval: 5000, side: 'top' }] } } },
    { kw: ['倒计时', '限时', '多少秒', '时长', '时间'], out: { action: 'modify', reply: '好，这局咱们限时 60 秒，时间到自动结算！', summary: '限时60秒', changes: [{ key: 'duration', value: 60 }] } },
  ];
  for (const r of R) {
    if (r.kw.some(k => t.includes(k))) return r.out;
  }
  return { action: 'ask', reply: '听起来很棒！你想让它更简单一点，还是更有挑战一点呀？', options: ['简单一点', '更有挑战', '你帮我想想'] };
}

// ---------- 调 DeepSeek ----------
function callDeepSeek(messages, hero, owner) {
  return new Promise((resolve, reject) => {
    const payload = {
      model: MODEL,
      messages: [
        { role: 'system', content: buildSystem(hero, owner) },
        ...messages,
      ],
      temperature: 0.3,
      max_tokens: 300,
      stream: false,
    };
    const body = JSON.stringify(payload);
    const req = https.request(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.error) return reject(new Error(j.error.message || 'API 错误'));
          const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          resolve(content || '');
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('超时')); });
    req.write(body);
    req.end();
  });
}

// ---------- /api/chat 处理 ----------
async function handleChat(res, body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const hero = body.hero || null;
  const owner = body.owner || '小朋友';
  const lastText = messages.length ? String(messages[messages.length - 1].content || '') : '';

  if (!lastText) return sendJSON(res, 200, { action: 'ask', reply: '你想给游戏加点什么呀？跟我说说吧～' });

  if (MOCK_MODE) {
    const out = sanitizeResult(mockChat(lastText));
    return sendJSON(res, 200, { ...out, mock: true });
  }

  try {
    const content = await callDeepSeek(messages, hero, owner);
    const out = sanitizeResult(extractJSON(content));
    return sendJSON(res, 200, out);
  } catch (e) {
    // 有 key 但真 AI 掉线：宁可不改，也绝不让本地引擎把"太快了"反着执行成"更快"。
    return sendJSON(res, 200, { action: 'ask', reply: '哎呀，我这边信号抖了一下，刚才没听清。你再跟我说一遍好吗？', fallback: true, note: String(e.message || e) });
  }
}

// ---------- 主服务器 ----------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && u.pathname === '/api/chat') {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(data || '{}'); } catch (e) { return sendJSON(res, 400, { error: 'bad json' }); }
      const ipKey = 'chat:' + (req.socket.remoteAddress || 'x');
      if (!rateAllowed(ipKey, 12, 60000)) {
        return sendJSON(res, 200, { action: 'ask', reply: '哎呀，我这边有点忙，稍等一下再跟我说好吗？', fallback: true, note: 'rate limited' });
      }
      handleChat(res, body);
    });
    return;
  }
  if (req.method === 'GET' && u.pathname === '/api/suggest') {
    const owner = String(u.searchParams.get('owner') || '').trim();
    const list = readSuggestions().filter(s => s.owner === owner).slice(-60).reverse();
    return sendJSON(res, 200, { ok: true, list });
  }
  if (req.method === 'POST' && u.pathname === '/api/suggest') {
    let sdata = '';
    req.on('data', c => { sdata += c; if (sdata.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(sdata || '{}'); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }
      const owner = String(body.owner || '').trim().slice(0, 20);
      const hero = String(body.hero || '').trim().slice(0, 20);
      const version = String(body.version || '').trim().slice(0, 30);
      const text = String(body.text || '').trim().slice(0, 200);
      if (!owner || !text) return sendJSON(res, 200, { ok: false, error: '缺少内容' });
      if (!rateAllowed('sg:' + owner, 6, 60000)) return sendJSON(res, 200, { ok: false, error: '太频繁啦，过一会儿再试' });
      const list = readSuggestions();
      list.push({ ts: Date.now(), owner: owner, hero: hero, version: version, text: text });
      writeSuggestions(list);
      return sendJSON(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/share') {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 2e6) req.destroy(); });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(b || '{}'); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }
      const payload = body.payload;
      if (!payload || typeof payload !== 'object') return sendJSON(res, 200, { ok: false, error: 'empty' });
      const clipped = clipSharePayload(payload);
      if (!clipped) return sendJSON(res, 200, { ok: false, error: 'bad payload' });
      const shares = readShares();
      let code = randCode();
      while (shares[code]) code = randCode();
      shares[code] = { ts: Date.now(), payload: clipped };
      const keys = Object.keys(shares);
      if (keys.length > 500) {
        keys.sort(function(a, b){ return (shares[a].ts || 0) - (shares[b].ts || 0); }).slice(0, keys.length - 500).forEach(function(k){ delete shares[k]; });
      }
      writeShares(shares);
      return sendJSON(res, 200, { ok: true, code: code });
    });
    return;
  }
  if (req.method === 'GET' && u.pathname.indexOf('/api/s/') === 0) {
    const code = decodeURIComponent(u.pathname.slice('/api/s/'.length));
    const hit = readShares()[code];
    if (!hit || !hit.payload) return sendJSON(res, 200, { ok: false, error: 'not found' });
    return sendJSON(res, 200, { ok: true, payload: hit.payload });
  }
  if (req.method === 'POST' && u.pathname === '/api/redeem') {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(b || '{}'); } catch (e) { return sendJSON(res, 400, { ok:false, error:'bad json' }); }
      const owner = String(body.owner || '').trim().slice(0, 20);
      const code = String(body.code || '').trim().slice(0, 20);
      if (!owner || !code) return sendJSON(res, 200, { ok:false, error:'empty' });
      const pts = teacherCodes[code];
      if (pts === undefined) return sendJSON(res, 200, { ok:false, error:'bad code' });
      const redeemed = readRedeemed();
      const list = Array.isArray(redeemed[owner]) ? redeemed[owner] : [];
      if (list.indexOf(code) >= 0) return sendJSON(res, 200, { ok:false, error:'used' });
      list.push(code);
      redeemed[owner] = list;
      writeRedeemed(redeemed);
      return sendJSON(res, 200, { ok:true, points: pts });
    });
    return;
  }
  if (req.method === 'GET' && u.pathname === '/api/health') {
    return sendJSON(res, 200, { ok: true, mock: MOCK_MODE, model: MODEL });
  }
  serveStatic(res, u.pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('==============================================');
  console.log('  AI 制作台服务已启动');
  console.log('  地址    : http://localhost:' + PORT + '/workshop_v1/');
  console.log('  制作台  : http://localhost:' + PORT + '/workbench_v1/');
  console.log('  模式    : ' + (MOCK_MODE ? '演示模式（未配置 key，用本地引擎模拟）' : 'DeepSeek 正式模式'));
  console.log('  模型    : ' + MODEL);
  console.log('  （配置 key：编辑 ai-config.json 或设环境变量 DEEPSEEK_API_KEY）');
  console.log('==============================================');
});
