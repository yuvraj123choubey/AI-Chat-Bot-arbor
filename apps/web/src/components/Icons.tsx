import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };
const base = (size: number, rest: SVGProps<SVGSVGElement>) => ({
  width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, ...rest
});
const icon = (paths: ReactNode) => ({ size = 16, ...rest }: IconProps) => <svg {...base(size, rest)}>{paths}</svg>;

export const LogoIcon = icon(<><circle cx="12" cy="12" r="3" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.93 4.93l2.12 2.12m9.9 9.9 2.12 2.12M4.93 19.07l2.12-2.12m9.9-9.9 2.12-2.12" /></>);
export const PlusIcon = icon(<><path d="M12 5v14M5 12h14" /></>);
export const SearchIcon = icon(<><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></>);
export const CodeIcon = icon(<><path d="m16 18 6-6-6-6M8 6l-6 6 6 6" /></>);
export const SparkIcon = icon(<><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48 2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48 2.83-2.83" /></>);
export const GridIcon = icon(<><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></>);
export const StarIcon = icon(<><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z" /></>);
export const ChevronIcon = icon(<><path d="m6 9 6 6 6-6" /></>);
export const ArrowIcon = icon(<><path d="M7 17 17 7M7 7h10v10" /></>);
export const StopIcon = icon(<><rect x="6" y="6" width="12" height="12" rx="2" /></>);
export const MicIcon = icon(<><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" /></>);
export const CopyIcon = icon(<><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>);
export const RefreshIcon = icon(<><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" /><path d="M21 3v5h-5" /></>);
export const LinkIcon = icon(<><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>);
export const CloseIcon = icon(<><path d="M18 6 6 18M6 6l12 12" /></>);
export const MenuIcon = icon(<><path d="M4 6h16M4 12h16M4 18h16" /></>);
export const FileIcon = icon(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>);
export const BookIcon = icon(<><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" /><path d="M4 19.5V21h16" /></>);
export const GlobeIcon = icon(<><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 0 20 15.3 15.3 0 0 1 0-20" /></>);
export const LayersIcon = icon(<><path d="m12 2 10 5-10 5L2 7z" /><path d="m2 17 10 5 10-5M2 12l10 5 10-5" /></>);
export const ChatIcon = icon(<><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></>);
export const CompassIcon = icon(<><circle cx="12" cy="12" r="10" /><path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36z" /></>);
