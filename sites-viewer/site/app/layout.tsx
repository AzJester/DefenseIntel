import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "INTEL | Insightful Defense",
  description: "Defense competitive intelligence, pursuit analysis and capture planning.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
