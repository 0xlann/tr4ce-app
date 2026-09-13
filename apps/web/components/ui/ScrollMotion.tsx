"use client";

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useLayoutEffect } from "react";
import { usePathname } from "next/navigation";

gsap.registerPlugin(ScrollTrigger);

/**
 * Site-wide reveal choreography. Server-rendered markup stays visible by
 * default; this adds the "gsapRunning" contract (set by an inline bootstrap)
 * and animates every [data-reveal] element once it enters the viewport.
 */
export function ScrollMotion() {
  const pathname = usePathname();

  useLayoutEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const revealed = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));

    if (reduced) {
      gsap.set(revealed, { opacity: 1, clearProps: "transform,filter" });
      document.querySelectorAll(".drawLine").forEach((line) => {
        (line as SVGPathElement).style.strokeDasharray = "none";
        (line as SVGPathElement).style.strokeDashoffset = "0";
      });
      return;
    }

    const context = gsap.context(() => {
      for (const el of revealed) {
        const delay = Number(el.dataset.revealDelay ?? 0);
        gsap.fromTo(
          el,
          { autoAlpha: 0, y: 26, filter: "blur(6px)" },
          {
            autoAlpha: 1,
            y: 0,
            filter: "blur(0px)",
            duration: 0.85,
            delay,
            ease: "expo.out",
            scrollTrigger: { trigger: el, start: "top 88%", once: true },
          },
        );
      }

      for (const group of document.querySelectorAll<HTMLElement>("[data-draw]")) {
        ScrollTrigger.create({
          trigger: group,
          start: "top 85%",
          once: true,
          onEnter: () => group.classList.add("isDrawn"),
        });
      }
    });

    /*
     * If a trigger never fires, nothing may stay hidden.
     *
     * `autoAlpha: 0` hides through `visibility: hidden`, not opacity alone, so restoring `opacity`
     * here left every un-triggered element invisible — the fail-safe looked right and did nothing.
     * Found by a 390px end-to-end run, where the content below the fold is exactly what a phone
     * reader has to scroll to.
     */
    const failSafe = window.setTimeout(() => {
      gsap.set(revealed, { autoAlpha: 1 });
    }, 2500);

    return () => {
      window.clearTimeout(failSafe);
      context.revert();
    };
  }, [pathname]);

  return null;
}
