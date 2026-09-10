/**
 * Editable v3 review diagrams and offline reading copies.
 * No running application or external document is modified by this script.
 * Usage: node build.mjs [path-to-cws-fe/apps/web/package.json]
 * Rendering dependencies are reused from the local frontend: sharp, React,
 * react-dom, react-markdown and remark-gfm. SVGs have no runtime dependencies.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const assetDir = path.join(root, '图片和附件');
const req = createRequire(process.argv[2] || '/Users/bobo/coco/cws-fe/apps/web/package.json');
const sharp = createRequire(req.resolve('next/package.json'))('sharp');
const React = req('react');
const { renderToStaticMarkup } = req('react-dom/server');
const { default: Markdown } = await import(pathToFileURL(req.resolve('react-markdown')));
const { default: remarkGfm } = await import(pathToFileURL(req.resolve('remark-gfm')));
const esc = (v) => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const palette = {
  user: { fill: '#EAF8F0', stroke: '#14845D' },
  cloud: { fill: '#EAF2FF', stroke: '#2461BC' },
  agent: { fill: '#F2ECFF', stroke: '#7250AC' },
  neutral: { fill: '#F2F5F9', stroke: '#697A91' },
  waiting: { fill: '#FFF4D9', stroke: '#B57A0C' },
};
const textWidth = (s, size) => [...String(s)].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 1 : .56) * size, 0);
function wrap(text, width, size) {
  const out = [];
  for (const line of String(text).split('\n')) {
    let s = '';
    for (const ch of line) {
      if (s && textWidth(s + ch, size) > width) { out.push(s); s = ''; }
      s += ch;
    }
    out.push(s);
  }
  return out;
}
class Canvas {
  constructor(w, h, title, subtitle) {
    this.w = w; this.h = h;
    this.parts = [`<rect width="${w}" height="${h}" fill="#FFFFFF"/>`];
    this.text(46, 57, title, 34, 'start', '#112749', 700);
    this.text(46, 97, subtitle, 20, 'start', '#586982');
  }
  rect(x, y, w, h, fill = '#F5F8FD', stroke = '#D8E3F0', radius = 14, extra = '') {
    this.parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="2" ${extra}/>`);
  }
  text(x, y, value, size = 20, anchor = 'start', fill = '#172F51', weight = 400) {
    const lines = Array.isArray(value) ? value : String(value).split('\n');
    this.parts.push(`<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${fill}" font-size="${size}" font-weight="${weight}">${lines.map((l, i) => `<tspan x="${x}" dy="${i ? size * 1.4 : 0}">${esc(l)}</tspan>`).join('')}</text>`);
  }
  line(x1, y1, x2, y2, color = '#316DBD', dashed = false, arrow = true) {
    this.parts.push(`<path d="M ${x1} ${y1} L ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="2.5" ${dashed ? 'stroke-dasharray="8 6"' : ''} ${arrow ? 'marker-end="url(#arrow)"' : ''}/>`);
  }
  box(x, y, w, h, lines, type = 'cloud', size = 20) {
    const c = palette[type]; this.rect(x, y, w, h, c.fill, c.stroke);
    const txt = Array.isArray(lines) ? lines : String(lines).split('\n');
    this.text(x + w / 2, y + h / 2 - (txt.length - 1) * size * .7 + size * .32, txt, size, 'middle', '#172F51', 600);
  }
  footer(y, text) {
    this.rect(35, y, this.w - 70, 64, '#F2F6FC', '#D8E3F0', 12);
    this.text(this.w / 2, y + 40, text, 20, 'middle', '#25446F', 600);
  }
  svg() {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.w}" height="${this.h}" viewBox="0 0 ${this.w} ${this.h}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#316DBD"/></marker></defs><g font-family="PingFang SC, Noto Sans CJK SC, Arial, sans-serif">${this.parts.join('')}</g></svg>`;
  }
}
function sequence(title, subtitle, actors, rows, footer, width = 1840) {
  const top = 242, bottom = 125;
  const height = top + rows.reduce((n, r) => n + (r.h || 91), 0) + bottom;
  const c = new Canvas(width, height, title, subtitle);
  const x = actors.map((_, i) => 155 + i * (width - 310) / (actors.length - 1));
  const actorW = Math.min(242, (width - 310) / (actors.length - 1) - 28);
  actors.forEach((a, i) => {
    c.box(x[i] - actorW / 2, 131, actorW, 78, [a[0], a[1]], a[2] || 'cloud', 18);
    c.line(x[i], 209, x[i], height - bottom, '#CBD6E4', true, false);
  });
  let y = top, loopStart, sharedArrowY;
  function message(from, to, label, returnValue = false) {
    if (from === to) {
      const lines = wrap(label, 300, 18);
      const center = Math.max(205, Math.min(width - 205, x[from]));
      c.rect(center - 148, y - 6, 296, 23 + 25 * lines.length, '#F7F1FF', '#AA90D1', 10);
      c.text(center, y + 18, lines, 18, 'middle', '#543C7B', 600);
      return;
    }
    const mid = (x[from] + x[to]) / 2;
    const lines = wrap(label, Math.min(540, Math.abs(x[from] - x[to]) - 25), 19);
    const labelW = Math.max(...lines.map(s => textWidth(s, 19))) + 20;
    const arrowY = sharedArrowY ?? (y + 13 + (lines.length - 1) * 26);
    const labelY = arrowY - 13 - (lines.length - 1) * 26;
    c.rect(mid - labelW / 2, labelY - 21, labelW, lines.length * 26, '#FFFFFF', 'none', 4);
    c.text(mid, labelY, lines, 19, 'middle', '#253F63', 500);
    c.line(x[from], arrowY, x[to], arrowY, returnValue ? '#6382A9' : '#316DBD', returnValue);
  }
  for (const r of rows) {
    if (r.kind === 'section') {
      c.rect(40, y - 14, width - 80, 45, '#EDF4FC', '#D5E2F1', 8);
      c.text(60, y + 16, r.label, 21, 'start', '#204F89', 700);
    } else if (r.kind === 'loop-start') {
      loopStart = y - 15;
      c.text(60, y + 13, r.label, 22, 'start', '#117A60', 700);
    } else if (r.kind === 'loop-end') {
      c.rect(38, loopStart, width - 76, y - loopStart + 13, 'none', '#168D70', 14, 'stroke-dasharray="9 5"');
      c.text(width - 60, y, '↺ 结果重新进入下一次决策', 19, 'end', '#117A60', 600);
    } else if (r.kind === 'note') {
      c.rect(50, y - 18, width - 100, 54, '#FFF6E5', '#E1C58D', 9);
      c.text(width / 2, y + 16, r.label, 19, 'middle', '#805C20', 500);
    } else if (r.kind === 'chain') {
      sharedArrowY = y + 13 + (Math.max(...r.edges.map(([a,b,label]) => wrap(label, Math.min(540, Math.abs(x[a] - x[b]) - 25), 19).length)) - 1) * 26;
      r.edges.forEach(a => message(...a));
      sharedArrowY = undefined;
    } else {
      message(r.from, r.to, r.label, r.returnValue);
    }
    y += r.h || 91;
  }
  c.footer(height - 91, footer);
  return c;
}
const m = (from, to, label, returnValue = false, h = 91) => ({ from, to, label, returnValue, h });
const section = label => ({ kind: 'section', label, h: 67 });
const note = label => ({ kind: 'note', label, h: 80 });
const chain = edges => ({ kind: 'chain', edges, h: 91 });
const figs = [];

// 01: rows intentionally repeat services to keep separate responsibilities legible.
{
  const c = new Canvas(1880, 1210, 'Browser Use · 具体服务如何协作', '目标方案 v3.0｜插件按用户登录；Agent 按能力开通；控制权按本次任务批准');
  const lanes = [
    { title: '① 插件登录和在线：没有 Agent 绑定', y: 144, boxes: [
      ['浏览器插件', 'zylos-browser-extension', 'user'], ['统一登录', 'Logto', 'cloud'],
      ['身份与 WS 票据', 'cws-core', 'cloud'], ['执行端在线', 'cws-comm', 'cloud']],
      labels: ['登录／注册', '验证用户身份', '票据验证'], note: '插件取得用户会话后，主动通过 WSS 连接 cws-comm。登录不授予网页控制权。' },
    { title: '② 应用连接开通：安装／启用 Agent 的 Browser Channel', y: 367, boxes: [
      ['应用连接', 'cws-fe', 'user'], ['权限入口', 'cws-core', 'cloud'], ['开通业务', 'cws-connect', 'cloud'],
      ['控制帧投递', 'cws-comm', 'cloud'], ['安装适配器', 'zylos-openmax', 'agent'],
      ['组件管理', 'zylos-core', 'agent'], ['Browser 工具', 'zylos-browser-channel', 'agent']],
      labels: ['选 Agent', '校验权限', '安装命令', '定向下发', '安装／启用', '启动／核验'], note: '安装结果：zylos-openmax → cws-core → cws-connect；收到健康回执才显示“已开通”。' },
    { title: '③ 私聊和任务授权：聊天走 Comm，授权真值在 Connect', y: 590, boxes: [
      ['私聊／授权卡', 'cws-fe', 'user'], ['身份与会话权限', 'cws-core', 'cloud'],
      ['消息传输', 'cws-comm', 'cloud'], ['C4 收发适配', 'zylos-openmax', 'agent'],
      ['C4 / SQLite / Agent', 'zylos-core', 'agent']],
      labels: ['发消息', '普通聊天', 'Agent 消息', '投递／回复'], note: '任务申请经 OpenMAX broker → cws-core → cws-connect；人类决定经 cws-fe → cws-core → cws-connect。' },
    { title: '④ 执行循环：不经过普通聊天队列', y: 813, boxes: [
      ['Agent 决策', 'zylos-core', 'agent'], ['CLI + agent-browser', 'zylos-browser-channel', 'agent'],
      ['任务定向中转', 'cws-comm', 'cloud'], ['浏览器插件', 'zylos-browser-extension', 'user'],
      ['本任务工作标签', 'Chrome', 'user']],
      labels: ['调用工具', 'WSS 执行帧', 'WSS 执行帧', 'chrome.debugger'], note: '命令向右、结果向左。Channel 与插件都主动连 Comm；Agent 不需要公网入站地址。' },
  ];
  for (const lane of lanes) {
    c.rect(28, lane.y, 1824, 206, '#F9FBFE', '#C6D7ED');
    c.text(48, lane.y + 35, lane.title, 25, 'start', '#153C70', 700);
    if (lane === lanes[0]) {
      // Three independent calls by the extension, not Logto -> Core -> Comm.
      [['Logto','统一登录','登录'],['cws-core','身份／WS 票据','取票据'],['cws-comm','Browser 执行端','出站 WSS']].forEach(([service,role,label],i)=>{
        const left=48+i*599;
        c.box(left,lane.y+76,184,67,['浏览器插件','同一用户会话'],'user',17);
        c.box(left+305,lane.y+76,272,67,[service,role],'cloud',18);
        c.line(left+184,lane.y+111,left+305,lane.y+111);
        c.text(left+245,lane.y+98,label,17,'middle','#426386');
      });
      c.text(50,lane.y+181,'同一个插件分别调用三个服务。Comm 还会向 Core 验证票据；登录不授予网页控制权。',19,'start','#48617F');
      continue;
    }
    const n = lane.boxes.length, boxW = n === 7 ? 218 : 266;
    const start = 48, space = (1784 - n * boxW) / (n - 1);
    lane.boxes.forEach((b, i) => {
      const x = start + i * (boxW + space);
      c.box(x, lane.y + 66, boxW, 77, b.slice(0, 2), b[2], n === 7 ? 16 : 18);
      if (i < n - 1) {
        c.line(x + boxW, lane.y + 111, x + boxW + space, lane.y + 111);
        // Protocol labels are intentionally above arrows, not over service names.
        c.text(x + boxW + space / 2, lane.y + 61, lane.labels[i], n === 7 ? 15 : 18, 'middle', '#426386');
      }
    });
    c.text(50, lane.y + 181, lane.note, 19, 'start', '#48617F');
  }
  c.text(49, 1062, '绿色：用户电脑　　蓝色：平台服务　　紫色：Agent 所在机器（可只有内网地址）', 20, 'start', '#345370', 600);
  c.footer(1093, 'cws-comm 是通信服务；Common 是共享代码／协议。cws-agent-manager 不在本次安装和执行主链上。');
  figs.push(['01-service-overview', c]);
}

figs.push(['02-user-login', sequence('① 插件登录：只登记用户在线，不绑定 Agent', '同一 OpenMAX 账号体系；插件拥有自己的登录会话。以下 Browser 入口为目标扩展。', [
  ['浏览器插件', '用户电脑', 'user'], ['Logto', '统一登录'], ['cws-core', '身份 / 票据'], ['cws-comm', 'Browser 执行端'],
], [
  section('A. 用户登录（已有 SSO 会话可复用，无须重复输入密码）'),
  m(0, 1, '公开客户端登录\n授权码 + PKCE'), m(1, 0, '返回插件用户会话', true),
  m(0, 2, 'onboard／识别平台用户'), m(2, 0, '确认平台 identity', true),
  section('B. 插件后台连接 Comm'),
  m(0, 2, '申请 Browser 用途 WS 票据'), m(2, 0, '短期建连票据', true),
  m(0, 3, '主动建立 WSS 连接'), m(3, 2, '消费票据／验证用途'),
  m(2, 3, '确认用户身份', true), m(3, 0, '执行端在线：endpoint + epoch', true),
  note('后台心跳与重连；没有任务时，不创建标签、不附加调试、不读取网页。'),
], '登录回答“你是谁”；不是回答“哪个 Agent 可以控制浏览器”。', 1660)]);

figs.push(['03-agent-enable', sequence('② Connector 开通：把 Browser 能力装到 Agent', '沿用实际 Channel 命令路径；不需要把某个浏览器绑定给 Agent。', [
  ['cws-fe', '应用连接', 'user'], ['cws-core', 'Agent 管理权限'], ['cws-connect', '能力状态'], ['cws-comm', '控制帧'],
  ['zylos-openmax', '确定性安装器', 'agent'], ['zylos-core', '组件管理', 'agent'], ['Browser Channel', '工具服务', 'agent'],
], [
  m(0, 1, '选择 Agent\n点击连接'), m(1, 2, '验证管理权\n请求开通'), m(2, 2, '保存“开通中”及 request ID'),
  m(2, 3, 'channel.connect\nbrowser 类型'), m(3, 4, 'Agent 已有连接\n投递控制命令'),
  m(4, 5, '受控安装／启用'), m(5, 6, '启动固定组件'),
  m(4, 6, '检查 CLI／服务／版本'), m(6, 4, '健康检查结果', true),
  m(4, 1, '按 request ID 回报安装结果', true), m(1, 2, '保存成功／失败'),
  note('cws-fe 经 Core 查询 Connect 的最新状态；只有成功回执才显示“已开通”。'),
], 'Browser Channel = zylos-browser-channel；本流程不开网页，也不授予任何任务操作权。')]);

figs.push(['04-request-and-preconnect', sequence('③ 提出浏览器需求：显示卡片，同时预连接', '普通聊天负责把需求送到 Agent；cws-connect 保存待授权任务。', [
  ['cws-fe', '私聊界面', 'user'], ['cws-core', '可信业务入口'], ['cws-comm', '聊天 / 任务通知'],
  ['zylos-openmax', 'C4 / 来源 broker', 'agent'], ['zylos-core', 'C4 / SQLite / Agent', 'agent'],
  ['Browser Channel', 'CLI / 预连接', 'agent'], ['cws-connect', '任务授权真值'],
], [
  section('A. “帮我打开 1688，搜索儿童玩具”'),
  chain([[0,1,'发送私聊'],[1,2,'保存／投递'],[2,3,'Agent 消息'],[3,4,'进入 C4']]),
  m(4, 5, '需要 Browser\n调用申请工具'),
  section('B. 创建待授权任务；不信任模型自填用户身份'),
  m(5, 3, '私有 broker：携带真实消息 context'),
  m(3, 1, '以 Agent 身份申请，携带来源句柄'),
  m(1, 6, '验证本人／会话／Agent 能力，创建任务'),
  m(6, 6, 'awaiting_consent\n暂不指定浏览器'),
  m(6, 2, '可靠事件：授权卡片'), m(2, 0, '原用户／原会话显示卡片'),
  section('C. 等待用户时建立中转连接，减少点允许后的等待'),
  m(5, 2, '经 Core / Connect 核验的任务级预连接'),
  note('预连接只有心跳与状态权限；不能发送 CDP、获取截图或创建工作标签。'),
], 'Browser Channel = zylos-browser-channel；卡片不代表已授权，模型文本不能替代人类批准。')]);

figs.push(['05-consent-and-ready', sequence('④ 聊天里点一次“允许”：平台确认后插件接单', '网页只核对当前插件，不直接让 background 开工；不需要再打开 Popup 授权。', [
  ['cws-fe', '聊天授权卡', 'user'], ['cws-core', '本人 / 会话权限'], ['cws-connect', '决定 / 状态 / outbox'],
  ['cws-comm', '在线执行端 / 路由'], ['浏览器插件', '当前 profile', 'user'],
], [
  section('A. 自动核对当前浏览器；未安装、离线或账号不一致就在卡片提示'),
  m(0, 4, '点击允许 → 只读核对当前插件'), m(4, 3, '已认证连接\n申请本次确认'),
  m(3, 4, '短期当前会话确认', true), m(4, 0, '返回确认，不返回登录 token', true),
  section('B. 人类决定只提交给 Core → Connect'),
  m(0, 1, '批准 task\n附本次确认'), m(1, 2, '校验本人\n转交决定'),
  m(2, 3, '验证确认\n短期预占执行端'), m(3, 2, '同一执行端\n无其他任务', true),
  m(2, 2, '同一事务：preparing\n决定回执 + outbox'),
  section('C. 可靠通知与 Ready；失败按任务记录对账'),
  chain([[2,3,'提交预占\n投递 prepare'],[3,4,'仅通知该执行端']]),
  m(4, 4, '保存任务上下文；此时仍不建页'),
  chain([[4,3,'Ready + 应用 ACK',true],[3,2,'核验目标／版本',true]]),
  m(2, 2, 'running；发布激活事件'),
  note('激活：Connect → Comm → zylos-openmax → C4 / SQLite → Agent；状态同时更新聊天卡片。'),
], '短期确认是后台安全参数，不是新配对码。首条具体网址到达，才创建工作页。', 1800)]);

figs.push(['06-execution-loop', sequence('⑤ 执行不是一串预写动作，而是持续观察与决策', '仅画工具主链；任务授权由 Connect 管，点击与截图不绕普通聊天队列。', [
  ['zylos-core', 'Agent 决策', 'agent'], ['Browser Channel', 'CLI + agent-browser', 'agent'],
  ['cws-comm', '任务定向中转'], ['浏览器插件', 'chrome.debugger', 'user'], ['Chrome', '本任务工作标签', 'user'],
], [
  section('A. 首次打开具体网址（此前没有 about:blank 工作页）'),
  chain([[0,1,'打开具体 URL'],[1,2,'任务建页命令'],[2,3,'定向投递'],[3,4,'相邻位置建页']]),
  chain([[4,3,'目标页已创建',true],[3,2,'返回 task target',true],[2,1,'返回结果',true],[1,0,'可以观察页面',true]]),
  {kind:'loop-start', label:'循环：直到任务完成，或需要用户处理', h:66},
  chain([[0,1,'观察页面'],[1,2,'CDP 读取／截图'],[2,3,'转发命令'],[3,4,'读取本任务页']]),
  chain([[4,3,'页面状态',true],[3,2,'状态／截图',true],[2,1,'原路返回',true],[1,0,'供模型实际查看',true]]),
  m(0,0,'根据本次观察决定下一步'),
  chain([[0,1,'选择下一动作'],[1,2,'CDP 点击／输入'],[2,3,'检查任务路由'],[3,4,'执行真实事件']]),
  chain([[4,3,'动作结果',true],[3,2,'执行结果',true],[2,1,'原路返回',true],[1,0,'检查后再观察',true]]),
  {kind:'loop-end', h:55},
  note('需要登录：Connect 置 waiting_user，插件解除调试并保留页；在对话明确继续后，回到上方循环。'),
  section('B. 任务完成／停止时：收尾后再给最终答案'),
  note('Channel → OpenMAX broker → cws-core → cws-connect：进入 finalizing，禁止新的普通操作。'),
  chain([[1,2,'任务清理'],[2,3,'仅允许收尾'],[3,4,'关临时页／解绑']]),
  chain([[4,3,'清理结果',true],[3,2,'应用回执',true],[2,1,'收尾结果',true],[1,0,'确认后回复',true]]),
  note('清理结果同步 Connect；最终文字：Agent → C4 → OpenMAX → cws-core → cws-comm → cws-fe。'),
], 'Browser Channel = zylos-browser-channel；需要登录则暂停，不能把“等待用户”当成最终完成。', 1800)]);

// 07: abstract browser chrome, not a flowchart of backend states.
{
  const c = new Canvas(1680, 1610, '⑥ 浏览器里会发生什么：你的页面不动', '示意中的颜色仅用于区分状态；任务结束不保留“已完成／已停止”分组。');
  function tab(x,y,w,label,color='#FFFFFF') {
    c.rect(x,y,w,43,color,'#C5CFDD',9); c.text(x+13,y+28,label,17,'start','#33445C'); c.text(x+w-18,y+28,'×',18,'middle','#8694A6');
  }
  function browser(y,title,group,taskTabs,mode,caption) {
    c.text(49,y,title,25,'start','#153C70',700);
    const by=y+21; c.rect(44,by,1592,165,'#FFFFFF','#CCD8E7',14);
    c.rect(45,by+1,1590,77,'#F0F3F8','none',13);
    [69,91,113].forEach((x,i)=>c.parts.push(`<circle cx="${x}" cy="${by+23}" r="6" fill="${['#E99692','#E5CB85','#91C6AC'][i]}"/>`));
    tab(143,by+17,185,'我的邮箱'); tab(337,by+17,190,'OpenMAX 对话');
    if(group){
      const p=palette[mode]; const gx=558, gw=235+taskTabs.length*218;
      c.rect(gx,by+10,gw,58,p.fill,p.stroke,10);
      c.rect(gx+8,by+19,204,39,p.stroke,'none',7);
      c.text(gx+110,by+45,group,18,'middle','#FFFFFF',600);
      taskTabs.forEach((t,i)=>tab(gx+224+i*218,by+18,207,t,p.fill));
    }else taskTabs.forEach((t,i)=>tab(558+i*218,by+17,207,t));
    c.text(72,by+118,caption,22,'start','#41607E');
  }
  browser(150,'1. 已登录／尚未执行',null,[],'user','没有工作标签，没有调试；插件只在后台在线。');
  browser(411,'2. 点击允许后，首条网址到达 → 开始工作','Agent · 工作中',['搜索页','详情页'],'user','只操作彩色组中的任务页面；你切去邮箱，不会改变 Agent 的目标。');
  browser(672,'3. 如果需要你登录 → 暂停','等待继续',['登录页'],'waiting','解除调试和光标；你处理完后，在 OpenMAX 对话里点“继续”。');
  browser(933,'4A. 结束／停止 → 清理临时页',null,[],'user','任务临时页关闭，空组消失；你原来的页面保留。');
  browser(1194,'4B. 如果明确要求保留结果 → 交还普通标签',null,['结果页'],'user','结果页退出 Agent 分组，不再受控；临时页照常清理。');
  c.footer(1500,'不确定归属的页面不强删；等待超时也要收尾。任务记录保留在聊天里，不靠标签组留历史。');
  figs.push(['07-tab-lifecycle',c]);
}

await fs.mkdir(assetDir,{recursive:true});
for(const [name,c] of figs){
  const svg=c.svg();
  await fs.writeFile(path.join(assetDir,`${name}.svg`),svg);
  await sharp(Buffer.from(svg),{density:96}).png().toFile(path.join(assetDir,`${name}.png`));
  console.log(`${name}: ${c.w} × ${c.h}`);
}

const style=`:root{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#24364d;background:#f3f6fb}body{margin:0}main{max-width:1120px;margin:32px auto;padding:44px 56px;background:white;border-radius:16px;box-shadow:0 5px 30px #24364d0b}h1{font-size:32px;color:#142c50}h2{margin-top:48px;padding-top:24px;border-top:1px solid #dce4ee;color:#164c85}h3{margin-top:28px}p,li{line-height:1.9}li{margin:7px 0}table{border-collapse:collapse;width:100%;font-size:14px;line-height:1.7;margin:22px 0}th,td{border:1px solid #dae3ee;padding:11px 13px;vertical-align:top}th{background:#edf4fd;text-align:left}code{font-size:.91em;background:#f0f3f8;border-radius:4px;padding:2px 4px}a{color:#1266ab}img{width:100%;height:auto;border:1px solid #e2e9f2;border-radius:10px;margin:12px 0;cursor:zoom-in}nav{font-size:14px;color:#627890;margin-bottom:28px}small{color:#61748d}@media(max-width:760px){main{margin:0;padding:22px 18px;border-radius:0}table{display:block;overflow-x:auto}h1{font-size:26px}}@media print{main{max-width:none;margin:0;padding:0;box-shadow:none}img{break-inside:avoid}h2,h3{break-after:avoid}a{color:inherit}nav{display:none}body{background:white}}`;
for(const [src,out,title] of [['review-design.md','review-design.html','Browser Use · 用户态简化版评审'],['implementation-design.md','implementation-design.html','Browser Use · 实施设计']]){
  const md=await fs.readFile(path.join(root,src),'utf8');
  const components={
    img:({node,...p})=>React.createElement('a',{href:p.src,target:'_blank',rel:'noopener'},React.createElement('img',p)),
    a:({node,...p})=>React.createElement('a',{...p,href:p.href?.replace(/^review-design\.md$/,'review-design.html').replace(/^implementation-design\.md$/,'implementation-design.html')}),
  };
  const body=renderToStaticMarkup(React.createElement(Markdown,{remarkPlugins:[remarkGfm],components},md));
  const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${style}</style></head><body><main><nav><a href="review-design.html">评审稿</a> · <a href="implementation-design.html">实施设计</a> · 图可点击放大 / SVG 可编辑 · v3.0 目标方案</nav>${body}</main></body></html>`;
  await fs.writeFile(path.join(root,out),html);
}
console.log('Rendered review-design.html and implementation-design.html.');
