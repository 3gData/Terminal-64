import { useEffect, useState } from "react";

export interface ChatScrollState {
  isScrolledUp: boolean;
  progress: number;
}

const SCROLLED_UP_THRESHOLD_PX = 32;

export function useChatScrollState(el: HTMLElement | null): ChatScrollState {
  const [state, setState] = useState<ChatScrollState>({ isScrolledUp: false, progress: 0 });

  useEffect(() => {
    if (!el) {
      setState({ isScrolledUp: false, progress: 0 });
      return;
    }

    let rafId = 0;

    const sync = () => {
      const maxScroll = el.scrollHeight - el.clientHeight;
      if (maxScroll <= 1) {
        setState((prev) =>
          prev.isScrolledUp || prev.progress !== 0 ? { isScrolledUp: false, progress: 0 } : prev
        );
        return;
      }
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const isScrolledUp = distFromBottom > SCROLLED_UP_THRESHOLD_PX;
      const progress = Math.max(0, Math.min(1, 1 - el.scrollTop / maxScroll));
      setState((prev) =>
        prev.isScrolledUp === isScrolledUp && Math.abs(prev.progress - progress) < 0.001
          ? prev
          : { isScrolledUp, progress }
      );
    };

    sync();
    rafId = requestAnimationFrame(sync);

    const onScroll = () => sync();
    el.addEventListener("scroll", onScroll, { passive: true });

    const ro = new ResizeObserver(sync);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);

    const mo = new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of Array.from(rec.addedNodes)) {
          if (node instanceof Element) ro.observe(node);
        }
      }
      sync();
    });
    mo.observe(el, { childList: true });

    return () => {
      cancelAnimationFrame(rafId);
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      mo.disconnect();
    };
  }, [el]);

  return state;
}
