/** A small set of line icons drawn for LUNORIZON (24-unit grid, stroke follows currentColor). */
const PATHS: Record<string, string> = {
  home: 'M4 11 12 4l8 7M6 9.5V20h12V9.5',
  plan: 'M12 3v3M12 18v3M3 12h3M18 12h3M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
  delay: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
  compare: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  engineering: 'M4 7h10M18 7h2M4 17h4M12 17h8M14 4v6M8 14v6',
  evidence: 'M12 3 4 6v6c0 4.5 3.4 8.1 8 9 4.6-.9 8-4.5 8-9V6l-8-3ZM8.5 12l2.5 2.5L15.5 10',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  battery: 'M3 8h15v8H3zM21 11v2M6 11v2M9 11v2',
  earth: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3.5 9h17M3.5 15h17M12 3c2.5 2.7 3.5 5.7 3.5 9s-1 6.3-3.5 9c-2.5-2.7-3.5-5.7-3.5-9s1-6.3 3.5-9Z',
  sliders: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  play: 'M8 5v14l11-7L8 5Z',
  pause: 'M8 5v14M16 5v14',
  shield: 'M12 3 4 6v6c0 4.5 3.4 8.1 8 9 4.6-.9 8-4.5 8-9V6l-8-3Z',
}

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ''} />
    </svg>
  )
}
