"use client";

import { MessagesSquare, Radio, SquareTerminal } from "lucide-react";
import { ChatMessage } from "fancy-ui-react";
import type { AgentSpeech, LogEntry, TeamMessage } from "@/lib/store";
import { agentShortName } from "@/lib/agents";
import Linkified from "../Linkified";

/** One real feed event: a bridge log line, an operator prompt, a seat's
 * verbatim PTY line, or a team-bus message one agent sent another. The union
 * keeps the ordering honest — nothing is synthesised to fill a gap. */
export type FeedItem =
  | { kind: "log"; key: string; ts: number; entry: LogEntry }
  | { kind: "speech"; key: string; ts: number; speech: AgentSpeech }
  | { kind: "bus"; key: string; ts: number; message: TeamMessage };

/** Seed entries have ts=0 so the SSR HTML and hydration agree. */
function logTime(ts: number): string {
  return ts > 0 ? new Date(ts).toLocaleTimeString([], { hour12: false }) : "boot";
}

function AvatarChip({
  label,
  tone = "bridge",
}: {
  label: string;
  tone?: "bridge" | "seat" | "bus";
}) {
  const seat = tone === "seat";
  const bus = tone === "bus";
  return (
    <span
      className={`inline-flex max-w-[74px] items-center gap-1 rounded-[2px] border px-1 py-px font-mono text-[7px] uppercase tracking-[0.1em] ${
        seat
          ? "border-ok/30 bg-ok/[0.06] text-ok"
          : bus
            ? "border-struct/30 bg-struct/[0.06] text-struct"
            : "border-line bg-bg-2 text-text-lo"
      }`}
      title={label}
    >
      {seat ? (
        <SquareTerminal size={7} aria-hidden />
      ) : bus ? (
        <MessagesSquare size={7} aria-hidden />
      ) : (
        <Radio size={7} aria-hidden />
      )}
      <span className="truncate">{label}</span>
    </span>
  );
}

function Footer({ ts, who }: { ts: number; who: string }) {
  return (
    <span className="font-mono text-[7px] uppercase tracking-[0.12em] text-text-lo/80">
      {who} · {logTime(ts)}
    </span>
  );
}

/**
 * A single feed turn rendered with FancyUI's ChatMessage: operator prompts are
 * `user`, real bridge info is `assistant` beside a bridge avatar, bridge
 * warnings/errors are `system`, and verbatim seat lines carry the seat label as
 * their avatar. Every body is still rendered through Linkified, so the console
 * never rewrites what the bridge or a PTY actually said.
 */
export default function AgentActivity({
  item,
  index,
}: {
  item: FeedItem;
  index: number;
}) {
  const delay = `${Math.min(index, 10) * 20}ms`;

  if (item.kind === "speech") {
    const label = item.speech.label || agentShortName(item.speech.agent);
    return (
      <ChatMessage
        role="assistant"
        sound={false}
        className="deck-enter mb-1 !gap-1.5"
        avatar={<AvatarChip label={label} tone="seat" />}
        footer={<Footer ts={item.speech.ts} who={label} />}
      >
        <span
          className="block whitespace-pre-wrap break-words font-mono text-[9px] leading-[1.5] text-text-mid"
          style={{ animationDelay: delay }}
        >
          <Linkified>{item.speech.line}</Linkified>
        </span>
      </ChatMessage>
    );
  }

  if (item.kind === "bus") {
    const m = item.message;
    return (
      <ChatMessage
        role="assistant"
        sound={false}
        className="deck-enter mb-1 !gap-1.5"
        avatar={<AvatarChip label={m.sender} tone="bus" />}
        footer={<Footer ts={m.ts} who={`${m.sender} → ${m.recipient} · veriyolu`} />}
      >
        <span
          className="block whitespace-pre-wrap break-words font-mono text-[9px] leading-[1.5] text-text-mid"
          style={{ animationDelay: delay }}
        >
          <Linkified>{m.body}</Linkified>
        </span>
      </ChatMessage>
    );
  }

  const { entry } = item;

  if (entry.level === "prompt") {
    return (
      <ChatMessage
        role="user"
        sound={false}
        className="deck-enter mb-1 !gap-1.5 [&_.ft-message-bubble]:!rounded-[3px] [&_.ft-message-bubble]:!border [&_.ft-message-bubble]:!border-accent/40 [&_.ft-message-bubble]:!bg-accent/[0.07] [&_.ft-message-bubble]:!px-2 [&_.ft-message-bubble]:!py-1"
        footer={<Footer ts={entry.ts} who="operatör" />}
      >
        <span className="block whitespace-pre-wrap break-words font-mono text-[9.5px] leading-[1.5] text-text-hi">
          <Linkified>{entry.message}</Linkified>
        </span>
      </ChatMessage>
    );
  }

  if (entry.level === "warn" || entry.level === "error") {
    const tone = entry.level === "error" ? "text-danger" : "text-warn";
    const dot = entry.level === "error" ? "bg-danger" : "bg-warn";
    return (
      <ChatMessage
        role="system"
        sound={false}
        className="deck-enter my-0.5"
        footer={<Footer ts={entry.ts} who={entry.level === "error" ? "hata" : "uyarı"} />}
      >
        <span className={`inline-flex items-start gap-1.5 text-left text-[9px] leading-[1.5] ${tone}`}>
          <span className={`mt-[5px] size-1 shrink-0 rounded-full ${dot}`} aria-hidden />
          <span className="whitespace-pre-wrap break-words">
            <Linkified>{entry.message}</Linkified>
          </span>
        </span>
      </ChatMessage>
    );
  }

  return (
    <ChatMessage
      role="assistant"
      sound={false}
      className="deck-enter mb-0.5 !gap-1.5"
      avatar={<AvatarChip label="köprü" />}
      footer={<Footer ts={entry.ts} who="köprü" />}
    >
      <span className="block whitespace-pre-wrap break-words font-mono text-[9px] leading-[1.5] text-text-mid">
        <Linkified>{entry.message}</Linkified>
      </span>
    </ChatMessage>
  );
}
