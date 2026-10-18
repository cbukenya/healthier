import React, { useEffect, useRef, useState } from 'react';
import {
  CalendarCheck, ChevronLeft, ChevronRight, CircleDotDashed, Crown, Database, FileCode2, Footprints, Heart, Moon, PersonStanding, Timer,
  TrendingDown, TrendingUp, TriangleAlert, createLucideIcon,
} from 'lucide-react';
import type { InsightPage, Kind, Observation } from '../pipeline/insights';
import { t, type MessageKey } from '../i18n';
import { tint } from '../ui/primitives';

const DOMAIN_LABELS: Record<string, MessageKey> = {
  cardio: 'insights.carousel.domains.cardio',
  sleep: 'insights.carousel.domains.sleep',
  body: 'insights.carousel.domains.body',
  cycle: 'insights.carousel.domains.cycle',
  data: 'insights.carousel.domains.data',
  movement: 'insights.carousel.domains.movement',
};

const DOMAIN_ICONS: Record<string, React.ReactNode> = {
  cardio: <Heart size={14} />,
  sleep: <Moon size={14} />,
  body: <PersonStanding size={14} />,
  cycle: <CircleDotDashed size={14} />,
  data: <FileCode2 size={14} />,
  movement: <Footprints size={14} />,
};

/** A card's glow: its tone strongest in the far corner, fading out before it reaches the words. */
const glow = (colour: string, strong: number, soft: number) =>
  `radial-gradient(130% 130% at 100% 100%, ${tint(colour, strong)} 0%, ${tint(colour, soft)} 42%, transparent 68%)`;

const TONE_STYLES: Record<string, { bg: string, border: string }> = {
  good: {
    bg: glow('var(--emerald-400)', 34, 10),
    border: tint('var(--emerald-400)', 16),
  },
  watch: {
    bg: glow('var(--amber-500)', 32, 9),
    border: tint('var(--amber-500)', 15),
  },
  neutral: {
    bg: glow('var(--slate-400)', 20, 6),
    border: tint('var(--slate-400)', 15),
  },
};

/** Each domain's chip in its page's colour. */
const DOMAIN_COLORS: Record<string, string> = {
  cardio: 'var(--rose-400)',
  sleep: 'var(--indigo-400)',
  body: 'var(--teal-300)',
  cycle: 'var(--pink-400)',
  data: 'var(--color-zinc-400)',
  movement: 'var(--emerald-400)',
};

const KIND_LABELS: Record<Kind, MessageKey> = {
  alert: 'insights.carousel.kinds.alert',
  nudge: 'insights.carousel.kinds.nudge',
  trend: 'insights.carousel.kinds.trend',
  milestone: 'insights.carousel.kinds.milestone',
  pattern: 'insights.carousel.kinds.pattern',
  review: 'insights.carousel.kinds.review',
  data: 'insights.carousel.kinds.data',
};

/** A trend with no single direction: the trending zigzag levelling off, drawn to match its up and down siblings. */
const TrendingFlat = createLucideIcon('trending-flat', [
  ['path', { d: 'M18 8l4 4-4 4', key: 'arrow' }],
  ['path', { d: 'm2 15 5-5 5 5 4-3h6', key: 'line' }],
]);

/** A pattern: three stepped bars. */
const Pattern = createLucideIcon('pattern-steps', [
  ['path', { d: 'M4.5 7h7', key: 'top' }],
  ['path', { d: 'M8.5 12h7', key: 'middle' }],
  ['path', { d: 'M12.5 17h7', key: 'bottom' }],
]);

/**
 * One colour for every kind badge, on every page. A page's own colour on a
 * badge could read as a verdict: Vitals' rose on a milestone looks like a warning.
 */
const KIND_COLOR = 'var(--indigo-400)';

/** On a page every card is from that page, so the chip says what kind of card it is instead. */
function KindIcon({ obs }: { obs: Observation }) {
  switch (obs.kind) {
    case 'alert': return <TriangleAlert size={14} />;
    case 'nudge': return <Timer size={14} />;
    case 'trend':
      // The line points the way the metric moved, and levels off when it didn't move one way.
      return obs.direction === 'up' ? <TrendingUp size={14} /> : obs.direction === 'down' ? <TrendingDown size={14} /> : <TrendingFlat size={14} />;
    case 'milestone': return <Crown size={14} />;
    case 'pattern': return <Pattern size={14} />;
    case 'review': return <CalendarCheck size={14} />;
    case 'data': return <Database size={14} />;
  }
}

/** Each page's carousel: its title, what it covers, and its own disclaimer where the general one isn't enough. */
const PAGE_COPY: Record<InsightPage, { title: MessageKey; description: MessageKey; disclaimer?: MessageKey }> = {
  activity: { title: 'insights.carousel.pages.activity.title', description: 'insights.carousel.pages.activity.description' },
  sleep: { title: 'insights.carousel.pages.sleep.title', description: 'insights.carousel.pages.sleep.description' },
  vitals: { title: 'insights.carousel.pages.vitals.title', description: 'insights.carousel.pages.vitals.description' },
  body: { title: 'insights.carousel.pages.body.title', description: 'insights.carousel.pages.body.description' },
  cycle: { title: 'insights.carousel.pages.cycle.title', description: 'insights.carousel.pages.cycle.description', disclaimer: 'cycle.disclaimer' },
};

/**
 * Today's key insights, or with `page` one page's own: titled for the page,
 * with a kind chip on every card.
 */
export function InsightsCarousel({ observations, page }: { observations: Observation[]; page?: InsightPage }) {
  const copy = page ? PAGE_COPY[page] : null;
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
      <div className="bg-card border border-zinc-800/80 rounded-[20px] pt-5 pb-4 md:pt-6 md:pb-5 overflow-hidden w-full relative flex-1 flex flex-col">
        <div className="flex justify-between items-center md:items-start gap-3 md:gap-6 px-4 md:px-6 pb-4">
          <div>
            <h2 className="font-display text-title text-zinc-100">{t(copy?.title ?? 'insights.carousel.title')}</h2>
            {/* A phone has room for the count, not the explanation. */}
            <p className="md:hidden text-detail text-zinc-500 mt-0.5 tabular-nums">
              {t('insights.carousel.position', { index: activeIndex + 1, count: observations.length })}
            </p>
            <p className="hidden md:block text-body-sm text-zinc-500 mt-1 max-w-[640px]">
              {t(copy?.description ?? 'insights.carousel.description')}
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <button onClick={prev} aria-label={t('insights.carousel.previous')} className="w-11 h-11 md:w-8 md:h-8 rounded-xl md:rounded-[10px] border border-zinc-800 bg-zinc-950 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100 transition-all flex items-center justify-center cursor-pointer">
              <ChevronLeft size={18} strokeWidth={2.5} />
            </button>
            <button onClick={next} aria-label={t('insights.carousel.next')} className="w-11 h-11 md:w-8 md:h-8 rounded-xl md:rounded-[10px] border border-zinc-800 bg-zinc-950 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100 transition-all flex items-center justify-center cursor-pointer">
              <ChevronRight size={18} strokeWidth={2.5} />
            </button>
          </div>
        </div>

        <div
          ref={railRef}
          className="flex gap-[14px] overflow-x-auto px-3.5 scroll-pl-3.5 md:px-6 md:scroll-pl-6 pb-1.5 snap-x snap-mandatory no-scrollbar flex-1"
          style={{ scrollBehavior: 'smooth' }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          onScroll={handleScroll}
        >
        {observations.map((obs) => {
          const tone = TONE_STYLES[obs.tone];
          return (
            <article
              key={obs.id}
              // On a phone the next card peeks in from the edge, so it's clear there are more to swipe;
              // the rail's padding matches the gap, so the card before stays out of sight.
              className="snap-start shrink-0 w-[calc(100%-16px)] md:w-full min-h-[172px] rounded-[18px] border p-[18px] md:p-5 relative flex flex-col bg-panel"
              style={{
                backgroundImage: tone.bg,
                borderColor: tone.border
              }}
            >
              <span
                className="self-end text-body-sm font-medium flex items-center gap-1.5"
                style={{
                  color: copy ? KIND_COLOR : DOMAIN_COLORS[obs.domain],
                }}
              >
                {copy ? <KindIcon obs={obs} /> : DOMAIN_ICONS[obs.domain]}
                {copy ? t(KIND_LABELS[obs.kind]) : DOMAIN_LABELS[obs.domain] ? t(DOMAIN_LABELS[obs.domain]) : obs.domain}
              </span>
              <div className="flex-1" />
              <div>
                <h3 className="font-display text-insight text-zinc-50 mt-3">
                  {obs.title}
                </h3>
                <p className="font-display text-insight-body md:text-insight-body-lg text-zinc-400 mt-2">
                  {obs.text}
                </p>
                {obs.action && (
                  <p className="font-display text-insight-body md:text-insight-body-lg text-zinc-300 md:text-zinc-400 mt-3 md:mt-4">
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
                  ? 'bg-zinc-400 w-[14px] rounded-[3px]'
                  : 'bg-rule-strong w-[5px] rounded-full'
              }`}
            />
          ))}
        </div>
        
        <p className="text-caption text-zinc-500 mt-1 px-4 md:px-0 text-center max-w-lg mx-auto">
          {t(copy?.disclaimer ?? 'insights.carousel.disclaimer')}
        </p>
      </div>
    </div>
  );
}
