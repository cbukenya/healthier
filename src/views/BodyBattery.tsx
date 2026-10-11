import React from 'react';

interface BodyBatteryProps {
  score: number;
  parts: { label: string; contribution: number; detail: string }[];
  confidence: string;
  label: string;
  className?: string;
}

export function BodyBattery({ score, parts, confidence, label, className = '' }: BodyBatteryProps) {
  let batteryState = '';
  let batteryColor = '';
  if (score < 17) {
    batteryState = '[DRAINED]';
    batteryColor = 'text-zinc-200';
  } else if (score < 50) {
    batteryState = '[LOW]';
    batteryColor = 'text-rose-500';
  } else if (score < 83) {
    batteryState = '[BALANCED]';
    batteryColor = 'text-yellow-500';
  } else {
    batteryState = '[CHARGED]';
    batteryColor = 'text-emerald-500';
  }
  const z = { tag: batteryState, color: batteryColor };

  const TOP = 9;
  const BOTTOM = 462;
  const fillY = BOTTOM - (score / 100) * (BOTTOM - TOP);
  const fillHeight = (score / 100) * (BOTTOM - TOP);

  const maxAbs = Math.max(...parts.map(p => Math.abs(p.contribution)), 1);

  return (
    <div className={`bg-[#0c0c0e] border border-[#1e1e22] rounded-[28px] p-[30px_24px] md:p-[44px_48px_40px] w-full max-w-[920px] mx-auto ${className}`}>
      <div className="grid grid-cols-1 md:grid-cols-[minmax(280px,1fr)_minmax(300px,440px)] gap-3 items-start">
        <div>
          <h1 className="text-[28px] md:text-[34px] font-bold tracking-[-0.02em] flex items-baseline gap-3 flex-wrap text-[#f4f4f5]">
            Body battery <span className={`text-[21px] font-bold tracking-[0.02em] ${z.color}`}>{z.tag}</span>
          </h1>
          <p className="mt-[18px] text-[18.5px] leading-[1.55] text-[#9ca0a8] max-w-[30ch]">
            Composed from HRV, resting heart rate, holistic sleep score & architecture against your personal 28-day baselines, and multi-day ACWR training load.
          </p>
          <div className="mt-[30px] inline-block bg-[#17171a] rounded-[20px] px-[30px] pt-[10px] pb-[14px]">
            <div className="flex items-baseline gap-1">
              <span className="text-[64px] md:text-[84px] font-bold tracking-[-0.03em] tabular-nums leading-[1.1] text-[#f4f4f5]">
                {score}
              </span>
              <span className="text-[17px] text-[#9ca0a8]">
                / 100
              </span>
            </div>
          </div>
          <div className="mt-[18px] text-[29px] font-bold tracking-[-0.01em] text-[#f4f4f5]">
            {label}
          </div>
        </div>

        <div className="w-full max-w-[340px] md:max-w-none mx-auto md:mx-0 mt-2 md:mt-0">
          <svg viewBox="0 0 470 480" role="img" aria-label="Body battery level" className="w-full h-auto block">
            <defs>
              <linearGradient id="charge" x1="0" y1="1" x2="0" y2="0">
                <stop offset="0"    stopColor="#f43f5e"/>
                <stop offset="0.30" stopColor="#f59e0b"/>
                <stop offset="0.55" stopColor="#eab308"/>
                <stop offset="0.82" stopColor="#22c55e"/>
                <stop offset="1"    stopColor="#22c55e"/>
              </linearGradient>

              <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
                <feGaussianBlur stdDeviation="8"/>
              </filter>

              <clipPath id="clipBody">
                <circle cx="120" cy="36" r="27"/>
                <rect x="107" y="54" width="26" height="24" rx="9"/>
                <path d="M84,90 C84,77 95,72 104,72 L136,72 C145,72 156,77 156,90 L152,184 C151,198 155,212 156,230 C157,250 146,260 120,260 C94,260 83,250 84,230 C85,212 89,198 88,184 Z"/>
                <rect x="69"  y="79" width="18" height="192" rx="9"   transform="rotate(10 78 87)"/>
                <rect x="153" y="79" width="18" height="192" rx="9"   transform="rotate(-10 162 87)"/>
                <rect x="88"  y="238" width="27" height="214" rx="13" transform="rotate(2 101 246)"/>
                <rect x="125" y="238" width="27" height="214" rx="13" transform="rotate(-2 139 246)"/>
                <rect x="68"  y="446" width="44" height="16" rx="8" transform="rotate(-5 106 454)"/>
                <rect x="128" y="446" width="44" height="16" rx="8" transform="rotate(5 134 454)"/>
              </clipPath>

              <clipPath id="clipLevel">
                <rect id="levelRect" x="20" y={fillY} width="200" height={fillHeight}/>
              </clipPath>
            </defs>

            <g filter="url(#glow)" opacity="0.4">
              <g clipPath="url(#clipBody)">
                <g clipPath="url(#clipLevel)">
                  <rect x="20" y="9" width="200" height="453" fill="url(#charge)"/>
                </g>
              </g>
            </g>

            <g fill="#1b1b1f">
              <circle cx="120" cy="36" r="27"/>
              <rect x="107" y="54" width="26" height="24" rx="9"/>
              <path d="M84,90 C84,77 95,72 104,72 L136,72 C145,72 156,77 156,90 L152,184 C151,198 155,212 156,230 C157,250 146,260 120,260 C94,260 83,250 84,230 C85,212 89,198 88,184 Z"/>
              <rect x="69"  y="79" width="18" height="192" rx="9"   transform="rotate(10 78 87)"/>
              <rect x="153" y="79" width="18" height="192" rx="9"   transform="rotate(-10 162 87)"/>
              <rect x="88"  y="238" width="27" height="214" rx="13" transform="rotate(2 101 246)"/>
              <rect x="125" y="238" width="27" height="214" rx="13" transform="rotate(-2 139 246)"/>
              <rect x="68"  y="446" width="44" height="16" rx="8" transform="rotate(-5 106 454)"/>
              <rect x="128" y="446" width="44" height="16" rx="8" transform="rotate(5 134 454)"/>
            </g>

            <g clipPath="url(#clipBody)">
              <g clipPath="url(#clipLevel)">
                <rect x="20" y="9" width="200" height="453" fill="url(#charge)"/>
              </g>
              <rect id="fillLine" x="20" y={fillY - 1} width="200" height="2" fill="#ffffff" opacity={score > 0 && score < 100 ? 0.35 : 0}/>
            </g>

            <g strokeDasharray="1.5 5" strokeLinecap="round" strokeWidth="1.5" stroke="#3f3f46">
              <line x1="158" y1="12"  x2="330" y2="12"/>
              <line x1="205" y1="163" x2="330" y2="163"/>
              <line x1="208" y1="313" x2="330" y2="313"/>
              <line x1="186" y1="460" x2="330" y2="460"/>
            </g>
            <g>
              <text className="font-bold tabular-nums text-[21px]" x="342" y="18"  fill="#22c55e">100%</text>
              <text className="text-[15px]" x="342" y="40" fill="#6b6f78">Charged</text>
              <text className="font-bold tabular-nums text-[21px]" x="342" y="169" fill="#eab308">66%</text>
              <text className="text-[15px]" x="342" y="191" fill="#6b6f78">Balanced</text>
              <text className="font-bold tabular-nums text-[21px]" x="342" y="319" fill="#f43f5e">33%</text>
              <text className="text-[15px]" x="342" y="341" fill="#6b6f78">Low</text>
              <text className="font-bold tabular-nums text-[21px]" x="342" y="466" fill="#e4e4e7">0%</text>
              <text className="text-[15px]" x="342" y="479" fill="#6b6f78">Drained</text>
            </g>
          </svg>
        </div>
      </div>

      <div className="mt-[26px]">
        <div className="text-[13px] font-semibold tracking-[0.22em] uppercase text-[#6b6f78] mb-[14px]">
          How it was reached
        </div>
        <div className="space-y-0">
          {parts.map(p => {
            const pos = p.contribution >= 0;
            const pct = (Math.abs(p.contribution) / maxAbs) * 45; // max 45% of width
            return (
              <div key={p.label} className="grid grid-cols-1 md:grid-cols-[230px_1fr_76px] items-center gap-[6px] md:gap-4 py-[5px]">
                <span className="text-[17px] text-[#d4d6db]">{p.label}</span>
                <div className="relative h-[12px] order-3 md:order-none">
                  <div className="absolute left-1/2 top-[-7px] bottom-[-7px] w-[1.5px] bg-[#3f3f46]" />
                  <div
                    className={`absolute top-[1px] h-[10px] rounded-full transition-all duration-700 ${pos ? 'bg-[#22c55e]' : 'bg-[#f43f5e]'}`}
                    style={{
                      width: `${pct}%`,
                      ...(pos ? { left: '50%' } : { right: '50%' })
                    }}
                  />
                </div>
                <span className={`text-[17px] font-semibold tabular-nums text-left md:text-right ${pos ? 'text-[#22c55e]' : 'text-[#f43f5e]'}`}>
                  {pos ? '+' : '−'}{Math.abs(p.contribution).toFixed(1)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <p className="mt-[26px] text-[15px] text-[#6b6f78] leading-[1.5]">
        {parts.map((p) => p.detail).join(' · ')}
      </p>
    </div>
  );
}
