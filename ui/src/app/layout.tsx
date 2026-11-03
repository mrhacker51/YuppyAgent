import type { Metadata } from "next";
import "./globals.css";
import ToasterHost from "@/components/fancy/ToasterHost";

export const metadata: Metadata = {
  title: "YuppyCode · AgentSpace Deck",
  description: "Multi-agent command center for real Claude Code and Codex PTY sessions.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="tr" className="h-full antialiased">
      <body className="relative isolate h-full overflow-hidden bg-background text-foreground">
        {children}
        <ToasterHost />
      </body>
    </html>
  );
}
