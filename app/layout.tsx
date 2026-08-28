import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Compliance Sentinel — Autonomous Web Change Detection",
  description:
    "An autonomous agent that monitors a pharma HCP web page, detects changes against its stored history, and reasons about why each change might matter for compliance.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
