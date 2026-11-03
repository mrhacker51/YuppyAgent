"use client";

import { useEffect } from "react";
import type { ModuleId } from "@/lib/modules";

/**
 * Global keyboard map. Shortcuts are a real part of the operator's workflow:
 * the command centre is used for hours, so switching modules or jumping to the
 * prompt must never require the mouse.
 *
 * Every binding is explicit and none of them fire while the user is typing in
 * an input, textarea, select or contenteditable — except ⌘/Ctrl+K, which
 * focuses the lead Claude terminal (the main command window).
 */
export interface ShortcutOptions {
  modules: readonly ModuleId[];
  onModule: (id: ModuleId) => void;
  onFocusPrompt: () => void;
  onToggleHelp: () => void;
}

export default function useKeyboardShortcuts({
  modules,
  onModule,
  onFocusPrompt,
  onToggleHelp,
}: ShortcutOptions) {
  useEffect(() => {
    const isTyping = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el.isContentEditable
      );
    };

    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) {
        if (e.key === "?" && !isTyping(e.target)) {
          e.preventDefault();
          onToggleHelp();
        }
        return;
      }
      // ⌘K / Ctrl+K — jump to the lead Claude terminal, from anywhere. Inside
      // a terminal, plain Ctrl+K is the CLI's own kill-line key: let it through.
      if (e.key.toLowerCase() === "k" && !e.shiftKey) {
        if (
          e.ctrlKey &&
          !e.metaKey &&
          e.target instanceof HTMLElement &&
          e.target.closest(".xterm")
        ) {
          return;
        }
        e.preventDefault();
        onFocusPrompt();
        return;
      }
      // ⌘1..9 — module tabs, in header order.
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= 9) {
        const id = modules[n - 1];
        if (id) {
          e.preventDefault();
          onModule(id);
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modules, onModule, onFocusPrompt, onToggleHelp]);
}
