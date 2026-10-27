import type { VisualizationData } from "./types.js";
import { VISUALIZATION_SCRIPT } from "./client.js";
import { analyzeVisualizationGraph } from "./graph.js";
import { VISUALIZATION_STYLES } from "./styles.js";

export function generateVisualizationHtml(data: VisualizationData): string {
  const json = JSON.stringify({ data, analysis: analyzeVisualizationGraph(data) })
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Codebase explorer</title>
<style>${VISUALIZATION_STYLES}</style>
</head>
<body>
<div id="app">
  <header class="header">
    <div class="header-top">
      <div class="brand"><span class="brand-mark" aria-hidden="true"></span><div><h1>Codebase explorer</h1><span class="eyebrow">Offline snapshot</span></div></div>
      <div class="explorer-controls">
        <button class="home-button" data-view="overview">Overview</button>
        <div class="analyze-control"><label for="analyze">Analyze</label><select id="analyze"><option value="">Explore</option><option value="changes">Changes</option><option value="hotspots">Hotspots</option><option value="cycles">Cycles</option></select></div>
        <button id="open-search" class="mobile-search">Search</button>
        <button id="open-details" class="drawer-details">Details</button>
      </div>
      <div class="history-actions">
        <button id="history-back" aria-label="Back within explorer" title="Back within explorer" disabled>←</button>
        <button id="history-forward" aria-label="Forward within explorer" title="Forward within explorer" disabled>→</button>
      </div>
    </div>
    <div class="snapshot-row">
      <div id="snapshot" class="snapshot" aria-label="Exported snapshot totals"></div>
      <details class="export-info"><summary>Export details</summary><div id="export-details"></div></details>
    </div>
  </header>
  <div id="partial" class="warning" hidden>Partial graph — the node limit omitted symbols and their relationships. Absence of an edge or cyclic group is not proof of absence in the complete program.</div>
  <div class="workspace">
    <aside id="navigator" class="pane navigator" aria-label="Search and navigation">
      <div class="pane-head"><h2 id="navigator-title">Search</h2><button class="dialog-close" data-close-dialog aria-label="Close search">Close</button></div>
      <div class="stack search-content"><label for="search">Find a module or symbol <kbd>/</kbd></label>
        <div class="searchbar"><input id="search" type="search" autocomplete="off" placeholder="Name, path, or kind…"><button id="clear-search" aria-label="Clear search">×</button></div>
        <label class="sr-only" for="search-type">Result type</label><select id="search-type" class="search-filter"><option value="all">All</option><option value="module">Modules</option><option value="symbol">Symbols</option><option value="change">Changes</option></select>
        <p id="result-count" class="status" role="status"></p><div id="results" class="list"></div><div id="search-pages"></div>
      </div>
    </aside>
    <main class="main" id="main" tabindex="-1">
      <div class="main-head"><nav id="breadcrumbs" class="breadcrumbs" aria-label="Breadcrumb"></nav><h2 id="view-title">Overview</h2><p id="view-description" class="meta"></p></div>
      <div id="surface"></div>
    </main>
    <aside id="inspector" class="pane inspector" aria-label="Selection details">
      <div class="pane-head"><h2 id="inspector-title">Details</h2><button class="dialog-close" data-close-dialog aria-label="Close details">Close</button></div><div id="details" class="stack"></div>
    </aside>
  </div>
</div>
<div id="announcement" class="sr-only" role="status" aria-live="polite"></div>
<noscript>This offline explorer needs JavaScript to display the exported graph. Enable JavaScript and reopen this file; no network access is required.</noscript>
<script type="application/json" id="visualization-data">${json}</script>
<script>${VISUALIZATION_SCRIPT}</script>
</body>
</html>`;
}
