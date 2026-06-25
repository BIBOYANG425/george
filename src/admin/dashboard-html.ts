// src/admin/dashboard-html.ts
// Self-contained single-page admin dashboard. No build step, no external deps —
// inline CSS + vanilla JS + hand-rolled SVG charts, so it renders offline and
// can be served as one string. Talks to /admin/api/* with the admin token
// (read from ?token= once, then kept in localStorage).

export function renderDashboardHtml(): string {
  return String.raw`<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>George · Admin Dashboard</title>
<style>
  :root{
    --bg:#0b0e14; --panel:#141a24; --panel2:#0f141c; --border:#232c3a;
    --txt:#e6edf3; --muted:#8b96a5; --faint:#5b6675;
    --accent:#6366f1; --accent2:#22d3ee; --good:#34d399; --warn:#fbbf24; --bad:#f87171;
    --user:#22d3ee; --george:#a78bfa;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{background:var(--bg);color:var(--txt);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
  a{color:var(--accent2);text-decoration:none}
  .wrap{max-width:1280px;margin:0 auto;padding:0 20px}
  /* header */
  header{position:sticky;top:0;z-index:20;background:rgba(11,14,20,.82);backdrop-filter:blur(8px);border-bottom:1px solid var(--border)}
  .head{display:flex;align-items:center;gap:14px;height:58px}
  .logo{font-weight:700;font-size:16px;letter-spacing:.2px;display:flex;align-items:center;gap:9px}
  .logo .g{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:grid;place-items:center;color:#08101e;font-weight:800}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--good);box-shadow:0 0 0 0 rgba(52,211,153,.6);animation:pulse 2s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,.5)}70%{box-shadow:0 0 0 7px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}
  .spacer{flex:1}
  .meta{color:var(--muted);font-size:12px;display:flex;align-items:center;gap:8px}
  .btn{background:var(--panel);border:1px solid var(--border);color:var(--txt);padding:6px 12px;border-radius:8px;cursor:pointer;font-size:13px}
  .btn:hover{border-color:var(--accent)}
  .btn.sm{padding:3px 9px;font-size:12px}
  .btn.on{background:var(--accent);border-color:var(--accent);color:#fff}
  /* tabs */
  .tabs{display:flex;gap:4px;height:46px;align-items:flex-end}
  .tab{padding:10px 16px;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;font-weight:500}
  .tab.active{color:var(--txt);border-bottom-color:var(--accent)}
  .tab:hover{color:var(--txt)}
  /* layout */
  main{padding:22px 0 80px}
  .grid{display:grid;gap:14px}
  .cards{grid-template-columns:repeat(4,1fr)}
  @media(max-width:900px){.cards{grid-template-columns:repeat(2,1fr)}}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:16px}
  .card .k{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.4px}
  .card .v{font-size:28px;font-weight:700;margin-top:6px;letter-spacing:-.5px}
  .card .s{color:var(--faint);font-size:12px;margin-top:2px}
  .v.accent{color:var(--accent2)} .v.good{color:var(--good)} .v.warn{color:var(--warn)}
  .panel{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:18px;margin-top:14px}
  .panel h3{margin:0 0 14px;font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px}
  .panel h3 .tag{color:var(--faint);font-weight:400;font-size:12px}
  .row2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:840px){.row2{grid-template-columns:1fr}}
  /* bars */
  .bars{display:flex;flex-direction:column;gap:9px}
  .bar{display:grid;grid-template-columns:130px 1fr 46px;align-items:center;gap:10px;font-size:13px}
  .bar .lbl{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bar .track{height:9px;background:var(--panel2);border-radius:6px;overflow:hidden}
  .bar .fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:6px}
  .bar .n{text-align:right;color:var(--txt);font-variant-numeric:tabular-nums}
  /* feed */
  .feed{display:flex;flex-direction:column;gap:8px}
  .msg{display:flex;gap:11px;padding:11px 13px;border:1px solid var(--border);border-radius:12px;background:var(--panel2)}
  .msg.user{border-left:3px solid var(--user)}
  .msg.assistant{border-left:3px solid var(--george)}
  .msg .av{width:30px;height:30px;border-radius:9px;flex:none;display:grid;place-items:center;font-size:12px;font-weight:700}
  .msg.user .av{background:rgba(34,211,238,.14);color:var(--user)}
  .msg.assistant .av{background:rgba(167,139,250,.14);color:var(--george)}
  .msg .body{flex:1;min-width:0}
  .msg .top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:3px}
  .msg .id{font-weight:600;font-size:12px}
  .msg .content{color:var(--txt);word-break:break-word;white-space:pre-wrap}
  .msg.user .content{color:#fff}
  .badge{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--border);color:var(--muted);white-space:nowrap}
  .badge.agent{color:var(--accent2);border-color:rgba(34,211,238,.3)}
  .badge.ch{color:var(--warn);border-color:rgba(251,191,36,.25)}
  .badge.cost{color:var(--good);border-color:rgba(52,211,153,.25)}
  .time{color:var(--faint);font-size:11px;font-variant-numeric:tabular-nums}
  /* table */
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--border);font-size:13px}
  th{color:var(--muted);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.3px}
  tbody tr:hover{background:var(--panel2)}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  .pill{font-size:11px;padding:2px 8px;border-radius:999px}
  .pill.paused{background:rgba(248,113,113,.14);color:var(--bad)}
  .pill.live{background:rgba(52,211,153,.14);color:var(--good)}
  .pill.none{background:var(--panel2);color:var(--faint)}
  /* drawer */
  .scrim{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:40;display:none}
  .scrim.open{display:block}
  .drawer{position:fixed;top:0;right:0;height:100%;width:min(720px,92vw);background:var(--bg);border-left:1px solid var(--border);z-index:50;transform:translateX(100%);transition:transform .22s ease;overflow-y:auto}
  .drawer.open{transform:none}
  .drawer .dhead{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--border);padding:16px 20px;display:flex;align-items:center;gap:12px}
  .drawer .dbody{padding:18px 20px}
  .blocks{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  @media(max-width:600px){.blocks{grid-template-columns:1fr}}
  .block{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:11px}
  .block .bk{color:var(--accent2);font-size:11px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px}
  .block .bv{color:var(--txt);white-space:pre-wrap;font-size:13px;min-height:18px;color:var(--muted)}
  .convo{display:flex;flex-direction:column;gap:7px;margin-top:8px}
  /* observations (read-only) */
  .obs{display:flex;flex-direction:column;gap:7px;margin-top:8px}
  .obs .o{display:flex;gap:10px;align-items:flex-start;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:9px 11px}
  .obs .sal{flex:0 0 auto;font-size:11px;font-weight:600;border-radius:6px;padding:2px 7px;border:1px solid var(--border);color:var(--muted)}
  .obs .sal.hi{color:var(--warn);border-color:rgba(251,191,36,.4)}
  .obs .otext{flex:1;font-size:13px;color:var(--txt);white-space:pre-wrap}
  .obs .ometa{color:var(--faint);font-size:11px;margin-top:3px;display:flex;gap:8px;flex-wrap:wrap}
  /* login */
  .login{max-width:420px;margin:14vh auto;background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:26px}
  .login h2{margin:0 0 6px} .login p{color:var(--muted);margin:0 0 16px;font-size:13px}
  .login input{width:100%;padding:11px 13px;border-radius:10px;border:1px solid var(--border);background:var(--panel2);color:var(--txt);font-size:14px}
  .login .btn{width:100%;margin-top:12px;justify-content:center;padding:11px}
  .empty{color:var(--faint);text-align:center;padding:30px}
  .err{color:var(--bad);font-size:12px;margin-top:8px}
  .note{font-size:12px;color:var(--muted);background:var(--panel2);border:1px dashed var(--border);border-radius:10px;padding:10px 12px;margin-top:12px}
  .hide{display:none!important}
  .skel{color:var(--faint)}
  /* controls */
  .ctrl-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media(max-width:600px){.ctrl-grid{grid-template-columns:1fr}}
  .ctrl-grid label{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--muted)}
  .ctrl-grid label.ck{flex-direction:row;align-items:center;gap:8px;grid-column:1/-1;color:var(--txt);font-size:13px}
  .ctrl-grid label.fb{grid-column:1/-1}
  .ctrl-grid select,.ctrl-grid input,.ctrl-grid textarea{padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--panel2);color:var(--txt);font-size:13px;font-family:inherit;resize:vertical}
  .ctrl-grid input[type=checkbox]{width:16px;height:16px;padding:0}
  .ctrl-foot{display:flex;align-items:center;justify-content:space-between;margin-top:14px;gap:10px}
  .ctrl-foot .usage{color:var(--muted);font-size:12px}
  .badge.block{color:var(--bad);border-color:rgba(248,113,113,.35)}
  .badge.model{color:var(--george);border-color:rgba(167,139,250,.35)}
  .badge.lim{color:var(--warn);border-color:rgba(251,191,36,.3)}
  /* flag button + review */
  .btn.sm.flag{padding:2px 7px;border-color:transparent;opacity:.55}
  .btn.sm.flag:hover{opacity:1;border-color:var(--bad)}
  .btn.sm.flag.flagged{opacity:1;color:var(--bad);border-color:rgba(248,113,113,.4)}
  .rev{display:flex;flex-direction:column;gap:8px;margin-top:8px}
  .rev .r{border:1px solid var(--border);border-radius:10px;padding:10px 12px;background:var(--panel2)}
  .rev .r .rtop{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-bottom:4px}
  .rev .r .rtext{font-size:13px;color:var(--txt);white-space:pre-wrap}
  .sig{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid rgba(251,191,36,.35);color:var(--warn)}
  .sig.danger{color:var(--bad);border-color:rgba(248,113,113,.5)}
  /* crisis radar */
  .panel.crisis{border-left:4px solid var(--border)}
  .panel.crisis.hit{border-left-color:var(--bad);background:color-mix(in srgb,var(--bad) 6%,var(--panel))}
  .panel.crisis.ok{border-left-color:var(--good)}
  .panel.crisis.off{border-left-color:var(--faint)}
  .r.crisisrow{border-color:rgba(248,113,113,.35)}
  .tabbadge{display:inline-grid;place-items:center;min-width:17px;height:17px;padding:0 4px;margin-left:6px;border-radius:999px;background:var(--bad);color:#fff;font-size:11px;font-weight:700;vertical-align:middle}
</style>
</head>
<body>
<div id="app"></div>

<!-- login -->
<div id="login" class="hide">
  <div class="login">
    <h2>George 后台</h2>
    <p>输入 Admin Token 进入 dashboard（仅本机/管理员）。</p>
    <input id="tok" type="password" placeholder="ADMIN_TOKEN" autocomplete="off" />
    <button class="btn" onclick="doLogin()">进入</button>
    <div id="loginErr" class="err"></div>
  </div>
</div>

<!-- shell -->
<div id="shell" class="hide">
  <header>
    <div class="wrap">
      <div class="head">
        <div class="logo"><span class="g">G</span> George · Admin</div>
        <span class="dot" title="live"></span>
        <div class="spacer"></div>
        <div class="meta"><span id="clock"></span><span>·</span><span id="updated">—</span></div>
        <button id="autoBtn" class="btn sm on" onclick="toggleAuto()">自动刷新 ON</button>
        <button class="btn sm" onclick="refresh()">刷新</button>
        <button class="btn sm" onclick="logout()">退出</button>
      </div>
      <div class="tabs">
        <div class="tab active" data-tab="overview" onclick="setTab('overview')">概览</div>
        <div class="tab" data-tab="live" onclick="setTab('live')">实时</div>
        <div class="tab" data-tab="users" onclick="setTab('users')">用户</div>
        <div class="tab" data-tab="review" onclick="setTab('review')">复盘</div>
        <div class="tab" data-tab="system" onclick="setTab('system')">系统</div>
      </div>
    </div>
  </header>
  <main><div class="wrap">
    <section id="overview"></section>
    <section id="live" class="hide"></section>
    <section id="users" class="hide"></section>
    <section id="review" class="hide"></section>
    <section id="system" class="hide"></section>
  </div></main>
</div>

<!-- drawer -->
<div id="scrim" class="scrim" onclick="closeDrawer()"></div>
<div id="drawer" class="drawer">
  <div class="dhead">
    <strong id="drawerTitle">用户</strong>
    <div class="spacer" style="flex:1"></div>
    <button class="btn sm" id="hbBtn" onclick="toggleHb()"></button>
    <button class="btn sm" onclick="closeDrawer()">关闭</button>
  </div>
  <div class="dbody" id="drawerBody"></div>
</div>

<script>
const API='/admin/api';
let TOKEN=null, TAB='overview', auto=true, timer=null, liveTimer=null, curUser=null, curUserPaused=null;

// ── token / boot ──
function boot(){
  const u=new URL(location.href); const q=u.searchParams.get('token'); const view=u.searchParams.get('view');
  if(q){ localStorage.setItem('george_admin_token',q); u.searchParams.delete('token'); history.replaceState({},'',u.toString()); }
  TOKEN=localStorage.getItem('george_admin_token');
  if(!TOKEN){ show('login'); return; }
  show('shell'); startClock();
  if(['overview','live','users','review','system'].includes(view)){ setTab(view); } else { refresh(); }
  scheduleAuto();
  refreshCrisisBadge(); // surface the crisis badge without opening 复盘
  const wantUser=u.searchParams.get('user'); if(wantUser){ setTimeout(()=>openUser(wantUser),300); }
}
function show(id){ for(const x of ['login','shell']) document.getElementById(x).classList.toggle('hide',x!==id); }
function doLogin(){ const v=document.getElementById('tok').value.trim(); if(!v) return; localStorage.setItem('george_admin_token',v); TOKEN=v; document.getElementById('loginErr').textContent=''; show('shell'); startClock(); refresh(); scheduleAuto(); }
function logout(){ localStorage.removeItem('george_admin_token'); TOKEN=null; clearInterval(timer); clearInterval(liveTimer); show('login'); }

async function api(path,opts){
  const r=await fetch(API+path,{...opts,headers:{'Authorization':'Bearer '+TOKEN,...(opts&&opts.headers)}});
  if(r.status===401){ logout(); throw new Error('unauthorized'); }
  if(!r.ok) throw new Error('http '+r.status);
  return r.json();
}

// ── clock / auto-refresh ──
function startClock(){ const t=()=>{document.getElementById('clock').textContent=new Date().toLocaleTimeString('zh-CN')}; t(); setInterval(t,1000); }
function scheduleAuto(){ clearInterval(timer); if(auto) timer=setInterval(()=>{ if(TAB!=='live') refresh(true); },15000); scheduleLive(); }
function scheduleLive(){ clearInterval(liveTimer); if(auto&&TAB==='live') liveTimer=setInterval(()=>loadLive(true),5000); }
function toggleAuto(){ auto=!auto; const b=document.getElementById('autoBtn'); b.classList.toggle('on',auto); b.textContent='自动刷新 '+(auto?'ON':'OFF'); scheduleAuto(); }
function stamp(){ document.getElementById('updated').textContent='更新于 '+new Date().toLocaleTimeString('zh-CN'); }

function setTab(t){
  TAB=t;
  for(const el of document.querySelectorAll('.tab')) el.classList.toggle('active',el.dataset.tab===t);
  for(const id of ['overview','live','users','review','system']) document.getElementById(id).classList.toggle('hide',id!==t);
  refresh(); scheduleLive();
}
function refresh(silent){
  if(TAB==='overview') loadOverview();
  else if(TAB==='live') loadLive();
  else if(TAB==='users') loadUsers();
  else if(TAB==='review') loadReview();
  else if(TAB==='system') loadSystem();
  if(!silent) stamp(); else stamp();
}

// ── helpers ──
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt=n=>n==null?'—':Number(n).toLocaleString('en-US');
const money=n=>n==null?'—':'$'+Number(n).toFixed(n<1?4:2);
function ago(iso){ if(!iso) return '—'; const s=(Date.now()-new Date(iso))/1000; if(s<60)return Math.floor(s)+'s'; if(s<3600)return Math.floor(s/60)+'m'; if(s<86400)return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d'; }
function hm(iso){ return iso? new Date(iso).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—'; }
function barList(items,max){ if(!items||!items.length) return '<div class="empty">暂无数据</div>'; const m=max||Math.max(...items.map(i=>i.count),1); return '<div class="bars">'+items.map(i=>'<div class="bar"><span class="lbl" title="'+esc(i.label)+'">'+esc(i.label)+'</span><span class="track"><span class="fill" style="width:'+Math.max(3,Math.round(i.count/m*100))+'%"></span></span><span class="n">'+fmt(i.count)+'</span></div>').join('')+'</div>'; }

// ── OVERVIEW ──
async function loadOverview(){
  const sec=document.getElementById('overview');
  try{
    const [o,ts,dist,growth]=await Promise.all([api('/overview'),api('/timeseries?days=14'),api('/distributions'),api('/growth').catch(()=>null)]);
    const cov=o.telemetry.coveragePct;
    sec.innerHTML=
      '<div class="grid cards">'
      +card('今日消息',fmt(o.today.messages),'共 '+fmt(o.totals.messages)+' 条')
      +card('今日提问',fmt(o.today.questions),'用户主动消息','accent')
      +card('今日活跃用户',fmt(o.today.activeUsers),'7日 '+fmt(o.totals.activeUsers7d)+' 人')
      +card('今日成本',money(o.today.costUsd),fmt(o.today.tokens)+' tokens','good')
      +'</div>'
      +'<div class="grid cards" style="margin-top:14px">'
      +card('总学生',fmt(o.totals.students))
      +card('活动 Events',fmt(o.totals.activeEvents)+' / '+fmt(o.totals.events),'active / 总')
      +card('Heartbeat 日志',fmt(o.totals.heartbeats),'proactive '+fmt(o.totals.proactiveSent))
      +'</div>'
      +renderGrowth(growth)
      +'<div class="panel"><h3>消息量趋势 <span class="tag">近 14 天 · 用户 vs George</span></h3>'+lineChart(ts)+'</div>'
      +'<div class="row2">'
        +'<div class="panel"><h3>工具使用分布 <span class="tag">每轮调用的 george 工具 · single-agent 也适用</span></h3>'+((dist.tools&&dist.tools.length)?barList(dist.tools):'<div class="empty">工具数据从新对话开始采集（telemetry）</div>')+'</div>'
        +'<div class="panel"><h3>渠道分布 <span class="tag">channel</span></h3>'+(dist.channels.length?barList(dist.channels):'<div class="empty">渠道数据从新对话开始采集</div>')+'</div>'
      +'</div>'
      +(cov<100?'<div class="note">📊 Telemetry 覆盖率 '+cov+'%（'+fmt(o.telemetry.messagesWithTokens)+'/'+fmt(o.totals.messages)+' 条带 token）。历史消息无 token/cost（reactive 路径此前丢弃了 SDK usage）；新对话开始已逐条采集。</div>':'');
    stamp();
  }catch(e){ sec.innerHTML='<div class="empty">加载失败：'+esc(e.message)+'</div>'; }
}
// Growth: onboarding funnel (counts + stuck-pending backlog) + retention (at-risk).
// Downgraded — no time-to-complete funnel (pending_users has no completed_at).
function renderGrowth(g){
  if(!g) return '';
  const ob=g.onboarding||{counts:{},backlog:[],tableMissing:false};
  const rt=g.retention||{atRisk:[],totalUsers:0,activeUsers7d:0};
  const c=ob.counts||{pending:0,completed:0,abandoned:0,total:0};
  let html='<div class="grid cards" style="margin-top:14px">'
    +card('Onboarding 待完成',fmt(c.pending||0),(ob.tableMissing?'表未迁移':'pending'),'warn')
    +card('已完成',fmt(c.completed||0),'completed','good')
    +card('已放弃',fmt(c.abandoned||0),'abandoned')
    +card('沉默有风险',fmt((rt.atRisk||[]).length),'7-45 天未活跃且曾活跃','accent')
    +'</div>';
  html+='<div class="row2">';
  html+='<div class="panel"><h3>Onboarding 积压 <span class="tag">pending 卡了多久 · 最久在前</span></h3>'
    +(ob.tableMissing?'<div class="empty">pending_users 未迁移</div>'
      :ob.error?'<div class="empty" style="color:var(--bad)">加载失败</div>'
      :(ob.backlog&&ob.backlog.length)?'<div style="overflow-x:auto"><table><thead><tr><th>code</th><th>handle</th><th class="num">卡了(天)</th></tr></thead><tbody>'
        +ob.backlog.map(b=>'<tr><td>'+esc(b.code)+'</td><td>'+esc(b.handleShort)+'</td><td class="num">'+fmt(b.ageDays)+'</td></tr>').join('')+'</tbody></table></div>'
      :'<div class="empty">没有卡住的 pending 🎉</div>')
    +'</div>';
  html+='<div class="panel"><h3>沉默有风险用户 <span class="tag">曾活跃 · 已静默 7-45 天 · 可挽回</span></h3>'
    +((rt.atRisk&&rt.atRisk.length)?'<div style="overflow-x:auto"><table><thead><tr><th>用户</th><th>身份</th><th class="num">静默(天)</th><th class="num">消息</th></tr></thead><tbody>'
      +rt.atRisk.map(r=>'<tr><td>'+esc(r.handleShort)+'</td><td>'+(r.name?esc(r.name):'<span class="skel">—</span>')+'</td><td class="num">'+fmt(r.daysSince)+'</td><td class="num">'+fmt(r.messages)+'</td></tr>').join('')+'</tbody></table></div>'
      :'<div class="empty">没有流失风险用户 👍</div>')
    +'</div>';
  html+='</div>';
  return html;
}
function card(k,v,s,cls){ return '<div class="card"><div class="k">'+esc(k)+'</div><div class="v '+(cls||'')+'">'+v+'</div>'+(s?'<div class="s">'+esc(s)+'</div>':'')+'</div>'; }

function lineChart(ts){
  if(!ts||!ts.length) return '<div class="empty">暂无数据</div>';
  const W=1080,H=180,pad=26,n=ts.length;
  const max=Math.max(...ts.map(d=>d.total),1);
  const bw=(W-pad*2)/n;
  let bars='';
  ts.forEach((d,i)=>{
    const x=pad+i*bw;
    const uh=(d.user/max)*(H-pad*2), ah=(d.assistant/max)*(H-pad*2);
    const total=uh+ah;
    bars+='<g>'
      +'<rect x="'+(x+bw*0.18)+'" y="'+(H-pad-total)+'" width="'+(bw*0.64)+'" height="'+ah+'" fill="#a78bfa" rx="2"></rect>'
      +'<rect x="'+(x+bw*0.18)+'" y="'+(H-pad-uh)+'" width="'+(bw*0.64)+'" height="'+uh+'" fill="#22d3ee" rx="2"></rect>'
      +'<text x="'+(x+bw/2)+'" y="'+(H-8)+'" fill="#5b6675" font-size="10" text-anchor="middle">'+esc(d.date.slice(5))+'</text>'
      +'<title>'+esc(d.date)+' · 用户 '+d.user+' / George '+d.assistant+'</title>'
    +'</g>';
  });
  return '<svg viewBox="0 0 '+W+' '+H+'" width="100%" style="display:block">'
    +'<line x1="'+pad+'" y1="'+(H-pad)+'" x2="'+(W-pad)+'" y2="'+(H-pad)+'" stroke="#232c3a"></line>'
    +bars
    +'<g transform="translate('+(W-pad-150)+',6)"><rect width="9" height="9" fill="#22d3ee" rx="2"></rect><text x="14" y="9" fill="#8b96a5" font-size="11">用户</text>'
    +'<rect x="60" width="9" height="9" fill="#a78bfa" rx="2"></rect><text x="74" y="9" fill="#8b96a5" font-size="11">George</text></g>'
    +'</svg>';
}

// ── LIVE ──
let liveOnlyToday=false;
async function loadLive(silent){
  const sec=document.getElementById('live');
  try{
    const data=await api('/live?limit=80'+(liveOnlyToday?'&today=1':''));
    sec.innerHTML=
      '<div class="panel"><h3>实时消息流 <span class="tag">用户在问什么 · 每 5s 刷新</span>'
        +'<div class="spacer" style="flex:1"></div>'
        +'<button class="btn sm '+(!liveOnlyToday?'on':'')+'" onclick="setLiveScope(false)">全部</button> '
        +'<button class="btn sm '+(liveOnlyToday?'on':'')+'" onclick="setLiveScope(true)">仅今日</button>'
      +'</h3>'
      +'<div class="feed">'+ (data.length? data.map(renderMsg).join('') : '<div class="empty">暂无消息</div>') +'</div></div>';
    if(!silent) stamp(); else stamp();
  }catch(e){ if(!silent) sec.innerHTML='<div class="empty">加载失败：'+esc(e.message)+'</div>'; }
}
function setLiveScope(t){ liveOnlyToday=t; loadLive(); }
function renderMsg(m){
  const isUser=m.role==='user';
  const who=m.who?esc(m.who):'';
  return '<div class="msg '+(isUser?'user':'assistant')+'">'
    +'<div class="av">'+(isUser?'U':'G')+'</div>'
    +'<div class="body"><div class="top">'
      +'<span class="id">'+(isUser?'👤 ':'🎓 ')+esc(m.handleShort)+'</span>'
      +(who?'<span class="badge">'+who+'</span>':'')
      +(m.agent?'<span class="badge agent">'+esc(m.agent)+'</span>':'')
      +(m.channel?'<span class="badge ch">'+esc(m.channel)+'</span>':'')
      +(m.tokens?'<span class="badge">'+fmt(m.tokens)+' tok</span>':'')
      +(m.costUsd?'<span class="badge cost">'+money(m.costUsd)+'</span>':'')
      +'<div class="spacer" style="flex:1"></div><span class="time">'+ago(m.createdAt)+'前 · '+hm(m.createdAt)+'</span>'
      +(!isUser&&m.id?'<button class="btn sm flag" title="标记为坏回合（off-voice/编造/错误）" onclick="flagTurn(this,'+JSON.stringify(m.id).replace(/"/g,'&quot;')+')">👎</button>':'')
    +'</div><div class="content">'+esc(m.content)+'</div></div></div>';
}

// Flag a George turn as a bad reply. Optional reason via prompt(); POSTs the flag
// and gives quick inline feedback on the button itself (no full reload).
async function flagTurn(btn,id){
  const reason=prompt('标记这条 George 回复为坏回合。可选：写一句原因（off-voice / 编造价格 / 教授名错了…）','');
  if(reason===null) return; // cancelled
  btn.disabled=true; const old=btn.textContent; btn.textContent='标记中…';
  try{
    await api('/message/'+encodeURIComponent(id)+'/flag',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'bad_turn',reason})});
    btn.textContent='✓ 已标记'; btn.classList.add('flagged');
    if(TAB==='review') loadReview();
  }catch(e){ btn.disabled=false; btn.textContent=old; alert('标记失败：'+e.message); }
}

// ── USERS ──
async function loadUsers(){
  const sec=document.getElementById('users');
  try{
    const rows=await api('/users?limit=150');
    sec.innerHTML='<div class="panel"><h3>对话用户 <span class="tag">'+rows.length+' 人 · 按最近活跃排序</span></h3>'
      +'<div style="overflow-x:auto"><table><thead><tr>'
      +'<th>用户</th><th>身份</th><th class="num">消息</th><th class="num">提问</th><th class="num">Tokens</th><th class="num">成本</th><th>最近活跃</th><th>Heartbeat</th><th></th>'
      +'</tr></thead><tbody>'
      + rows.map(r=>{
          const hb = r.heartbeat? (r.heartbeat.paused?'<span class="pill paused">已暂停</span>':'<span class="pill live">运行中</span>') : '<span class="pill none">未配置</span>';
          const who = r.name? esc(r.name) : (r.major? esc(r.major+' '+(r.year||'')) : (r.hasStudent?'<span class="skel">学生</span>':'<span class="skel">访客</span>'));
          return '<tr>'
            +'<td><strong>'+esc(r.handleShort)+'</strong>'+(r.onboarded?' <span class="badge cost">✓</span>':'')+ctrlBadges(r.control)+'</td>'
            +'<td>'+who+'</td>'
            +'<td class="num">'+fmt(r.messages)+'</td>'
            +'<td class="num">'+fmt(r.questions)+'</td>'
            +'<td class="num">'+(r.tokens?fmt(r.tokens):'—')+'</td>'
            +'<td class="num">'+(r.costUsd?money(r.costUsd):'—')+'</td>'
            +'<td>'+ago(r.lastActive)+'前</td>'
            +'<td>'+hb+'</td>'
            +'<td><button class="btn sm" onclick="openUser('+JSON.stringify(r.userId).replace(/"/g,'&quot;')+')">查看</button></td>'
          +'</tr>';
        }).join('')
      +'</tbody></table></div></div>';
    stamp();
  }catch(e){ sec.innerHTML='<div class="empty">加载失败：'+esc(e.message)+'</div>'; }
}

function shortModel(m){ return String(m).replace('claude-','').replace(/-\d{8}$/,'').replace('-4-','4.'); }
function ctrlBadges(c){ if(!c) return ''; let s=''; if(c.blocked) s+=' <span class="badge block">🚫封禁</span>'; if(c.modelOverride) s+=' <span class="badge model">主·'+esc(shortModel(c.modelOverride))+'</span>'; if(c.emotionalModel) s+=' <span class="badge model">情·'+esc(shortModel(c.emotionalModel))+'</span>'; if(c.dailyMessageLimit!=null) s+=' <span class="badge lim">限'+c.dailyMessageLimit+'/日</span>'; return s; }

// ── USER drawer ──
async function openUser(id){
  curUser=id;
  document.getElementById('scrim').classList.add('open');
  document.getElementById('drawer').classList.add('open');
  document.getElementById('drawerBody').innerHTML='<div class="empty">加载中…</div>';
  try{
    const [d]=await Promise.all([api('/user/'+encodeURIComponent(id)), loadModels()]);
    curUserPaused = d.heartbeat? !!d.heartbeat.paused : null;
    document.getElementById('drawerTitle').textContent=d.handleShort+(d.student&&d.student.name?' · '+d.student.name:'');
    const hbBtn=document.getElementById('hbBtn');
    if(d.heartbeat){ hbBtn.classList.remove('hide'); hbBtn.textContent=curUserPaused?'恢复 Heartbeat':'暂停 Heartbeat'; }
    else hbBtn.classList.add('hide');
    const p=d.profile||{};
    const blocks=['identity','academic','interests','relationships','state','george_notes'];
    const st=d.student;
    document.getElementById('drawerBody').innerHTML=
      '<div class="grid cards" style="grid-template-columns:repeat(3,1fr)">'
        +card('消息',fmt(d.stats.messages))
        +card('Tokens',d.stats.tokens?fmt(d.stats.tokens):'—')
        +card('成本',d.stats.costUsd?money(d.stats.costUsd):'—','','good')
      +'</div>'
      +(st?'<div class="note">学生档案：'+esc(st.name||'(无名)')+' · '+esc(st.major||'—')+' · '+esc(st.year||'—')+' · onboarded='+(st.onboarding_complete?'是':'否')+'</div>':'<div class="note">未匹配到 students 记录（访客 / 仅 web 会话）。</div>')
      +(d.heartbeat?'<div class="note">Heartbeat：cadence='+esc(d.heartbeat.cadence||'—')+' · 活跃 '+esc((d.heartbeat.active_hours_start||'')+'-'+(d.heartbeat.active_hours_end||''))+' · '+(d.heartbeat.paused?'已暂停':'运行中')+' · proactive 同意='+(d.heartbeat.consent_proactive_messages?'是':'否')+'</div>':'')
      +controlsPanel(d)
      +'<div class="panel"><h3>记忆档案 <span class="tag">user_profiles 6 blocks</span></h3><div class="blocks">'
        + blocks.map(b=>'<div class="block"><div class="bk">'+b.replace('_',' ')+'</div><div class="bv">'+(p[b]?esc(p[b]):'<span class="skel">空</span>')+'</div></div>').join('')
      +'</div></div>'
      +renderObsPanel(d)
      +'<div class="panel"><h3>对话记录 <span class="tag">'+d.conversation.length+' 条</span></h3><div class="convo">'
        + (d.conversation.length? d.conversation.map(renderConvoMsg).join('') : '<div class="empty">无记录</div>')
      +'</div></div>';
  }catch(e){ document.getElementById('drawerBody').innerHTML='<div class="empty">加载失败：'+esc(e.message)+'</div>'; }
}
// Observations panel (read-only). Three states: rows, "未迁移" (table absent in
// this env — graceful degradation, not an error), or "暂无观察".
function renderObsPanel(d){
  const obs=d.observations||[];
  let inner;
  if(obs.length) inner='<div class="obs">'+obs.map(renderObs).join('')+'</div>';
  else if(d.observationsTableMissing) inner='<div class="empty">该表未迁移（user_observations 不在此环境）</div>';
  else if(d.observationsError) inner='<div class="empty" style="color:var(--bad)">观察加载失败（权限/超时/查询错误）— 不是「没有观察」</div>';
  else inner='<div class="empty">暂无观察记忆</div>';
  return '<div class="panel"><h3>观察记忆 <span class="tag">user_observations · 按 salience 排序'+(obs.length?' · '+obs.length+' 条':'')+'</span></h3>'+inner+'</div>';
}
function renderObs(o){
  const hi=Number(o.salience)>=4?' hi':'';
  return '<div class="o"><span class="sal'+hi+'">S'+esc(String(o.salience))+'</span>'
    +'<div style="flex:1"><div class="otext">'+esc(o.content)+'</div>'
    +'<div class="ometa">'+(o.kind?'<span>'+esc(o.kind)+'</span>':'')
      +(o.consolidated?'<span>已固化</span>':'')
      +'<span>'+ago(o.createdAt)+'前</span></div></div></div>';
}
function renderConvoMsg(m){
  const isUser=m.role==='user';
  return '<div class="msg '+(isUser?'user':'assistant')+'"><div class="av">'+(isUser?'U':'G')+'</div><div class="body">'
    +'<div class="top"><span class="id">'+(isUser?'用户':'George')+'</span>'
    +(m.agent?'<span class="badge agent">'+esc(m.agent)+'</span>':'')
    +(m.tokens?'<span class="badge">'+fmt(m.tokens)+' tok</span>':'')
    +'<div class="spacer" style="flex:1"></div><span class="time">'+hm(m.createdAt)+'</span>'
    +(!isUser&&m.id?'<button class="btn sm flag" title="标记为坏回合" onclick="flagTurn(this,'+JSON.stringify(m.id).replace(/"/g,'&quot;')+')">👎</button>':'')
    +'</div>'
    +'<div class="content">'+esc(m.content)+'</div></div></div>';
}
// Model options are fetched from /admin/api/models per TIER (main / emotional),
// each derived from the deployment's model catalog (env-filtered), cached after
// first load. Falls back to just the "default" option if the fetch fails.
let MODELS_MAIN=[['','默认（继承全局）']], MODELS_EMO=[['','默认（继承全局）']];
let MODELS_LOADED=false;
async function loadModels(){
  if(MODELS_LOADED) return;
  try{
    const [mm,me]=await Promise.all([api('/models?tier=main'),api('/models?tier=emotional')]);
    if(Array.isArray(mm.choices)&&mm.choices.length) MODELS_MAIN=mm.choices.map(x=>[x.id,x.label]);
    if(Array.isArray(me.choices)&&me.choices.length) MODELS_EMO=me.choices.map(x=>[x.id,x.label]);
    MODELS_LOADED=true;
  }catch(e){ /* keep fallback */ }
}
function modelOptions(models,cur){
  const known=models.some(m=>m[0]===cur);
  return models.map(m=>'<option value="'+esc(m[0])+'"'+(m[0]===cur?' selected':'')+'>'+esc(m[1])+'</option>').join('')+'<option value="__custom"'+((!known&&cur)?' selected':'')+'>自定义…</option>';
}
function controlsPanel(d){
  const c=d.controls||{}, u=d.usage||{};
  // 主模型 → modelOverride field (orchestrator + sub-agents); 情绪模型 → emotionalModel
  // field (fast-path quick reply). Both are live.
  const curMain=c.modelOverride||'';
  const curEmo=c.emotionalModel||'';
  const mKnown=MODELS_MAIN.some(m=>m[0]===curMain), eKnown=MODELS_EMO.some(m=>m[0]===curEmo);
  const usageStr = u.limit!=null ? (u.used+' / '+u.limit+' 条（今日）') : (u.used+' 条（今日）· 无限额');
  return '<div class="panel"><h3>使用控制 <span class="tag">主/情绪模型 · 每日限额 · 封禁</span></h3>'
    +'<div class="ctrl-grid">'
      +'<label>主模型 Main<span class="tag">orchestrator + 子agent</span><select id="ctlModel" onchange="onModelSel(\'ctlModel\',\'ctlCustomWrap\')">'+modelOptions(MODELS_MAIN,curMain)+'</select></label>'
      +'<label id="ctlCustomWrap" class="'+((!mKnown&&curMain)?'':'hide')+'">自定义主模型 ID<input id="ctlCustom" value="'+((!mKnown&&curMain)?esc(curMain):'')+'" placeholder="e.g. deepseek-chat"></label>'
      +'<label>情绪模型 Emotional<span class="tag">快速回复 fast-path</span><select id="ctlEmo" onchange="onModelSel(\'ctlEmo\',\'ctlEmoCustomWrap\')">'+modelOptions(MODELS_EMO,curEmo)+'</select></label>'
      +'<label id="ctlEmoCustomWrap" class="'+((!eKnown&&curEmo)?'':'hide')+'">自定义情绪模型 ID<input id="ctlEmoCustom" value="'+((!eKnown&&curEmo)?esc(curEmo):'')+'" placeholder="e.g. doubao-seed-2-0-lite-260215"></label>'
      +'<label>每日消息上限<input id="ctlLimit" type="number" min="0" value="'+(c.dailyMessageLimit!=null?c.dailyMessageLimit:'')+'" placeholder="留空 = 不限"></label>'
      +'<label class="ck"><input id="ctlBlocked" type="checkbox"'+(c.blocked?' checked':'')+'> 封禁此用户（直接拒绝，不调用模型）</label>'
      +'<label class="fb">封禁/限额时给用户看的提示语（留空用默认）<textarea id="ctlFeedback" rows="2" placeholder="例如：你的提问额度今天用完啦，明天再来找学长哈～">'+(c.feedbackMessage?esc(c.feedbackMessage):'')+'</textarea></label>'
    +'</div>'
    +'<div class="ctrl-foot"><span class="usage">今日用量 '+esc(usageStr)+'</span><button class="btn" onclick="saveControls()">保存控制</button></div>'
    +(c.updatedAt?'<div class="skel" style="font-size:11px;margin-top:8px">上次更新 '+hm(c.updatedAt)+' · by '+esc(c.updatedBy||'—')+'</div>':'')
    +'<div id="ctlMsg" class="err"></div></div>';
}
function onModelSel(selId,wrapId){ const sel=document.getElementById(selId),w=document.getElementById(wrapId); if(w) w.classList.toggle('hide',sel.value!=='__custom'); }
async function saveControls(){
  if(!curUser) return;
  const sel=document.getElementById('ctlModel').value;
  const cust=document.getElementById('ctlCustom'); const custom=cust?cust.value.trim():'';
  const modelOverride = sel==='__custom' ? custom : sel;
  const eSel=document.getElementById('ctlEmo').value;
  const eCust=document.getElementById('ctlEmoCustom'); const eCustom=eCust?eCust.value.trim():'';
  const emotionalModel = eSel==='__custom' ? eCustom : eSel;
  const limRaw=document.getElementById('ctlLimit').value.trim();
  const msg=document.getElementById('ctlMsg'); msg.style.color='';
  let dailyMessageLimit=null;
  if(limRaw!==''){
    dailyMessageLimit=parseInt(limRaw,10);
    if(!Number.isFinite(dailyMessageLimit)||dailyMessageLimit<0){
      msg.style.color='var(--bad)'; msg.textContent='每日上限请填非负整数（留空=不限）'; return;
    }
  }
  const blocked=document.getElementById('ctlBlocked').checked;
  const fb=document.getElementById('ctlFeedback'); const feedbackMessage = fb ? fb.value.trim() : '';
  msg.textContent='保存中…';
  try{
    await api('/user/'+encodeURIComponent(curUser)+'/controls',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({modelOverride,emotionalModel,dailyMessageLimit,blocked,feedbackMessage})});
    msg.style.color='var(--good)'; msg.textContent='已保存 ✓ 主模型 + 情绪模型实时生效（后端下一条消息即按此执行）';
    if(TAB==='users') loadUsers();
  }catch(e){ msg.style.color='var(--bad)'; msg.textContent='保存失败：'+e.message; }
}
async function toggleHb(){
  if(!curUser||curUserPaused===null) return;
  const act=curUserPaused?'resume':'pause';
  try{ await api('/user/'+encodeURIComponent(curUser)+'/'+act,{method:'POST'}); openUser(curUser); if(TAB==='users') loadUsers(); }
  catch(e){ alert('操作失败：'+e.message); }
}
function closeDrawer(){ document.getElementById('scrim').classList.remove('open'); document.getElementById('drawer').classList.remove('open'); curUser=null; }

// ── REVIEW (AI quality: flagged turns + fabrication suspects) ──
async function loadReview(){
  const sec=document.getElementById('review');
  try{
    const d=await api('/review');
    const cr=d.crisis||{enabled:false,queue:[]};
    const fl=d.flagged||{flags:[],tableMissing:false,error:false};
    const fab=d.fabrication||{suspects:[],scanned:0};
    const inj=d.injection||{entries:[],error:false,tableMissing:false};
    setCrisisBadge(cr.enabled?(cr.queue||[]).length:0);
    sec.innerHTML=
      renderCrisisPanel(cr)
      +'<div class="panel"><h3>已标记的坏回合 <span class="tag">message_flags · 人工标记</span></h3>'
        +(fl.tableMissing?'<div class="empty">该表未迁移（message_flags 不在此环境）— 应用 migration 后开始记录</div>'
          :fl.error?'<div class="empty" style="color:var(--bad)">加载失败（非「无标记」）</div>'
          :(fl.flags.length?'<div class="rev">'+fl.flags.map(renderFlag).join('')+'</div>':'<div class="empty">还没有标记 — 在「实时」或用户抽屉里点 👎 标记坏回合</div>'))
      +'</div>'
      +'<div class="panel"><h3>编造哨兵 <span class="tag">有具体声明(课号/价格/评分)却没调用工具 · 启发式，需人工判断 · 仅判定有 telemetry 的近 '+fmt(fab.scanned||0)+' 条</span></h3>'
        +(fab.error?'<div class="empty" style="color:var(--bad)">加载失败（非「无可疑」）— 查询出错</div>'
          :fab.suspects.length?'<div class="rev">'+fab.suspects.map(renderSuspect).join('')+'</div>':'<div class="empty">近期没有可疑回合 👍</div>')
      +'</div>'
      +'<div class="panel"><h3>注入拦截日志 <span class="tag">admin_audit_log · 边界拦截</span></h3>'
        +(inj.tableMissing?'<div class="empty">审计表未迁移</div>'
          :inj.error?'<div class="empty" style="color:var(--bad)">加载失败</div>'
          :inj.entries.length?'<div class="rev">'+inj.entries.map(renderInjection).join('')+'</div>':'<div class="empty">近期没有拦截到注入尝试</div>')
      +'</div>';
    stamp();
  }catch(e){ sec.innerHTML='<div class="empty">加载失败：'+esc(e.message)+'</div>'; }
}
// Crisis queue — TOP of the page, red-bordered. When the radar is OFF it shows the
// gate explicitly; when ON+empty it shows a REASSURING empty state (not a scary
// blank); when ON+hits it lists each student for a human to act on per the SOP.
function renderCrisisPanel(cr){
  if(!cr.enabled){
    return '<div class="panel crisis off"><h3>🛟 安危雷达 <span class="tag">未启用 · 需先定危机响应 SOP（谁看 / 多久 / 升级给谁 / 非工作时间）</span></h3>'
      +'<div class="empty">雷达已就绪但未开启。定好 SOP 后设 GEORGE_CRISIS_RADAR_ENABLED=true 再上线。</div></div>';
  }
  const q=cr.queue||[];
  if(!q.length){
    return '<div class="panel crisis ok"><h3>🛟 安危雷达 <span class="tag">实时扫描学生消息 + 情绪观察</span></h3>'
      +'<div class="empty">这会儿没人需要 check-in，一切安好 🌿</div></div>';
  }
  return '<div class="panel crisis hit"><h3>🛟 安危雷达 <span class="tag">'+q.length+' 位可能需要关注 · 按 SOP 处理</span></h3>'
    +'<div class="rev">'+q.map(renderDistress).join('')+'</div></div>';
}
function renderDistress(h){
  return '<div class="r crisisrow"><div class="rtop">'
    +'<span class="badge block">'+esc(h.handleShort||'—')+'</span>'
    +(h.signals||[]).map(x=>'<span class="sig danger">'+esc(x)+'</span>').join('')
    +'<span class="badge">'+esc(h.source==='observation'?'情绪观察':'消息')+'</span>'
    +'<div class="spacer" style="flex:1"></div><span>'+ago(h.createdAt)+'前</span></div>'
    +'<div class="rtext">'+esc(h.snippet||'')+'</div></div>';
}
function renderInjection(e){
  return '<div class="r"><div class="rtop">'
    +'<span>'+esc(e.handleShort||'—')+'</span>'
    +(e.source?'<span class="badge ch">'+esc(e.source)+'</span>':'')
    +'<div class="spacer" style="flex:1"></div><span>'+ago(e.createdAt)+'前</span></div>'
    +(e.preview?'<div class="rtext skel">'+esc(e.preview)+'</div>':'')+'</div>';
}
// Set/clear the 复盘 tab badge — only shows when there is at least one crisis hit.
function setCrisisBadge(n){
  const tab=document.querySelector('.tab[data-tab="review"]');
  if(!tab) return;
  let b=tab.querySelector('.tabbadge');
  if(n>0){ if(!b){ b=document.createElement('span'); b.className='tabbadge'; tab.appendChild(b);} b.textContent=n; }
  else if(b){ b.remove(); }
}
// Lightweight boot probe so the crisis badge can appear without opening 复盘.
async function refreshCrisisBadge(){
  try{ const d=await api('/review'); const cr=d.crisis||{}; setCrisisBadge(cr.enabled?(cr.queue||[]).length:0); }catch(e){}
}
function renderFlag(f){
  return '<div class="r"><div class="rtop">'
    +'<span class="badge block">'+esc(f.kind||'bad_turn')+'</span>'
    +'<span>'+esc(f.handleShort||'—')+'</span>'
    +(f.agent?'<span class="badge agent">'+esc(f.agent)+'</span>':'')
    +(f.model?'<span class="badge model">'+esc(shortModel(f.model))+'</span>':'')
    +'<div class="spacer" style="flex:1"></div><span>'+esc(f.actor||'')+' · '+ago(f.createdAt)+'前</span></div>'
    +(f.reason?'<div class="rtext" style="color:var(--warn)">“'+esc(f.reason)+'”</div>':'')
    +'<div class="rtext">'+(f.content?esc(f.content):'<span class="skel">（原消息已删除，仅存标记）</span>')+'</div></div>';
}
function renderSuspect(s){
  return '<div class="r"><div class="rtop">'
    +'<span>'+esc(s.handleShort||'—')+'</span>'
    +(s.agent?'<span class="badge agent">'+esc(s.agent)+'</span>':'')
    +(s.signals||[]).map(x=>'<span class="sig">'+esc(x)+'</span>').join('')
    +'<div class="spacer" style="flex:1"></div>'
    +'<button class="btn sm flag" title="确认为坏回合" onclick="flagTurn(this,'+JSON.stringify(s.id).replace(/"/g,'&quot;')+')">👎</button>'
    +'<span style="margin-left:8px">'+ago(s.createdAt)+'前</span></div>'
    +'<div class="rtext">'+esc(s.content)+'</div></div>';
}

// ── SYSTEM ──
async function loadSystem(){
  const sec=document.getElementById('system');
  try{
    const h=await api('/health');
    const tc=h.telemetryCoverage, hb=h.heartbeat;
    const mc=h.memoryConsent||{configured:0,consented:0};
    const mcPct=mc.configured?Math.round((mc.consented/mc.configured)*100):0;
    sec.innerHTML=
      '<div class="grid cards">'
        +card('Telemetry 覆盖',tc.tokensPct+'%',fmt(tc.withTokens)+'/'+fmt(tc.total)+' 带 token',tc.tokensPct>50?'good':'warn')
        +card('Agent 标注',tc.agentPct+'%',fmt(tc.withAgent)+'/'+fmt(tc.total)+' 条')
        +card('Heartbeat 配置',fmt(hb.configured),hb.paused+' 暂停 · '+hb.consented+' proactive 同意')
        +card('记忆同意 opt-in',mcPct+'%',fmt(mc.consented)+'/'+fmt(mc.configured)+' 开启长期记忆','accent')
      +'</div>'
      +'<div class="row2">'
        +'<div class="panel"><h3>Heartbeat 近期结果</h3>'+(hb.recentOutcomes.length?barList(hb.recentOutcomes.map(o=>({label:o.outcome,count:o.count}))):'<div class="empty">暂无</div>')+'</div>'
        +'<div class="panel"><h3>近期 Heartbeat 日志</h3>'+(hb.recent.length? '<div style="overflow-x:auto"><table><thead><tr><th>时间</th><th>结果</th><th class="num">ms</th></tr></thead><tbody>'+hb.recent.map(r=>'<tr><td>'+hm(r.fired_at)+'</td><td>'+esc(r.outcome)+'</td><td class="num">'+fmt(r.duration_ms)+'</td></tr>').join('')+'</tbody></table></div>':'<div class="empty">暂无</div>')+'</div>'
      +'</div>'
      +'<div class="note">📌 Telemetry 覆盖率反映"被丢弃的 SDK usage"修复进度：reactive 路径现已逐条把 token/cost/model/sub-agent 写入 messages 表。历史行为空，故百分比会随新对话上升。下一步（Phase 0 正式版）是独立 turn_telemetry 表 + bia-admin migration。</div>';
    stamp();
  }catch(e){ sec.innerHTML='<div class="empty">加载失败：'+esc(e.message)+'</div>'; }
}

document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeDrawer(); });
boot();
</script>
</body>
</html>`;
}
