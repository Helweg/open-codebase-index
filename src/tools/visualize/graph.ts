import type { VisualizationData } from "./types.js";

export interface VisualizationGraphAnalysis {
  moduleCycles: string[][];
  symbolCycles: string[][];
}

interface Components {
  groups: string[][];
  outgoing: Map<string, Set<string>>;
}

// Iterative Kosaraju traversal: bounded by vertices + distinct edges, including deep chains.
function components(ids: string[], edges: Array<{ source: string; target: string }>): Components {
  const ordered = [...new Set(ids)].sort();
  const outgoing = new Map(ordered.map((id) => [id, new Set<string>()]));
  const incoming = new Map(ordered.map((id) => [id, new Set<string>()]));
  for (const { source, target } of edges) {
    if (!outgoing.has(source) || !outgoing.has(target)) continue;
    outgoing.get(source)!.add(target);
    incoming.get(target)!.add(source);
  }
  const adjacency = new Map([...outgoing].map(([id, targets]) => [id, [...targets].sort()]));
  const visited = new Set<string>();
  const finished: string[] = [];
  for (const id of ordered) {
    if (visited.has(id)) continue;
    visited.add(id);
    const stack = [{ id, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const targets = adjacency.get(frame.id)!;
      if (frame.next === targets.length) {
        finished.push(frame.id);
        stack.pop();
      } else {
        const target = targets[frame.next++];
        if (!visited.has(target)) {
          visited.add(target);
          stack.push({ id: target, next: 0 });
        }
      }
    }
  }
  visited.clear();
  const groups: string[][] = [];
  for (let i = finished.length - 1; i >= 0; i--) {
    const start = finished[i];
    if (visited.has(start)) continue;
    const group: string[] = [];
    const stack = [start];
    visited.add(start);
    while (stack.length) {
      const id = stack.pop()!;
      group.push(id);
      for (const predecessor of incoming.get(id)!) {
        if (visited.has(predecessor)) continue;
        visited.add(predecessor);
        stack.push(predecessor);
      }
    }
    groups.push(group.sort());
  }
  groups.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return { groups, outgoing };
}

function cyclicGroups({ groups, outgoing }: Components): string[][] {
  return groups.filter((group) => group.length > 1 || outgoing.get(group[0])!.has(group[0]));
}

export function analyzeVisualizationGraph(data: VisualizationData): VisualizationGraphAnalysis {
  const modules = components(data.modules.map((module) => module.id), data.moduleEdges);
  const symbols = components(data.nodes.map((node) => node.id), data.edges);
  return {
    moduleCycles: cyclicGroups(modules),
    symbolCycles: cyclicGroups(symbols),
  };
}
