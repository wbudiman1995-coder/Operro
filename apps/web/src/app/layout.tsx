/**
 * Function index:
 * - RootLayout: establishes Operro metadata, language, and global visual foundation.
 */
import type { Metadata } from "next";
import { Geist } from "next/font/google";

import "./globals.css";

const geist = Geist({
  variable: "--font-operro-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Operro — Operasional bisnis dalam satu tempat",
    template: "%s | Operro",
  },
  description:
    "Operro membantu bisnis layanan mengelola booking, pelanggan, tim, dan operasional harian dengan lebih rapi.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id" data-scroll-behavior="smooth" className={`${geist.variable} h-full antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
