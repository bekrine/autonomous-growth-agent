import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { Sidebar } from "@/components/layout/sidebar";

export const metadata: Metadata = {
  title: "Autonomous Growth Agent",
  description: "Operator console for the autonomous social-media growth agent",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen bg-surface text-white">
        <Providers>
          <Sidebar />
          <div className="flex-1">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
