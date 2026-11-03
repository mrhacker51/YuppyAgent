"use client";

import { useCallback, useEffect, useMemo, type MouseEvent } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  getBezierPath,
  useNodesState,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useHudStore } from "@/lib/store";
import { resolveEffects, useEffectsStore } from "@/lib/effects";
import { cityFromGraph } from "@/lib/city";
import { buildGraph } from "@/lib/networkGraph";
import { graphStats, project2D } from "@/lib/universe";
import PixiField from "./PixiField";

interface FlowNodeData extends Record<string, unknown> {
  label: string;
  sub: string;
  color: string;
  status: string;
  kind: string;
  selected: boolean;
}

type FlowNode = Node<FlowNodeData, "yuppy">;

interface FlowEdgeData extends Record<string, unknown> {
  color: string;
  active: boolean;
  kind: string;
}

type FlowEdge = Edge<FlowEdgeData, "yuppy">;

const STATUS_LABEL: Record<string, string> = {
  idle: "boşta",
  ready: "hazır",
  live: "canlı",
  busy: "çalışıyor",
  completed: "tamamlandı",
  failed: "hata",
  offline: "yok",
  disabled: "kapalı",
};

function FlowNodeView({ data, selected }: NodeProps<FlowNode>) {
  const state = `${selected || data.selected ? "is-selected" : ""} ${
    data.status === "failed" ? "is-failed" : ""
  } ${data.status === "busy" || data.status === "live" ? "is-active" : ""}`;
  const tone = { ["--rf-node-color" as string]: data.color };

  // Same city as the 3D stage: departments are towers, agents are pods on
  // the plot, the core is the central plaza.
  if (data.kind === "department") {
    return (
      <div className={`rf-tower ${state}`} style={tone}>
        <span className="rf-tower-roof" aria-hidden />
        <span className="rf-tower-facade" aria-hidden />
        <span className="rf-node-copy">
          <span className="rf-tower-kicker">Tower</span>
          <span className="rf-node-label">{data.label}</span>
          <span className="rf-node-sub">
            <span className="rf-node-status">{STATUS_LABEL[data.status] ?? data.status}</span>
            <span className="rf-node-sep">·</span>
            {data.sub}
          </span>
        </span>
        <Handle type="target" position={Position.Left} className="rf-handle" />
        <Handle type="source" position={Position.Right} className="rf-handle" />
      </div>
    );
  }

  if (data.kind === "core") {
    return (
      <div className={`rf-plaza ${state}`} style={tone}>
        <span className="rf-node-core" aria-hidden />
        <span className="rf-node-copy">
          <span className="rf-tower-kicker">Plaza</span>
          <span className="rf-node-label">{data.label}</span>
        </span>
        <Handle type="target" position={Position.Left} className="rf-handle" />
        <Handle type="source" position={Position.Right} className="rf-handle" />
      </div>
    );
  }

  return (
    <div className={`rf-pod ${state}`} style={tone}>
      <span className="rf-node-halo" aria-hidden />
      <span className="rf-node-core" aria-hidden />
      <span className="rf-node-copy">
        <span className="rf-node-label">{data.label}</span>
        <span className="rf-node-sub">
          <span className="rf-node-status">{STATUS_LABEL[data.status] ?? data.status}</span>
          <span className="rf-node-sep">·</span>
          {data.sub}
        </span>
      </span>
      <Handle type="target" position={Position.Left} className="rf-handle" />
      <Handle type="source" position={Position.Right} className="rf-handle" />
    </div>
  );
}

function FlowEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<FlowEdge>) {
  // Roads, not arcs: an almost-straight street with an asphalt casing and a
  // dashed centre line, live traffic shown by the animated overlay.
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    curvature: 0.08,
  });
  const color = data?.color ?? "#3f3f46";
  const active = data?.active ?? false;
  return (
    <>
      <BaseEdge
        id={`${id}-bed`}
        path={path}
        style={{
          stroke: "#12151b",
          strokeWidth: active ? 7 : 5,
          opacity: 0.95,
          strokeLinecap: "round",
        }}
      />
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: color,
          strokeWidth: active ? 1.4 : 1,
          strokeDasharray: active ? undefined : "5 6",
          opacity: active ? 0.95 : 0.4,
          filter: active ? `drop-shadow(0 0 3px ${color})` : undefined,
        }}
      />
      {active && (
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={3.4}
          strokeLinecap="round"
          className="rf-edge-flow"
          aria-hidden
        />
      )}
    </>
  );
}

const nodeTypes = { yuppy: FlowNodeView };
const edgeTypes = { yuppy: FlowEdgeView };

export default function FlowNetwork() {
  const departments = useHudStore((s) => s.departments);
  const agents = useHudStore((s) => s.agents);
  const sessions = useHudStore((s) => s.sessions);
  const tasks = useHudStore((s) => s.tasks);
  const conflicts = useHudStore((s) => s.conflicts);
  const status = useHudStore((s) => s.status);
  const selectedDept = useHudStore((s) => s.selectedDept);
  const selectedAgent = useHudStore((s) => s.selectedAgent);

  const settings = useEffectsStore((s) => s.settings);
  const resolved = useMemo(() => resolveEffects(settings, false), [settings]);

  const graph = useMemo(
    () =>
      buildGraph({
        departments,
        agents,
        sessions,
        tasks,
        conflicts,
        selectedDept,
        selectedAgent,
      }),
    [departments, agents, sessions, tasks, conflicts, selectedDept, selectedAgent],
  );
  const model = useMemo(() => cityFromGraph(graph), [graph]);
  const stats = useMemo(() => graphStats(graph), [graph]);
  const signature = useMemo(() => model.nodes.map((n) => n.id).join("|"), [model.nodes]);

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);

  useEffect(() => {
    setNodes((previous) => {
      const map = new Map(previous.map((node) => [node.id, node]));
      return model.nodes.map((node) => {
        const existing = map.get(node.id);
        const position = existing?.position ?? project2D(node.position, 30);
        return {
          id: node.id,
          type: "yuppy",
          position,
          selected: node.selected,
          draggable: true,
          data: {
            label: node.label,
            sub: node.sub,
            color: node.color,
            status: node.status,
            kind: node.kind,
            selected: node.selected,
          },
        } satisfies FlowNode;
      });
    });
  }, [model, signature, setNodes]);

  const edges = useMemo<FlowEdge[]>(
    () =>
      model.edges.map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        type: "yuppy",
        animated: false,
        data: { color: edge.color, active: edge.active, kind: edge.kind },
        style: { stroke: edge.color, strokeWidth: edge.active ? 1.7 : 1 },
      })),
    [model.edges],
  );

  const onNodeClick = useCallback((_: MouseEvent, node: Node) => {
    const data = node.data as FlowNodeData;
    const state = useHudStore.getState();
    if (data.kind === "department") {
      const id = node.id.slice("dept:".length);
      state.setSelectedDept(state.selectedDept === id ? "" : id);
    } else if (data.kind === "agent") {
      const id = node.id.slice("agent:".length);
      state.setSelectedAgent(id);
      const session = state.sessions.find((s) => s.agent === id);
      if (session) state.focusSession(session.id);
    }
  }, []);

  return (
    <div className="relative h-full w-full min-h-[260px] overflow-hidden border border-line bg-[#07080a]">
      <PixiField density={resolved.density} reducedMotion={resolved.reducedMotion} />

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.28, maxZoom: 1.35 }}
        minZoom={0.35}
        maxZoom={2.2}
        nodesConnectable={false}
        proOptions={{ hideAttribution: false }}
        className="rf-yuppy"
      >
        <Background
          variant={BackgroundVariant.Lines}
          gap={48}
          lineWidth={1}
          color="rgba(110, 130, 150, 0.14)"
        />
        <Controls showInteractive={false} className="rf-controls" />
        <MiniMap
          pannable
          zoomable
          className="rf-minimap"
          nodeColor={(node) => {
            const data = node.data as FlowNodeData;
            return data?.color ?? "#3f3f46";
          }}
          maskColor="rgba(7, 8, 10, 0.78)"
        />
      </ReactFlow>

      <div className="pointer-events-none absolute left-2 top-2 flex flex-col gap-0.5 font-mono text-[8px] uppercase tracking-[0.14em] text-text-lo">
        <span className="text-text-mid">
          2B şehir · {stats.departments} tower · {stats.agents} ajan
        </span>
        <span>
          pty {sessions.length} · canlı {stats.live + stats.busy} · sürükle konumlandır
        </span>
      </div>

      <div className="pointer-events-none absolute right-2 top-8 font-mono text-[8px] uppercase tracking-[0.14em] text-text-lo">
        react flow · cadde planı · pixi parçacık alanı
      </div>

      <div className="pointer-events-none absolute bottom-1.5 left-2 flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-wider text-text-lo/70">
        <span
          className={`size-1 rounded-full ${status === "connected" ? "bg-ok status-pulse" : "bg-danger"}`}
          aria-hidden
        />
        {status === "connected" ? "canlı ağ" : "çevrimdışı"}
      </div>
    </div>
  );
}
