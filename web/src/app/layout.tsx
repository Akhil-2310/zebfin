import type { Metadata } from "next";
import { Fredoka, Geist_Mono, Nunito, Pixelify_Sans } from "next/font/google";
import { SessionProvider } from "@/lib/session";
import "./globals.css";

const body = Nunito({
  variable: "--font-body",
  subsets: ["latin"],
});

// Rounded display face for headings and buttons; the pixel face is only an
// accent (logo, Zeb's LCD screens).
const display = Fredoka({
  variable: "--font-display",
  subsets: ["latin"],
});

const pixel = Pixelify_Sans({
  variable: "--font-pixel",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Zebfin",
  description: "Private finance for organizations on Zcash: payroll, treasury and books, end-to-end encrypted.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${body.variable} ${display.variable} ${pixel.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
