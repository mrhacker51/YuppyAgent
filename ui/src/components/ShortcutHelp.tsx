"use client";

import { Dialog } from "fancy-ui-react";

type Group = {
  id: string;
  title: string;
  hint: string;
  wide?: boolean;
  rows: Array<[string, string]>;
};

/**
 * Only bindings that actually exist in the shell are listed. ⌘K focuses the
 * lead Claude terminal (the main command window); the palette is ⌘⇧K.
 */
const GROUPS: Group[] = [
  {
    id: "focus",
    title: "Odak",
    hint: "palet, yardım ve kapatma",
    rows: [
      ["⌘K / Ctrl+K", "ana komut penceresine (lead Claude) odaklan"],
      ["⌘⇧K / Ctrl+Shift+K", "komut paletini aç / kapat"],
      ["?", "bu yardımı aç / kapat"],
      ["Esc", "paneli veya iletişim kutusunu kapat"],
    ],
  },
  {
    id: "navigation",
    title: "Gezinme",
    hint: "modüller, terminaller, ofis",
    rows: [
      ["⌘1 … ⌘9", "modül seç (soldan sağa)"],
      ["← →", "terminal kolon genişliği −10 / +10"],
      ["↑ ↓", "terminal satır yüksekliği −4 / +4"],
      ["çift tık", "terminal kolonlarını eşitle"],
      ["boş masaya tıkla", "o koltukta PTY başlat"],
      ["ajana tıkla", "terminalini aç / odakla"],
    ],
  },
  {
    id: "dispatch",
    title: "Komut",
    hint: "ana komut penceresi lead Claude'dur",
    wide: true,
    rows: [
      ["↵", "lead Claude'a gönder (ana komut penceresinde)"],
      ["Ctrl-C", "lead'in o anki işini kes (PTY'ye gerçek tuş)"],
      ["görev dağıtımı", "lead, yuppy_dispatch ile ekibe paralel görev açar"],
    ],
  },
];

/** Keyboard help. Dialog owns Escape, outside-click dismissal and focus trap. */
export default function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Klavye kısayolları"
      description="Yalnızca bu panelde gerçekten bağlı olan kısayollar listelenir."
      dismissible
      className="max-w-2xl"
      footer={
        <span className="flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-[0.13em] text-text-lo">
          <kbd className="rounded-[3px] border border-line bg-bg-2 px-1.5 py-0.5 font-mono text-[8px] text-text-mid">
            Esc
          </kbd>
          ile kapat
        </span>
      }
    >
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {GROUPS.map((group) => (
          <section
            key={group.id}
            className={group.wide ? "sm:col-span-2" : ""}
            aria-labelledby={`shortcut-${group.id}`}
          >
            <header className="mb-1.5 flex items-baseline gap-2 border-b border-line/70 pb-1">
              <h3
                id={`shortcut-${group.id}`}
                className="font-mono text-[9px] uppercase tracking-[0.16em] text-accent/85"
              >
                {group.title}
              </h3>
              <span className="font-mono text-[8px] uppercase tracking-[0.12em] text-text-lo/70">
                {group.hint}
              </span>
            </header>
            <table className="w-full table-fixed border-collapse">
              <tbody>
                {group.rows.map(([key, label]) => (
                  <tr key={key} className="align-baseline">
                    <th scope="row" className="w-[38%] py-0.5 pr-3 text-left font-normal">
                      <kbd className="inline-block rounded-[3px] border border-line-mid bg-bg-2 px-1.5 py-0.5 font-mono text-[9px] font-normal text-text-mid">
                        {key}
                      </kbd>
                    </th>
                    <td className="py-0.5 font-mono text-[9.5px] leading-snug text-text-lo">
                      {label}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
