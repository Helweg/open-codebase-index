export const VISUALIZATION_STYLES: string = String.raw`
:root {
  color-scheme:dark;
  --bg:#0c121c;
  --surface:#131d2b;
  --raised:#192638;
  --fg:#edf2fa;
  --muted:#a8b8cd;
  --border:#2d3e54;
  --accent:#b4a2ff;
  --accent-soft:#24213d;
  --shadow:0 12px 32px #0003;
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif
}
@media(prefers-color-scheme:light) {
  :root {
    color-scheme:light;
    --bg:#f6f8fc;
    --surface:#fff;
    --raised:#edf2f9;
    --fg:#1b293d;
    --muted:#52647c;
    --border:#d4deeb;
    --accent:#6943ca;
    --accent-soft:#f0ebfc;
    --shadow:0 12px 32px #263c5914
  }
}
* { box-sizing:border-box; scrollbar-width:thin; scrollbar-color:var(--border) transparent }
[hidden] { display:none!important }
body { margin:0; background:var(--bg); color:var(--fg) }
button,input,select { font:inherit; color:inherit }
button,select,summary { cursor:pointer }
button {
  min-height:44px;
  padding:8px 12px;
  border:1px solid var(--border);
  border-radius:8px;
  background:var(--surface);
  transition:background-color .12s,border-color .12s;
  overflow-wrap:anywhere
}
button:hover { border-color:var(--accent); background:var(--raised) }
button:disabled { opacity:.4; cursor:default }
button[aria-current=true],button[aria-current=page],button.selected {
  border-color:var(--accent);
  background:var(--accent-soft)
}
:focus-visible { outline:2px solid var(--accent); outline-offset:3px }
input,select {
  min-width:0;
  min-height:44px;
  padding:8px 10px;
  background:var(--bg);
  border:1px solid var(--border);
  border-radius:8px
}
input[type=checkbox] { min-height:0; width:16px; height:16px; accent-color:var(--accent); margin:0 }
input::placeholder { color:var(--muted); opacity:.85 }
h1,h2,h3,p,dl { margin:0; overflow-wrap:anywhere }
h1 { font-size:17px; line-height:1.3; letter-spacing:-.025em; font-weight:650 }
h2 { font-size:26px; line-height:1.2; letter-spacing:-.035em; font-weight:650 }
h3 { font-size:15px; line-height:1.4; font-weight:650 }
small,.meta,.scope-note,.lane-summary,.location,.status { font-size:12px; color:var(--muted) }
.mono { font-family:ui-monospace,"SF Mono",Consolas,monospace; font-size:12px }
.wrap,.location { overflow-wrap:anywhere }
.location { display:block; line-height:1.6 }
.muted { color:var(--muted) }
.eyebrow,.kind-label {
  font-size:12px;
  font-weight:550;
  color:var(--muted);
  letter-spacing:.045em
}
.eyebrow { text-transform:uppercase; letter-spacing:.08em }
.kind-label { display:block; margin-top:3px }
.stack { display:grid; gap:10px; align-content:start; min-width:0 }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap }
.spaced { justify-content:space-between }
.section { margin-top:28px }
.badge,.count-badge {
  display:inline-flex;
  align-items:center;
  width:fit-content;
  border:1px solid var(--border);
  border-radius:5px;
  padding:2px 7px;
  font-size:12px;
  color:var(--muted);
  line-height:1.5
}
.count-badge { font-variant-numeric:tabular-nums; border:0; background:var(--raised); border-radius:20px }
.scope-note { line-height:1.6; max-width:80ch }
.empty { padding:20px; border:1px dashed var(--border); border-radius:10px; color:var(--muted); font-size:13px }
.warning { grid-row:2; border-bottom:1px solid var(--accent); padding:10px 24px; background:var(--accent-soft); font-size:12px }
.card {
  display:block;
  width:100%;
  min-width:0;
  text-align:left;
  padding:12px;
  background:var(--surface)
}
.card-title { display:block; font-weight:600; line-height:1.4; overflow-wrap:anywhere }
.card>.meta,.card>.location { display:block; margin-top:6px; overflow-wrap:anywhere }
.card .kind-label+.location { margin-top:6px }
.metric { display:grid; gap:2px; font-size:12px; color:var(--muted) }
.metric strong { font-size:22px; font-weight:600; letter-spacing:-.025em; color:var(--fg); font-variant-numeric:tabular-nums; line-height:1.25 }
.card-stats { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; padding:14px 0 2px }
.card-footer { display:block; padding-top:12px; margin-top:12px; border-top:1px solid var(--border); font-size:12px; color:var(--muted) }
.list { display:grid; gap:10px; min-width:0; align-content:start; grid-auto-rows:max-content }
.pager { display:flex; gap:8px; align-items:center; justify-content:space-between; margin-top:8px; font-size:12px; color:var(--muted); font-variant-numeric:tabular-nums }
.pager button { font-size:12px; padding:8px 10px }
.kv { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:12px; padding:9px 0; border-bottom:1px solid var(--border); font-size:12px }
.kv dt { color:var(--muted) }
.kv dd { margin:0; text-align:right; overflow-wrap:anywhere; font-variant-numeric:tabular-nums }
details { min-width:0; padding:0 12px; border:1px solid var(--border); border-radius:8px; background:var(--surface) }
summary { min-height:44px; padding:12px 0; font-size:13px; overflow-wrap:anywhere }
details>.stack { margin:0 0 12px }
details>p { margin:0 0 12px }
.original-location summary { font-size:12px; color:var(--muted) }
.original-location p { font-size:12px }
.edge-record { display:grid; gap:10px; padding:14px; border:1px solid var(--border); border-radius:10px; background:var(--surface); overflow-wrap:anywhere }
.edge-record>.location { color:var(--fg) }
.edge-record .card { border:0; border-left:2px solid var(--border); border-radius:0; padding:6px 10px; background:transparent }
.edge-record .card-title { font-size:12px }
.edge-record .kind-label { display:none }
.edge-record .card>.meta { font-size:12px; margin-top:3px }
.callsite-meta { gap:6px }
.callsite-meta .eyebrow { margin-right:auto }
#app { height:100dvh; display:grid; grid-template-rows:auto auto minmax(0,1fr); overflow:hidden }
.header { grid-row:1; padding:12px 24px 4px; border-bottom:1px solid var(--border); background:var(--surface); z-index:5 }
.header-top { display:grid; grid-template-columns:minmax(180px,1fr) auto auto; gap:24px; align-items:center }
.brand { display:flex; align-items:center; gap:12px; min-width:0 }
.brand .eyebrow { font-size:12px; letter-spacing:.1em }
.brand-mark { width:30px; height:30px; flex-shrink:0; border:1px solid var(--accent); border-radius:8px; position:relative; background:var(--accent-soft) }
.brand-mark:before,.brand-mark:after { content:""; position:absolute; width:10px; height:10px; border:1px solid var(--accent); border-radius:2px }
.brand-mark:before { top:5px; left:5px }
.brand-mark:after { bottom:5px; right:5px; background:var(--accent-soft) }
.explorer-controls,.history-actions,.analyze-control { display:flex; align-items:center; gap:8px }
.analyze-control { padding-left:12px; margin-left:4px; border-left:1px solid var(--border); font-size:12px; color:var(--muted) }
.analyze-control select { min-height:44px; width:100px; font-size:13px; color:var(--fg); background:var(--surface) }
.home-button { border-color:transparent; font-weight:600 }
.history-actions button { width:44px; padding:4px; font-size:20px; background:transparent }
.snapshot-row { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px 16px; min-height:48px }
.snapshot { display:flex; align-items:center; gap:24px }
.snapshot .metric { display:flex; gap:6px; align-items:baseline }
.snapshot .metric strong { font-size:14px; letter-spacing:0 }
.export-info { position:relative; padding:0; border:0; border-radius:0; background:transparent; flex-shrink:0 }
.export-info summary { padding:12px 0; font-size:12px; color:var(--muted) }
#export-details { position:absolute; top:100%; right:0; width:min(340px,calc(100vw - 32px)); padding:16px; border:1px solid var(--border); background:var(--surface); border-radius:10px; box-shadow:var(--shadow); z-index:6 }
#export-details .scope-note { margin-top:12px }
.workspace { grid-row:3; display:grid; grid-template-columns:260px minmax(0,1fr) 300px; min-height:0 }
.pane { padding:20px 16px; min-width:0; min-height:0; overflow:auto; background:var(--surface) }
.navigator { display:flex; flex-direction:column; border-right:1px solid var(--border) }
.inspector { border-left:1px solid var(--border) }
.pane-head { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:20px; flex-shrink:0 }
.pane-head h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); font-weight:600 }
.navigator>.search-content { flex:1; min-height:0; grid-template-rows:auto auto auto auto minmax(0,1fr) auto }
.search-content>label { display:flex; align-items:center; justify-content:space-between; font-size:12px; color:var(--muted) }
kbd { font:12px ui-monospace,monospace; border:1px solid var(--border); border-radius:4px; min-width:22px; text-align:center; color:var(--muted) }
.searchbar { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:6px }
.searchbar input,.search-filter { width:100% }
.searchbar button { background:var(--bg); font-size:18px; width:44px; padding:4px }
.search-filter { font-size:12px }
#results { overflow:auto; padding:4px; margin:0 -4px }
#results .card { border-color:transparent; padding:10px; background:transparent; border-radius:7px }
#results .card:hover { border-color:var(--border); background:var(--raised) }
#results .card[aria-current=true] { background:var(--accent-soft); border-color:var(--accent) }
#results .card-title { font-size:13px }
#results .kind-label { font-size:12px }
#search-pages { min-width:0 }
.main { display:flex; flex-direction:column; gap:24px; min-width:0; min-height:0; padding:28px; overflow:auto }
.main-head { display:grid; gap:10px; min-width:0 }
.main-head>p { font-size:13px; line-height:1.6 }
.breadcrumbs { display:flex; flex-wrap:wrap; align-items:center; gap:6px; font-size:12px; color:var(--muted); min-width:0 }
.breadcrumbs button { background:transparent; border-color:transparent; padding:6px 8px; margin-left:-8px; font-size:12px; color:var(--muted) }
.breadcrumbs button:hover { color:var(--fg); background:var(--raised) }
.breadcrumbs>span:last-child { color:var(--fg) }
#surface { min-height:0; position:relative; flex:1 }
.directory { gap:12px }
.category-filters { gap:8px }
.category-control { display:flex; align-items:center; gap:7px; min-height:44px; padding:8px 10px; border:1px solid var(--border); border-radius:8px; font-size:12px; background:var(--surface); cursor:pointer }
.category-control:has(input:checked) { border-color:var(--accent); background:var(--accent-soft) }
.category-control:has(input:disabled) { opacity:.45; cursor:default }
.category-count { font-variant-numeric:tabular-nums; color:var(--muted) }
.overview-section { margin-top:12px }
.section-heading { display:flex; gap:8px; align-items:center; margin-bottom:12px }
.section-heading h3 { font-size:15px }
.overview-section .list { grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr)); gap:12px }
.directory-card { display:grid; grid-template-columns:minmax(0,1fr) auto; grid-template-rows:auto minmax(0,1fr) auto auto; align-content:start; column-gap:8px; padding:16px; border-radius:10px }
.directory-card>.card-title { grid-column:1; grid-row:1; padding-right:4px; font-size:15px }
.directory-card>.location { grid-column:1/-1; grid-row:2; margin-top:6px; align-self:start }
.directory-card>.category-badge { grid-column:2; grid-row:1; align-self:start; padding:1px 6px }
.directory-card>.card-stats,.directory-card>.card-footer { grid-column:1/-1 }
.search-match { outline:2px solid var(--accent); outline-offset:-2px }
.focus-scene { display:grid; gap:16px; position:relative }
.scene-note { margin-bottom:0 }
.flow { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1fr); gap:24px; position:relative; isolation:isolate; min-width:0 }
.lane { min-width:0; min-height:0; max-height:min(640px,calc(100dvh - 280px)); overflow:auto; padding:0 4px 4px; z-index:1; position:relative; scroll-margin-top:64px }
.lane-heading { display:flex; justify-content:space-between; align-items:center; gap:6px }
.lane-heading h3 { font-size:13px }
.lane-summary { margin:6px 0 14px }
.neighbor-row { display:grid; min-width:0; border:1px solid var(--border); border-radius:9px; overflow:hidden; background:var(--surface) }
.neighbor-row:has(.selected) { border-color:var(--accent) }
.neighbor-link { border:0; border-radius:0; padding:12px }
.neighbor-row>.inspect-control { border:0; border-top:1px solid var(--border); border-radius:0; font-size:12px; background:transparent; color:var(--accent); padding:8px 12px; text-align:left }
.neighbor-row>.inspect-control:after { content:"→"; float:right }
.neighbor-row>.inspect-control:hover,.neighbor-row>.inspect-control.selected { background:var(--accent-soft) }
.focus-lane { align-self:start; min-width:0; padding-top:64px; z-index:1 }
.focus-card { display:grid; gap:10px; border:1px solid var(--accent); border-top:3px solid var(--accent); border-radius:10px; padding:16px; background:var(--surface); box-shadow:var(--shadow); overflow-wrap:anywhere; scroll-margin-top:64px }
.focus-card h3 { font-size:18px; letter-spacing:-.02em }
.focus-card .eyebrow { color:var(--accent) }
.focus-card .card-stats { border-top:1px solid var(--border); margin-top:2px; padding-top:12px }
.focus-actions { display:flex; flex-wrap:wrap; gap:8px }
.focus-actions button { flex:1; font-size:12px; padding:8px }
.focus-card>[data-action=browse-files] { background:var(--accent-soft); border-color:var(--accent); font-weight:600 }
.self-calls { display:grid; gap:6px; border-top:1px solid var(--border); padding-top:10px }
.self-calls .inspect-control { font-size:12px }
#copy-status:empty { display:none }
.focus-jumps { display:none }
.focus-edges { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; overflow:hidden; z-index:0 }
.focus-edges .connection { fill:none; stroke:var(--accent); stroke-width:1.5; opacity:.3 }
.focus-edges .connection.selected { stroke-width:2.5; opacity:1 }
.focus-edges .connection-hit { fill:none; stroke:transparent; stroke-width:12; pointer-events:stroke; cursor:pointer }
.flow.stacked { grid-template-columns:minmax(0,1fr); gap:24px }
.flow.stacked .lane { max-height:440px; padding:0 4px 4px; scroll-margin-top:64px }
.flow.stacked .focus-lane { grid-row:1; padding:0 }
.flow.stacked .focus-edges { display:none }
.focus-scene:has(.flow.stacked) .focus-jumps { display:flex; flex-wrap:wrap; gap:6px; position:sticky; top:-1px; z-index:3; padding:8px 0; background:var(--bg); border-bottom:1px solid var(--border) }
.focus-jumps button { flex:1; padding:8px; font-size:12px; white-space:nowrap }
.files-section { padding-top:24px; border-top:1px solid var(--border); gap:16px }
#files-title { font-size:18px; scroll-margin-top:64px }
.local-filter { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:6px 8px; max-width:600px }
.local-filter label { grid-column:1/-1; font-size:12px; color:var(--muted) }
.local-filter button { font-size:12px }
.file-group summary { line-height:1.7 }
.file-group summary .location { display:inline; color:var(--fg) }
.file-count { display:block; padding-left:16px; margin-top:2px }
.file-group[open] { border-color:var(--muted) }
.file-group .card { background:var(--bg); display:grid; grid-template-columns:minmax(0,1fr) auto; gap:2px 12px }
.file-group .card-title { grid-column:1; grid-row:1 }
.file-group .kind-label { grid-column:1; grid-row:2; margin:0 }
.file-group .card>.location { grid-column:2; grid-row:1/3; align-self:center; margin:0 }
.group-heading { margin:8px 0 0 }
.lane-heading .group-heading,.section-heading .group-heading,.focus-card .group-heading { margin:0 }
#details { gap:16px }
#details>h3:first-child { font-size:18px; color:var(--fg); margin:0 }
.relationship-endpoints { gap:6px }
.relationship-endpoints .eyebrow:not(:first-child) { margin-top:8px }
.analysis-heading { margin-bottom:20px }
.analysis-heading h3 { margin:0; font-size:18px }
.analysis-heading [data-action=explore] { margin-left:auto; font-size:12px }
.view-list { display:grid; gap:16px; max-width:1000px }
.view-list>.group-heading { margin-top:16px }
.copy-field { width:100%; margin-top:8px }
.mobile-search,.drawer-details,.dialog-close { display:none }
.pane[role=dialog] { position:fixed; z-index:20; inset:0 0 0 auto; width:380px; max-width:100vw; border-left:1px solid var(--border); box-shadow:0 0 0 100vmax #0007, var(--shadow) }
.pane[role=dialog] .dialog-close { display:block }
.sr-only { position:absolute; top:0; left:0; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap }
@media(min-width:1024px) and (max-width:1279px) {
  .workspace { grid-template-columns:240px minmax(0,1fr) }
  .inspector:not([role=dialog]) { display:none }
  .drawer-details { display:block }
}
@media(max-width:1023px) {
  .workspace { grid-template-columns:minmax(0,1fr) }
  .navigator:not([role=dialog]),.inspector:not([role=dialog]) { display:none }
  .mobile-search,.drawer-details { display:block }
  .pane[role=dialog].navigator { left:0; right:auto; border-left:0; border-right:1px solid var(--border) }
  .header { padding:10px 16px 2px }
  .header-top { grid-template-columns:minmax(0,1fr) auto; gap:8px }
  .brand { gap:8px }
  .brand-mark { width:28px; height:28px }
  .brand h1 { font-size:16px }
  .history-actions { grid-column:2; grid-row:1; gap:4px }
  .explorer-controls { grid-row:2; grid-column:1/-1; justify-content:space-between; gap:6px }
  .explorer-controls>button { padding:8px; font-size:12px }
  .analyze-control { gap:6px; padding-left:8px; margin-left:0 }
  .analyze-control select { width:86px; padding:6px; font-size:12px }
  .main { padding:20px 16px; gap:20px }
  h2 { font-size:24px }
  .snapshot { gap:14px }
  .snapshot .metric { gap:4px; font-size:12px }
  .snapshot .metric strong { font-size:13px }
  .snapshot-row { gap:8px }
  .export-info summary { font-size:12px }
  .warning { padding:8px 16px }
}
@media(max-width:420px) {
  .brand-mark { display:none }
  .analyze-control { border:0; padding-left:0 }
  .analyze-control label { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0) }
  .snapshot { gap:10px }
  .snapshot-row { gap:6px }
  .snapshot .metric { gap:3px }
  .export-info summary { font-size:12px }
  .category-filters { gap:6px }
  .category-control { padding:8px; gap:6px }
  .directory-card { padding:16px }
}
@media(prefers-reduced-motion:reduce) {
  * { scroll-behavior:auto!important; transition:none!important }
}
`;
