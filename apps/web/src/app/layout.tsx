import type { Metadata } from "next";
import type { ReactNode } from "react";
import "../styles/globals.css";

export const metadata: Metadata = {
  title: "Noderunner",
  description: "Which dependency alerts can your code actually reach, and the cheapest fix.",
};

export default function Layout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <a className="brand" href="/">
            Noderunner
          </a>
          <span className="tag">dependency triage with a graph path behind every claim</span>
        </header>
        {children}
      </body>
    </html>
  );
}
