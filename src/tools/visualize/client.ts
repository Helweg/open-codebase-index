export const VISUALIZATION_SCRIPT: string = String.raw`
(() => {
    "use strict";
    const { data, analysis } = JSON.parse(document.getElementById("visualization-data").textContent);
    const $ = (id) => document.getElementById(id);
    const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    const nodeOrder = (a, b) => compare(a.name, b.name) || compare(a.filePath, b.filePath) || a.line - b.line || compare(a.id, b.id);
    const nodes = new Map(data.nodes.map((node) => [node.id, node]));
    const modules = new Map(data.modules.map((item) => [item.id, item]));
    const changes = new Map((data.changes || []).map((item) => [item.id, item]));
    const incoming = new Map(), outgoing = new Map(), members = new Map(), filesByModule = new Map();
    const moduleIncoming = new Map(), moduleOutgoing = new Map(), pairs = new Map();
    function append(map, key, value) { if (!map.has(key))
        map.set(key, []); map.get(key).push(value); }
    for (const node of nodes.values()) {
        append(members, node.moduleId, node);
        if (!filesByModule.has(node.moduleId)) filesByModule.set(node.moduleId, new Map());
        append(filesByModule.get(node.moduleId), node.filePath, node);
    }
    for (const list of members.values()) list.sort(nodeOrder);
    for (const files of filesByModule.values()) for (const list of files.values()) list.sort(nodeOrder);
    for (const edge of data.edges) {
        const source = nodes.get(edge.source), target = nodes.get(edge.target);
        if (!source || !target)
            continue;
        append(outgoing, edge.source, edge);
        append(incoming, edge.target, edge);
        if (source.moduleId === target.moduleId || !modules.has(source.moduleId) || !modules.has(target.moduleId)) continue;
        if (!pairs.has(source.moduleId))
            pairs.set(source.moduleId, new Map());
        append(pairs.get(source.moduleId), target.moduleId, edge);
    }
    for (const edge of data.moduleEdges) {
        if (!modules.has(edge.source) || !modules.has(edge.target))
            continue;
        append(moduleOutgoing, edge.source, edge);
        append(moduleIncoming, edge.target, edge);
    }
    const sortedNodes = [...nodes.values()].sort(nodeOrder);
    const sortedModules = [...modules.values()].sort((a, b) => compare(a.label, b.label) || compare(a.pathPrefix, b.pathPrefix) || compare(a.id, b.id));
    const hotspots = sortedNodes.map((node) => ({ node, inCount: (incoming.get(node.id) || []).length, outCount: (outgoing.get(node.id) || []).length }))
        .sort((a, b) => (b.inCount + b.outCount) - (a.inCount + a.outCount) || nodeOrder(a.node, b.node));
    const searchIndex = [
        ...sortedModules.map((item) => ({ type: "module", id: item.id, name: item.label, path: item.pathPrefix, text: [item.label, item.pathPrefix, item.category].join(" ") })),
        ...sortedNodes.map((item) => ({ type: "symbol", id: item.id, name: item.name, path: item.filePath, text: [item.name, item.filePath, item.kind].join(" ") })),
        ...[...changes.values()].map((item) => ({ type: "change", id: item.id, name: item.title, path: item.source, text: [item.title, item.summary, item.source, ...item.filePaths].join(" ") }))
    ].map((item) => ({ ...item, lowerName: item.name.toLowerCase(), haystack: item.text.toLowerCase() }));
    const pages = new Map(), pageActions = new Map();
    const analyses = ["changes", "hotspots", "cycles"];
    const scrollPositions = new Map(), openFiles = new Set(), moduleFilters = new Map();
    let route, query = "", resultType = "all", searchPage = 0, restoreFrame = 0;
    let activeDialog = null, dialogOpener = null, focusObserver = null;
    function selection() {
        return route.analysis === "changes" ? { type: "change", id: route.change } : { type: route.view, id: route.id };
    }
    function revealOwner(node) {
        const files = [...(filesByModule.get(node.moduleId) || [])].sort(([a], [b]) => compare(a, b));
        moduleFilters.delete(node.moduleId);
        pages.set("files:" + node.moduleId, Math.floor(files.findIndex(([path]) => path === node.filePath) / 50));
        const key = JSON.stringify([node.moduleId, node.filePath]);
        openFiles.add(key);
        pages.set("symbols:" + key, Math.floor((filesByModule.get(node.moduleId)?.get(node.filePath) || []).findIndex((item) => item.id === node.id) / 50));
    }
    function selectEntity(type, id) {
        if (type === "change") navigate({ view: route.view, id: route.id, analysis: "changes", change: id });
        else {
            if (type === "module" && route.view === "symbol") {
                const node = nodes.get(route.id);
                if (node?.moduleId === id) revealOwner(node);
            }
            navigate({ view: type, id });
        }
    }
    function el(tag, className, text) {
        const item = document.createElement(tag);
        if (className)
            item.className = className;
        if (text !== undefined)
            item.textContent = String(text);
        return item;
    }
    function button(text, action) {
        const item = el("button", "", text);
        item.type = "button";
        if (action)
            item.dataset.action = action;
        return item;
    }
    function entityButton(type, id, title, subtitle) {
        const item = button("");
        item.className = "card";
        item.dataset.entity = type;
        item.dataset.id = id;
        item.append(el("strong", "card-title", title));
        if (subtitle)
            item.append(el("span", "meta", subtitle));
        const selected = selection();
        if (selected.type === type && selected.id === id)
            item.setAttribute("aria-current", "true");
        return item;
    }
    function displayPath(filePath, moduleId) {
        const normalized = filePath.replace(/\\/g, "/"), prefix = modules.get(moduleId)?.pathPrefix.replace(/\\/g, "/");
        if (!prefix || normalized === prefix || normalized.startsWith(prefix + "/")) return filePath;
        const index = normalized.indexOf("/" + prefix + "/");
        if (index >= 0) return normalized.slice(index + 1);
        if (normalized.endsWith("/" + prefix)) return prefix;
        return filePath;
    }
    function pathLabel(filePath, moduleId, line) {
        const suffix = line === undefined ? "" : ":" + line;
        const label = el("span", "location mono", displayPath(filePath, moduleId) + suffix);
        label.title = filePath + suffix;
        return label;
    }
    function readableKind(kind) { return kind.replace(/_(declaration|definition)$/, "").replace(/_/g, " "); }
    function symbolButton(node, extra) {
        const item = entityButton("symbol", node.id, node.name);
        const kind = el("span", "kind-label", readableKind(node.kind));
        kind.title = node.kind;
        item.append(kind, pathLabel(node.filePath, node.moduleId, node.line));
        if (extra) item.append(el("span", "meta", extra));
        item.setAttribute("aria-label", node.name + ", " + node.kind + ", " + node.filePath + ":" + node.line + (extra ? ", " + extra : ""));
        return item;
    }
    function moduleButton(item) {
        const link = entityButton("module", item.id, item.label);
        link.append(pathLabel(item.pathPrefix, item.id));
        return link;
    }
    function originalLocation(node) {
        const disclosure = el("details", "original-location");
        disclosure.append(el("summary", "", "Original definition path"), el("p", "mono wrap", node.filePath + ":" + node.line));
        return disclosure;
    }
    function empty(text) { return el("div", "empty", text); }
    function heading(text) { return el("h3", "group-heading", text); }
    function kv(label, value) {
        const row = el("div", "kv");
        row.append(el("dt", "", label), el("dd", "", value));
        return row;
    }
    function facts(entries) { const list = el("dl"); for (const [label, value] of entries)
        list.append(kv(label, value)); return list; }
    function paged(items, key, renderItem, emptyText, pageSize = 50) {
        const root = el("div", "stack");
        function paint() {
            const count = Math.max(1, Math.ceil(items.length / pageSize));
            const page = Math.min(Math.max(0, pages.get(key) || 0), count - 1);
            pages.set(key, page);
            const list = el("div", "list");
            list.dataset.list = key;
            for (const item of items.slice(page * pageSize, (page + 1) * pageSize))
                list.append(renderItem(item));
            if (!items.length)
                list.append(empty(emptyText || "No matches in this snapshot."));
            const bar = el("div", "pager");
            const previous = button("Previous", "page"), next = button("Next", "page");
            previous.dataset.page = next.dataset.page = key;
            previous.dataset.delta = "-1";
            next.dataset.delta = "1";
            previous.disabled = page === 0;
            next.disabled = page === count - 1;
            bar.append(previous, el("span", "", (items.length ? page * pageSize + 1 : 0) + "–" + Math.min(items.length, (page + 1) * pageSize) + " of " + items.length), next);
            bar.hidden = count === 1;
            root.replaceChildren(list, bar);
        }
        pageActions.set(key, (delta) => {
            const focused = document.activeElement;
            pages.set(key, (pages.get(key) || 0) + delta);
            paint();
            if (focused && focused.dataset.page === key) {
                const controls = [...root.querySelectorAll("[data-action=page]")];
                (controls.find((item) => item.dataset.delta === String(delta) && !item.disabled) || controls.find((item) => !item.disabled))?.focus();
            }
            updateDirectoryCount();
            updateSearchHighlights();
            scheduleFocusEdges();
        });
        paint();
        return root;
    }
    function relationRecords(value) {
        return value.view === "module" ? pairs.get(value.from)?.get(value.to) || [] :
            (outgoing.get(value.from) || []).filter((edge) => edge.target === value.to);
    }
    function normalize(hash) {
        const params = new URLSearchParams(hash.replace(/^#/, ""));
        const view = params.get("view"), id = params.get("id");
        const primary = view === "module" && modules.has(id) || view === "symbol" && nodes.has(id);
        const value = primary ? { view, id } : { view: "overview" };
        if (analyses.includes(params.get("analysis"))) {
            value.analysis = params.get("analysis");
            if (value.analysis === "changes") {
                const change = params.get("change");
                if (changes.size) value.change = changes.has(change) ? change : changes.keys().next().value;
            }
        } else if (primary) {
            const from = params.get("from"), to = params.get("to"), index = view === "module" ? modules : nodes;
            const aggregate = view === "module" && (moduleOutgoing.get(from) || []).some((edge) => edge.target === to);
            if (index.has(from) && index.has(to) && (from === id || to === id) &&
                (aggregate || relationRecords({ view, from, to }).length)) Object.assign(value, { from, to });
        }
        return value;
    }
    function fragment(value) {
        const params = new URLSearchParams({ view: value.view });
        for (const key of ["id", "analysis", "change", "from", "to"]) if (value[key]) params.set(key, value[key]);
        return "#" + params;
    }
    const historyKey = "explorer-" + Math.random().toString(36).slice(2);
    let entry = 0, lastEntry = 0;
    function historyState() { return { explorer: historyKey, entry }; }
    function historyControls() { $("history-back").disabled = entry <= 0; $("history-forward").disabled = entry >= lastEntry; }
    function scopeKey() { return JSON.stringify([route.view, route.id || "", route.analysis || ""]); }
    function saveScroll() {
        if (!route) return;
        scrollPositions.set(scopeKey(), { main: $("main").scrollTop,
            lanes: [...document.querySelectorAll(".lane")].map((lane) => [lane.dataset.direction, lane.scrollTop]) });
    }
    function restoreScroll() {
        cancelAnimationFrame(restoreFrame);
        const saved = scrollPositions.get(scopeKey());
        restoreFrame = requestAnimationFrame(() => {
            $("main").scrollTop = saved?.main || 0;
            for (const lane of document.querySelectorAll(".lane")) lane.scrollTop = saved?.lanes.find(([direction]) => direction === lane.dataset.direction)?.[1] || 0;
            scheduleFocusEdges();
        });
    }
    function navigate(value, focus = "main") {
        const next = normalize(fragment(value));
        saveScroll();
        if (fragment(next) !== fragment(route)) {
            entry++;
            lastEntry = entry;
            history.pushState(historyState(), "", fragment(next));
        }
        route = next;
        closeDialog();
        render();
        if (focus === "inspector") {
            if (innerWidth < 1280) openDialog("inspector", $("open-details"));
            else $("evidence-title")?.focus({ preventScroll: true });
        } else $("main").focus({ preventScroll: true });
    }
    function restoreRoute() {
        saveScroll();
        const state = history.state;
        if (state?.explorer === historyKey) entry = state.entry;
        else { entry++; lastEntry = entry; }
        route = normalize(location.hash);
        history.replaceState(historyState(), "", fragment(route));
        closeDialog();
        render();
    }
    function openDialog(id, opener) {
        closeDialog();
        const pane = $(id);
        activeDialog = pane;
        dialogOpener = opener;
        pane.hidden = false;
        pane.setAttribute("role", "dialog");
        pane.setAttribute("aria-modal", "true");
        pane.setAttribute("aria-labelledby", id === "navigator" ? "navigator-title" : "inspector-title");
        for (const region of [document.querySelector(".header"), $("main"), $(id === "navigator" ? "inspector" : "navigator")])
            region.inert = true;
        (id === "navigator" ? $("search") : pane.querySelector("button, input, summary"))?.focus();
    }
    function closeDialog() {
        if (!activeDialog)
            return;
        activeDialog.removeAttribute("role");
        activeDialog.removeAttribute("aria-modal");
        activeDialog.removeAttribute("aria-labelledby");
        for (const region of [document.querySelector(".header"), $("main"), $("navigator"), $("inspector")])
            region.inert = false;
        activeDialog = null;
        dialogOpener?.focus();
        dialogOpener = null;
    }
    function renderSearch() {
        const q = query.trim().toLowerCase();
        const priority = { module: 0, symbol: 1, change: 2 };
        const matched = searchIndex.filter((item) => (resultType === "all" ? q || item.type === "module" : item.type === resultType) && (!q || item.haystack.includes(q)))
            .map((item) => ({ item, rank: item.lowerName === q ? 0 : item.lowerName.startsWith(q) ? 1 : 2 }))
            .sort((a, b) => a.rank - b.rank || priority[a.item.type] - priority[b.item.type] || compare(a.item.name, b.item.name) || compare(a.item.path, b.item.path) || compare(a.item.id, b.item.id));
        const count = Math.max(1, Math.ceil(matched.length / 50));
        searchPage = Math.min(searchPage, count - 1);
        $("result-count").textContent = matched.length + (!q && resultType === "all" ? " modules in this export" : " results");
        const items = matched.slice(searchPage * 50, (searchPage + 1) * 50).map(({ item }) => {
            if (item.type === "module") return moduleButton(modules.get(item.id));
            if (item.type === "symbol") return symbolButton(nodes.get(item.id));
            return entityButton("change", item.id, item.name, item.path);
        });
        $("results").replaceChildren(...(items.length ? items : [empty("No matches. Try a full path, name, or kind.")]));
        const bar = el("div", "pager"), prev = button("Previous", "search-prev"), next = button("Next", "search-next");
        prev.disabled = searchPage === 0;
        next.disabled = searchPage === count - 1;
        bar.append(prev, el("span", "", (searchPage + 1) + "/" + count), next);
        bar.hidden = count === 1;
        $("search-pages").replaceChildren(bar);
        updateSearchHighlights();
    }
    function updateSearchHighlights() {
        const q = query.trim().toLowerCase();
        for (const card of $("surface").querySelectorAll("[data-entity], [data-file-path]")) {
            let text = card.dataset.filePath || "";
            const item = card.dataset.entity === "module" ? modules.get(card.dataset.id) : nodes.get(card.dataset.id);
            if (item) text = card.dataset.entity === "module" ? [item.label, item.pathPrefix, item.category].join(" ") : [item.name, item.filePath, item.kind].join(" ");
            card.classList.toggle("search-match", Boolean(q && text.toLowerCase().includes(q)));
        }
    }
    function svg(tag, attributes, text) {
        const item = document.createElementNS("http://www.w3.org/2000/svg", tag);
        for (const [key, value] of Object.entries(attributes || {}))
            item.setAttribute(key, String(value));
        if (text !== undefined)
            item.textContent = text;
        return item;
    }
    const categoryBuckets = [
        ["Code", ["source", "native"]],
        ["Tests & fixtures", ["test", "fixture"]],
        ["Supporting files", ["command", "script", "doc", "benchmark", "other"]]
    ];
    const activeCategories = new Set(categoryBuckets.map(([label]) => label));
    function moduleCounts(item) {
        return {
            symbols: (members.get(item.id) || []).length,
            files: filesByModule.get(item.id)?.size || 0,
            incoming: new Set((moduleIncoming.get(item.id) || []).map((edge) => edge.source)).size,
            outgoing: new Set((moduleOutgoing.get(item.id) || []).map((edge) => edge.target)).size
        };
    }
    function metric(label, value) {
        const item = el("span", "metric");
        item.append(el("strong", "", value.toLocaleString("en")), document.createTextNode(" "), el("span", "", label));
        return item;
    }
    function moduleStats(item) {
        const counts = moduleCounts(item), stats = el("span", "card-stats");
        stats.append(metric("symbols", counts.symbols), metric("files", counts.files));
        return stats;
    }
    function updateDirectoryCount() {
        const count = $("overview-count");
        if (count) count.textContent = $("surface").querySelectorAll("[data-entity=module]").length + " of " + count.dataset.total + " exported modules shown";
    }
    function renderOverview() {
        if (!modules.size) {
            $("surface").append(empty("No exported modules in this snapshot. No symbols or relationships have been invented."));
            return;
        }
        const root = el("div", "stack directory"), controls = el("div", "row category-filters");
        const groups = categoryBuckets.map(([label, categories]) => ({ label, items: sortedModules.filter((item) => categories.includes(item.category)) }));
        for (const { label, items } of groups) {
            const control = el("label", "category-control"), input = el("input");
            input.type = "checkbox";
            input.checked = activeCategories.has(label);
            input.disabled = !items.length;
            input.addEventListener("change", () => {
                if (input.checked) activeCategories.add(label); else activeCategories.delete(label);
                paint();
            });
            control.append(input, document.createTextNode(label), el("span", "category-count", items.length));
            controls.append(control);
        }
        const content = el("div", "stack");
        function paint() {
            const enabled = groups.filter(({ label, items }) => activeCategories.has(label) && items.length);
            content.replaceChildren();
            const count = el("p", "meta");
            count.id = "overview-count";
            count.dataset.total = enabled.reduce((sum, { items }) => sum + items.length, 0);
            content.append(count);
            if (!enabled.length) {
                content.append(empty("No categories selected"));
                const show = button("Show all categories");
                show.addEventListener("click", () => {
                    for (const { label } of groups) activeCategories.add(label);
                    for (const input of controls.querySelectorAll("input")) input.checked = true;
                    paint();
                });
                content.append(show);
            }
            for (const { label, items } of enabled) {
                const section = el("section", "overview-section");
                const title = el("div", "section-heading");
                title.append(heading(label), el("span", "count-badge", items.length));
                section.append(title, paged(items, "overview:" + label, (item) => {
                    const card = moduleButton(item), counts = moduleCounts(item);
                    card.classList.add("directory-card");
                    card.append(el("span", "badge category-badge", item.category), moduleStats(item),
                        el("span", "card-footer", counts.incoming + " incoming · " + counts.outgoing + " outgoing modules"));
                    return card;
                }));
                content.append(section);
            }
            updateDirectoryCount();
            updateSearchHighlights();
        }
        root.append(controls, el("p", "scope-note", "Path-based groups · Counts describe the exported slice. Category filters apply only to this directory."), content);
        $("surface").append(root);
        paint();
    }
    function edgeRecord(edge) {
        const source = nodes.get(edge.source), target = nodes.get(edge.target);
        const row = el("div", "edge-record");
        const meta = el("div", "row callsite-meta");
        meta.append(el("span", "eyebrow", "Callsite"), el("span", "badge", edge.callType), el("span", "meta", edge.confidence));
        row.append(meta, pathLabel(source.filePath, source.moduleId, edge.line),
            symbolButton(source, "Caller definition"), symbolButton(target, "Callee definition"));
        return row;
    }
    function groupedNeighbors(records, field) {
        const groups = new Map();
        for (const edge of records)
            append(groups, edge[field], edge);
        return [...groups].map(([id, edges]) => ({ node: nodes.get(id), edges })).sort((a, b) => b.edges.length - a.edges.length || nodeOrder(a.node, b.node));
    }
    function filteredFiles(id) {
        const q = (moduleFilters.get(id) || "").trim().toLowerCase();
        return [...(filesByModule.get(id) || [])].sort(([a], [b]) => compare(a, b)).map(([path, definitions]) => {
            const matched = !q || path.toLowerCase().includes(q) ? definitions :
                definitions.filter((node) => (node.name + " " + node.kind).toLowerCase().includes(q));
            return { path, definitions, matched };
        }).filter(({ matched }) => matched.length);
    }
    function renderModule() {
        const id = route.id;
        renderFocusGraph("module", id);
        const section = el("section", "section files-section stack"), title = heading("Files and symbols");
        title.id = "files-title";
        title.tabIndex = -1;
        const label = el("label", "", "Filter files or symbols"), input = el("input"), clear = button("Clear filter");
        input.type = "search";
        input.id = "module-filter";
        input.value = moduleFilters.get(id) || "";
        label.htmlFor = input.id;
        const content = el("div", "stack");
        function paint() {
            content.replaceChildren(paged(filteredFiles(id), "files:" + id, ({ path, definitions, matched }) => {
                const key = JSON.stringify([id, path]), disclosure = el("details", "file-group"), summary = el("summary");
                summary.dataset.filePath = path;
                summary.append(pathLabel(path, id), el("span", "meta file-count", matched.length === definitions.length ?
                    definitions.length + (definitions.length === 1 ? " symbol" : " symbols") : matched.length + " of " + definitions.length + " symbols"));
                disclosure.append(summary);
                let materialized = false;
                function populate() {
                    if (!materialized) {
                        disclosure.append(paged(matched, "symbols:" + key, (node) => {
                            const link = symbolButton(node);
                            link.querySelector(".location").textContent = "Line " + node.line;
                            return link;
                        }));
                        materialized = true;
                        updateSearchHighlights();
                    }
                }
                disclosure.addEventListener("toggle", () => {
                    if (disclosure.open) { openFiles.add(key); populate(); } else openFiles.delete(key);
                    scheduleFocusEdges();
                });
                if (openFiles.has(key)) { disclosure.open = true; populate(); }
                return disclosure;
            }, (members.get(id) || []).length ? "No files or symbols match this module-local filter." : "No exported symbols in this module."));
            updateSearchHighlights();
        }
        function filter(value) {
            moduleFilters.set(id, value);
            pages.delete("files:" + id);
            for (const path of filesByModule.get(id)?.keys() || []) pages.delete("symbols:" + JSON.stringify([id, path]));
            paint();
        }
        input.addEventListener("input", () => filter(input.value));
        clear.addEventListener("click", () => { input.value = ""; filter(""); input.focus(); });
        const filters = el("div", "local-filter");
        filters.append(label, input, clear);
        section.append(title, filters, content);
        $("surface").append(section);
        paint();
    }
    function renderModuleDetails(item, details) {
        details.append(heading(item.label), el("p", "mono wrap", item.pathPrefix),
            facts([["Category", item.category], ["Exported symbols", (members.get(item.id) || []).length], ["Represented files", filesByModule.get(item.id)?.size || 0]]),
            heading("Symbol kinds"), facts(Object.entries(item.kinds).sort(([a], [b]) => compare(a, b))));
    }
    function renderSymbolDetails(node, details) {
        const ins = incoming.get(node.id) || [], outs = outgoing.get(node.id) || [];
        details.append(heading(node.name), pathLabel(node.filePath, node.moduleId, node.line),
            facts([["Kind", readableKind(node.kind)], ["Definition line", node.line]]),
            heading("Call summary"), facts([
                ["Callers", new Set(ins.map((edge) => edge.source)).size],
                ["Callees", new Set(outs.map((edge) => edge.target)).size],
                ["Incoming calls", ins.length], ["Outgoing calls", outs.length]]), originalLocation(node));
        const module = modules.get(node.moduleId);
        if (module)
            details.append(heading("Module"), moduleButton(module));
        details.append(el("p", "scope-note", "Totals include self-calls. Source bodies are not included in this export."));
    }
    function changeDetails(item, details) {
        const structural = item.source === "call graph";
        details.append(heading(item.title), el("p", "wrap", item.summary), facts([["Source", structural ? "Structural context (call graph)" : item.source],
            ["When", structural ? "Snapshot structure, not recent activity" : item.when],
            ["Intent", item.intent], ["Attention (heuristic)", item.risk],
            ["Represented call edges", item.calls],
            ["Additions/deletions in represented indexed files", item.churn]]), el("p", "wrap", structural ? "No matching recent Git activity was included in this snapshot. This record describes call-graph structure, not recent changes." : item.why));
        const module = modules.get(item.moduleId), node = nodes.get(item.focusNodeId);
        if (module)
            details.append(heading("Related module"), moduleButton(module));
        if (node)
            details.append(heading("Related symbol"), symbolButton(node));
        details.append(heading("Provided file paths"), el("p", "meta", "Sampled paths supplied by this activity record; not an exhaustive changed-file list."));
        for (const path of item.filePaths)
            details.append(el("p", "mono wrap meta", path));
    }
    function inspectRelationship(from, to) {
        navigate({ view: route.view, id: route.id, from, to }, "inspector");
    }
    function relationshipDetails(details) {
        const isModule = route.view === "module", index = isModule ? modules : nodes;
        const source = index.get(route.from), target = index.get(route.to), records = relationRecords(route);
        const title = heading("Call relationship");
        title.id = "evidence-title";
        title.tabIndex = -1;
        details.append(title);
        const endpoints = el("div", "relationship-endpoints stack");
        for (const [label, item] of [["Caller", source], ["Callee", target]]) {
            endpoints.append(el("span", "eyebrow", label), isModule ? moduleButton(item) : symbolButton(item));
        }
        details.append(endpoints, facts([["Original call records", records.length]]));
        for (const [field, label] of [["callType", "Call types"], ["confidence", "Confidence"]]) {
            const counts = new Map();
            for (const record of records) counts.set(record[field], (counts.get(record[field]) || 0) + 1);
            details.append(heading(label), facts([...counts].sort(([a], [b]) => compare(a, b))));
        }
        details.append(paged(records, JSON.stringify(["evidence", route.view, route.from, route.to]), edgeRecord, "No contributing callsite records in this export"),
            button("Back to " + route.view + " details", "clear-evidence"));
    }
    let inspectorSelection = "";
    function renderDetails() {
        const details = $("details"), selected = selection();
        const key = JSON.stringify([selected.type, selected.id, route.from, route.to]);
        if (inspectorSelection !== key) $("inspector").scrollTop = 0;
        inspectorSelection = key;
        if (route.from && route.to) relationshipDetails(details);
        else if (selected.type === "module") renderModuleDetails(modules.get(selected.id), details);
        else if (selected.type === "symbol") renderSymbolDetails(nodes.get(selected.id), details);
        else if (selected.type === "change" && selected.id) changeDetails(changes.get(selected.id), details);
        else details.append(empty("Select a module or symbol to inspect the exported snapshot. Source bodies are not included."));
    }
    let focusFrame = 0;
    function scheduleFocusEdges() {
        if (!focusFrame) focusFrame = requestAnimationFrame(() => { focusFrame = 0; drawFocusEdges(); });
    }
    function drawFocusEdges() {
        const flow = document.querySelector(".flow"), root = document.querySelector(".focus-edges"), center = $("focus-node");
        if (!flow || !root || !center) return;
        flow.classList.toggle("stacked", flow.clientWidth < 720);
        root.replaceChildren();
        if (flow.classList.contains("stacked")) return;
        const box = flow.getBoundingClientRect(), middle = center.getBoundingClientRect();
        root.setAttribute("viewBox", "0 0 " + box.width + " " + box.height);
        const defs = svg("defs"), marker = svg("marker", { id: "focus-arrow", viewBox: "0 0 10 10", refX: 10, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto" });
        marker.append(svg("path", { d: "M0 0L10 5L0 10Z", fill: "var(--accent)" }));
        defs.append(marker);
        root.append(defs);
        for (const lane of flow.querySelectorAll(".lane")) {
            const laneBox = lane.getBoundingClientRect();
            for (const card of lane.querySelectorAll(".neighbor-link")) {
                const rect = card.getBoundingClientRect();
                if (rect.bottom <= Math.max(0, laneBox.top) || rect.top >= Math.min(innerHeight, laneBox.bottom)) continue;
                const isIncoming = lane.dataset.direction === "incoming";
                const y = Math.max(laneBox.top, Math.min(laneBox.bottom, rect.top + rect.height / 2)) - box.top;
                const x1 = (isIncoming ? rect.right : middle.right) - box.left;
                const x2 = (isIncoming ? middle.left : rect.left) - box.left;
                const y1 = isIncoming ? y : middle.top + middle.height / 2 - box.top;
                const y2 = isIncoming ? middle.top + middle.height / 2 - box.top : y;
                const mid = (x1 + x2) / 2, from = card.dataset.from, to = card.dataset.to;
                const d = "M" + x1 + "," + y1 + " C" + mid + "," + y1 + " " + mid + "," + y2 + " " + x2 + "," + y2;
                const selected = route.from === from && route.to === to;
                const line = svg("path", { d, class: "connection" + (selected ? " selected" : ""), "marker-end": "url(#focus-arrow)" });
                const hit = svg("path", { d, class: "connection-hit", "data-from": from, "data-to": to, "data-action": "inspect" });
                root.append(line, hit);
            }
        }
    }
    function inspectButton(from, to, count) {
        const control = button("Inspect " + count + (count === 1 ? " call" : " calls"), "inspect");
        control.className = "inspect-control";
        control.dataset.from = from;
        control.dataset.to = to;
        control.classList.toggle("selected", route.from === from && route.to === to);
        control.setAttribute("aria-label", control.textContent + ": " + (route.view === "module" ? modules.get(from)?.pathPrefix : nodes.get(from)?.name) + " → " + (route.view === "module" ? modules.get(to)?.pathPrefix : nodes.get(to)?.name));
        return control;
    }
    function renderFocusGraph(type, id) {
        const isModule = type === "module", item = (isModule ? modules : nodes).get(id);
        const scene = el("section", "focus-scene"), flow = el("div", "flow"), jumps = el("nav", "focus-jumps");
        jumps.setAttribute("aria-label", "Jump within " + type);
        function jump(label, target) {
            const control = button(label, "jump-section");
            control.dataset.target = target;
            jumps.append(control);
        }
        jump("Focus", "focus-node");
        flow.append(svg("svg", { class: "focus-edges", "aria-hidden": "true" }));
        function lane(direction) {
            const isIncoming = direction === "incoming", section = el("section", "lane"), field = isIncoming ? "source" : "target";
            section.dataset.direction = direction;
            section.id = direction + "-lane";
            section.tabIndex = -1;
            let neighbors;
            if (isModule) {
                const grouped = new Map();
                for (const edge of (isIncoming ? moduleIncoming : moduleOutgoing).get(id) || []) {
                    if (edge[field] !== id) grouped.set(edge[field], (grouped.get(edge[field]) || 0) + edge.weight);
                }
                neighbors = [...grouped].map(([other, count]) => ({ node: modules.get(other), count })).sort((a, b) => b.count - a.count ||
                    compare(a.node.label, b.node.label) || compare(a.node.pathPrefix, b.node.pathPrefix) || compare(a.node.id, b.node.id));
            } else neighbors = groupedNeighbors((isIncoming ? incoming : outgoing).get(id) || [], field)
                .filter(({ node }) => node.id !== id).map(({ node, edges }) => ({ node, count: edges.length }));
            const label = isModule ? (isIncoming ? "Incoming modules" : "Outgoing modules") : (isIncoming ? "Callers" : "Callees");
            jump((isModule ? (isIncoming ? "Incoming" : "Outgoing") : label) + " " + neighbors.length, section.id);
            const title = el("div", "lane-heading");
            title.append(heading((isIncoming ? "" : "→ ") + label + (isIncoming ? " →" : "")), el("span", "count-badge", neighbors.length));
            const callCount = neighbors.reduce((sum, neighbor) => sum + neighbor.count, 0);
            section.append(title, el("p", "lane-summary", callCount.toLocaleString("en") + " contributing " + (callCount === 1 ? "call" : "calls")));
            section.append(paged(neighbors, JSON.stringify([type, id, direction]), ({ node, count }) => {
                const row = el("div", "neighbor-row"), link = isModule ? moduleButton(node) : symbolButton(node);
                const from = isIncoming ? node.id : id, to = isIncoming ? id : node.id;
                link.classList.add("neighbor-link");
                link.dataset.from = from;
                link.dataset.to = to;
                row.append(link, inspectButton(from, to, count));
                return row;
            }, "No resolved " + direction + " neighbors in this exported snapshot.", 12));
            section.addEventListener("scroll", scheduleFocusEdges, { passive: true });
            return section;
        }
        const center = el("section", "focus-lane"), card = el("div", "focus-card stack");
        card.id = "focus-node";
        card.tabIndex = -1;
        card.append(el("span", "eyebrow", "Selected " + type), heading(isModule ? item.label : item.name),
            pathLabel(isModule ? item.pathPrefix : item.filePath, isModule ? id : item.moduleId, isModule ? undefined : item.line));
        if (isModule) {
            card.append(el("span", "badge", item.category), moduleStats(item), button("Browse files", "browse-files"));
        } else {
            const kind = el("span", "kind-label", readableKind(item.kind));
            kind.title = item.kind;
            card.append(kind);
            const counts = el("span", "card-stats");
            counts.append(metric("callers", new Set((incoming.get(id) || []).map((edge) => edge.source).filter((other) => other !== id)).size),
                metric("callees", new Set((outgoing.get(id) || []).map((edge) => edge.target).filter((other) => other !== id)).size));
            card.append(counts);
            const self = (outgoing.get(id) || []).filter((edge) => edge.target === id);
            if (self.length) {
                const row = el("div", "self-calls");
                row.append(el("span", "meta", "Self-calls (" + self.length + ")"), inspectButton(id, id, self.length));
                card.append(row);
            }
            const actions = el("div", "focus-actions");
            if (modules.has(item.moduleId)) {
                const owner = button("Module: " + modules.get(item.moduleId).label);
                owner.dataset.entity = "module";
                owner.dataset.id = item.moduleId;
                actions.append(owner);
            }
            actions.append(button("Copy location", "copy-location"));
            const status = el("div", "stack");
            status.id = "copy-status";
            status.setAttribute("role", "status");
            card.append(actions, status, el("p", "scope-note", "Definition metadata only. No source bodies."));
        }
        center.append(card);
        flow.append(lane("incoming"), center, lane("outgoing"));
        if (isModule) jump("Files", "files-title");
        scene.append(jumps, el("p", "scope-note scene-note", isModule ?
            "Cross-module calls only. Browse files for internal symbol relationships." : "Caller → selected symbol → callee. Lane counts exclude self-calls."),
            flow);
        $("surface").append(scene);
        focusObserver = new ResizeObserver(scheduleFocusEdges);
        focusObserver.observe(flow);
        for (const section of flow.querySelectorAll(".lane, .focus-card")) focusObserver.observe(section);
        scheduleFocusEdges();
    }
    function renderChanges() {
        const root = el("div", "view-list");
        if (!changes.size)
            root.append(empty("No activity records were included in this snapshot."));
        for (const structural of [false, true]) {
            const records = [...changes.values()].filter((item) => (item.source === "call graph") === structural);
            if (!records.length)
                continue;
            root.append(heading(structural ? "Structural context" : "Recent Git activity"), el("p", "meta", structural ? "Call-graph context, not recent history. No matching recent Git activity was included for these records." : "90-day history scope, limited to represented indexed files."));
            root.append(paged(records, structural ? "structural-changes" : "git-changes", (item) => entityButton("change", item.id, item.title, (structural ? "Call graph" : item.source + " \u00B7 " + item.when) + " \u00B7 Attention (heuristic): " + item.risk + " \u00B7 " + item.summary)));
        }
        $("surface").append(root);
    }
    function renderHotspots() {
        $("surface").append(paged(hotspots, "hotspots", ({ node, inCount, outCount }) => symbolButton(node, (inCount + outCount) + " score = " + inCount + " incoming + " + outCount + " outgoing call edges"), "No symbols were exported. Hotspot scores require an exported call graph."));
    }
    function renderCycles() {
        const root = el("div", "view-list");
        root.append(el("p", "meta", "Members of a cyclic group are mutually reachable through resolved calls. This is not an ordered cycle path; a one-member group means a self-edge."));
        for (const [type, groups] of [["module", analysis.moduleCycles], ["symbol", analysis.symbolCycles]]) {
            root.append(heading((type === "module" ? "Module" : "Symbol") + " cyclic groups (" + groups.length + ")"));
            root.append(paged(groups, type + "-cycles", (group) => {
                const details = el("details");
                const first = type === "module" ? modules.get(group[0]).label : nodes.get(group[0]).name;
                details.append(el("summary", "", first + " \u00B7 " + group.length + " " + (type === "module" ? "modules" : "symbols") + (group.length === 1 ? " \u00B7 self-recursion" : " \u00B7 mutually reachable")));
                details.addEventListener("toggle", () => {
                    if (details.open && details.children.length === 1)
                        details.append(paged(group, type + "-group:" + group[0], (id) => type === "module" ? moduleButton(modules.get(id)) : symbolButton(nodes.get(id))));
                });
                return details;
            }, "No " + type + " cyclic groups among resolved edges in this exported graph."));
        }
        $("surface").append(root);
    }
    function renderContent() {
        if (route.analysis) {
            const bar = el("div", "row analysis-heading");
            bar.append(heading(route.analysis[0].toUpperCase() + route.analysis.slice(1)), el("span", "badge", "Whole exported snapshot"), button("Back to exploration", "explore"));
            $("surface").append(bar);
            if (route.analysis === "changes") renderChanges();
            else if (route.analysis === "hotspots") renderHotspots();
            else renderCycles();
        } else if (route.view === "module") renderModule();
        else if (route.view === "symbol") renderFocusGraph("symbol", route.id);
        else renderOverview();
    }
    function render() {
        focusObserver?.disconnect();
        cancelAnimationFrame(focusFrame);
        focusFrame = 0;
        pageActions.clear();
        $("surface").replaceChildren();
        $("details").replaceChildren();
        const crumbs = [], overview = route.view === "overview" ? el("span", "", "Overview") : button("Overview");
        if (route.view !== "overview") overview.dataset.view = "overview";
        crumbs.push(overview);
        let title = "Repository overview", description = "Choose a module to explore its files, definitions, and calls.";
        if (route.view === "module") {
            title = modules.get(route.id).label;
            description = modules.get(route.id).pathPrefix;
        } else if (route.view === "symbol") {
            const node = nodes.get(route.id), owner = modules.get(node.moduleId);
            if (owner) {
                const parent = button(owner.label);
                parent.dataset.entity = "module";
                parent.dataset.id = owner.id;
                crumbs.push(el("span", "meta", "/"), parent);
            }
            title = node.name;
            description = displayPath(node.filePath, node.moduleId) + ":" + node.line;
        }
        if (route.view !== "overview") crumbs.push(el("span", "meta", "/"), el("span", "wrap", title));
        $("breadcrumbs").replaceChildren(...crumbs);
        $("view-title").textContent = title;
        $("view-description").textContent = description;
        $("view-description").title = route.view === "symbol" ? nodes.get(route.id).filePath + ":" + nodes.get(route.id).line : description;
        document.querySelector("[data-view=overview]").setAttribute("aria-current", route.view === "overview" && !route.analysis ? "page" : "false");
        $("analyze").value = route.analysis || "";
        renderContent();
        renderDetails();
        renderSearch();
        historyControls();
        restoreScroll();
        $("announcement").textContent = title + (route.analysis ? " · " + route.analysis + " · Whole exported snapshot" : "");
    }
    async function copyLocation() {
        const node = nodes.get(route.id);
        if (!node)
            return;
        const location = node.filePath + ":" + node.line, status = $("copy-status");
        try {
            await navigator.clipboard.writeText(location);
            if (status.isConnected)
                status.replaceChildren(el("p", "status", "Location copied."));
        }
        catch {
            if (!status.isConnected)
                return;
            const label = el("label", "status", "Clipboard unavailable. Select this location and copy it manually.");
            const field = el("input", "copy-field mono");
            field.readOnly = true;
            field.value = location;
            label.append(field);
            status.replaceChildren(label);
            field.focus();
            field.select();
        }
    }
    document.addEventListener("click", (event) => {
        const target = event.target.closest("button, [data-action], [data-entity], [data-close-dialog]");
        if (!target)
            return;
        if (target.hasAttribute("data-close-dialog")) {
            closeDialog();
            return;
        }
        if (target.dataset.entity) {
            selectEntity(target.dataset.entity, target.dataset.id);
            return;
        }
        if (target.dataset.view) {
            navigate({ view: target.dataset.view });
            return;
        }
        const action = target.dataset.action;
        if (action === "page")
            pageActions.get(target.dataset.page)?.(Number(target.dataset.delta));
        else if (action === "search-prev" || action === "search-next") {
            searchPage += action === "search-next" ? 1 : -1;
            renderSearch();
            const next = $("search-pages").querySelector("[data-action=" + action + "]");
            (next.disabled ? $("search-pages").querySelector("button:not(:disabled)") : next)?.focus();
            $("navigator").scrollTop = 0;
        }
        else if (action === "inspect") inspectRelationship(target.dataset.from, target.dataset.to);
        else if (action === "clear-evidence" || action === "explore") navigate({ view: route.view, id: route.id });
        else if (action === "browse-files" || action === "jump-section") {
            const section = $(action === "browse-files" ? "files-title" : target.dataset.target);
            section?.scrollIntoView({ block: "start" });
            section?.focus({ preventScroll: true });
        }
        else if (action === "copy-location")
            void copyLocation();
    });
    document.addEventListener("keydown", (event) => {
        if (activeDialog && event.key === "Escape") {
            event.preventDefault();
            closeDialog();
            return;
        }
        if (event.key === "Escape" && document.querySelector(".export-info[open]")) {
            event.preventDefault();
            const disclosure = document.querySelector(".export-info");
            disclosure.open = false;
            disclosure.querySelector("summary").focus();
            return;
        }
        if (activeDialog && event.key === "Tab") {
            const focusable = [...activeDialog.querySelectorAll("button:not(:disabled), input, select, summary, [tabindex='0']")].filter((item) => item.getClientRects().length);
            const first = focusable[0], last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
            }
            else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
        }
        if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.target.closest("input, textarea, select, [contenteditable=true]")) {
            event.preventDefault();
            if (innerWidth < 1024)
                openDialog("navigator", $("open-search"));
            else
                $("search").focus();
        }
    });
    $("search").addEventListener("input", (event) => { query = event.target.value; searchPage = 0; renderSearch(); });
    $("search-type").addEventListener("change", (event) => { resultType = event.target.value; searchPage = 0; renderSearch(); });
    $("clear-search").addEventListener("click", () => { query = ""; $("search").value = ""; searchPage = 0; renderSearch(); $("search").focus(); });
    $("analyze").addEventListener("change", (event) => navigate({ view: route.view, id: route.id, analysis: event.target.value }));
    $("main").addEventListener("scroll", scheduleFocusEdges, { passive: true });
    $("open-search").addEventListener("click", (event) => openDialog("navigator", event.currentTarget));
    $("open-details").addEventListener("click", (event) => openDialog("inspector", event.currentTarget));
    $("history-back").addEventListener("click", () => { if (entry > 0)
        history.back(); });
    $("history-forward").addEventListener("click", () => { if (entry < lastEntry)
        history.forward(); });
    addEventListener("popstate", restoreRoute);
    addEventListener("hashchange", () => { if (fragment(route) !== location.hash)
        restoreRoute(); });
    addEventListener("resize", () => { if (activeDialog && ((activeDialog.id === "navigator" && innerWidth >= 1024) || (activeDialog.id === "inspector" && innerWidth >= 1280)))
        closeDialog(); scheduleFocusEdges(); });
    $("partial").hidden = !data.metadata.truncated;
    $("snapshot").append(metric("modules", modules.size), metric("symbols", nodes.size), metric("calls", data.edges.length));
    $("export-details").append(facts([["Input symbols", data.metadata.totalSymbols], ["Input call edges", data.metadata.totalEdges],
        ["Scope", data.metadata.directory || "All exported directories"]]), el("p", "scope-note", "Offline resolved-call snapshot, not every program dependency or live state."));
    route = normalize(location.hash);
    history.replaceState(historyState(), "", fragment(route));
    render();
})();
`;
