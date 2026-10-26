/**
 * The icon set. DESIGN-SYSTEM section 9: a small set of inline SVGs, drawn
 * at 20px on a 2px stroke, in `currentColor`, so an icon takes its colour from
 * the text beside it. No icon package.
 *
 * The state icons (dot, plate, receipt, triangle, tick) carry meaning beside a
 * colour and a word, never alone. Every icon is decorative to a screen reader,
 * because the word next to it says the same thing.
 */
function Svg({ size = 20, className = '', children, fill = 'none' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill={fill}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`flex-none ${className}`}
    >
      {children}
    </svg>
  );
}

/* States, section 4b. */
export const DotIcon = (props) => (
  <Svg {...props}>
    <circle cx="10" cy="10" r="4.5" fill="currentColor" />
  </Svg>
);
export const PlateIcon = (props) => (
  <Svg {...props}>
    <circle cx="10" cy="10" r="7" />
    <circle cx="10" cy="10" r="3.5" />
  </Svg>
);
export const ReceiptIcon = (props) => (
  <Svg {...props}>
    <path d="M5 2.5h10v15l-2.5-1.5-2.5 1.5-2.5-1.5L5 17.5z" />
    <path d="M8 7h4M8 10.5h4" />
  </Svg>
);
export const TriangleIcon = (props) => (
  <Svg {...props}>
    <path d="M10 3 18 17H2z" />
    <path d="M10 8.5v3.5M10 14.5v.01" />
  </Svg>
);
export const TickIcon = (props) => (
  <Svg {...props}>
    <path d="m4 10.5 4 4 8-9" />
  </Svg>
);
export const ClockIcon = (props) => (
  <Svg {...props}>
    <circle cx="10" cy="10" r="7.5" />
    <path d="M10 6v4l2.5 2" />
  </Svg>
);
/** Free has no state colour; its icon is an empty ring. */
export const RingIcon = (props) => (
  <Svg {...props}>
    <circle cx="10" cy="10" r="4.5" />
  </Svg>
);
export const CrossIcon = (props) => (
  <Svg {...props}>
    <path d="m5 5 10 10M15 5 5 15" />
  </Svg>
);

/* Navigation and actions. */
export const HomeIcon = (props) => (
  <Svg {...props}>
    <path d="M3 9.5 10 3.5l7 6V17H3z" />
    <path d="M8 17v-5h4v5" />
  </Svg>
);
export const FloorIcon = (props) => (
  <Svg {...props}>
    <rect x="2.5" y="2.5" width="6" height="6" rx="1.5" />
    <rect x="11.5" y="2.5" width="6" height="6" rx="1.5" />
    <rect x="2.5" y="11.5" width="6" height="6" rx="1.5" />
    <rect x="11.5" y="11.5" width="6" height="6" rx="1.5" />
  </Svg>
);
export const BagIcon = (props) => (
  <Svg {...props}>
    <path d="M4 6.5h12l-1 11H5z" />
    <path d="M7.5 6.5V5a2.5 2.5 0 0 1 5 0v1.5" />
  </Svg>
);
export const ScooterIcon = (props) => (
  <Svg {...props}>
    <circle cx="5" cy="15" r="2.5" />
    <circle cx="15.5" cy="15" r="2.5" />
    <path d="M7.5 15h5.5l2-7h-3M12 4h2.5" />
  </Svg>
);
export const KitchenIcon = (props) => (
  <Svg {...props}>
    <path d="M3 9h14v3.5a4.5 4.5 0 0 1-4.5 4.5h-5A4.5 4.5 0 0 1 3 12.5z" />
    <path d="M7 6V3.5M10 6V2.5M13 6V3.5" />
  </Svg>
);
export const CashIcon = (props) => (
  <Svg {...props}>
    <rect x="2" y="5" width="16" height="10" rx="1.5" />
    <circle cx="10" cy="10" r="2.25" />
  </Svg>
);
export const LockIcon = (props) => (
  <Svg {...props}>
    <rect x="4" y="9" width="12" height="8.5" rx="1.5" />
    <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
  </Svg>
);
export const ChartIcon = (props) => (
  <Svg {...props}>
    <path d="M3 17h14M6 14V9M10 14V4M14 14v-3" />
  </Svg>
);
export const MenuBookIcon = (props) => (
  <Svg {...props}>
    <path d="M3.5 4h5a2 2 0 0 1 1.5.7A2 2 0 0 1 11.5 4h5v12h-5a1.5 1.5 0 0 0-1.5 1.5A1.5 1.5 0 0 0 8.5 16h-5z" />
  </Svg>
);
export const GearIcon = (props) => (
  <Svg {...props}>
    <circle cx="10" cy="10" r="2.75" />
    <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
  </Svg>
);
export const PeopleIcon = (props) => (
  <Svg {...props}>
    <circle cx="7.5" cy="7" r="3" />
    <path d="M2 17a5.5 5.5 0 0 1 11 0M13 4.3a3 3 0 0 1 0 5.4M15.5 12.5A5.5 5.5 0 0 1 18 17" />
  </Svg>
);
export const MoreIcon = (props) => (
  <Svg {...props}>
    <circle cx="4.5" cy="10" r="1" fill="currentColor" />
    <circle cx="10" cy="10" r="1" fill="currentColor" />
    <circle cx="15.5" cy="10" r="1" fill="currentColor" />
  </Svg>
);
export const BackIcon = (props) => (
  <Svg {...props}>
    <path d="M12.5 4 6.5 10l6 6" />
  </Svg>
);
export const PlusIcon = (props) => (
  <Svg {...props}>
    <path d="M10 4v12M4 10h12" />
  </Svg>
);
export const MinusIcon = (props) => (
  <Svg {...props}>
    <path d="M4 10h12" />
  </Svg>
);
export const PrintIcon = (props) => (
  <Svg {...props}>
    <path d="M5.5 7.5V3h9v4.5M5.5 14H3.5V8h13v6h-2" />
    <rect x="5.5" y="11.5" width="9" height="6" />
  </Svg>
);
/** P48. The floor's view of a table's history. */
export const EyeIcon = (props) => (
  <Svg {...props}>
    <path d="M1.5 10S4.5 4 10 4s8.5 6 8.5 6-3 6-8.5 6-8.5-6-8.5-6Z" />
    <circle cx="10" cy="10" r="2.5" />
  </Svg>
);
export const SearchIcon = (props) => (
  <Svg {...props}>
    <circle cx="8.5" cy="8.5" r="5.5" />
    <path d="m13 13 4.5 4.5" />
  </Svg>
);
export const DeviceIcon = (props) => (
  <Svg {...props}>
    <rect x="4" y="2.5" width="12" height="15" rx="2" />
    <path d="M9 14.5h2" />
  </Svg>
);
export const SignOutIcon = (props) => (
  <Svg {...props}>
    <path d="M8 3.5H4v13h4M12 6.5 15.5 10 12 13.5M15.5 10H7.5" />
  </Svg>
);
export const BellIcon = (props) => (
  <Svg {...props}>
    <path d="M5 14V9a5 5 0 0 1 10 0v5l1.5 2h-13zM8.5 18.5h3" />
  </Svg>
);
export const GlobeIcon = (props) => (
  <Svg {...props}>
    <circle cx="10" cy="10" r="7.5" />
    <path d="M2.5 10h15M10 2.5c2.2 2.4 2.2 12.6 0 15M10 2.5c-2.2 2.4-2.2 12.6 0 15" />
  </Svg>
);

/* Sign in and the account menu. */
export const PhoneIcon = (props) => (
  <Svg {...props}>
    <rect x="5.5" y="2" width="9" height="16" rx="2" />
    <path d="M9 15h2" />
  </Svg>
);
export const AtIcon = (props) => (
  <Svg {...props}>
    <circle cx="10" cy="10" r="3" />
    <path d="M13 10v1.5a2.5 2.5 0 0 0 5 0V10a8 8 0 1 0-3.2 6.4" />
  </Svg>
);
export const PersonIcon = (props) => (
  <Svg {...props}>
    <circle cx="10" cy="6.5" r="3.5" />
    <path d="M3 18a7 7 0 0 1 14 0" />
  </Svg>
);
export const EyeOffIcon = (props) => (
  <Svg {...props}>
    <path d="M7.5 4.4A8.8 8.8 0 0 1 10 4c5.5 0 8.5 6 8.5 6a14 14 0 0 1-2 2.8M5 5.8C2.8 7.4 1.5 10 1.5 10s3 6 8.5 6a8 8 0 0 0 3.7-.9" />
    <path d="M2.5 2.5l15 15" />
  </Svg>
);
export const ChevronDownIcon = (props) => (
  <Svg {...props}>
    <path d="m5 7.5 5 5 5-5" />
  </Svg>
);
