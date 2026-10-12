import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Footprints, Moon, Heart, PersonStanding, FileCode2 } from 'lucide-react';
import type { Observation } from '../pipeline/derive';

const DOMAIN_LABELS: Record<string, string> = {
  cardio: 'Vitals',
  sleep: 'Sleep',
  body: 'Body',
  data: 'Data',
  movement: 'Activity',
};

const DOMAIN_ICONS: Record<string, React.ReactNode> = {
  cardio: <Heart size={14} />,
  sleep: <Moon size={14} />,
  body: <PersonStanding size={14} />,
  data: <FileCode2 size={14} />,
  movement: <Footprints size={14} />,
};

const TONE_STYLES: Record<string, { bg: string, border: string }> = {
  good: {
    bg: 'radial-gradient(130% 130% at 100% 100%, rgba(52,211,153,.34) 0%, rgba(52,211,153,.10) 42%, rgba(52,211,153,0) 68%)',
    border: 'rgba(52,211,153,.16)',
  },
  watch: {
    bg: 'radial-gradient(130% 130% at 100% 100%, rgba(245,158,11,.32) 0%, rgba(245,158,11,.09) 42%, rgba(245,158,11,0) 68%)',
    border: 'rgba(245,158,11,.15)',
  },
  neutral: {
    bg: 'radial-gradient(130% 130% at 100% 100%, rgba(148,163,184,.20) 0%, rgba(148,163,184,.06) 42%, rgba(148,163,184,0) 68%)',
    border: 'rgba(148,163,184,.15)',
  },
};

const DOMAIN_STYLES: Record<string, { color: string, border: string, bg: string }> = {
  cardio: { color: '#fb7185', border: 'rgba(251,113,133,.3)', bg: 'rgba(251,113,133,.08)' },
  sleep: { color: '#818cf8', border: 'rgba(129,140,248,.3)', bg: 'rgba(129,140,248,.08)' },
  body: { color: '#5eead4', border: 'rgba(94,234,212,.3)', bg: 'rgba(94,234,212,.08)' },
  data: { color: '#a1a1aa', border: 'rgba(161,161,170,.3)', bg: 'rgba(161,161,170,.08)' },
  movement: { color: '#34d399', border: 'rgba(52,211,153,.3)', bg: 'rgba(52,211,153,.08)' },
};

export function InsightsCarousel({ observations }: { observations: Observation[] }) {
  const railRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isHovered, setIsHovered] = useState(false);

  const go = (idx: number, smooth = true) => {
    if (!railRef.current) return;
    const clamped = Math.max(0, Math.min(observations.length - 1, idx));
    setActiveIndex(clamped);
    // Card width matches container width
    const itemWidth = (railRef.current.firstElementChild as HTMLElement)?.offsetWidth || 330;
    const gap = 14;
    railRef.current.scrollTo({ left: clamped * (itemWidth + gap), behavior: smooth ? 'smooth' : 'auto' });
  };

  const prev = () => go(activeIndex - 1);
  const next = () => go(activeIndex >= observations.length - 1 ? 0 : activeIndex + 1);

  useEffect(() => {
    if (activeIndex > observations.length - 1) setActiveIndex(Math.max(0, observations.length - 1));
  }, [observations.length, activeIndex]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq.matches || isHovered || observations.length <= 1) return;

    const timer = setInterval(() => {
      setActiveIndex((curr) => {
        const nextIdx = curr >= observations.length - 1 ? 0 : curr + 1;
        if (railRef.current) {
          const itemWidth = (railRef.current.firstElementChild as HTMLElement)?.offsetWidth || 330;
          const gap = 14;
          railRef.current.scrollTo({ left: nextIdx * (itemWidth + gap), behavior: 'smooth' });
        }
        return nextIdx;
      });
    }, 30000);

    return () => clearInterval(timer);
  }, [isHovered, observations.length]);

  // A re-sync can shrink the list (insights are daypart- and state-gated);
  // never leave the index stranded past the end.
  useEffect(() => {
    if (activeIndex > observations.length - 1) {
      setActiveIndex(Math.max(0, observations.length - 1));
      railRef.current?.scrollTo({ left: 0, behavior: 'auto' });
    }
  }, [observations.length, activeIndex]);

  const handleScroll = () => {
    if (!railRef.current) return;
    const scrollLeft = railRef.current.scrollLeft;
    const itemWidth = (railRef.current.firstElementChild as HTMLElement)?.offsetWidth || 330;
    const gap = 14;
    const newIdx = Math.round(scrollLeft / (itemWidth + gap));
    if (newIdx !== activeIndex) {
      setActiveIndex(newIdx);
    }
  };

  if (!observations.length) return null;

  return (
    <div className="h-full flex flex-col">
      <div className="bg-[#09090b] border border-zinc-800/80 rounded-[20px] pt-6 pb-5 overflow-hidden w-full relative flex-1 flex flex-col">
        <div className="flex justify-between items-start gap-6 px-6 pb-4">
          <div>
            <h2 className="text-zinc-100 text-[15px] font-medium tracking-tight">Key insights</h2>
            <p className="text-zinc-500 text-[13px] mt-1 leading-[1.55] max-w-[640px]">
              Derived from your data to give you a quick overview of what it means — the
              things that stand out, good or bad, that deserve your attention.
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <button onClick={prev} aria-label="Previous insights" className="w-8 h-8 rounded-[10px] border border-zinc-800 bg-zinc-950 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100 transition-all flex items-center justify-center cursor-pointer">
              <ChevronLeft size={18} strokeWidth={2.5} />
            </button>
            <button onClick={next} aria-label="Next insights" className="w-8 h-8 rounded-[10px] border border-zinc-800 bg-zinc-950 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100 transition-all flex items-center justify-center cursor-pointer">
              <ChevronRight size={18} strokeWidth={2.5} />
            </button>
          </div>
        </div>

        <div
          ref={railRef}
          className="flex gap-[14px] overflow-x-auto px-6 scroll-pl-6 pb-1.5 snap-x snap-mandatory no-scrollbar flex-1"
          style={{ scrollBehavior: 'smooth' }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          onScroll={handleScroll}
        >
        {observations.map((obs, i) => {
          const tone = TONE_STYLES[obs.tone];
          const dom = DOMAIN_STYLES[obs.domain];
          return (
            <article
              key={i}
              className="snap-start shrink-0 w-full min-h-[172px] rounded-[18px] border p-5 relative flex flex-col bg-[#111114]"
              style={{
                backgroundImage: tone.bg,
                borderColor: tone.border
              }}
            >
              <span
                className="self-end text-[13px] font-medium flex items-center gap-1.5"
                style={{
                  color: dom.color,
                }}
              >
                {DOMAIN_ICONS[obs.domain]}
                {DOMAIN_LABELS[obs.domain] || obs.domain}
              </span>
              <div className="flex-1" />
              <div>
                <h3 className="text-[#fafafa] text-[16.5px] font-bold tracking-[-0.015em] mt-3 leading-[1.25]">
                  {obs.title}
                </h3>
                <p className="text-[18.5px] leading-[1.55] text-[#9ca0a8] mt-2">
                  {obs.text}
                </p>
                {obs.action && (
                  <p className="text-[18.5px] leading-[1.55] text-[#9ca0a8] mt-4">
                    {obs.action}
                  </p>
                )}
              </div>
            </article>
          );
        })}
      </div>

        <div className="flex gap-[5px] justify-center mt-3.5 mb-2">
          {observations.map((_, i) => (
            <i
              key={i}
              className={`h-[5px] transition-all duration-300 ${
                i === activeIndex
                  ? 'bg-[#a1a1aa] w-[14px] rounded-[3px]'
                  : 'bg-[#2c2c32] w-[5px] rounded-full'
              }`}
            />
          ))}
        </div>
        
        <p className="text-zinc-500 text-[11px] mt-1 text-center max-w-lg mx-auto">
          General wellness information, not medical advice. Healthier is not a medical device. If you're worried about your health, talk to a clinician.
        </p>
      </div>
    </div>
  );
}
