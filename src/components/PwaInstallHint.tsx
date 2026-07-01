"use client";

import { useEffect, useState } from "react";

const DISMISS_KEY = "bc-assistant-pwa-hint-dismissed";

function isIosDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator &&
      (navigator as Navigator & { standalone?: boolean }).standalone === true)
  );
}

export default function PwaInstallHint() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isIosDevice() || isStandalone()) return;
    if (window.localStorage.getItem(DISMISS_KEY) === "1") return;
    setVisible(true);
  }, []);

  if (!visible) return null;

  return (
    <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-3 py-2 text-center text-[11px] text-amber-950 sm:px-6 sm:py-2.5 sm:text-sm">
      <span>
        Install on iPhone: tap{" "}
        <span className="font-semibold">Share</span> →{" "}
        <span className="font-semibold">Add to Home Screen</span>
      </span>
      <button
        type="button"
        onClick={() => {
          window.localStorage.setItem(DISMISS_KEY, "1");
          setVisible(false);
        }}
        className="ml-3 rounded-full px-2 py-0.5 font-medium text-amber-800 transition hover:bg-amber-100"
      >
        Dismiss
      </button>
    </div>
  );
}
