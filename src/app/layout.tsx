import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import PwaInstallHint from "@/components/PwaInstallHint";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "BC Assistant",
    template: "%s | BC Assistant",
  },
  description:
    "AI assistant for Choco Delight and Saurabh Food Business Central — customers, sales, inventory, and reports.",
  applicationName: "BC Assistant",
  appleWebApp: {
    capable: true,
    title: "BC Assistant",
    statusBarStyle: "black-translucent",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: "#18181b",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full h-dvh overflow-hidden antialiased`}
    >
      <body className="flex h-dvh min-h-dvh flex-col overflow-hidden antialiased">
        <PwaInstallHint />
        {children}
      </body>
    </html>
  );
}
