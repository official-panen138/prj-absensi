const VARIANTS = {
  primary: 'bg-emerald-500 text-black hover:bg-emerald-400',
  ghost: 'bg-transparent text-gray-400 border border-gray-700 hover:border-gray-600 hover:text-gray-300',
  warning: 'bg-yellow-500 text-black hover:bg-yellow-400',
  success: 'bg-emerald-400 text-black hover:bg-emerald-300',
  danger: 'bg-red-500 text-white hover:bg-red-400',
  purple: 'bg-purple-500 text-white hover:bg-purple-400',
};

const SIZES = {
  sm: 'text-xs px-2.5 py-1',
  md: 'text-[13px] px-4 py-2',
};

export default function Btn({ children, variant = 'primary', onClick, disabled, size = 'md', className = '' }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-md font-semibold cursor-pointer transition-all duration-150 ${disabled ? 'opacity-50 cursor-not-allowed' : ''} ${VARIANTS[variant] || VARIANTS.primary} ${SIZES[size] || SIZES.md} ${className}`}
    >
      {children}
    </button>
  );
}
